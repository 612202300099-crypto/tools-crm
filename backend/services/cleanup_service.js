/**
 * Cleanup Service (The Janitor) — v3
 * ─────────────────────────────────────────────────────────────
 * Menggunakan raw SQLite query (better-sqlite3) langsung —
 * BUKAN supabase_shim — karena shim tidak support complex chaining
 * seperti .in().lt() yang dibutuhkan di sini.
 *
 * TIER 1 — Hapus setelah 3 hari:
 *   - Foto dari customer berstatus VALIDATED
 *   - Foto dari customer berstatus SUDAH_KIRIM_FOTO
 *
 * TIER 2 — Hapus setelah 7 hari (abandoned):
 *   - Foto dari customer BELUM_KIRIM_FOTO yang sudah >7 hari tidak aktif
 *
 * TIER 3 — Folder kosong:
 *   - Hapus folder uploads/{id} yang sudah tidak punya file
 *
 * DISK MONITOR:
 *   - Cek disk sebelum & sesudah cleanup
 *   - Log WARNING jika >80%, KRITIS jika >90%
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

// ─── Lazy-load db agar tidak crash jika dipanggil sebelum dotenv ─────────────
function getDb() {
    return require('../db');
}

// ─── Disk Usage ───────────────────────────────────────────────────────────────
function getDiskUsagePercent() {
    try {
        const out = execSync("df / --output=pcent | tail -1").toString().trim();
        return parseInt(out.replace('%', ''), 10) || 0;
    } catch (e) {
        return 0;
    }
}

// ─── Hapus file fisik + hapus record DB ──────────────────────────────────────
function deleteMediaRecords(db, mediaList) {
    let deleted = 0;
    let failed = 0;

    const deleteStmt = db.prepare('DELETE FROM media WHERE id = ?');

    for (const media of mediaList) {
        try {
            // Hapus file fisik
            if (media.file_name) {
                const filePath = path.join(UPLOADS_DIR, media.file_name);
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            }
            // Hapus record DB
            deleteStmt.run(media.id);
            deleted++;
        } catch (err) {
            console.error(`  ⚠️ Gagal hapus ${media.file_name || media.id}: ${err.message}`);
            failed++;
        }
    }

    return { deleted, failed };
}

// ─── Hapus folder kosong di uploads/ ─────────────────────────────────────────
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

// ─── FUNGSI UTAMA ─────────────────────────────────────────────────────────────
async function runCleanup(forceTier2 = false) {
    const startTime = Date.now();
    console.log(`\n[${new Date().toISOString()}] 🧹 The Janitor v3 mulai bekerja...`);

    const diskBefore = getDiskUsagePercent();
    console.log(`[DISK] 💾 Penggunaan disk: ${diskBefore}%`);

    if (diskBefore >= 95) {
        console.error(`[DISK] 🚨 KRITIS! Disk ${diskBefore}% — Cleanup darurat diaktifkan!`);
        forceTier2 = true;
    } else if (diskBefore >= 80) {
        console.warn(`[DISK] ⚠️ WARNING: Disk ${diskBefore}% — Mendekati batas aman.`);
    } else {
        console.log(`[DISK] ✅ Disk dalam batas aman.`);
    }

    let totalDeleted = 0;
    let totalFailed = 0;

    try {
        const db = getDb();

        // ═══════════════════════════════════════════════════════════
        // TIER 1: VALIDATED atau SUDAH_KIRIM_FOTO → hapus foto >3 hari
        // ═══════════════════════════════════════════════════════════
        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
        const cutoff3 = threeDaysAgo.toISOString();

        const tier1Media = db.prepare(`
            SELECT m.id, m.file_name
            FROM media m
            JOIN customers c ON m.customer_id = c.id
            WHERE c.status IN ('VALIDATED', 'SUDAH_KIRIM_FOTO')
              AND m.created_at < ?
        `).all(cutoff3);

        if (tier1Media.length > 0) {
            console.log(`[TIER-1] 🗑️ Menghapus ${tier1Media.length} foto dari VALIDATED/SUDAH_KIRIM_FOTO (>3 hari)...`);
            const { deleted, failed } = deleteMediaRecords(db, tier1Media);
            totalDeleted += deleted;
            totalFailed += failed;
            console.log(`[TIER-1] ✅ ${deleted} dihapus, ${failed} gagal.`);
        } else {
            console.log(`[TIER-1] ✅ Tidak ada foto expired dari VALIDATED/SUDAH_KIRIM_FOTO.`);
        }

        // ═══════════════════════════════════════════════════════════
        // TIER 2: BELUM_KIRIM_FOTO abandoned → hapus foto >7 hari
        // ═══════════════════════════════════════════════════════════
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const cutoff7 = sevenDaysAgo.toISOString();

        const tier2Media = db.prepare(`
            SELECT m.id, m.file_name
            FROM media m
            JOIN customers c ON m.customer_id = c.id
            WHERE c.status = 'BELUM_KIRIM_FOTO'
              AND m.created_at < ?
        `).all(cutoff7);

        if (tier2Media.length > 0) {
            console.log(`[TIER-2] 🗑️ Menghapus ${tier2Media.length} foto dari customer abandoned (>7 hari)...`);
            const { deleted, failed } = deleteMediaRecords(db, tier2Media);
            totalDeleted += deleted;
            totalFailed += failed;
            console.log(`[TIER-2] ✅ ${deleted} dihapus, ${failed} gagal.`);
        } else {
            console.log(`[TIER-2] ✅ Tidak ada foto abandoned yang perlu dihapus.`);
        }

        // ═══════════════════════════════════════════════════════════
        // TIER 3: Folder kosong
        // ═══════════════════════════════════════════════════════════
        const removedFolders = cleanEmptyFolders();
        if (removedFolders > 0) {
            console.log(`[TIER-3] 🗂️ Menghapus ${removedFolders} folder uploads kosong.`);
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const diskAfter = getDiskUsagePercent();

        console.log(`\n✅ The Janitor v3 selesai dalam ${elapsed}s.`);
        console.log(`   Dihapus: ${totalDeleted} file | Gagal: ${totalFailed}`);
        console.log(`   Disk: ${diskBefore}% → ${diskAfter}%\n`);

    } catch (err) {
        console.error('❌ Terjadi kesalahan di The Janitor:', err.message);
        console.error(err.stack);
    }
}

// Jalankan langsung via CLI: node cleanup_service.js
if (require.main === module) {
    // Muat env dulu sebelum apapun
    require('dotenv').config({ path: path.join(__dirname, '../../.env') });
    require('dotenv').config({ path: path.join(__dirname, '../.env') });

    runCleanup(true)
        .then(() => process.exit(0))
        .catch(e => { console.error(e); process.exit(1); });
} else {
    module.exports = runCleanup;
}
