require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(process.env.SUPABASE_URL, supabaseKey);

const PUBLIC_API_URL = process.env.PUBLIC_API_URL || 'https://api-wa.parecustom.com';

async function migrateData() {
    console.log("Memulai proses migrasi foto dari Supabase Cloud ke Lokal VPS...");

    // Siapkan folder root uploads
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir);
    }

    try {
        // Ambil semua media (Filter bisa ditambahkan, sementara kita cek semua jika belum pakai link lokal)
        const { data: mediaFiles, error } = await supabase.from('media').select('*');
        if (error) throw error;

        console.log(`Ditemukan total ${mediaFiles.length} file di database.`);

        let successCount = 0;
        let failCount = 0;
        let skippedCount = 0;

        for (let i = 0; i < mediaFiles.length; i++) {
            const media = mediaFiles[i];

            // Jika file sudah mengarah ke lokal, skip
            if (media.file_url && media.file_url.includes(PUBLIC_API_URL)) {
                skippedCount++;
                continue;
            }

            // Jika tidak ada URL foto yang valid, skip
            if (!media.file_url) {
                skippedCount++;
                continue;
            }

            console.log(`[${i + 1}/${mediaFiles.length}] Mendownload: ${media.file_name}`);
            try {
                // Proses penyimpanan fisik file (Buffer)
                const response = await fetch(media.file_url);
                if (!response.ok) {
                    throw new Error(`Failed to fetch ${media.file_url} - Status ${response.status}`);
                }

                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);

                // Ekstrak folder dari nama file (misal file_name = "xxx-customer-id/foto-xxx.jpg")
                const filePath = path.join(uploadsDir, media.file_name);
                const fileDir = path.dirname(filePath);

                if (!fs.existsSync(fileDir)) {
                    fs.mkdirSync(fileDir, { recursive: true });
                }

                fs.writeFileSync(filePath, buffer);

                // Update URL di Supabase agar frontend me-load dari Lokal
                const newLocalUrl = `${PUBLIC_API_URL}/uploads/${media.file_name}`;
                
                await supabase
                    .from('media')
                    .update({ file_url: newLocalUrl })
                    .eq('id', media.id);

                successCount++;
            } catch (err) {
                console.error(`❌ Gagal memigrasi ${media.file_name}:`, err.message);
                failCount++;
            }
        }

        console.log("=========================================");
        console.log("MIGRASI SELESAI!");
        console.log(`✅ Berhasil dipindah: ${successCount} foto`);
        console.log(`⏭️ Dilewati (Sudah lokal/Kosong): ${skippedCount} foto`);
        console.log(`❌ Gagal: ${failCount} foto`);
        console.log("=========================================");

    } catch (err) {
        console.error("Terjadi kesalahan fatal saat migrasi:", err);
    }
}

migrateData();
