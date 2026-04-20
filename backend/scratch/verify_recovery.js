const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function verifyRecovery() {
    console.log("Verifying messages in the gap period: 19th 19:00 to 20th 07:00 WIB...");
    
    // Konversi WIB ke UTC untuk query
    const startTime = '2026-04-19T12:00:00Z'; // 19:00 WIB
    const endTime = '2026-04-20T00:00:00Z';   // 07:00 WIB

    const { data: messages, error } = await supabase
        .from('messages')
        .select('id, created_at, customer_id, body, is_deleted')
        .gte('created_at', startTime)
        .lte('created_at', endTime)
        .order('created_at', { ascending: true });

    if (error) {
        console.error(error);
        return;
    }

    console.log(`Found ${messages.length} messages in DB for this range.`);
    
    if (messages.length > 0) {
        // Ambil info customer untuk 5 pesan pertama
        const firstFew = messages.slice(0, 10);
        for (const m of firstFew) {
            const { data: cust } = await supabase.from('customers').select('phone_number, name').eq('id', m.customer_id).single();
            console.log(`- ${m.created_at} | Cust: ${cust ? cust.phone_number : 'MISSING'} (${cust ? cust.name : '?'}) | Body: ${m.body.substring(0, 20)} | Deleted: ${m.is_deleted}`);
        }
    } else {
        console.log("CRITICAL: No messages found in DB for this range. Resync failed to insert.");
    }
}

verifyRecovery();
