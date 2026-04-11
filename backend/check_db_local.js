
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../backend/.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function checkCustomer() {
  const customerId = '557eef5c-cf51-4c31-9101-b7cb0987f030';
  const phoneNumber = '62895623102780';

  console.log(`Checking database for Customer ID: ${customerId} / Phone: ${phoneNumber}`);

  // 1. Check customer record
  const { data: customer, error: cError } = await supabase
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .single();
  
  if (cError) {
    console.error('Customer Error:', cError);
  } else {
    console.log('Customer Record:', customer);
  }

  // 2. Count messages
  const { count: msgCount, error: mError } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', customerId);

  console.log('Total Messages in DB:', msgCount);

  // 3. Count media
  const { count: mediaCount, error: mediaError } = await supabase
    .from('media')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', customerId);

  console.log('Total Media in DB:', mediaCount);

  // 4. List the media to see timestamps or filenames
  const { data: mediaList, error: listError } = await supabase
    .from('media')
    .select('id, created_at, file_name')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: true });

  if (mediaList) {
    console.log('Media List Examples (first 5):', mediaList.slice(0, 5));
    console.log('Media List Examples (last 5):', mediaList.slice(-5));
  }
}

checkCustomer();
