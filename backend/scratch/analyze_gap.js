const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function analyzeGap() {
    console.log("Analyzing Gap between 2026-04-19 19:00 and 2026-04-20 08:30...");
    
    const startTime = '2026-04-19T19:00:00Z';
    const endTime = '2026-04-20T08:30:00Z';

    const { data: messages, error: msgError } = await supabase
        .from('messages')
        .select('created_at, body, customer_id')
        .gte('created_at', startTime)
        .lte('created_at', endTime)
        .order('created_at', { ascending: true });

    if (msgError) {
        console.error("Error fetching messages:", msgError);
        return;
    }

    console.log(`Found ${messages.length} messages in this range.`);
    
    if (messages.length > 0) {
        console.log("Last 5 messages before 19:20 on 19th:");
        const beforeGp = messages.filter(m => m.created_at < '2026-04-19T19:20:00Z');
        beforeGp.slice(-5).forEach(m => console.log(`  ${m.created_at} | ${m.body.substring(0, 30)}`));

        console.log("\nMessages during the gap (19:20 19th to 06:30 20th):");
        const duringGap = messages.filter(m => m.created_at >= '2026-04-19T19:20:00Z' && m.created_at < '2026-04-20T06:30:00Z');
        if (duringGap.length === 0) {
            console.log("  TOTAL SILENCE. No messages received.");
        } else {
            duringGap.forEach(m => console.log(`  ${m.created_at} | ${m.body.substring(0, 30)}`));
        }

        console.log("\nFirst 5 messages after 06:30 on 20th:");
        const afterGap = messages.filter(m => m.created_at >= '2026-04-20T06:30:00Z');
        afterGap.slice(0, 5).forEach(m => console.log(`  ${m.created_at} | ${m.body.substring(0, 30)}`));
    }
}

analyzeGap();
