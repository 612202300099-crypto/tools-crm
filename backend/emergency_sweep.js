require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY);
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || 'https://api-wa.parecustom.com';

const client = new Client({
    authStrategy: new LocalAuth({ clientId: "crm-polaroid" }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

const withTimeout = (promise, ms, label) => {
    let timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`[TIMEOUT] ${label} (${ms/1000}s)`)), ms)
    );
    return Promise.race([promise, timeout]);
};

client.on('ready', async () => {
    console.log('🚀 Emergency Sweep Engine Ready!');
    
    try {
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() - 1); // 24 jam terakhir
        const limitTimestamp = Math.floor(targetDate.getTime() / 1000);

        console.log(`🔍 Mencari chat aktif sejak ${targetDate.toLocaleString()}...`);
        const chats = await client.getChats();
        
        let totalPhotosDownloaded = 0;

        for (const chat of chats) {
            if (chat.isGroup || chat.id.user === 'status' || chat.id.user === 'broadcast') continue;
            if (chat.lastMessage && chat.lastMessage.timestamp < limitTimestamp) continue;

            console.log(`\n---------------------------------------------------`);
            console.log(`📂 Menyisir Chat: ${chat.id.user} (${chat.name || 'No Name'})`);
            
            try {
                // Ambil 100 pesan terakhir untuk memastikan tidak ada yang terlewat dalam 24 jam
                const messages = await withTimeout(chat.fetchMessages({ limit: 100 }), 60000, 'fetchMessages');
                
                // Cari info customer di DB
                const { data: customer } = await supabase.from('customers').select('id, phone_number').eq('phone_number', chat.id.user).single();
                if (!customer) {
                    console.log(`   ⚠️ Customer belum terdaftar di DB (Skip).`);
                    continue;
                }

                let chatMediaCount = 0;

                for (const msg of messages) {
                    if (msg.timestamp >= limitTimestamp && msg.hasMedia) {
                        // Cek apakah media ini sudah ada di DB
                        const { data: existingMedia } = await supabase.from('media').select('id').eq('message_id', msg.id._serialized).limit(1);
                        
                        if (existingMedia && existingMedia.length > 0) {
                            // console.log(`   ✅ Media ${msg.id.id} sudah ada.`);
                            continue;
                        }

                        console.log(`   📥 Mendownload media baru: ${msg.id.id}...`);
                        try {
                            const media = await withTimeout(msg.downloadMedia(), 45000, 'downloadMedia');
                            if (!media || !media.data) throw new Error('Data kosong');

                            const buffer = Buffer.from(media.data, 'base64');
                            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E6);
                            let fileExt = (media.mimetype || 'image/jpeg').split('/')[1].split(';')[0];
                            const ext = fileExt === 'jpeg' ? 'jpg' : fileExt; 
                            
                            const fileName = `${customer.id}/foto-${uniqueSuffix}.${ext}`;
                            const uploadsDir = path.join(__dirname, 'uploads', customer.id.toString());
                            if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
                            
                            const filePath = path.join(__dirname, 'uploads', fileName);
                            fs.writeFileSync(filePath, buffer);

                            const publicUrl = `${PUBLIC_API_URL}/uploads/${fileName}`;

                            // Hubungkan ke tabel messages (Pastikan message record ada)
                            let { data: msgRecord } = await supabase.from('messages').select('id').eq('wa_id', msg.id._serialized).single();
                            
                            if (!msgRecord) {
                                // Jika message record belum ada, buat dulu
                                const { data: newMsg } = await supabase.from('messages').insert({
                                    customer_id: customer.id,
                                    wa_id: msg.id._serialized,
                                    message_hash: msg.id.id,
                                    body: '[Attachment]',
                                    is_from_me: msg.fromMe,
                                    created_at: new Date(msg.timestamp * 1000).toISOString()
                                }).select().single();
                                msgRecord = newMsg;
                            }

                            if (msgRecord) {
                                await supabase.from('media').insert({
                                    customer_id: customer.id,
                                    message_id: msgRecord.id,
                                    file_url: publicUrl,
                                    file_name: fileName,
                                    created_at: new Date(msg.timestamp * 1000).toISOString()
                                });
                                
                                await supabase.from('customers').update({ status: 'SUDAH_KIRIM_FOTO' }).eq('id', customer.id);
                                console.log(`   ✅ BERHASIL! Foto tersimpan.`);
                                totalPhotosDownloaded++;
                            }

                        } catch (mediaErr) {
                            console.error(`   ❌ Gagal download: ${mediaErr.message}`);
                        }
                    }
                }
            } catch (chatErr) {
                console.error(`   ❌ Gagal akses chat: ${chatErr.message}`);
            }
        }

        console.log(`\n\n===================================================`);
        console.log(`🏁 SELESAI! Berhasil memulihkan ${totalPhotosDownloaded} foto.`);
        console.log(`===================================================`);
        process.exit(0);

    } catch (err) {
        console.error('💥 ERROR FATAL:', err.message);
        process.exit(1);
    }
});

client.initialize();
