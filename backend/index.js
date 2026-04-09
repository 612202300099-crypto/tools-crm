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
async function processMessageCommand(message, skipCustomerUpdate = false) {
    try {
        if (message.from === 'status@broadcast' || message.isStatus) return;
        if (message.type === 'e2e_notification' || message.type === 'call_log' || message.type === 'protocol') return;
        
        const chat = await message.getChat();
        if (chat.isGroup) return; 

        // PENENTUAN NOMOR HP CUSTOMER (Bukan pengirim, tapi lawan bicaranya)
        const isFromMe = message.fromMe;
        const rawId = isFromMe ? message.to : message.from;

        // Anti error Multi-device (:1) dan ID baru (@lid)
        const customerPhoneNumber = rawId.split('@')[0].split(':')[0];
        
        // Filter: Hanya proses nomor HP murni (digit), abaikan status, group, dll.
        if (!/^\d+$/.test(customerPhoneNumber) || customerPhoneNumber.length < 5) return;

        let { data: customer, error: customerError } = await supabase
            .from('customers')
            .select('*')
            .eq('phone_number', customerPhoneNumber)
            .single();

        if (!customer) {
            let contactName = 'Pelanggan Baru';
            try {
                const contact = await message.getContact();
                if (contact && contact.pushname) contactName = contact.pushname;
            } catch (pErr) {
                console.error('⚠️ Gagal mengambil nama kontak (WWebJS Error), menggunakan default.');
            }

            const { data: newCustomer, error: createError } = await supabase
                .from('customers')
                .insert({
                    phone_number: customerPhoneNumber,
                    name: (isFromMe ? 'Pelanggan Baru' : contactName),
                    status: 'BELUM_KIRIM_FOTO'
                })
                .select()
                .single();

            if (createError) {
                if (createError.code === '23505') {
                    const { data: existing } = await supabase.from('customers').select('*').eq('phone_number', customerPhoneNumber).single();
                    customer = existing;
                } else {
                    throw createError;
                }
            } else {
                customer = newCustomer;
            }
        } else if (!skipCustomerUpdate) {
            // Pelanggan sudah ada — sundul ke atas di Inbox (Hanya jika bukan saat resync massal)
            await supabase.from('customers').update({ created_at: new Date().toISOString() }).eq('id', customer.id);
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
            if (!message.hasMedia) return; 
            
            // HEALING MODE: Cek apakah media sudah benar-benar ada di tabel media?
            const { data: secureMedia } = await supabase
                .from('media')
                .select('id')
                .eq('message_id', messageRecord.id)
                .limit(1);
            
            if (secureMedia && secureMedia.length > 0) {
                 return; // Sudah lengkap, skip.
            }
            console.log(`🩹 HEALING: Menambal media yang hilang untuk pesan ${waMessageId}`);
        } else {
            const { data: msgData, error: msgError } = await supabase
                .from('messages')
                .insert({
                    customer_id: customer.id,
                    wa_id: waMessageId,
                    body: message.body || (message.hasMedia ? '[Attachment Dokumen/Gambar]' : ''),
                    is_from_me: isFromMe,
                    created_at: msgTimestamp
                })
                .select()
                .single();
            if(!msgError) messageRecord = msgData;
        }

        if (message.hasMedia) {
            console.log(`📥 Mengunduh media dari ${customerPhoneNumber}...`);
            const media = await message.downloadMedia();
            
            if (!media || !media.data) {
                console.log(`⚠️ Gambar Kadaluarsa/Gagal didownload dari server WA untuk ${customerPhoneNumber}`);
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
                    console.log(`✅ Foto aman di database dari customer ${customerPhoneNumber}`);
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

    // [STARTUP SYNC]
    try {
        console.log('🔄 Menyisir pesan tertinggal dalam rentang 1 HARI TERAKHIR (limit 1000/chat)...');
        const chats = await client.getChats();
        
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() - 1);
        const limitTimestamp = Math.floor(targetDate.getTime() / 1000);
        
        let processedCount = 0;
        for (const chat of chats) {
            if (!chat.isGroup) {
                const historyMessages = await chat.fetchMessages({ limit: 1000 });
                for (const msg of historyMessages) {
                    if (msg.timestamp >= limitTimestamp) {
                        processedCount++;
                        await processMessageCommand(msg, true);
                    }
                }
            }
        }
        console.log(`✅ Selesai menyisir ${processedCount} pesan tertinggal.`);
    } catch (e) {
         console.error('⚠️ Gagal sinkronisasi pesan offline:', e);
    }
});

client.on('disconnected', (reason) => {
    console.log('WhatsApp Client disconnected:', reason);
    isConnected = false;
});

// Gunakan message_create agar menangkap pesan dari kita juga (yang dikirim lewat HP)
client.on('message_create', async (message) => {
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
           const { error: insErr } = await supabase.from('messages').insert({
               customer_id: customer_id,
               body: message,
               is_from_me: true,
               created_at: new Date().toISOString()
           });

           if (!insErr) {
               await supabase.from('customers').update({ created_at: new Date().toISOString() }).eq('id', customer_id);
           }
        }
        res.json({ success: true, message: 'Sent' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/wa/resync', async (req, res) => {
    const { phone_number, customer_id } = req.body;
    if (!isConnected) return res.status(400).json({ error: 'WhatsApp is not connected' });
    
    try {
        const chatId = phone_number + '@c.us';
        const chat = await client.getChatById(chatId);
        
        console.log(`[RESYNC - SAFE MODE] Memulai penyisiran ulang history untuk: ${phone_number}`);
        // KOREKSI: Kita TIDAK LAGI MENGHAPUS data lama. 
        // Logika processMessageCommand sudah otomatis melakukan 'Healing' (menambah yang kurang, skip yang sudah ada).
        // Ini mencegah resiko chat hilang jika koneksi terputus di tengah jalan.

        console.log(`[RESYNC] Mendownload ulang history 1000 pesan terakhir...`);
        const historyMessages = await chat.fetchMessages({ limit: 1000 });
        
        let count = 0;
        for (const msg of historyMessages) {
            await processMessageCommand(msg, true);
            count++;
        }
        
        console.log(`[RESYNC] Selesai! Berhasil menyisir ${count} pesan.`);
        res.json({ success: true, processed: count });
    } catch (err) {
        console.error('[RESYNC ERROR]:', err);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend WA Engine running on port ${PORT}`);
});

