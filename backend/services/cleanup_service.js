/**
 * Cleanup Service (The Janitor) — v2
 * ─────────────────────────────────────────────────────────────
 * Strategi penghapusan bertingkat untuk menjaga disk VPS tetap sehat:
 *
 * TIER 1 — Agresif (Hapus segera):
 *   - File foto dari customer VALIDATED yang lebih dari 3 hari
 *   - File foto dari customer SUDAH_KIRIM_FOTO yang lebih dari 3 hari
 *
 * TIER 2 — Aman (Hapus setelah 7 hari):
 *   - File foto dari customer BELUM_KIRIM_FOTO yang lebih dari 7 hari
 *     (kemungkinan besar customer abandonded / tidak jadi order)
 *
 * TIER 3 — Folder kosong (cleanup sisa):
 *   - Hapus folder uploads/{customer_id} yang sudah kosong
 *
 * DISK MONITOR — Alert:
 *   - Jika disk > 85% → log WARNING
 *   - Jika disk > 95% → log CRITICAL + paksa cleanup Tier 1+2
 */

require('dotenv').config();
const { createClient } = require('../supabase_shim');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

// ─── Helper: Cek penggunaan disk saat ini ────────────────────────────────────
function getDiskUsagePercent() {
    try {
        // Baca dari /proc/mounts atau gunakan df
        const output = execSync("df / --output=pcent | tail -1").toString().trim();
        return parseInt(output.replace('%', ''), 10);
    } catch (e) {
        return 0; // Jika gagal baca, anggap aman
    }
}

// ─── Helper: Hapus file + record DB ──────────────────────────────────────────
async function deleteMediaRecords(mediaList) {
    let deletedFiles = 0;
    let failedFiles = 0;
    const idsToDelete = [];

    for (const media of mediaList) {
        // Konstruksi path: uploads/customer_id/filename atau uploads/filename
        const filePath = path.join(UPLOADS_DIR, media.file_name);

        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                deletedFiles++;
            } else {
                // File sudah tidak ada di disk, tapi record DB masih ada → hapus DB saja
                deletedFiles++;
            }
            idsToDelete.push(media.id);
        } catch (err) {
            console.error(`  ⚠️ Gagal hapus ${media.file_name}: ${err.message}`);
            failedFiles++;
        }
    }

    // Hapus batch dari database
    if (idsToDelete.length > 0) {
        await supabase.from('media').delete().in('id', idsToDelete);
    }

    return { deletedFiles, failedFiles };
}

// ─── Helper: Hapus folder kosong di uploads/ ─────────────────────────────────
function cleanEmptyFolders() {
    if (!fs.existsSync(UPLOADS_DIR)) return 0;
    let removed = 0;
    try {
        const entries = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const folderPath = path.join(UPLOADS_DIR, entry.name);
            const files = fs.readdirSync(folderPath);
            if (files.length === 0) {
                fs.rmdirSync(folderPath);
                removed++;
            }
        }
    } catch (e) { /* silent */ }
    return removed;
}

// ─── Fungsi Utama ─────────────────────────────────────────────────────────────
async function runCleanup(forceTier2 = false) {
    const startTime = Date.now();
    console.log(`\n[${new Date().toISOString()}] 🧹 The Janitor v2 mulai bekerja...`);

    // ── Cek kondisi disk dulu ──
    const diskPercent = getDiskUsagePercent();
    console.log(`[DISK] 💾 Penggunaan disk: ${diskPercent}%`);

    if (diskPercent >= 95) {
        console.error(`[DISK] 🚨 KRITIS! Disk ${diskPercent}% — Cleanup darurat diaktifkan!`);
        forceTier2 = true; // Paksa hapus semua tier
    } else if (diskPercent >= 85) {
        console.warn(`[DISK] ⚠️ WARNING: Disk ${diskPercent}% — Mendekati batas aman.`);
    } else {
        console.log(`[DISK] ✅ Disk ${diskPercent}% — Dalam batas aman.`);
    }

    let totalDeleted = 0;
    let totalFailed = 0;

    try {
        // ═══════════════════════════════════════════════════════
        // TIER 1: Customer VALIDATED atau SUDAH_KIRIM_FOTO > 3 hari
        // ═══════════════════════════════════════════════════════
        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

        const { data: tier1Customers } = await supabase
            .from('customers')
            .select('id')
            .in('status', ['VALIDATED', 'SUDAH_KIRIM_FOTO']);

        if (tier1Customers && tier1Customers.length > 0) {
            const ids = tier1Customers.map(c => c.id);

            const { data: tier1Media } = await supabase
                .from('media')
                .select('id, file_name, created_at')
                .in('customer_id', ids)
                .lt('created_at', threeDaysAgo.toISOString());

            if (tier1Media && tier1Media.length > 0) {
                console.log(`[TIER-1] 🗑️ Menghapus ${tier1Media.length} foto dari VALIDATED/SUDAH_KIRIM_FOTO (>3 hari)...`);
                const { deletedFiles, failedFiles } = await deleteMediaRecords(tier1Media);
                totalDeleted += deletedFiles;
                totalFailed += failedFiles;
                console.log(`[TIER-1] ✅ Selesai: ${deletedFiles} dihapus, ${failedFiles} gagal.`);
            } else {
                console.log(`[TIER-1] ✅ Tidak ada foto VALIDATED/SUDAH yang expired.`);
            }
        }

        // ═══════════════════════════════════════════════════════
        // TIER 2: Customer BELUM_KIRIM_FOTO > 7 hari (abandoned)
        // Hanya dijalankan jika forceTier2 = true (disk kritis) atau default
        // ═══════════════════════════════════════════════════════
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const { data: tier2Customers } = await supabase
            .from('customers')
            .select('id')
            .eq('status', 'BELUM_KIRIM_FOTO')
            .lt('created_at', sevenDaysAgo.toISOString()); // Customer yang sudah > 7 hari tanpa update

        if (tier2Customers && tier2Customers.length > 0) {
            const ids = tier2Customers.map(c => c.id);

            const { data: tier2Media } = await supabase
                .from('media')
                .select('id, file_name, created_at')
                .in('customer_id', ids)
                .lt('created_at', sevenDaysAgo.toISOString());

            if (tier2Media && tier2Media.length > 0) {
                console.log(`[TIER-2] 🗑️ Menghapus ${tier2Media.length} foto dari customer abandoned (>7 hari)...`);
                const { deletedFiles, failedFiles } = await deleteMediaRecords(tier2Media);
                totalDeleted += deletedFiles;
                totalFailed += failedFiles;
                console.log(`[TIER-2] ✅ Selesai: ${deletedFiles} dihapus, ${failedFiles} gagal.`);
            } else {
                console.log(`[TIER-2] ✅ Tidak ada foto abandoned yang perlu dihapus.`);
            }
        }

        // ═══════════════════════════════════════════════════════
        // TIER 3: Bersihkan folder kosong
        // ═══════════════════════════════════════════════════════
        const removedFolders = cleanEmptyFolders();
        if (removedFolders > 0) {
            console.log(`[TIER-3] 🗂️ Menghapus ${removedFolders} folder uploads kosong.`);
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const diskAfter = getDiskUsagePercent();
        console.log(`\n✅ The Janitor Selesai dalam ${elapsed}s.`);
        console.log(`   Total dihapus: ${totalDeleted} file | Gagal: ${totalFailed}`);
        console.log(`   Disk sekarang: ${diskAfter}% (sebelumnya: ${diskPercent}%)\n`);

    } catch (err) {
        console.error('❌ Terjadi kesalahan di The Janitor:', err.message);
    }
}

// Untuk dijalankan langsung: node cleanup_service.js
if (require.main === module) {
    runCleanup(true) // force tier 2 jika dijalankan manual
        .then(() => process.exit(0))
        .catch(e => { console.error(e); process.exit(1); });
} else {
    module.exports = runCleanup;
}
