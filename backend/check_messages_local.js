
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../backend/.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function checkMessages() {
  const customerId = '557eef5c-cf51-4c31-9101-b7cb0987f030';

  const { data: messages, error } = await supabase
    .from('messages')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error(error);
    return;
  }

  console.log(`Checking ${messages.length} messages for media placeholders...`);
  
  const placeholders = messages.filter(m => m.body.includes('[Attachment'));
  console.log(`Found ${placeholders.length} messages with [Attachment] body.`);

  for (const msg of messages) {
      console.log(`${msg.created_at} | ${msg.body.substring(0, 50)} | WA_ID: ${msg.wa_id ? 'YES' : 'NO'}`);
  }
}

checkMessages();
