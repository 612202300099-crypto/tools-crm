
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../backend/.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function checkLidNumbers() {
  const { data: customers, error } = await supabase
    .from('customers')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) {
    console.error(error);
    return;
  }

  console.log("Recent 30 customers inserted:");
  customers.forEach(c => {
    console.log(`[${c.created_at}] ID: ${c.id} | Phone: ${c.phone_number} | Name: ${c.name}`);
  });
}

checkLidNumbers();
