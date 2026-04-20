require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const cleanupService = require('./services/cleanup_service');
const { checkAndRespond, sendPostOrderFollowUp, invalidateConfigCache, withTimeout } = require('./services/ai_followup_service');

const app = express();
app.use(cors());
app.use(express.json());

// Setup URL Publik untuk menayangkan Foto dari VPS
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || 'https://api-wa.parecustom.com';

// Servis file static dari VPS
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Setup Multer untuk upload gambar konfigurasi AI Bot
const aiImageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'uploads', 'ai-config');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `order-example${ext}`);
    }
});
const uploadAiImage = multer({
    storage: aiImageStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // Max 5MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Hanya file gambar yang diizinkan.'));
    }
});

const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(process.env.SUPABASE_URL, supabaseKey);

let qrCodeData = '';
let isConnected = false;
const contactCache = new Map(); // [GLOBAL CACHE] LID -> JID/Phone Mapping

const client = new Client({
    authStrategy: new LocalAuth({ clientId: "crm-polaroid" }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu']
    }
});

// FUNGSI PENDUKUNG: Resolving LID ke Nomor HP asli secara agresif
async function resolveIdentifier(id, chatObject = null) {
    const serialized = id.includes('@') ? id : (id.includes('-') ? id + '@g.us' : id + '@c.us');
    
    // 1. Cek Cache Global
    if (contactCache.has(serialized)) {
        return contactCache.get(serialized);
    }

    // 2. Upayakan mapping LID via Official API (whatsapp-web.js dev version)
    if (serialized.endsWith('@lid') && client.getContactLidAndPhone) {
        try {
            const mapping = await withTimeout(client.getContactLidAndPhone([serialized]), 5000, 'getContactLidAndPhone');
            if (mapping && mapping.length > 0 && mapping[0].pn) {
                const phone = mapping[0].pn.split('@')[0];
                contactCache.set(serialized, phone);
                return phone;
            }
        } catch (e) { /* silent */ }
    }

    // 3. Cek via getContact (bisa mentrigger sinkronisasi lokal)
    if (chatObject && chatObject.getContact) {
        try {
            const contact = await withTimeout(chatObject.getContact(), 8000, 'getContact_resolve');
            if (contact && contact.number && !contact.number.includes('lid')) {
                const phone = String(contact.number).replace(/\D/g, '');
                contactCache.set(serialized, phone);
                return phone;
            }
        } catch (e) { /* silent */ }
    }

    // 4. Force Sync via client.getContactById
    try {
        const contact = await withTimeout(client.getContactById(serialized), 5000, 'getContactById_resolve');
        if (contact && contact.number && !contact.number.includes('lid')) {
            const phone = String(contact.number).replace(/\D/g, '');
            contactCache.set(serialized, phone);
            return phone;
        }
    } catch (e) { /* silent */ }

    // Fallback: Kembalikan ID aslinya (biasanya ini angka LID panjang)
    return serialized.split('@')[0].replace(/\D/g, '');
}

async function hydrateContactCache() {
    console.log('📇 [HYDRATION] Membangun Cache Kontak Global...');
    try {
        const contacts = await client.getContacts();
        let mapped = 0;
        for (const c of contacts) {
            if (c.id && c.number && !c.id.user.includes('lid') && !c.number.includes('lid')) {
                // Mapping standard
                contactCache.set(c.id._serialized, c.number);
                mapped++;
            }
        }
        console.log(`✅ [HYDRATION] Sukses membangun mapping ${mapped} kontak.`);
    } catch (e) {
        console.error('⚠️ [HYDRATION] Gagal sinkronisasi kontak:', e.message);
    }
}

// CORE ENGINE HANDLER (Diekstrak agar bisa dipakai untuk pesan masuk realtime & sinkronisasi tertinggal)
async function processMessageCommand(message, skipCustomerUpdate = false) {
    try {
        const isFromMe = message.fromMe;
        console.log(`[DEBUG] 📩 Masuk processMessageCommand | Dari: ${message.from} | Tipe: ${message.type}`);
        
        // Kita tidak boleh memblokir `message.from` berbasis @lid secara absolut di sini 
        // karena pesan OUTGOING (dari HP sendiri) seringkali di-sync oleh WA menggunakan LID host.
        
        let chat;
        try {
            chat = await withTimeout(message.getChat(), 30000, 'getChat');
        } catch (e) {
            console.error(`[TIMEOUT-GUARD] getChat gagal/timeout:`, e.message);
            return;
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
        let customerPhoneNumber = chat.id.user; // Fallback "628xxx" (tanpa @c.us)
        let contactPushname = 'Pelanggan Baru';
        
        // [AGRESIVE RESOLVER] Memastikan kita dapat nomor asli, bukan LID
        customerPhoneNumber = await resolveIdentifier(chat.id._serialized, chat);
        
        try {
            const contact = await withTimeout(chat.getContact(), 5000, 'getPushname');
            if (contact && contact.pushname) contactPushname = contact.pushname;
        } catch (err) { /* silent fallback untuk pushname */ }
        
        console.log(`[DEBUG] 🔍 Resolved Phone Number: ${customerPhoneNumber} (LID Network: ${isLidNetwork})`);

        // [SHIELD LEVEL 3] Validasi Nomor Ketat (Bukan ID / Hash Angka Panjang) Poin 5 & 6
        if (!customerPhoneNumber || customerPhoneNumber.length < 10) {
             console.log(`[DEBUG] 🛡️ Menolak karena nomor HP tidak valid/kosong.`);
             return;
        }
        
        // PENTING: Mencegah penciptaan Data Customer Siluman dari jaringan LID.
        // KECUALI jika pesan tersebut memiliki MEDIA (Gambar/Foto). 
        // Lebih baik punya data "Nomor Aneh" daripada pesanan/foto customer hilang sama sekali.
        if (isLidNetwork && customerPhoneNumber === String(chat.id.user).replace(/\D/g, '')) {
             if (!message.hasMedia) {
                 console.log(`[DEBUG] 🛑 [BLOCK] Mengabaikan teks LID tanpa media: ${customerPhoneNumber}`);
                 return;
             }
             console.log(`[DEBUG] ⚠️ [ALLOW-BY-MEDIA] Meloloskan LID ${customerPhoneNumber} karena memiliki media penting.`);
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
                    status: 'BELUM_KIRIM_FOTO',
                    created_at: msgTimestamp // Gunakan waktu pesan asli
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
        } else {
            // Pelanggan sudah ada — Update 'Last Activity' (created_at) jika pesan ini lebih baru
            // Saat resync massal, kita gunakan waktu pesan asli, bukan waktu 'SEKARANG'.
            const currentActivity = new Date(customer.created_at).getTime();
            const msgTime = new Date(msgTimestamp).getTime();

            if (msgTime > currentActivity) {
                await supabase.from('customers').update({ created_at: msgTimestamp }).eq('id', customer.id);
            }
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
            // [FIX] Hanya simpan ke galeri dan update status jika media berasal dari CUSTOMER (!isFromMe)
            if (!isFromMe) {
                console.log(`📥 Mengunduh media dari customer ${customerPhoneNumber}...`);
                const media = await withTimeout(message.downloadMedia(), 25000, 'downloadMedia');
                
                if (!media || !media.data) {
                    console.log(`⚠️ Gambar Kadaluarsa/Gagal didownload dari server WA untuk ${customerPhoneNumber}`);
                } else {
                    const buffer = Buffer.from(media.data, 'base64');
                    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                    let fileExt = media.mimetype ? media.mimetype.split('/')[1] : 'jpg';
                    if (fileExt && fileExt.includes(';')) fileExt = fileExt.split(';')[0];
                    const ext = fileExt === 'jpeg' ? 'jpg' : fileExt; 
                    
                    const fileName = `${customer.id}/foto-${uniqueSuffix}.${ext}`;

                    try {
                        const uploadsDir = path.join(__dirname, 'uploads', customer.id.toString());
                        if (!fs.existsSync(uploadsDir)) {
                            fs.mkdirSync(uploadsDir, { recursive: true });
                        }
                        
                        const filePath = path.join(__dirname, 'uploads', fileName);
                        fs.writeFileSync(filePath, buffer);

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
            } else {
                console.log(`[DEBUG] ⏭️ Media dari Bot/Admin (fromMe) dideteksi. Lewati galeri & status update.`);
            }
        }
        // ─── AI FOLLOW-UP: Minta nomor pesanan jika belum ada ─────────────────
        // Dipanggil SETELAH customer & pesan tersimpan ke DB, sebelum fungsi selesai.
        // Hanya berjalan untuk pesan teks dari customer (bukan media, bukan fromMe)
        if (!message.hasMedia && !isFromMe && customer) {
            await checkAndRespond(client, customer, message, supabase);
        }
        // ───────────────────────────────────────────────────────────────────────

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

    // Build Contact Cache
    await hydrateContactCache();

    // [STARTUP SYNC] - Improved & Robust
    try {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        console.log('🔄 Menyisir pesan tertinggal dalam rentang 1 HARI TERAKHIR...');
        
        let chats = [];
        try {
            chats = await withTimeout(client.getChats(), 60000, 'getChats_startup');
        } catch (getChatsErr) {
            console.error('❌ Gagal mengambil daftar chat saat startup:', getChatsErr.message);
            return;
        }
        
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() - 1);
        const limitTimestamp = Math.floor(targetDate.getTime() / 1000);
        
        let processedCount = 0;
        let errorCount = 0;

        for (const chat of chats) {
            // [SHIELD] Abaikan status, grup, dan chat kosong
            if (chat.isGroup || chat.id.user === 'status' || chat.id.user === 'broadcast') continue;

            try {
                // Jeda 1.5 detik agar tidak memicu proteksi internal WhatsApp/Puppeteer
                await sleep(1500);

                // Cek pesan terakhir sebelum fetch (Optimasi: Jika pesan terakhir sudah lama, skip)
                if (chat.lastMessage && chat.lastMessage.timestamp < limitTimestamp) {
                    continue;
                }

                // FETCH MESSAGES dengan proteksi error waitForChatLoading
                const historyMessages = await withTimeout(chat.fetchMessages({ limit: 50 }), 30000, 'fetchMessages_startup')
                    .catch(err => {
                        if (err.message.includes('waitForChatLoading') || err.message.includes('undefined')) {
                            console.log(`ℹ️ Skip chat ${chat.id.user}: WhatsApp Web belum siap (waitForChatLoading).`);
                            return [];
                        }
                        throw err;
                    });

                for (const msg of historyMessages) {
                    if (msg.timestamp >= limitTimestamp) {
                        processedCount++;
                        await processMessageCommand(msg, true);
                    }
                }
            } catch (chatErr) {
                errorCount++;
                console.error(`⚠️ Gagal menyisir chat ${chat.id.user}:`, chatErr.message);
            }
        }
        console.log(`✅ Selesai menyisir ${processedCount} pesan tertinggal. (Gagal: ${errorCount} chat)`);
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
            const chat = await withTimeout(after.getChat(), 30000, 'getChat_revoke');
            if (chat) {
                let checkPhone = chat.id.user;
                const contact = await withTimeout(chat.getContact(), 4000, 'getContact_revoke');
                if (contact && contact.number) checkPhone = String(contact.number).replace(/\D/g, '');
                
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

// Deep Resync Endpoint: Untuk menangani gap waktu spesifik (seperti saat crash loop)
app.post('/api/wa/deep-resync', async (req, res) => {
    const { start_date, end_date } = req.body; // Format: '2026-04-19T19:00:00'
    if (!isConnected) return res.status(400).json({ error: 'WhatsApp is not connected' });

    try {
        const startTs = Math.floor(new Date(start_date).getTime() / 1000);
        const endTs = end_date ? Math.floor(new Date(end_date).getTime() / 1000) : Math.floor(Date.now() / 1000);

        console.log(`[DEEP-RESYNC] Memulai penyisiran paksa dari ${start_date} hingga ${end_date || 'Sekarang'}...`);
        const chats = await client.getChats();
        
        let totalProcessed = 0;
        for (const chat of chats) {
            if (chat.isGroup || chat.id.user === 'status') continue;
            
            // Skip chat yang tidak ada aktifitas di range tersebut (jika lastMessage tersedia)
            if (chat.lastMessage && chat.lastMessage.timestamp < startTs) continue;

            console.log(`[DEEP-RESYNC] Menyisir chat ${chat.id.user}...`);
            try {
                const messages = await withTimeout(chat.fetchMessages({ limit: 100 }), 30000, 'fetchMessages_deep');
                for (const msg of messages) {
                    if (msg.timestamp >= startTs && msg.timestamp <= endTs) {
                        // skipCustomerUpdate kita set false agar 'created_at' customer di-update sesuai waktu pesan asli
                        await processMessageCommand(msg, false);
                        totalProcessed++;
                    }
                }
            } catch (chatErr) {
                console.error(`[DEEP-RESYNC ERROR] Chat ${chat.id.user}:`, chatErr.message);
            }
            await new Promise(r => setTimeout(r, 1000)); // Rate limiting
        }

        res.json({ success: true, processed: totalProcessed });
    } catch (err) {
        res.status(500).json({ error: err.message });
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
        await withTimeout(client.sendMessage(chatId, message), 30000, 'sendMessage_API');

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
        const chat = await withTimeout(client.getChatById(chatId), 30000, 'getChatById_API');
        
        console.log(`[RESYNC - SAFE MODE] Memulai penyisiran ulang history untuk: ${phone_number}`);
        // KOREKSI: Kita TIDAK LAGI MENGHAPUS data lama. 
        // Logika processMessageCommand sudah otomatis melakukan 'Healing' (menambah yang kurang, skip yang sudah ada).
        // Ini mencegah resiko chat hilang jika koneksi terputus di tengah jalan.

        console.log(`[RESYNC] Mendownload ulang history 1000 pesan terakhir...`);
        const historyMessages = await withTimeout(chat.fetchMessages({ limit: 1000 }), 60000, 'fetchMessages_API');
        
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

app.post('/api/wa/delete-chats', async (req, res) => {
    // API ini berjalan MURNI mengelola manipulasi File & Database (tidak perlu mengecek isConnected WA).
    const { customer_ids } = req.body;
    
    if (!Array.isArray(customer_ids) || customer_ids.length === 0) {
        return res.status(400).json({ error: 'Tidak ada ID Pelanggan yang dituju.' });
    }

    try {
        console.log(`[DELETE-CHATS] Mengeksekusi pencucian data massal sejumlah: ${customer_ids.length} pelanggan...`);
        let successfullyDeleted = 0;

        for (const customerId of customer_ids) {
             try {
                 // FASE 1: Isolasi & Pemusnahan File Fisik Hardisk (Zero Leakage)
                 const folderPath = path.join(__dirname, 'uploads', customerId.toString());
                 if (fs.existsSync(folderPath)) {
                      await fs.promises.rm(folderPath, { recursive: true, force: true }).catch(err => {
                          // Toleransi apabila file memang sedang dikunci sistem operasi
                          console.error(`⚠️ (Tertahan) Gagal wipe folder fisik ${customerId}:`, err.message);
                      });
                 }

                 // FASE 2: Evakuasi Tabel Turunan
                 await supabase.from('media').delete().eq('customer_id', customerId);
                 await supabase.from('messages').delete().eq('customer_id', customerId);

                 // FASE 3: Cabut Akar Utama
                 await supabase.from('customers').delete().eq('id', customerId);
                 
                 successfullyDeleted++;
             } catch (isolatedErr) {
                 // Mencegah PM2 Crash: Error penghapusan 1 orang, tidak akan membatalkan yang lain
                 console.error(`⚠️ [FAIL-SAFE] Skip penghapusan customer ${customerId} akibat error:`, isolatedErr.message);
             }
        }

        console.log(`✅ [DELETE-CHATS] Operasi tuntas. Menghapus penuh ${successfullyDeleted} pelanggan.`);
        return res.json({ success: true, count: successfullyDeleted });
    } catch (fatalErr) {
        console.error('❌ [DELETE-CHATS FATAL ERROR]:', fatalErr.message);
        return res.status(500).json({ error: 'Terjadi kegagalan server internal.' });
    }
});

// ═══════════════════════════════════════════════════════════
// ENDPOINT API: MANAJEMEN MEDIA (Scan AI & Hapus Massal)
// ═══════════════════════════════════════════════════════════
const { scanImageForOrderId, deleteMediaBulk } = require('./services/media_service');

// POST /api/media/scan — Scan satu gambar untuk menemukan Nomor Pesanan via AI Vision
app.post('/api/media/scan', async (req, res) => {
    const { media_id, customer_id } = req.body;
    if (!media_id || !customer_id) {
        return res.status(400).json({ error: 'media_id dan customer_id diperlukan.' });
    }

    try {
        // Ambil info media dari database
        const { data: media, error: mediaErr } = await supabase
            .from('media')
            .select('id, file_name, customer_id')
            .eq('id', media_id)
            .single();

        if (mediaErr || !media) {
            return res.status(404).json({ error: 'Media tidak ditemukan di database.' });
        }

        // Guard: Pastikan media milik customer yang benar (anti manipulasi)
        if (media.customer_id !== customer_id) {
            return res.status(403).json({ error: 'Media ini bukan milik customer tersebut.' });
        }

        // Bangun path lokal file
        const filePath = path.join(__dirname, 'uploads', media.file_name);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File fisik tidak ditemukan di server. Coba resync terlebih dahulu.' });
        }

        console.log(`[MEDIA-SCAN] 🔍 Memindai gambar ${media.file_name} untuk Customer ${customer_id}...`);
        const result = await scanImageForOrderId(filePath);

        if (result.found) {
            // Otomatis simpan ke database customer
            await supabase
                .from('customers')
                .update({ order_id: result.orderId })
                .eq('id', customer_id);

            // Kirim pesan follow-up (ketentuan + link TikTok) via WA
            const { data: custData } = await supabase.from('customers').select('phone_number').eq('id', customer_id).single();
            if (custData && isConnected) {
                await sendPostOrderFollowUp(client, custData.phone_number, result.orderId, supabase);
            }

            console.log(`[MEDIA-SCAN] ✅ Nomor pesanan ditemukan: ${result.orderId}`);
            return res.json({ success: true, found: true, order_id: result.orderId });
        }

        console.log(`[MEDIA-SCAN] ❌ Tidak ditemukan 18 digit di gambar. Raw: ${result.raw}`);
        return res.json({ success: true, found: false, message: 'Nomor pesanan (18 digit) tidak ditemukan dalam gambar ini.' });

    } catch (err) {
        console.error('[MEDIA-SCAN] FATAL:', err.message);
        return res.status(500).json({ error: 'Gagal memindai gambar: ' + err.message });
    }
});

// POST /api/media/delete-bulk — Hapus beberapa media sekaligus (file VPS + database)
app.post('/api/media/delete-bulk', async (req, res) => {
    const { media_ids, customer_id } = req.body;
    if (!Array.isArray(media_ids) || media_ids.length === 0 || !customer_id) {
        return res.status(400).json({ error: 'media_ids (array) dan customer_id diperlukan.' });
    }

    try {
        // Ambil data media yang akan dihapus (hanya milik customer tersebut)
        const { data: mediaItems, error: fetchErr } = await supabase
            .from('media')
            .select('id, file_name')
            .in('id', media_ids)
            .eq('customer_id', customer_id);

        if (fetchErr || !mediaItems || mediaItems.length === 0) {
            return res.status(404).json({ error: 'Tidak ada media valid yang ditemukan untuk dihapus.' });
        }

        console.log(`[MEDIA-DELETE] 🗑️ Menghapus ${mediaItems.length} file media milik Customer ${customer_id}...`);
        const result = await deleteMediaBulk(mediaItems, supabase);

        // Hitung ulang: Jika semua media habis, kembalikan status ke BELUM_KIRIM_FOTO
        const { data: remaining } = await supabase
            .from('media')
            .select('id')
            .eq('customer_id', customer_id)
            .limit(1);

        if (!remaining || remaining.length === 0) {
            await supabase
                .from('customers')
                .update({ status: 'BELUM_KIRIM_FOTO' })
                .eq('id', customer_id);
            console.log(`[MEDIA-DELETE] ℹ️ Semua media habis — status direset ke BELUM_KIRIM_FOTO.`);
        }

        console.log(`[MEDIA-DELETE] ✅ Berhasil: ${result.deleted}, Gagal: ${result.failed}`);
        return res.json({ success: true, deleted: result.deleted, failed: result.failed });

    } catch (err) {
        console.error('[MEDIA-DELETE] FATAL:', err.message);
        return res.status(500).json({ error: 'Gagal menghapus media: ' + err.message });
    }
});

// ═══════════════════════════════════════════════════════════
// ENDPOINT API: KONFIGURASI AI BOT
// ═══════════════════════════════════════════════════════════

// GET /api/ai/config — Ambil konfigurasi bot saat ini
app.get('/api/ai/config', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('ai_config')
            .select('is_enabled, system_prompt, order_image_url, post_order_message')
            .eq('id', 1)
            .single();

        if (error) throw error;
        res.json({ success: true, config: data });
    } catch (err) {
        res.status(500).json({ error: 'Gagal membaca konfigurasi AI: ' + err.message });
    }
});

// POST /api/ai/config — Update toggle ON/OFF dan system prompt
app.post('/api/ai/config', async (req, res) => {
    const { is_enabled, system_prompt, post_order_message } = req.body;
    try {
        const updates = { updated_at: new Date().toISOString() };
        if (typeof is_enabled === 'boolean') updates.is_enabled = is_enabled;
        if (typeof system_prompt === 'string' && system_prompt.trim()) updates.system_prompt = system_prompt.trim();
        if (typeof post_order_message === 'string') updates.post_order_message = post_order_message.trim();

        const { error } = await supabase
            .from('ai_config')
            .update(updates)
            .eq('id', 1);

        if (error) throw error;

        // Invalidate cache agar perubahan langsung aktif tanpa restart PM2
        invalidateConfigCache();

        res.json({ success: true, message: 'Konfigurasi AI berhasil disimpan.' });
    } catch (err) {
        res.status(500).json({ error: 'Gagal menyimpan konfigurasi: ' + err.message });
    }
});

// POST /api/ai/config/image — Upload gambar contoh nomor pesanan
app.post('/api/ai/config/image', uploadAiImage.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Tidak ada file gambar yang diupload.' });

        const imageUrl = `${PUBLIC_API_URL}/uploads/ai-config/${req.file.filename}`;

        const { error } = await supabase
            .from('ai_config')
            .update({ order_image_url: imageUrl, updated_at: new Date().toISOString() })
            .eq('id', 1);

        if (error) throw error;

        // Invalidate cache agar URL gambar baru langsung dipakai
        invalidateConfigCache();

        console.log(`[AI-BOT] 🖼️ Gambar contoh pesanan diperbarui: ${imageUrl}`);
        res.json({ success: true, image_url: imageUrl });
    } catch (err) {
        res.status(500).json({ error: 'Gagal upload gambar: ' + err.message });
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

