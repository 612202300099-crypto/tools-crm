
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../backend/.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function listRecentCustomers() {
  const { data: customers, error } = await supabase
    .from('customers')
    .select('phone_number, name, created_at')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error(error);
    return;
  }

  customers.forEach(c => {
    console.log(`[${c.created_at}] ${c.phone_number} | ${c.name}`);
  });
}

listRecentCustomers();
