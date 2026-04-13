require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const cleanupService = require('./services/cleanup_service');

const app = express();
app.use(cors());
app.use(express.json());

// Setup URL Publik untuk menayangkan Foto dari VPS
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || 'https://api-wa.parecustom.com';

// Servis file static dari VPS
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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
        console.log(`[DEBUG] 📩 Masuk processMessageCommand | Dari: ${message.from} | Tipe: ${message.type}`);
        
        // Kita tidak boleh memblokir `message.from` berbasis @lid secara absolut di sini 
        // karena pesan OUTGOING (dari HP sendiri) seringkali di-sync oleh WA menggunakan LID host.
        
        let chat;
        try {
            chat = await message.getChat();
        } catch (e) {
            return; // Gagalkan jika chat tidak ada wujudnya
        }

        if (chat.isGroup) {
             // Sembunyikan log grup agar tidak spam
             return;
        }

        let isLidNetwork = false;
        if (chat.id && (chat.id.server === 'lid' || chat.id._serialized.includes('@lid'))) {
             // Jangan langsung ditolak! Kita akan usahakan me-resolve No HP aslinya dari contact!
             isLidNetwork = true;
        }

        // [SHIELD LEVEL 2] Blokir System Messages (Status/Broadcast)
        if (message.from === 'status@broadcast' || message.isStatus) {
             return;
        }
        if (message.type === 'e2e_notification' || message.type === 'call_log' || message.type === 'protocol' || message.type === 'broadcast_list') {
             return;
        }

        // PENENTUAN NOMOR HP CUSTOMER: Menggunakan getContact() dari WA memastikan kita dapat nomor asli
        const isFromMe = message.fromMe;
        let customerPhoneNumber = chat.id.user; // Fallback "628xxx" (tanpa @c.us)
        let contactPushname = 'Pelanggan Baru';
        
        try {
            const contact = await chat.getContact();
            if (contact) {
                if (contact.number) customerPhoneNumber = String(contact.number).replace(/\D/g, ''); // Prioritas: Resolusi HP Asli
                if (contact.pushname) contactPushname = contact.pushname;
            }
        } catch (err) {
             console.error("[DEBUG] Gagal getContact (Fallback berlajan)", err.message);
        }

        if (!customerPhoneNumber) customerPhoneNumber = String(chat.id.user).replace(/\D/g, ''); // Fallback string regex aman
        console.log(`[DEBUG] 🔍 Resolved Phone Number: ${customerPhoneNumber} (LID Network: ${isLidNetwork})`);

        // [SHIELD LEVEL 3] Validasi Nomor Ketat (Bukan ID / Hash Angka Panjang) Poin 5 & 6
        if (!customerPhoneNumber || customerPhoneNumber.length < 10) {
             console.log(`[DEBUG] 🛡️ Menolak karena nomor HP tidak valid/kosong.`);
             return;
        }
        
        // PENTING: Jika nomor >= 15 digit (sangat panjang seperti 182996376277186) DAN asalnya dari jaringan LID,
        // Ini berarti kita GAGAL mendapatkan nomor HP aslinya. Kita tolak agar tidak jadi Customer Siluman!
        if (customerPhoneNumber.length >= 15 && isLidNetwork) {
             console.log(`[DEBUG] 🛑 [BLOCK] Mencegah penciptaan Data Customer Siluman dari ID Panjang Asli: ${customerPhoneNumber}`);
             return;
        }

        // [HISTORY REVOKE SAFE-MODE] Jika sinkronisasi menangkap riwayat pesan ditarik (Poin 2)
        if (message.type === 'revoked') {
            let targetHash = null;
            if (message._data && message._data.protocolMessageKey && message._data.protocolMessageKey.id) {
                targetHash = message._data.protocolMessageKey.id;
            } else if (message.id && message.id.id) {
                targetHash = message.id.id; 
            }

            if (!targetHash) {
                 console.log("⚠️ [HISTORY REVOKE FAIL-SAFE] Referensi ID asli hilang. Pembatalan diblokir untuk keamanan.");
                 return;
            }

            const { data: dbMsg } = await supabase.from('messages').select('id, is_deleted, customer_id').eq('message_hash', targetHash).single();
            if (dbMsg) {
                if (dbMsg.is_deleted) return; // Idempotent check
                console.log(`🗑️ [HISTORY REVOKE] Menjalankan 3-Layer Sinkronisasi pada Hash: ${targetHash}...`);
                
                // LAYER 2: Menghapus foto fisik dari VPS lokal (Non-Blocking) & Database Media
                const { data: mediaData } = await supabase.from('media').select('id, file_name').eq('message_id', dbMsg.id);
                if (mediaData && mediaData.length > 0) {
                    for (const m of mediaData) {
                        const filePath = path.join(__dirname, 'uploads', m.file_name);
                        await fs.promises.unlink(filePath).catch(e => { /* silent skip */ });
                        await supabase.from('media').delete().eq('id', m.id);
                    }
                }
                // LAYER 1: Soft Delete pesan di tabel
                await supabase.from('messages').update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', dbMsg.id);
            }
            return;
        }

        let { data: customer, error: customerError } = await supabase
            .from('customers')
            .select('*')
            .eq('phone_number', customerPhoneNumber)
            .single();

        if (!customer) {
            console.log(`[DEBUG] 🆕 Menciptakan customer baru di DB...`);
            const { data: newCustomer, error: createError } = await supabase
                .from('customers')
                .insert({
                    phone_number: customerPhoneNumber,
                    name: contactPushname,
                    status: 'BELUM_KIRIM_FOTO'
                })
                .select()
                .single();

            if (createError) {
                console.log(`[DEBUG] ⚠️ Gagal create customer:`, createError);
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
        
        console.log(`[DEBUG] 📬 Lolos! Memasukkan ke tabel messages (Duplicate Check run...)`);

        // KODE PELACAK INTERNAL WA (SANGAT UNIK PER FOTO)
        const waMessageId = message.id._serialized;
        const msgTimestamp = new Date(message.timestamp * 1000).toISOString();
        const secureMessageHash = message.id.id || waMessageId.split('_').pop();

        // 0. ANTI-DUPLIKAT (Cek Kesamaan Kode KTP WA_ID Asli menggunakan Constraint Hash Lintas Prefix)
        let isDuplicate = false;
        let messageRecord = null;

        if (customer && customer.id) {
            const { data: duplicate } = await supabase
                .from('messages')
                .select('id')
                .eq('message_hash', secureMessageHash) 
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
                    message_hash: secureMessageHash, 
                    body: message.body || (message.hasMedia ? '[Attachment Dokumen/Gambar]' : ''),
                    is_from_me: isFromMe,
                    created_at: msgTimestamp
                })
                .select()
                .single();
            if(!msgError) {
                messageRecord = msgData;
            } else {
                console.error("❌ ERROR FATAL INSERT DATABASE MESSAGE:", msgError.message, msgError.details);
            }
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

                try {
                    // Buat folder jika belum ada (Berdasarkan ID Customer)
                    const uploadsDir = path.join(__dirname, 'uploads', customer.id.toString());
                    if (!fs.existsSync(uploadsDir)) {
                        fs.mkdirSync(uploadsDir, { recursive: true });
                    }
                    
                    // Simpan file ke hardisk VPS langsung (Sangat Cepat & Tanpa Timeout)
                    const filePath = path.join(__dirname, 'uploads', fileName);
                    fs.writeFileSync(filePath, buffer);

                    // Buat link publik untuk diakses frontend
                    const publicUrl = `${PUBLIC_API_URL}/uploads/${fileName}`;

                    await supabase
                        .from('media')
                        .insert({
                            customer_id: customer.id,
                            message_id: messageRecord ? messageRecord.id : null,
                            file_url: publicUrl,
                            file_name: fileName,
                            created_at: msgTimestamp
                        });

                    if (customer.status === 'BELUM_KIRIM_FOTO') {
                        await supabase
                           .from('customers')
                           .update({ status: 'SUDAH_KIRIM_FOTO' })
                           .eq('id', customer.id);
                    }
                    console.log(`✅ Foto tersimpan di LOKAL VPS dari customer ${customerPhoneNumber}`);
                } catch (uploadError) {
                    console.error('❌ GAGAL MENYIMPAN FOTO KE VPS:', uploadError.message);
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
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        console.log('🔄 Menyisir pesan tertinggal dalam rentang 1 HARI TERAKHIR (limit 50/chat)...');
        const chats = await client.getChats();
        
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() - 1);
        const limitTimestamp = Math.floor(targetDate.getTime() / 1000);
        
        let processedCount = 0;
        for (const chat of chats) {
            if (!chat.isGroup) {
                try {
                    // Beri jeda 2 detik tiap chat agar WA Web tidak hang (mencegah error waitForChatLoading)
                    await sleep(2000);
                    const historyMessages = await chat.fetchMessages({ limit: 50 });
                    for (const msg of historyMessages) {
                        if (msg.timestamp >= limitTimestamp) {
                            processedCount++;
                            await processMessageCommand(msg, true);
                        }
                    }
                } catch (chatErr) {
                    console.error(`⚠️ Gagal menyisir chat ${chat.id.user}:`, chatErr.message);
                }
            }
        }
        console.log(`✅ Selesai menyisir ${processedCount} pesan tertinggal.`);
    } catch (e) {
         console.error('⚠️ Gagal total sinkronisasi pesan offline:', e);
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

// Menangkap event Penghapusan Pesan (Tarik Pesan) secara Real-time
client.on('message_revoke_everyone', async (after, before) => {
    try {
        if(!after) return;
        
        // Poin 2: Wajib Referensi Asli (Jangan menebak hash baru!)
        let targetHash = null;
        if (before && before.id && before.id.id) {
             targetHash = before.id.id; // Kebenaran 1: Memori WA Asli
        } else if (after._data && after._data.protocolMessageKey && after._data.protocolMessageKey.id) {
             targetHash = after._data.protocolMessageKey.id; // Kebenaran 2: Raw Protocol Storage
        }

        if (!targetHash) {
             console.log(`⚠️ [REVOKE GUARD SKIP] Referensi ID Target asli kosong (Protocol ID: ${after.id._serialized}). Mencegah Salah Hapus.`);
             return;
        }

        console.log(`ℹ️ [REVOKE EVENT] Mencari Hash Pesan Asli (SOT): ${targetHash}...`);
        
        // Poin 1 & 4: Pencarian dan Idempotent Lock
        const { data: dbMsg } = await supabase
            .from('messages')
            .select('id, customer_id, is_deleted')
            .eq('message_hash', targetHash)
            .single();

        if (!dbMsg) {
             console.log(`❌ [REVOKE GAGAL] Pesan Hash ${targetHash} tidak ditemukan dalam penyimpanan DB.`);
             return;
        }

        if (dbMsg.is_deleted) {
             console.log(`⏭️ [REVOKE SKIP] Idempotent: Pesan Hash ${targetHash} sudah pernah ditandai terhapus.`);
             return;
        }

        // Poin 1 Lanjutan: Validasi Ruang Obrolan
        try {
            const chat = await after.getChat();
            if (chat) {
                let checkPhone = chat.id.user;
                const contact = await chat.getContact();
                if (contact && contact.number) checkPhone = contact.number;
                
                const { data: custInfo } = await supabase.from('customers').select('id').eq('phone_number', checkPhone).single();
                if (custInfo && custInfo.id !== dbMsg.customer_id) {
                     console.log(`⛔ [FATAL SHIELD] Batal menghapus ${targetHash}! Kepemilikan (Customer ID) bentrok (Anti-Salah-Hapus).`);
                     return;
                }
            }
        } catch (e) {
             // Jika protokol tak bisa dilacak chat-nya, abaikan verifikasi ini dan percaya pada spesifikasi Hash Unik.
             console.log(`ℹ️ [REVOKE INFO] Tidak dapat memverifikasi pengirim via chat protocol, tapi Hash Unik dikonfirmasi valid.`);
        }

        // LAYER 2: Hapus File VPS Asinkronus Non-Blocking (Poin 2). LAYER 3: Hapus DB Media
        const { data: mediaData } = await supabase.from('media').select('id, file_name').eq('message_id', dbMsg.id);
        if (mediaData && mediaData.length > 0) {
            for (const m of mediaData) {
                const filePath = path.join(__dirname, 'uploads', m.file_name);
                await fs.promises.unlink(filePath).catch(e => {
                     console.log(`ℹ️ Media fisik ${m.file_name} sudah tidak di memori VPS.`); 
                });
                await supabase.from('media').delete().eq('id', m.id);
            }
        }

        // LAYER 1: Terakhir, Soft Delete tabel messages
        await supabase.from('messages').update({
             is_deleted: true,
             deleted_at: new Date().toISOString()
        }).eq('id', dbMsg.id);

        console.log(`✅ [3-LAYER SYNC SUCCESS] Pesan Asli (Hash: ${targetHash}) resmi Lenyap & Soft-Deleted secara aman!`);
    } catch (e) {
        console.error('⚠️ Error Fatal memproses pesan Real-time Tarik (Revoke):', e.message);
    }
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
    
    // THE JANITOR: Menjalankan skrip bersih-bersih tepat setiap Pukul 02:00 Pagi.
    cron.schedule('0 2 * * *', () => {
        cleanupService();
    });
    console.log('🧹 The Janitor (Auto-Cleanup) dijadwalkan setiap jam 02:00 pagi.');
});

