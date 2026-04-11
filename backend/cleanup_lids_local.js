
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../backend/.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function cleanUpBadLids() {
  const { data: customers, error } = await supabase
    .from('customers')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error(error);
    return;
  }

  const badLids = customers.filter(c => c.phone_number.length >= 14 && !c.phone_number.startsWith('62895623102780')); 
  // keeping the one specific from before (the one with 14 digits that the user mentioned was valid, 62895623102780 - wait is that 14 digits? 62 895 6231 02780 is 14 digits)
  // Let's just filter for phone numbers that do NOT start with 62 or 08! Real IDs start with 62 or 08 in Indonesia.
  
  const reallyBadLids = customers.filter(c => !c.phone_number.startsWith('62') && !c.phone_number.startsWith('08') && !c.phone_number.startsWith('+62'));

  console.log("Deleting these bad customer records:");
  for (const c of reallyBadLids) {
    console.log(`Deleting ID: ${c.id} | Phone: ${c.phone_number} | Name: ${c.name}`);
    await supabase.from('media').delete().eq('customer_id', c.id);
    await supabase.from('messages').delete().eq('customer_id', c.id);
    await supabase.from('customers').delete().eq('id', c.id);
  }
}

cleanUpBadLids();
