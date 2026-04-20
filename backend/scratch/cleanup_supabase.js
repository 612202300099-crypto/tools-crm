const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function clearMediaBucket() {
    console.log("🧹 Memulai pembersihan Supabase Storage: Bucket 'media'...");
    
    // 1. List files in the bucket
    // Note: This only lists the first 1000. For 2.3GB, there might be more. We need to loop.
    const BUCKET_NAME = 'media';
    
    try {
        let hasMore = true;
        let totalDeleted = 0;

        while (hasMore) {
            const { data: files, error: listError } = await supabase
                .storage
                .from(BUCKET_NAME)
                .list('', { limit: 100 }); // Small batches to be safe

            if (listError) throw listError;
            if (!files || files.length === 0) {
                hasMore = false;
                break;
            }

            const filePaths = files.map(f => f.name);
            const { error: deleteError } = await supabase
                .storage
                .from(BUCKET_NAME)
                .remove(filePaths);

            if (deleteError) throw deleteError;

            totalDeleted += filePaths.length;
            console.log(`🗑️ Berhasil menghapus ${filePaths.length} file (Total: ${totalDeleted})...`);
            
            // If we got fewer than the limit, we are done
            if (files.length < 100) hasMore = false;
        }

        console.log(`✅ SELESAI: Total ${totalDeleted} file sampah berhasil dibersihkan dari Supabase.`);
        console.log(`ℹ️ Quota Supabase akan segera pulih dalam waktu ~1 jam (delay refresh dashboard).`);
    } catch (err) {
        console.error("❌ Gagal membersihkan storage:", err.message);
    }
}

clearMediaBucket();
