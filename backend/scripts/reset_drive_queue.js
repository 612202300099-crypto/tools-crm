const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../db');

async function main() {
    console.log('================================================================');
    console.log('🚀 MEMULAI PROSES RESET SINKRONISASI GOOGLE DRIVE');
    console.log('================================================================\n');

    // 1. Kalkulasi Threshold Waktu
    // "Kemarin mulai dari jam 12 siang" (Waktu Lokal / WIB)
    const now = new Date();
    const thresholdDate = new Date(now);
    thresholdDate.setDate(now.getDate() - 1); // Kemarin
    thresholdDate.setHours(12, 0, 0, 0); // Jam 12:00:00 lokal

    // Karena SQLite menyimpan waktu dalam UTC, kita gunakan toISOString() 
    // agar perbandingan berjalan persis sama dengan SQLite CURRENT_TIMESTAMP.
    const thresholdUTC = thresholdDate.toISOString();
    
    console.log(`⏰ Filter Waktu Aktif:`);
    console.log(`   - Waktu Lokal (WIB) : ${thresholdDate.toLocaleString('id-ID')}`);
    console.log(`   - Waktu UTC Basis   : ${thresholdUTC}\n`);

    try {
        // 2. Bersihkan Antrean Lama (Mulai dari Nol)
        console.log(`🧹 Mengosongkan tabel antrean 'drive_upload_queue' secara total...`);
        db.prepare(`DELETE FROM drive_upload_queue`).run();
        // Reset auto increment agar mulai dari ID 1
        db.prepare(`DELETE FROM sqlite_sequence WHERE name='drive_upload_queue'`).run();
        console.log(`✅ Antrean lama berhasil dimusnahkan!\n`);

        // 3. Tarik data Media yang valid berdasarkan filter waktu
        console.log(`🔍 Menyisir foto pelanggan setelah ${thresholdDate.toLocaleString('id-ID')}...`);
        
        // Tarik data dengan JOIN untuk mendapatkan info lengkap
        const query = `
            SELECT 
                m.id as media_id,
                m.customer_id,
                m.file_url,
                m.storage_key,
                m.storage_type,
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
        
        const validMedia = db.prepare(query).all(thresholdUTC);
        
        if (validMedia.length === 0) {
            console.log(`⚠️ Tidak ada foto satupun yang ditemukan setelah batas waktu tersebut.`);
            console.log(`================================================================`);
            return;
        }

        console.log(`📸 Berhasil menyaring ${validMedia.length} foto valid untuk disinkronkan.\n`);
        
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
