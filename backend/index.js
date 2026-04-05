require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(process.env.SUPABASE_URL, supabaseKey);

let qrCodeData = '';
let isConnected = false;

const client = new Client({
    authStrategy: new LocalAuth({ clientId: "crm-polaroid" }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu']
    }
});

// CORE ENGINE HANDLER (Diekstrak agar bisa dipakai untuk pesan masuk realtime & sinkronisasi tertinggal)
async function processMessageCommand(message) {
    try {
        if (message.from === 'status@broadcast' || message.isStatus) return;
        if (message.type === 'e2e_notification' || message.type === 'call_log' || message.type === 'protocol') return;
        
        const chat = await message.getChat();
        if (chat.isGroup) return; 
        
        const contact = await message.getContact();
        const phoneNumber = contact.number;

        let { data: customer, error: customerError } = await supabase
            .from('customers')
            .select('*')
            .eq('phone_number', phoneNumber)
            .single();

        if (!customer) {
            const { data: newCustomer, error: createError } = await supabase
                .from('customers')
                .insert({
                    phone_number: phoneNumber,
                    name: contact.pushname || 'Pelanggan Baru',
                    status: 'BELUM_KIRIM_FOTO'
                })
                .select()
                .single();

            if (createError) throw createError;
            customer = newCustomer;

            // Mode Siluman: Jangan balas pesan otomatis "Halo kak". Posisikan bot sebagai penyedot pasif.
        }

        // KODE PELACAK INTERNAL WA (SANGAT UNIK PER FOTO)
        const waMessageId = message.id._serialized;
        const msgTimestamp = new Date(message.timestamp * 1000).toISOString();

        // 0. ANTI-DUPLIKAT (Cek Kesamaan Kode KTP WA_ID Asli)
        let isDuplicate = false;
        let messageRecord = null;

        if (customer && customer.id) {
            const { data: duplicate } = await supabase
                .from('messages')
                .select('id')
                .eq('wa_id', waMessageId) 
                .limit(1);

            if (duplicate && duplicate.length > 0) {
                isDuplicate = true;
                messageRecord = duplicate[0];
            }
        }

        if (isDuplicate) {
            if (!message.hasMedia) return; // Abaikan 100% jika teks biasa.
            
            // Healing Media Jika RLS Kemarin Menghambat Fotonya.
            const { data: secureMedia } = await supabase
                .from('media')
                .select('id')
                .eq('message_id', messageRecord.id)
                .limit(1);
            
            if (secureMedia && secureMedia.length > 0) {
                 return; // Aman.
            }
            console.log('🩹 Menyembuhkan Media yang gagal Upload gara-gara RLS tempo hari...');
        } else {
            // Rekap pesan text / default yang benar-benar baru
            // FITUR BARU: Memaksa rekaman jangkar WA_ID di tabel messages!
            const { data: msgData, error: msgError } = await supabase
                .from('messages')
                .insert({
                    customer_id: customer.id,
                    wa_id: waMessageId,
                    body: message.body || '[Attachment Dokumen/Gambar]',
                    is_from_me: false,
                    created_at: msgTimestamp
                })
                .select()
                .single();
            if(!msgError) messageRecord = msgData;
        }

        if (message.hasMedia) {
            console.log(`📥 Mengunduh media dari ${phoneNumber}...`);
            const media = await message.downloadMedia();
            
            if (!media || !media.data) {
                console.log(`⚠️ Gambar Kadaluarsa/Gagal didownload dari server WA untuk ${phoneNumber}`);
                return;
            }

            if (media && media.data) {
                const buffer = Buffer.from(media.data, 'base64');
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                let fileExt = media.mimetype ? media.mimetype.split('/')[1] : 'jpg';
                if (fileExt && fileExt.includes(';')) fileExt = fileExt.split(';')[0];
                const ext = fileExt === 'jpeg' ? 'jpg' : fileExt; 
                
                const fileName = `${customer.id}/foto-${uniqueSuffix}.${ext}`;

                const { data: uploadData, error: uploadError } = await supabase.storage
                    .from('media')
                    .upload(fileName, buffer, {
                        contentType: media.mimetype || 'image/jpeg',
                        upsert: false
                    });

                if (uploadError) {
                    console.error('❌ GAGAL UPLOAD STORAGE:', uploadError.message);
                } else {
                    const { data: publicUrlData } = supabase.storage.from('media').getPublicUrl(fileName);
                    
                    await supabase
                        .from('media')
                        .insert({
                            customer_id: customer.id,
                            message_id: messageRecord ? messageRecord.id : null,
                            file_url: publicUrlData.publicUrl,
                            file_name: fileName,
                            created_at: msgTimestamp
                        });

                    if (customer.status === 'BELUM_KIRIM_FOTO') {
                        await supabase
                           .from('customers')
                           .update({ status: 'SUDAH_KIRIM_FOTO' })
                           .eq('id', customer.id);
                    }
                    console.log(`✅ Foto aman di database dari customer ${phoneNumber}`);
                }
            }
        }
    } catch (error) {
        console.error('Terjadi error memproses pesan (Skip):', error);
    }
}


client.on('qr', (qr) => {
    qrCodeData = qr;
    isConnected = false;
    console.log('New QR code generated - please scan');
});

client.on('ready', async () => {
    console.log('WhatsApp Client is ready!');
    qrCodeData = '';
    isConnected = true;

    // [KOREKSI FATAL 3]: FITUR SINKRONISASI 4 HARI TERAKHIR (Bukan cuma yang unread)
    try {
        console.log('🔄 Menyisir semua pesan dalam rentang 4 HARI TERAKHIR...');
        const chats = await client.getChats();
        
        // Buat batas waktu 4 hari ke belakang
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() - 4);
        const limitTimestamp = Math.floor(targetDate.getTime() / 1000);
        
        let processedCount = 0;
        for (const chat of chats) {
            if (!chat.isGroup) {
                // Tarik 1000 pesan terakhir dari setiap chat untuk mencegah media barbar yg tertinggal
                const historyMessages = await chat.fetchMessages({ limit: 1000 });
                // Proses satu persatu pesan masuk yg masih masuk rentang 4 hari
                for (const msg of historyMessages) {
                    if (!msg.fromMe && msg.timestamp >= limitTimestamp) {
                        processedCount++;
                        await processMessageCommand(msg);
                    }
                }
                // Tandai sudah dibaca di HP khusus yg masih ada badge hijaunya
                if (chat.unreadCount > 0) {
                    await chat.sendSeen();
                }
            }
        }
        console.log(`✅ Selesai menyisir dan menarik ${processedCount} pesan potensial dari 4 hari yang lalu.`);
    } catch (e) {
         console.error('⚠️ Gagal sinkronisasi pesan offline:', e);
    }
});

client.on('disconnected', (reason) => {
    console.log('WhatsApp Client disconnected:', reason);
    isConnected = false;
});

client.on('message', async (message) => {
    await processMessageCommand(message);
});

client.initialize();

// Endpoint status
app.get('/api/wa/status', (req, res) => {
    res.json({
        connected: isConnected,
        qr: qrCodeData 
    });
});

app.post('/api/wa/send', async (req, res) => {
    const { phone_number, message, customer_id } = req.body;
    if (!isConnected) return res.status(400).json({ error: 'WhatsApp is not connected' });
    
    try {
        const chatId = phone_number + '@c.us';
        await client.sendMessage(chatId, message);

        if (customer_id) {
           await supabase.from('messages').insert({
               customer_id: customer_id,
               body: message,
               is_from_me: true
           });
        }
        res.json({ success: true, message: 'Sent' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend WA Engine running on port ${PORT}`);
});
