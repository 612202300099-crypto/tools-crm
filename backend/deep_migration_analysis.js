const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function deepAnalysis() {
    const { data, error, count } = await supabase
        .from('media')
        .select('file_url', { count: 'exact' });

    if (error) {
        console.error('Error fetching media:', error);
        return;
    }

    const total = count;
    const vpsCount = data.filter(m => m.file_url.includes('api-wa.parecustom.com')).length;
    const supabaseCount = data.filter(m => m.file_url.includes('supabase.co')).length;
    const missingCount = total - vpsCount - supabaseCount;

    console.log(`--- HASIL ANALISA MENDALAM ---`);
    console.log(`Total Semua Record Media : ${total}`);
    console.log(`Sudah di Terpindah ke VPS : ${vpsCount}`);
    console.log(`Masih di Supabase Storage: ${supabaseCount}`);
    console.log(`Lain-lain/Broken            : ${missingCount}`);
    
    if (supabaseCount === 0) {
        console.log(`\n✅ KESIMPULAN: Seluruh data sudah 100% pindah ke VPS.`);
    } else {
        console.log(`\n⚠️ PERINGATAN: Masih ada ${supabaseCount} data di Supabase yang belum pindah.`);
    }
}

deepAnalysis();
