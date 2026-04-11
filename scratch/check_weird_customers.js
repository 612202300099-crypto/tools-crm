
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../backend/.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function checkWeirdCustomers() {
  const { data: customers, error } = await supabase
    .from('customers')
    .select('id, phone_number, name')
    .order('created_at', { ascending: false });

  if (error) {
    console.error(error);
    return;
  }

  console.log(`Total customers: ${customers.length}`);
  const weird = customers.filter(c => c.phone_number.includes(':') || c.phone_number.includes('@') || isNaN(c.phone_number.replace('+', '')));
  
  if (weird.length > 0) {
    console.log('Found weird customers:');
    weird.forEach(c => console.log(`- ID: ${c.id} | Phone: ${c.phone_number} | Name: ${c.name}`));
  } else {
    console.log('No weird customers found (with current filter).');
  }
}

checkWeirdCustomers();
