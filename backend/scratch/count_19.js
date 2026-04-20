const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function countApril19() {
    console.log("Counting messages for April 19, 2026...");
    
    const startTime = '2026-04-19T00:00:00Z';
    const endTime = '2026-04-19T23:59:59Z';

    const { data: messages, error } = await supabase
        .from('messages')
        .select('created_at')
        .gte('created_at', startTime)
        .lte('created_at', endTime);

    if (error) {
        console.error(error);
        return;
    }

    console.log(`Total messages on April 19: ${messages.length}`);
    
    const hourly = {};
    messages.forEach(m => {
        const hour = new Date(m.created_at).getUTCHours();
        hourly[hour] = (hourly[hour] || 0) + 1;
    });

    for(let i=0; i<24; i++) {
        if (hourly[i]) {
            console.log(`Hour ${String(i).padStart(2, '0')}:00 | ${hourly[i]} messages`);
        }
    }
}

countApril19();
