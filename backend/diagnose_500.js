/**
 * Emergency Diagnostic Script - Supabase 500 Error
 * Uses the local backend's supabase-js dependency
 */
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://zvlrsnksgmvkbfajqdyk.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp2bHJzbmtzZ212a2JmYWpxZHlrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzMTg2NTMsImV4cCI6MjA5MDg5NDY1M30.Ie1Y29IphExr_d8dmzD_ANIHHMfjeL2JTde_TjaEh0s';

const supabase = createClient(supabaseUrl, supabaseKey);

async function diagnose() {
    console.log('=== EMERGENCY SUPABASE DIAGNOSTIC ===');
    console.log(`Time: ${new Date().toISOString()}\n`);

    // Test 1: Basic connectivity
    console.log('--- TEST 1: Basic SELECT (no joins) ---');
    try {
        const { data, error, status } = await supabase
            .from('customers')
            .select('id, phone_number, name')
            .limit(5);
        if (error) {
            console.log(`❌ FAILED: Status ${status}, Error: ${JSON.stringify(error)}`);
        } else {
            console.log(`✅ OK: Got ${data?.length} rows`);
            if (data?.length > 0) console.log('   Sample:', JSON.stringify(data[0]));
        }
    } catch (e) {
        console.log(`❌ EXCEPTION: ${e.message}`);
    }

    // Test 2: THE FAILING QUERY with media(count)
    console.log('\n--- TEST 2: SELECT with media:media(count) - THE FAILING QUERY ---');
    try {
        const { data, error, status } = await supabase
            .from('customers')
            .select('id, phone_number, name, order_id, status, is_valid, created_at, media:media(count)')
            .order('created_at', { ascending: false })
            .limit(1000);
        if (error) {
            console.log(`❌ FAILED: Status ${status}`);
            console.log(`   Error code: ${error.code}`);
            console.log(`   Error message: ${error.message}`);
            console.log(`   Error details: ${error.details}`);
            console.log(`   Error hint: ${error.hint}`);
        } else {
            console.log(`✅ OK: Got ${data?.length} rows`);
        }
    } catch (e) {
        console.log(`❌ EXCEPTION: ${e.message}`);
    }

    // Test 3: Media table direct
    console.log('\n--- TEST 3: Media table direct access ---');
    try {
        const { data, error } = await supabase.from('media').select('id, customer_id').limit(5);
        if (error) console.log(`❌ FAILED: ${JSON.stringify(error)}`);
        else console.log(`✅ OK: Got ${data?.length} rows`);
    } catch (e) {
        console.log(`❌ EXCEPTION: ${e.message}`);
    }

    // Test 4: Customer count
    console.log('\n--- TEST 4: Customer count ---');
    try {
        const { count, error } = await supabase.from('customers').select('*', { count: 'exact', head: true });
        if (error) console.log(`❌ FAILED: ${JSON.stringify(error)}`);
        else console.log(`✅ Total customers in DB: ${count}`);
    } catch (e) {
        console.log(`❌ EXCEPTION: ${e.message}`);
    }

    // Test 5: Media count
    console.log('\n--- TEST 5: Media count ---');
    try {
        const { count, error } = await supabase.from('media').select('*', { count: 'exact', head: true });
        if (error) console.log(`❌ FAILED: ${JSON.stringify(error)}`);
        else console.log(`✅ Total media in DB: ${count}`);
    } catch (e) {
        console.log(`❌ EXCEPTION: ${e.message}`);
    }

    // Test 6: Relationship without alias
    console.log('\n--- TEST 6: Relationship without alias ---');
    try {
        const { data, error, status } = await supabase
            .from('customers')
            .select('id, media(count)')
            .limit(5);
        if (error) {
            console.log(`❌ FAILED: Status ${status}, Error: ${JSON.stringify(error)}`);
        } else {
            console.log(`✅ OK: Got ${data?.length} rows`);
            if (data?.length > 0) console.log('   Sample:', JSON.stringify(data[0]));
        }
    } catch (e) {
        console.log(`❌ EXCEPTION: ${e.message}`);
    }

    // Test 7: Direct REST call - the exact failing URL
    console.log('\n--- TEST 7: Direct REST API (exact failing URL) ---');
    try {
        const response = await fetch(`${supabaseUrl}/rest/v1/customers?select=id,phone_number,name,order_id,status,is_valid,created_at,media:media(count)&order=created_at.desc&limit=1000`, {
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
            }
        });
        console.log(`   HTTP Status: ${response.status} ${response.statusText}`);
        const body = await response.text();
        console.log(`   Response (first 500): ${body.substring(0, 500)}`);
    } catch (e) {
        console.log(`❌ EXCEPTION: ${e.message}`);
    }

    // Test 8: Direct REST - simple query
    console.log('\n--- TEST 8: Direct REST API (simple query) ---');
    try {
        const response = await fetch(`${supabaseUrl}/rest/v1/customers?select=id,name&limit=5`, {
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
            }
        });
        console.log(`   HTTP Status: ${response.status} ${response.statusText}`);
        const body = await response.text();
        console.log(`   Response (first 500): ${body.substring(0, 500)}`);
    } catch (e) {
        console.log(`❌ EXCEPTION: ${e.message}`);
    }

    // Test 9: Check Supabase project health
    console.log('\n--- TEST 9: Supabase Health Check ---');
    try {
        const response = await fetch(`${supabaseUrl}/rest/v1/`, {
            headers: {
                'apikey': supabaseKey,
            }
        });
        console.log(`   Health Status: ${response.status} ${response.statusText}`);
    } catch (e) {
        console.log(`❌ EXCEPTION: ${e.message}`);
    }

    console.log('\n=== DIAGNOSTIC COMPLETE ===');
}

diagnose().catch(console.error);
