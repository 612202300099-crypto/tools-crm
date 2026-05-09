const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../db');

async function main() {
    console.log('================================================================');
    console.log('🚀 MEMULAI PROSES RESET SINKRONISASI GOOGLE DRIVE');
    console.log('================================================================\n');

    // 1. Kalkulasi Threshold Waktu: KITA AMBIL DARI AWAL WAKTU!
    const thresholdUTC = '2000-01-01T00:00:00.000Z';
    
    console.log(`⏰ Filter Waktu Aktif: SEMUA DATA DARI AWAL`);

    try {
        // 2. Bersihkan Antrean Lama (Mulai dari Nol)
        console.log(`🧹 Mengosongkan tabel antrean 'drive_upload_queue' secara total...`);
        db.prepare(`DELETE FROM drive_upload_queue`).run();
        // Reset auto increment agar mulai dari ID 1
        db.prepare(`DELETE FROM sqlite_sequence WHERE name='drive_upload_queue'`).run();
        console.log(`✅ Antrean lama berhasil dimusnahkan!\n`);

        // 3. Tarik data Media
        console.log(`🔍 Menyisir SEMUA foto pelanggan dari database...`);
        
        // Tarik data dengan JOIN untuk mendapatkan info lengkap
        const query = `
            SELECT 
                m.id as media_id,
                m.customer_id,
                m.file_url,
                m.storage_key,
                m.storage_type,
                m.file_name,
                m.created_at,
                c.phone_number,
                c.resi,
                c.store_name,
                c.order_detail
            FROM media m
            JOIN customers c ON m.customer_id = c.id
            WHERE m.created_at >= ?
            ORDER BY m.customer_id ASC, m.created_at ASC
        `;
        
        const allMedia = db.prepare(query).all(thresholdUTC);
        
        // Filter cerdas: Skip foto abu-abu (file fisik hilang)
        const fs = require('fs');
        const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
        let validMedia = [];
        let skippedMissing = 0;

        for (const item of allMedia) {
            // Jika foto ada di S3, pasti aman.
            if (item.storage_type === 'object') {
                validMedia.push(item);
                continue;
            }
            
            // Jika foto berstatus local, kita harus cek fisik file-nya
            const localPath = path.join(UPLOADS_DIR, item.file_name || '');
            if (fs.existsSync(localPath)) {
                validMedia.push(item);
            } else {
                skippedMissing++; // Foto gaib (abu-abu)
            }
        }

        console.log(`📸 Menyaring ${allMedia.length} foto...`);
        console.log(`🗑️ DIBUANG: ${skippedMissing} foto gaib (abu-abu) yang hilang saat pindah VPS.`);
        console.log(`✅ TERSISA: ${validMedia.length} foto valid untuk disinkronkan ke Drive.\n`);
        
        if (validMedia.length === 0) return;
        
        // 4. Memproses dan Menyuntikkan Ulang ke Queue
        const insertStmt = db.prepare(`
            INSERT INTO drive_upload_queue
                (customer_id, media_id, file_url, storage_key, storage_type,
                 order_id, store_name, resi, product_abbr, sku,
                 photo_index, customer_phone, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        // Kamus untuk melacak nomor urut foto (photo_index) per pelanggan
        const photoIndexes = {};
        let countInserted = 0;
        
        // Gunakan Transaction agar penulisan Database sangat cepat dan aman
        db.transaction(() => {
            for (const item of validMedia) {
                // Kalkulasi Photo Index (1, 2, 3, dst per customer)
                if (!photoIndexes[item.customer_id]) {
                    photoIndexes[item.customer_id] = 1;
                } else {
                    photoIndexes[item.customer_id]++;
                }
                const photoIndex = photoIndexes[item.customer_id];

                // Parse detail pesanan untuk mencari Singkatan Produk & SKU
                let productAbbr = 'LAINNYA';
                let sku = '';
                try {
                    const detail = JSON.parse(item.order_detail || '[]');
                    const mainItem = detail.find(i => i.isPolaroid) || detail[0];
                    if (mainItem) {
                        productAbbr = mainItem.productAbbr || 'LAINNYA';
                        sku = mainItem.sku || '';
                    }
                } catch (e) { /* silent fallback jika JSON rusak */ }
                
                // Tentukan status awal
                const status = item.resi ? 'PENDING' : 'WAITING_RESI';

                // Eksekusi insert baris
                insertStmt.run(
                    item.customer_id,
                    item.media_id,
                    item.file_url,
                    item.storage_key,
                    item.storage_type,
                    null, // order_id
                    item.store_name,
                    item.resi,
                    productAbbr,
                    sku,
                    photoIndex,
                    item.phone_number,
                    status
                );
                
                countInserted++;
            }
        })();

        console.log(`🎉 BINGO! ${countInserted} foto sukses disuntikkan kembali ke Antrean Drive.`);
        console.log(`🤖 Pekerja otomatis (Worker) akan mendeteksinya dalam 30 detik.`);
        console.log(`\n(⚠️ PASTIKAN ISI GOOGLE DRIVE ANDA SUDAH DIHAPUS SECARA MANUAL AGAR TIDAK DOBEL)`);
        console.log('================================================================');

    } catch (err) {
        console.error(`\n❌ TERJADI KESALAHAN FATAL:`, err.message);
        console.error(err.stack);
    }
}

main();
