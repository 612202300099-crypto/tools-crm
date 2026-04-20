const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function checkAfter19() {
    console.log("Checking messages after April 19, 19:00...");
    
    const startTime = '2026-04-19T19:00:00Z';
    const endTime = '2026-04-20T12:00:00Z';

    const { data: messages, error } = await supabase
        .from('messages')
        .select('created_at')
        .gte('created_at', startTime)
        .lte('created_at', endTime)
        .order('created_at', { ascending: true })
        .limit(2000);

    if (error) {
        console.error(error);
        return;
    }

    console.log(`Total messages found between 19th 19:00 and 20th 12:00: ${messages.length}`);
    
    if (messages.length > 0) {
        console.log(`First message: ${messages[0].created_at}`);
        console.log(`Last message: ${messages[messages.length-1].created_at}`);
        
        const hourly = {};
        messages.forEach(m => {
            const date = new Date(m.created_at);
            const key = `${date.getUTCDate()}nd ${date.getUTCHours()}:00`;
            hourly[key] = (hourly[key] || 0) + 1;
        });
        console.log("Hourly Breakdown:");
        Object.keys(hourly).sort().forEach(k => console.log(`  ${k} | ${hourly[k]} messages`));
    }
}

checkAfter19();
