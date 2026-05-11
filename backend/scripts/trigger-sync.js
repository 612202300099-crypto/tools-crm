/**
 * trigger-sync.js
 * Jalankan langsung di VPS: node backend/scripts/trigger-sync.js [days]
 * Contoh: node backend/scripts/trigger-sync.js 4
 * 
 * Script ini menghasilkan JWT Token secara otomatis dan memanggil
 * endpoint emergency-mass-sync tanpa perlu curl yang rumit.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const http = require('http');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'crm-super-secret-key-2026';
const PORT = process.env.PORT || 3001;
const DAYS = parseInt(process.argv[2]) || 4;

// Generate JWT Token yang valid (sama seperti admin login)
const token = jwt.sign(
    { id: 1, email: process.env.ADMIN_EMAIL || 'admin@polaroid.com', role: 'admin' },
    JWT_SECRET,
    { expiresIn: '2h' }
);

console.log(`\n🚨 ========================================`);
console.log(`🚨  EMERGENCY MASS SYNC DIMULAI`);
console.log(`🚨  Menyisir ${DAYS} hari terakhir...`);
console.log(`🚨 ========================================\n`);

const body = JSON.stringify({ days: DAYS });

const options = {
    hostname: 'localhost',
    port: PORT,
    path: '/api/local/emergency-mass-sync',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body)
    }
};

const req = http.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        if (res.statusCode === 200) {
            try {
                const parsed = JSON.parse(data);
                console.log(`✅ BERHASIL DIPICU! Server menjawab:`);
                console.log(`   ${parsed.message || JSON.stringify(parsed)}`);
                console.log(`\n📋 Pantau progres dengan perintah:`);
                console.log(`   pm2 logs WA-Engine --lines 100\n`);
            } catch (e) {
                console.log(`✅ Respons server:`, data);
            }
        } else {
            console.error(`❌ Gagal! HTTP ${res.statusCode}: ${data}`);
            console.error(`\n💡 Pastikan WA-Engine sedang berjalan: pm2 status`);
        }
    });
});

req.on('error', (e) => {
    console.error(`\n❌ Tidak dapat terhubung ke server!`);
    console.error(`   Error: ${e.message}`);
    console.error(`\n💡 Pastikan WA-Engine berjalan di port ${PORT}: pm2 status\n`);
});

req.write(body);
req.end();
