require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { convertHeicToJpg } = require('../utils/heicConverter');
const db = require('../db'); // Menggunakan database SQLite lokal

const PUBLIC_API_URL = process.env.PUBLIC_API_URL || 'https://api-wa.parecustom.com';

async function migratePastHeic() {
    console.log("=== MEMULAI MIGRASI DATA HEIC LAMA (LOCAL DB) ===");
    
    const uploadsDir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadsDir)) {
        console.error("Folder uploads tidak ditemukan!");
        return;
    }

    let hasMore = true;
    let offset = 0;
    const limit = 50;

    let totalSuccess = 0;
    let totalFail = 0;
    let totalNotFound = 0;

    while (hasMore) {
        console.log(`\n🔍 Fetching batch HEIC dari index ${offset}...`);
        
        // Query langsung ke SQLite
        const mediaFiles = db.prepare(`
            SELECT * FROM media 
            WHERE file_name LIKE '%.heic' OR file_name LIKE '%.HEIC'
            LIMIT ? OFFSET ?
        `).all(limit, offset);

        if (!mediaFiles || mediaFiles.length === 0) {
            hasMore = false;
            break;
        }

        for (const media of mediaFiles) {
            try {
                // 1. Temukan file lokal di VPS
                const oldFilePath = path.join(uploadsDir, media.file_name);
                
                if (!fs.existsSync(oldFilePath)) {
                    console.warn(`⚠️ File lokal tidak ditemukan (mungkin sudah dihapus/tertinggal di cloud): ${oldFilePath}`);
                    totalNotFound++;
                    continue;
                }

                console.log(`🔄 Mengkonversi: ${media.file_name} ...`);

                // 2. Baca file HEIC
                const heicBuffer = fs.readFileSync(oldFilePath);

                // 3. Konversi menggunakan Worker Thread (AMAN & NON-BLOCKING)
                const jpgBuffer = await convertHeicToJpg(heicBuffer);

                // 4. Siapkan nama file & path baru (.jpg)
                const newFileName = media.file_name.replace(/\.heic$/i, '.jpg');
                const newFilePath = path.join(uploadsDir, newFileName);

                // 5. Simpan file JPG ke disk
                fs.writeFileSync(newFilePath, jpgBuffer);

                // 6. Update database lokal SQLite
                const newLocalUrl = `${PUBLIC_API_URL}/uploads/${newFileName}`;
                try {
                    db.prepare(`UPDATE media SET file_name = ?, file_url = ? WHERE id = ?`).run(newFileName, newLocalUrl, media.id);
                } catch (updateError) {
                    throw new Error(`DB Update Error: ${updateError.message}`);
                }

                // 7. Hapus file HEIC lama (Hemat disk VPS)
                fs.unlinkSync(oldFilePath);

                totalSuccess++;
                console.log(`✅ Sukses: ${newFileName}`);
            } catch (err) {
                console.error(`❌ Gagal untuk file ${media.file_name}:`, err.message);
                totalFail++;
            }
        }

        offset += limit;
    }

    console.log("\n=========================================");
    console.log("MIGRASI HEIC LAMA SELESAI!");
    console.log(`✅ Berhasil Dikonversi : ${totalSuccess}`);
    console.log(`❓ File Hilang di Disk : ${totalNotFound}`);
    console.log(`❌ Gagal Dikonversi    : ${totalFail}`);
    console.log("=========================================");
    
    // Matikan process karena worker mungkin menahan event loop jika ada antrian yang belum tuntas, 
    // meski seharusnya sudah mati otomatis.
    process.exit(0);
}

migratePastHeic();
