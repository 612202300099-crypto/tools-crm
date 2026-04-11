const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function researchSchema() {
    console.log("Checking Customers Status values...");
    const { data: statusSamples } = await supabase.from('customers').select('status').limit(100);
    const uniqueStatuses = [...new Set(statusSamples.map(s => s.status))];
    console.log("Existing Statuses in DB:", uniqueStatuses);

    console.log("\nChecking Media table created_at format...");
    const { data: mediaSample } = await supabase.from('media').select('created_at').limit(1);
    console.log("Sample Timestamp:", mediaSample[0]?.created_at);
}

researchSchema();
