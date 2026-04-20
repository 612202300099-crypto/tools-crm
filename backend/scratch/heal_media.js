const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function healMedia() {
    console.log("🩹 Starting Media Healing Script...");
    
    // 1. Cari media yang customer_id-nya null (Akibat bug sebelumnya)
    const { data: brokenMedia, error } = await supabase
        .from('media')
        .select('id, message_id')
        .is('customer_id', null);

    if (error) {
        console.error("❌ Gagal fetch broken media:", error);
        return;
    }

    console.log(`🔍 Ditemukan ${brokenMedia.length} record media yang rusak.`);

    let fixedCount = 0;
    for (const m of brokenMedia) {
        if (!m.message_id) continue;

        // 2. Cari customer_id dari tabel messages
        const { data: msg, error: msgError } = await supabase
            .from('messages')
            .select('customer_id')
            .eq('id', m.message_id)
            .single();

        if (msg && msg.customer_id) {
            // 3. Update media dengan customer_id yang benar
            const { error: updateError } = await supabase
                .from('media')
                .update({ customer_id: msg.customer_id })
                .eq('id', m.id);
            
            if (!updateError) {
                fixedCount++;
            }
        }
    }

    console.log(`✅ Healing Selesai. ${fixedCount} record berhasil diperbaiki.`);
}

healMedia();
