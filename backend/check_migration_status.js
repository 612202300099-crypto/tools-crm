const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function checkMedia() {
    const { data, error } = await supabase
        .from('media')
        .select('*')
        .limit(10);

    if (error) {
        console.error('Error fetching media:', error);
        return;
    }

    console.log('Sample Data from Media Table:');
    console.table(data.map(m => ({ id: m.id, file_url: m.file_url })));

    const updatedCount = data.filter(m => m.file_url.includes('api-wa.parecustom.com')).length;
    console.log(`\nUpdated in this sample: ${updatedCount}/10`);
}

checkMedia();
