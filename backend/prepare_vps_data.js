const db = require('./db');
const fs = require('fs');
const path = require('path');

async function cleanVpsData() {
    console.log("=== MEMULAI PEMBERSIHAN DATA VPS (SISA 4 HARI TERAKHIR) ===");

    // 1. Tentukan batas waktu (4 hari yang lalu)
    const fourDaysAgo = new Date();
    fourDaysAgo.setDate(fourDaysAgo.getDate() - 4);
    const cutoffDate = fourDaysAgo.toISOString();
    console.log(`Batas waktu pembersihan: Data sebelum ${cutoffDate}`);

    // 2. Cari semua pelanggan yang statusnya VALIDATED dan dibuat sebelum batas waktu
    const oldValidatedCustomers = db.prepare(`
        SELECT id, phone_number FROM customers 
        WHERE status = 'VALIDATED' AND created_at < ?
    `).all(cutoffDate);

    if (oldValidatedCustomers.length === 0) {
        console.log("✅ Tidak ada data lama berstatus VALIDATED yang perlu dihapus. Database sudah bersih.");
        return;
    }

    console.log(`Menemukan ${oldValidatedCustomers.length} pelanggan berstatus VALIDATED yang lebih lama dari 4 hari.`);

    let deletedMediaCount = 0;
    let deletedMessageCount = 0;

    // 3. Hapus data media dan file fisiknya
    for (const customer of oldValidatedCustomers) {
        // Ambil semua media milik pelanggan ini
        const medias = db.prepare('SELECT id, file_name FROM media WHERE customer_id = ?').all(customer.id);
        
        for (const media of medias) {
            const filePath = path.join(__dirname, 'uploads', media.file_name);
            // Hapus file fisik
            if (fs.existsSync(filePath)) {
                try {
                    fs.unlinkSync(filePath);
                    deletedMediaCount++;
                } catch (err) {
                    console.error(`Gagal menghapus file ${media.file_name}:`, err.message);
                }
            }
        }

        // Hapus row media (CASCADE delete dari SQLite harusnya jalan, tapi kita hapus manual untuk aman)
        db.prepare('DELETE FROM media WHERE customer_id = ?').run(customer.id);
        
        // Hapus row pesan
        const infoMsg = db.prepare('DELETE FROM messages WHERE customer_id = ?').run(customer.id);
        deletedMessageCount += infoMsg.changes;

        // Terakhir, hapus row pelanggan
        db.prepare('DELETE FROM customers WHERE id = ?').run(customer.id);
    }

    // [PENTING] Vacuum database untuk mengembalikan ruang hardisk yang kosong ke OS
    console.log("Sedang melakukan VACUUM untuk mengompres database...");
    db.exec('VACUUM');

    console.log("=========================================================");
    console.log(`✅ PEMBERSIHAN SELESAI!`);
    console.log(`- Total Pelanggan Dihapus : ${oldValidatedCustomers.length}`);
    console.log(`- Total Pesan Dihapus     : ${deletedMessageCount}`);
    console.log(`- Total File Foto Dihapus : ${deletedMediaCount}`);
    console.log("Database lokal sekarang sangat ringan dan siap digunakan.");
    console.log("=========================================================");
}

cleanVpsData();
