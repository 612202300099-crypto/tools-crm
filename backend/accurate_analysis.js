const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function accurateAnalysis() {
    let totalVps = 0;
    let totalSupabase = 0;
    
    // Count VPS
    const { count: vpsCount, error: vpsError } = await supabase
        .from('media')
        .select('*', { count: 'exact', head: true })
        .ilike('file_url', '%api-wa.parecustom.com%');
    
    // Count Supabase
    const { count: supabaseCount, error: supabaseError } = await supabase
        .from('media')
        .select('*', { count: 'exact', head: true })
        .ilike('file_url', '%supabase.co%');

    // Total
    const { count: totalCount, error: totalError } = await supabase
        .from('media')
        .select('*', { count: 'exact', head: true });

    console.log(`--- ANALISA AKURAT (CEK SELURUH DATABASE) ---`);
    console.log(`Total Data Media di DB      : ${totalCount}`);
    console.log(`Sudah Aman di VPS           : ${vpsCount}`);
    console.log(`Masih Tertinggal di Supabase: ${supabaseCount}`);

    const progress = ((vpsCount / totalCount) * 100).toFixed(2);
    console.log(`Progress Migrasi            : ${progress}%`);

    if (supabaseCount === 0) {
        console.log(`\n✅ KESIMPULAN: SEMUA SUDAH PINDAH. Aman untuk hapus file di Supabase Storage.`);
    } else {
        console.log(`\n⚠️ PERINGATAN: JANGAN HAPUS DULU. Masih ada ${supabaseCount} foto yang belum terpindah.`);
        console.log(`Silakan jalankan kembali: node migrate_to_local.js di VPS Anda.`);
    }
}

accurateAnalysis();
