require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(process.env.SUPABASE_URL, supabaseKey);

const PUBLIC_API_URL = process.env.PUBLIC_API_URL || 'https://api-wa.parecustom.com';

async function migrateAllData() {
    console.log("=== MEMULAI MIGRASI MASSAL (SUPPORT 14.000+ DATA) ===");
    
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

    let hasMore = true;
    let offset = 0;
    const limit = 100; // Proses per 100 agar aman & stabil

    let totalSuccess = 0;
    let totalFail = 0;
    let totalSkipped = 0;

    while (hasMore) {
        console.log(`\nFetching data dari index ${offset}...`);
        
        const { data: mediaFiles, error } = await supabase
            .from('media')
            .select('*')
            // HANYA memigrasi data pembuatan tanggal 8 April 2026 jam 00:01 ke atas (WIB = 7 April 17:01 UTC)
            .gte('created_at', '2026-04-07T17:01:00Z')
            .range(offset, offset + limit - 1);

        if (error) {
            console.error("Gagal mengambil data:", error.message);
            break;
        }

        if (!mediaFiles || mediaFiles.length === 0) {
            hasMore = false;
            break;
        }

        for (const media of mediaFiles) {
            // Skip jika sudah lokal
            if (media.file_url && media.file_url.includes('api-wa.parecustom.com')) {
                totalSkipped++;
                continue;
            }

            if (!media.file_url || !media.file_url.includes('supabase.co')) {
                totalSkipped++;
                continue;
            }

            try {
                const response = await fetch(media.file_url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                const buffer = Buffer.from(await response.arrayBuffer());
                
                const filePath = path.join(uploadsDir, media.file_name);
                const fileDir = path.dirname(filePath);
                if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });

                fs.writeFileSync(filePath, buffer);

                // Update URL di DB
                const newLocalUrl = `${PUBLIC_API_URL}/uploads/${media.file_name}`;
                await supabase.from('media').update({ file_url: newLocalUrl }).eq('id', media.id);
                
                totalSuccess++;
                process.stdout.write(`.` ); // Indikator titik agar tidak sepi
            } catch (err) {
                console.error(`\n❌ Gagal: ${media.file_name} -> ${err.message}`);
                totalFail++;
            }
        }

        console.log(`\nBerhasil memproses batch ini. (Total Sukses: ${totalSuccess})`);
        offset += limit;
    }

    console.log("\n=========================================");
    console.log("MIGRASI MASSAL SELESAI!");
    console.log(`✅ Total Pindah : ${totalSuccess}`);
    console.log(`⏭️ Total Skip   : ${totalSkipped}`);
    console.log(`❌ Total Gagal  : ${totalFail}`);
    console.log("=========================================");
}

migrateAllData();
