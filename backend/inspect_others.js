const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function inspectOthers() {
    const { data, error } = await supabase
        .from('media')
        .select('file_url')
        .limit(10000); // Fetch more to find patterns

    if (error) {
        console.error(error);
        return;
    }

    const samples = [];
    for (const m of data) {
        if (!m.file_url.includes('api-wa.parecustom.com') && !m.file_url.includes('supabase.co')) {
            samples.push(m.file_url);
            if (samples.length >= 10) break;
        }
    }

    console.log('Contoh URL yang tidak terdeteksi VPS atau Supabase:');
    console.log(samples);
}

inspectOthers();
