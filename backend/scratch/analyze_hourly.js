const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function analyzeHourly() {
    console.log("Analyzing message count per hour from 19th 12:00 to 20th 12:00...");
    
    const startTime = '2026-04-18T00:00:00Z';
    const endTime = '2026-04-20T23:59:59Z';

    const { data: messages, error } = await supabase
        .from('messages')
        .select('created_at')
        .gte('created_at', startTime)
        .lte('created_at', endTime);

    if (error) {
        console.error(error);
        return;
    }

    const counts = {};
    messages.forEach(m => {
        const date = new Date(m.created_at);
        const hourKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')} ${String(date.getUTCHours()).padStart(2, '0')}:00`;
        counts[hourKey] = (counts[hourKey] || 0) + 1;
    });

    const sortedKeys = Object.keys(counts).sort();
    sortedKeys.forEach(key => {
        console.log(`${key} | ${counts[key]} messages`);
    });
}

analyzeHourly();
