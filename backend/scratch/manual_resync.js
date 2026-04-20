const { Client, LocalAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

dotenv.config({ path: path.join(__dirname, '../.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Penyesuaian Waktu (WIB ke UTC)
// Target Gap: 19 April 19:00 WIB s/d 20 April 07:00 WIB
const START_WIB = new Date('2026-04-19T19:00:00+07:00');
const END_WIB = new Date('2026-04-20T07:00:00+07:00');

const START_TS = Math.floor(START_WIB.getTime() / 1000);
const END_TS = Math.floor(END_WIB.getTime() / 1000);

console.log(`[RESYNC] Target Range: ${START_WIB.toLocaleString()} - ${END_WIB.toLocaleString()}`);

const client = new Client({
    authStrategy: new LocalAuth({ clientId: "crm-polaroid" }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('Scan QR if needed (should be authenticated already)');
});

client.on('ready', async () => {
    console.log('Client is ready for resync!');

    try {
        const chats = await client.getChats();
        console.log(`Analyzing ${chats.length} chats...`);

        let totalRecovered = 0;

        for (const chat of chats) {
            if (chat.isGroup || chat.id.user === 'status') continue;

            // Optimasi: Hanya cek chat yang punya aktifitas belakangan ini
            if (chat.lastMessage && chat.lastMessage.timestamp < START_TS) {
                continue;
            }

            console.log(`Checking chat: ${chat.id.user}...`);
            
            try {
                // Ambil history yang lebih banyak (100 pesan) untuk memastikan range tertutup
                const messages = await chat.fetchMessages({ limit: 100 });
                const filtered = messages.filter(m => m.timestamp >= START_Ts && m.timestamp <= END_TS);

                if (filtered.length > 0) {
                    console.log(`  Found ${filtered.length} messages to recover.`);
                    // Kita bisa memanggil API internal atau mensimulasikan processMessageCommand
                    // Karena script ini jalan mandiri, kita perlu memanggil logic yang mirip dengan index.js
                    // Tapi untuk efisiensi, user bisa juga memakai endpoint /api/wa/resync di UI 
                    // Namun di sini kita lakukan otomatis.
                    
                    // Kita akan kirim pesan-pesan ini ke sebuah "Temporary Processing" endpoint atau langsung ke logic
                    // Untuk amannya, kita cetak saja dulu atau panggil processMessageCommand jika kita import
                    totalRecovered += filtered.length;
                }
            } catch (err) {
                console.error(`  Error fetching ${chat.id.user}:`, err.message);
            }
            
            await new Promise(r => setTimeout(r, 1000)); // Jeda antar chat
        }

        console.log(`\nDONE! Found ${totalRecovered} messages in total that might be missing.`);
        console.log("Tip: Run this logic inside index.js to use the existing database processing functions.");
        
        process.exit(0);
    } catch (err) {
        console.error('Fatal error during resync:', err);
        process.exit(1);
    }
});

client.initialize();
