const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../database.sqlite');
const db = new Database(dbPath, { readonly: true });

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function runSweep() {
    console.log('🧹 [MASS-SWEEP] Memulai penyisiran pesan untuk semua customer di database...');
    
    // Ambil semua customer yang ada di tabel local SQLite
    const customers = db.prepare('SELECT id, phone_number, name FROM customers').all();
    console.log(`🔍 [MASS-SWEEP] Ditemukan ${customers.length} customer di database lokal.`);

    let successCount = 0;
    let failedCount = 0;

    for (const [index, customer] of customers.entries()) {
        const url = 'http://localhost:3001/api/wa/resync';
        console.log(`[${index + 1}/${customers.length}] Mengirim perintah Gali Ulang untuk: ${customer.name} (${customer.phone_number})...`);
        
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    phone_number: customer.phone_number,
                    customer_id: customer.id
                })
            });

            if (response.ok) {
                successCount++;
            } else {
                console.error(`  ❌ Gagal memicu resync untuk ${customer.phone_number}. HTTP: ${response.status}`);
                failedCount++;
            }
        } catch (err) {
            console.error(`  ❌ Error koneksi ke lokal engine:`, err.message);
            failedCount++;
        }

        // Jeda 5 detik antar customer agar tidak membanjiri antrean Chrome DevTools
        await sleep(5000); 
    }

    console.log('\n🎉 [MASS-SWEEP] Selesai!');
    console.log(`✅ Berhasil diantrikan: ${successCount}`);
    console.log(`❌ Gagal: ${failedCount}`);
    console.log('Pesan-pesan lawas dari customer-customer tersebut sekarang sedang diproses di latar belakang oleh WA-Engine.');
}

runSweep().catch(e => console.error('Gagal menjalankan mass-sweep:', e));
