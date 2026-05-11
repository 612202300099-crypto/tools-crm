async function runGlobalSweep() {
    console.log('🧹 [GLOBAL-SWEEP] Memulai penyisiran massal (Mencari kontak yang terlewat)...');
    
    const url = 'http://localhost:3001/api/wa/global-sweep';
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await response.json();
        
        if (response.ok) {
            console.log(`✅ Sukses: ${data.message}`);
            console.log(`⚠️ Silakan pantau log PM2 (pm2 logs WA-Engine) untuk melihat proses ekstraksi foto secara realtime.`);
        } else {
            console.error(`❌ Gagal:`, data);
        }
    } catch (err) {
        console.error(`❌ Error koneksi ke lokal engine:`, err.message);
    }
}

runGlobalSweep().catch(e => console.error('Gagal menjalankan global-sweep:', e));
