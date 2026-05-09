const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../db');

async function main() {
    console.log('================================================================');
    console.log('🚀 MEMULAI OPERASI BEDAH DATABASE: PEMBERSIHAN URL LAMA');
    console.log('================================================================\n');

    const oldDomain = 'https://api-wa.parecustom.com';
    const newDomain = 'https://api.kirimfoto.com';

    console.log(`[INFO] Domain Lama : ${oldDomain}`);
    console.log(`[INFO] Domain Baru : ${newDomain}\n`);

    try {
        // 1. Periksa tabel media
        console.log(`🔍 Memeriksa tabel 'media'...`);
        const mediaWithOldUrl = db.prepare(`SELECT id, file_url FROM media WHERE file_url LIKE ?`).all(`%${oldDomain}%`);
        
        console.log(`📸 Menemukan ${mediaWithOldUrl.length} foto dengan URL lama di tabel media.`);
        
        if (mediaWithOldUrl.length > 0) {
            const updateMediaStmt = db.prepare(`UPDATE media SET file_url = ? WHERE id = ?`);
            let countMedia = 0;
            
            db.transaction(() => {
                for (const item of mediaWithOldUrl) {
                    const newUrl = item.file_url.replace(oldDomain, newDomain);
                    updateMediaStmt.run(newUrl, item.id);
                    countMedia++;
                }
            })();
            
            console.log(`✅ Sukses memperbarui ${countMedia} baris di tabel media.\n`);
        } else {
            console.log(`✅ Tabel media sudah bersih!\n`);
        }

        // 2. Periksa tabel drive_upload_queue
        console.log(`🔍 Memeriksa tabel 'drive_upload_queue'...`);
        const queueWithOldUrl = db.prepare(`SELECT id, file_url FROM drive_upload_queue WHERE file_url LIKE ?`).all(`%${oldDomain}%`);
        
        console.log(`📂 Menemukan ${queueWithOldUrl.length} antrean Drive dengan URL lama.`);
        
        if (queueWithOldUrl.length > 0) {
            const updateQueueStmt = db.prepare(`UPDATE drive_upload_queue SET file_url = ? WHERE id = ?`);
            let countQueue = 0;
            
            db.transaction(() => {
                for (const item of queueWithOldUrl) {
                    const newUrl = item.file_url.replace(oldDomain, newDomain);
                    updateQueueStmt.run(newUrl, item.id);
                    countQueue++;
                }
            })();
            
            console.log(`✅ Sukses memperbarui ${countQueue} baris di tabel drive_upload_queue.\n`);
        } else {
            console.log(`✅ Tabel drive_upload_queue sudah bersih!\n`);
        }

        console.log('================================================================');
        console.log('🎉 OPERASI SELESAI! SEMUA URL SUDAH SINKRON DENGAN DOMAIN BARU.');
        console.log('================================================================');

    } catch (err) {
        console.error(`\n❌ TERJADI KESALAHAN FATAL:`, err.message);
        console.error(err.stack);
    }
}

main();
