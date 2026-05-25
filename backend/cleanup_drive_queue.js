/**
 * cleanup_drive_queue.js
 * ──────────────────────────────────────────────────────────────
 * Membersihkan data "hantu" (orphan) di tabel drive_upload_queue
 * dan drive_folders setelah penghapusan massal customer.
 *
 * MASALAH:
 *   Saat customer dihapus dari tabel `customers`, data terkait
 *   di `drive_upload_queue` TIDAK ikut terhapus (tidak ada ON DELETE CASCADE).
 *   Akibatnya, dashboard Drive menampilkan angka palsu:
 *     - 63103 Menunggu Resi  ← padahal customernya sudah tidak ada
 *     - 2528 Gagal           ← idem
 *     - 37966 Selesai        ← idem
 *
 * SOLUSI:
 *   Script ini mendeteksi dan menghapus semua baris di drive_upload_queue
 *   yang customer_id-nya sudah tidak ada di tabel customers.
 *
 * CARA PAKAI:
 *   Mode analisa (aman, tidak menghapus):
 *     node cleanup_drive_queue.js
 *
 *   Mode hapus (permanen):
 *     node cleanup_drive_queue.js --confirm
 */

const db = require('./db');

const isConfirm = process.argv.includes('--confirm');

console.log('\n╔══════════════════════════════════════════════════════╗');
console.log('║   CLEANUP DATA HANTU - Drive Upload Queue           ║');
console.log('╚══════════════════════════════════════════════════════╝');

if (!isConfirm) {
    console.log('\n⚠️  MODE SIMULASI — Tidak ada data yang dihapus.');
    console.log('   Tambahkan --confirm untuk menghapus permanen.\n');
} else {
    console.log('\n🔴 MODE HAPUS PERMANEN\n');
}

// ── 1. Statistik SEBELUM pembersihan ──────────────────────────────────────
console.log('── Statistik SEBELUM Pembersihan ──────────────────────');

const totalCustomers = db.prepare('SELECT COUNT(*) as c FROM customers').get().c;
console.log(`   Jumlah customer aktif  : ${totalCustomers}`);

const statsBefore = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM drive_upload_queue
    GROUP BY status
    ORDER BY count DESC
`).all();

let totalQueueBefore = 0;
for (const row of statsBefore) {
    console.log(`   Drive Queue [${row.status.padEnd(14)}]: ${row.count}`);
    totalQueueBefore += row.count;
}
console.log(`   ─────────────────────────────────`);
console.log(`   TOTAL drive_upload_queue          : ${totalQueueBefore}`);

const totalFolders = db.prepare('SELECT COUNT(*) as c FROM drive_folders').get().c;
console.log(`   TOTAL drive_folders               : ${totalFolders}\n`);

// ── 2. Deteksi data yatim piatu (orphan) ─────────────────────────────────
console.log('── Mendeteksi Data Hantu (Orphan) ─────────────────────');

const orphanByStatus = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM drive_upload_queue
    WHERE customer_id NOT IN (SELECT id FROM customers)
    GROUP BY status
    ORDER BY count DESC
`).all();

let totalOrphans = 0;
for (const row of orphanByStatus) {
    console.log(`   👻 Orphan [${row.status.padEnd(14)}]: ${row.count}`);
    totalOrphans += row.count;
}
console.log(`   ─────────────────────────────────`);
console.log(`   TOTAL data hantu                  : ${totalOrphans}`);

const validEntries = totalQueueBefore - totalOrphans;
console.log(`   Data VALID (customer masih ada)   : ${validEntries}`);

const orphanPercentage = totalQueueBefore > 0 
    ? ((totalOrphans / totalQueueBefore) * 100).toFixed(1) 
    : 0;
console.log(`   Persentase hantu                  : ${orphanPercentage}%\n`);

// ── 3. Deteksi orphan di drive_folders ───────────────────────────────────
// Folder yang sudah tidak ada customer terkaitnya di queue
const orphanFolders = db.prepare(`
    SELECT COUNT(*) as c FROM drive_folders
    WHERE folder_path NOT IN (
        SELECT DISTINCT 
            UPPER(COALESCE(duq.store_name,'UNKNOWN')) || '/' || 
            COALESCE(duq.product_abbr,'LAINNYA') || '/' || 
            COALESCE(duq.resi,'NORESI') || '_' || COALESCE(duq.sku,'NOSKU')
        FROM drive_upload_queue duq
        WHERE duq.customer_id IN (SELECT id FROM customers)
    )
`).get().c;
console.log(`   👻 Orphan drive_folders           : ${orphanFolders}\n`);

// ── 4. Eksekusi pembersihan ──────────────────────────────────────────────
if (totalOrphans === 0 && orphanFolders === 0) {
    console.log('✅ Database sudah bersih! Tidak ada data hantu yang perlu dibersihkan.');
    process.exit(0);
}

if (!isConfirm) {
    console.log('── Simulasi Selesai ──────────────────────────────────');
    console.log(`   Jika dijalankan dengan --confirm:`);
    console.log(`   - ${totalOrphans} baris orphan di drive_upload_queue akan DIHAPUS`);
    console.log(`   - ${orphanFolders} baris orphan di drive_folders akan DIHAPUS`);
    console.log(`\n   Jalankan: node cleanup_drive_queue.js --confirm\n`);
    process.exit(0);
}

// Mode --confirm: Hapus permanen
console.log('── Menjalankan Pembersihan ────────────────────────────');

const deleteQueue = db.prepare(`
    DELETE FROM drive_upload_queue
    WHERE customer_id NOT IN (SELECT id FROM customers)
`).run();
console.log(`   ✅ Dihapus dari drive_upload_queue : ${deleteQueue.changes} baris`);

// Bersihkan juga folder cache yang sudah tidak relevan
// Kita hapus semua cache folder — nanti akan di-rebuild otomatis saat upload berikutnya
const deleteFolders = db.prepare(`DELETE FROM drive_folders`).run();
console.log(`   ✅ Reset cache drive_folders       : ${deleteFolders.changes} baris (akan auto-rebuild)`);

// ── 5. Statistik SESUDAH pembersihan ─────────────────────────────────────
console.log('\n── Statistik SESUDAH Pembersihan ─────────────────────');

const statsAfter = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM drive_upload_queue
    GROUP BY status
    ORDER BY count DESC
`).all();

let totalQueueAfter = 0;
for (const row of statsAfter) {
    console.log(`   Drive Queue [${row.status.padEnd(14)}]: ${row.count}`);
    totalQueueAfter += row.count;
}
console.log(`   ─────────────────────────────────`);
console.log(`   TOTAL drive_upload_queue          : ${totalQueueAfter}`);
console.log(`   TOTAL dihapus                     : ${totalQueueBefore - totalQueueAfter}`);

console.log('\n✅ PEMBERSIHAN SELESAI!');
console.log('   Dashboard Drive sekarang menampilkan angka yang akurat.');
console.log('   Restart engine: pm2 restart WA-Engine\n');
