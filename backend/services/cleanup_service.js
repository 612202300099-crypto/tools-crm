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
const fs   = require('fs');
const { execSync } = require('child_process');
const objectStorage = require('./object_storage_service');

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

// ─── Hapus file fisik + hapus record DB ────────────────────────────────────────────
async function deleteMediaRecords(db, mediaList) {
    let deleted = 0;
    let failed  = 0;

    const deleteStmt = db.prepare('DELETE FROM media WHERE id = ?');

    for (const media of mediaList) {
        try {
            // Hapus dari object storage ATAU disk lokal berdasarkan storage_type
            const storageType = media.storage_type || 'local';
            const storageKey  = media.storage_key  || media.file_name;
            await objectStorage.deleteMedia(storageKey, storageType);

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
    console.log(`\n[${new Date().toISOString()}] 🧹 The Janitor v4 mulai bekerja (Object Storage Mode)...`);

    const diskBefore = getDiskUsagePercent();
    console.log(`[DISK] 💾 Penggunaan disk lokal VPS: ${diskBefore}%`);

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
        // TIER 0: EMERGENCY — Hapus file LOKAL yang sudah aman di Object Storage
        // Ini adalah cleanup paling efektif karena Object Storage = cloud,
        // file lokal hanyalah salinan yang bisa dihapus tanpa kehilangan data.
        // ═══════════════════════════════════════════════════════════
        if (diskBefore >= 80) {
            console.log(`[TIER-0] 🚨 Disk ${diskBefore}% — Menghapus file lokal yang sudah ada di Object Storage...`);
            let tier0Deleted = 0;

            try {
                // Cari semua media yang storage_type = 'object' (sudah di cloud)
                const cloudMedia = db.prepare(`
                    SELECT id, file_name, storage_key, storage_type FROM media
                    WHERE storage_type = 'object' AND file_name IS NOT NULL
                `).all();

                for (const media of cloudMedia) {
                    // Cek apakah file lokal masih ada di disk
                    const localPath = path.join(UPLOADS_DIR, media.file_name);
                    if (fs.existsSync(localPath)) {
                        try {
                            fs.unlinkSync(localPath);
                            tier0Deleted++;
                        } catch (e) { /* silent */ }
                    }
                }

                // Juga scan folder uploads/ untuk file yatim (tidak ada di DB)
                if (diskBefore >= 95 && fs.existsSync(UPLOADS_DIR)) {
                    const customerDirs = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true });
                    for (const dir of customerDirs) {
                        if (!dir.isDirectory()) continue;
                        const dirPath = path.join(UPLOADS_DIR, dir.name);
                        try {
                            const files = fs.readdirSync(dirPath);
                            for (const file of files) {
                                const relPath = `${dir.name}/${file}`;
                                // Cek apakah file ini sudah di Object Storage
                                const inCloud = db.prepare(
                                    `SELECT 1 FROM media WHERE file_name = ? AND storage_type = 'object' LIMIT 1`
                                ).get(relPath);
                                if (inCloud) {
                                    fs.unlinkSync(path.join(dirPath, file));
                                    tier0Deleted++;
                                }
                            }
                        } catch (e) { /* silent */ }
                    }
                }

                if (tier0Deleted > 0) {
                    console.log(`[TIER-0] ✅ ${tier0Deleted} file lokal dihapus (sudah aman di Object Storage).`);
                    console.log(`[TIER-0] 💾 Disk sekarang: ${getDiskUsagePercent()}%`);
                } else {
                    console.log(`[TIER-0] ✅ Tidak ada file lokal yang perlu dihapus.`);
                }
            } catch (e) {
                console.warn(`[TIER-0] ⚠️ Error:`, e.message);
            }
        }

        // ═══════════════════════════════════════════════════════════
        // TIER 1: VALIDATED atau SUDAH_KIRIM_FOTO → hapus foto
        // Normal mode: >3 hari | Crisis mode (disk>90%): >1 hari
        // ═══════════════════════════════════════════════════════════
        const tier1Days = (diskBefore >= 90) ? 1 : 3;
        const tier1Cutoff = new Date();
        tier1Cutoff.setDate(tier1Cutoff.getDate() - tier1Days);

        const tier1Media = db.prepare(`
            SELECT m.id, m.file_name, m.storage_key, m.storage_type
            FROM media m
            JOIN customers c ON m.customer_id = c.id
            WHERE c.status IN ('VALIDATED', 'SUDAH_KIRIM_FOTO')
              AND m.created_at < ?
        `).all(tier1Cutoff.toISOString());

        if (tier1Media.length > 0) {
            console.log(`[TIER-1] 🗑️ Menghapus ${tier1Media.length} foto VALIDATED/SUDAH_KIRIM_FOTO (>${tier1Days} hari)...`);
            const { deleted, failed } = deleteMediaRecords(db, tier1Media);
            totalDeleted += deleted;
            totalFailed += failed;
            console.log(`[TIER-1] ✅ ${deleted} dihapus, ${failed} gagal.`);
        } else {
            console.log(`[TIER-1] ✅ Tidak ada foto expired VALIDATED/SUDAH_KIRIM_FOTO (threshold: ${tier1Days} hari).`);
        }

        // ═══════════════════════════════════════════════════════════
        // TIER 2: BELUM_KIRIM_FOTO abandoned
        // Normal mode: >7 hari | Crisis mode (disk>90%): >2 hari
        // ═══════════════════════════════════════════════════════════
        const tier2Days = (diskBefore >= 90) ? 2 : 7;
        const tier2Cutoff = new Date();
        tier2Cutoff.setDate(tier2Cutoff.getDate() - tier2Days);

        const tier2Media = db.prepare(`
            SELECT m.id, m.file_name, m.storage_key, m.storage_type
            FROM media m
            JOIN customers c ON m.customer_id = c.id
            WHERE c.status = 'BELUM_KIRIM_FOTO'
              AND m.created_at < ?
        `).all(tier2Cutoff.toISOString());

        if (tier2Media.length > 0) {
            console.log(`[TIER-2] 🗑️ Menghapus ${tier2Media.length} foto customer abandoned (>${tier2Days} hari)...`);
            const { deleted, failed } = deleteMediaRecords(db, tier2Media);
            totalDeleted += deleted;
            totalFailed += failed;
            console.log(`[TIER-2] ✅ ${deleted} dihapus, ${failed} gagal.`);
        } else {
            console.log(`[TIER-2] ✅ Tidak ada foto abandoned (threshold: ${tier2Days} hari).`);
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
