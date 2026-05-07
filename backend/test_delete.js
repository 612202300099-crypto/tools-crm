const { createClient } = require('@supabase/supabase-js');
const supabase = createClient('https://zvlrsnksgmvkbfajqdyk.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTMxODY1MywiZXhwIjoyMDkwODk0NjUzfQ.xCoGF88qYZwian01moHMH6QoxiXOtYaOs_WGZBnGVSw');

async function testDelete() {
    console.log("Checking if we can delete files to free up quota...");
    try {
        const { data: media, error: err1 } = await supabase.from('media').select('*').limit(500);
        if (err1) {
            console.log("Error selecting:", err1);
            return;
        }
        console.log(`Found ${media.length} media. Trying to delete 1...`);
        if (media.length === 0) return;
        
        const m = media[0];
        const filename = m.file_name;
        
        const { error: err2 } = await supabase.storage.from('media').remove([filename]);
        if (err2) {
            console.log("Error deleting from storage:", err2);
        } else {
            console.log(`Successfully deleted ${filename} from storage! Quota might be recoverable.`);
        }
    } catch(e) {
        console.log("Exception:", e);
    }
}
testDelete();
