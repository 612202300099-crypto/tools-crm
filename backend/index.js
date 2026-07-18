// [CRITICAL FIX] Load .env dari folder yang SAMA dengan index.js
// BUKAN dari process.cwd() — karena PM2 bisa start dari folder mana saja.
// Tanpa ini, jika PM2 start dari /root/ → .env di /root/tools-crm/backend/.env tidak terbaca!
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient, setIo } = require('./supabase_shim');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const chromeSemaphore = require('./services/chrome_semaphore');
const cleanupService = require('./services/cleanup_service');
const StabilityManager = require('./services/stability_manager');
const MediaQueueService = require('./services/media_queue_service');
const objectStorage = require('./services/object_storage_service');
const pendingOrderSvc = require('./services/pending_order_service');
const { checkAndRespond, checkAndRespondMedia, sendPostOrderFollowUp, invalidateConfigCache, withTimeout, sendWAMessageDirect } = require('./services/ai_followup_service');

const { router: localApiRouter, authenticateToken } = require('./api');
const db = require('./db');
const { lookupOrder } = require('./services/spreadsheet_service');
const { detectOrderId } = require('./utils/orderIdUtils'); // [BUG FIX] Regex order ID terpusat (14-20 digit)

// [BEST PRACTICE] Global Error Catcher — Server Tidak Pernah Mati
// Mencegah server Node.js crash karena error yang tidak tertangkap.
process.on('uncaughtException', (err) => {
    // [CRITICAL FIX] Error Puppeteer ini BUKAN fatal — terjadi saat WA
    // sedang navigate/load halaman. Jika dibiarkan crash → PM2 restart →
    // session rusak → harus scan QR lagi. Solusi: SKIP saja.
    const PUPPETEER_NOISE = [
        'Execution context was destroyed',
        'Session closed',
        'Target closed',
        'detached Frame',
        'Protocol error',
        'waitForChatLoading',
        'Cannot read properties of null',
    ];
    if (PUPPETEER_NOISE.some(msg => err.message?.includes(msg))) {
        console.warn(`[PUPPETEER-GUARD] ⚠️ Browser noise terdeteksi (skip): ${err.message.substring(0, 80)}`);
        return; // JANGAN crash — ini normal saat WA Web loading
    }
    console.error('\n🚨 [GLOBAL ERROR] Uncaught Exception terdeteksi:');
    console.error(err.stack || err.message);
    console.error('ℹ️ Server tetap berjalan berkat pelindung global.\n');
});

process.on('unhandledRejection', (reason, promise) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const PUPPETEER_NOISE = [
        'Execution context was destroyed',
        'Session closed',
        'Target closed',
        'detached Frame',
        'Protocol error',
        'waitForChatLoading',
    ];
    if (PUPPETEER_NOISE.some(noise => msg?.includes(noise))) {
        console.warn(`[PUPPETEER-GUARD] ⚠️ Promise rejection browser (skip): ${msg.substring(0, 80)}`);
        return; // JANGAN crash
    }
    console.error('\n🚨 [GLOBAL ERROR] Unhandled Promise Rejection terdeteksi:');
    console.error(reason);
    console.error('ℹ️ Promise yang gagal diabaikan untuk menjaga stabilitas server.\n');
});


const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * safeDbCall - Wrapper untuk Supabase agar tahan banting terhadap Network Timeout
 * Melakukan retry hingga 3x jika terjadi kesalahan koneksi.
 */
async function safeDbCall(operation, label = 'DB_OP', retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const result = await operation();
            if (result.error) throw result.error;
            return result;
        } catch (err) {
            const isNetworkError = err.message?.includes('fetch') || err.message?.includes('timeout') || err.code === 'UND_ERR_CONNECT_TIMEOUT';
            if (isNetworkError && i < retries - 1) {
                const delay = (i + 1) * 2000;
                console.warn(`[${label}] ⚠️ Koneksi DB gagal (Percobaan ${i + 1}/${retries}). Mencoba lagi dalam ${delay}ms...`);
                await sleep(delay);
                continue;
            }
            throw err;
        }
    }
}

const app = express();
app.use(cors());
app.use(express.json());

// --- DEBUG LOGGING MIDDLEWARE ---
app.use((req, res, next) => {
    if ((req.url.includes('/login') || req.url.includes('/api/')) && !req.url.includes('/drive-status')) {
        console.log(`[REQ] ${req.method} ${req.url} from ${req.headers.origin || 'unknown'} - Body:`, req.body ? JSON.stringify(req.body).substring(0, 100) : 'none');
    }
    next();
});
// --------------------------------

// ─── EMERGENCY MASS SYNC ENDPOINT ────────────────────────────────────────────────
app.post('/api/local/emergency-mass-sync', authenticateToken, async (req, res) => {
    // Bisa mengatur berapa hari ke belakang via parameter body (default 2 hari)
    const daysBack = parseInt(req.body?.days) || parseInt(req.query?.days) || 2;
    res.json({ message: `🚨 Sapu Jagat (Emergency Mass Sync) dimulai untuk ${daysBack} hari terakhir.` });

    // Jalankan di background agar request HTTP tidak timeout
    (async () => {
        let isEmergencyRunning = true;
        try {
            console.log('\\n=========================================================');
            console.log(`[EMERGENCY] 🚨 Memulai "Sapu Jagat" untuk ${daysBack} hari terakhir...`);
            console.log('=========================================================\\n');

            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() - daysBack);

            // Ambil semua customer dari 2 hari lalu yang belum VALIDATED
            // (yang sudah VALIDATED berarti fotonya sudah beres diverifikasi)
            // [CRITICAL FIX] Urutkan dari yang paling LAMA (ASC) agar pelanggan yang paling menderita menunggu lama segera diselamatkan lebih dulu.
            const customers = db.prepare("SELECT * FROM customers WHERE created_at >= ? AND status != 'VALIDATED' ORDER BY created_at ASC").all(targetDate.toISOString());

            console.log(`[EMERGENCY] Ditemukan ${customers.length} customer untuk disisir ulang.`);

            let successCount = 0;

            for (const c of customers) {
                try {
                    console.log(`\\n[EMERGENCY] 🔍 Memproses: ${c.phone_number} (Order: ${c.order_id || 'KOSONG'})`);

                    // 1. RE-LOOKUP SPREADSHEET (Mencocokkan ulang data yang baru diupdate)
                    if (c.order_id) {
                        const lookup = await lookupOrder(c.order_id, { bypassCache: true });
                        if (lookup && lookup.found) {
                            db.prepare('UPDATE customers SET resi = ?, store_name = ?, order_detail = ? WHERE id = ?')
                                .run(lookup.resi, lookup.storeName, JSON.stringify(lookup.items), c.id);
                            c.resi = lookup.resi;
                            c.store_name = lookup.storeName;
                            c.order_detail = JSON.stringify(lookup.items);
                            console.log(`[EMERGENCY] ✅ Update Spreadsheet: ${c.resi} - ${c.store_name}`);
                        } else {
                            console.log(`[EMERGENCY] ❌ Order ID ${c.order_id} masih belum ada di Spreadsheet.`);
                        }
                    }

                    // 2. FETCH HISTORY WA (Gali Ulang otomatis untuk foto yang timeout/terlewat)
                    let chatIdsToSync = new Set([`${c.phone_number}@c.us`]);
                    try {
                        const dbMsgs = db.prepare('SELECT wa_id FROM messages WHERE customer_id = ? AND wa_id IS NOT NULL').all(c.id);
                        for (const msg of dbMsgs) {
                            const parts = msg.wa_id.split('_');
                            if (parts.length >= 2) chatIdsToSync.add(parts[1]);
                        }
                    } catch (e) {}

                    for (const targetChatId of chatIdsToSync) {
                        try {
                            const chat = await chromeSemaphore.acquire('EMERGENCY:getChat', () => {
                                return withTimeout(client.getChatById(targetChatId), 10000, 'emergency_getChat');
                            }, { priority: 2, timeout: 20000 });

                            // ── DEEP PAGINATION (sama seperti Gali Ulang UI) ──────────────────
                            // fetchMessages biasa hanya baca RAM browser → lewatkan foto lama.
                            // loadEarlierMessages() = "scroll ke atas" → muat dari server WA.
                            let allMessages = await chromeSemaphore.acquire('EMERGENCY:fetch_init', () => {
                                return withTimeout(chat.fetchMessages({ limit: 100 }), 60000, 'emergency_fetch_init');
                            }, { priority: 2, timeout: 90000 });

                            let prevCount = 0;
                            let emIter = 0;
                            const EM_MAX_ITER = 40;

                            while (emIter < EM_MAX_ITER) {
                                emIter++;
                                prevCount = allMessages.length;
                                try {
                                    const hasMore = await chromeSemaphore.acquire('EMERGENCY:loadEarlier', () => {
                                        return withTimeout(chat.loadEarlierMessages(), 25000, 'emergency_loadEarlier');
                                    }, { priority: 2, timeout: 35000 });

                                    const refreshed = await chromeSemaphore.acquire('EMERGENCY:fetch_refresh', () => {
                                        return withTimeout(chat.fetchMessages({ limit: 5000 }), 120000, 'emergency_fetch_refresh');
                                    }, { priority: 2, timeout: 150000 });

                                    const newFound = refreshed.length - prevCount;
                                    if (newFound > 0) allMessages = refreshed;

                                    const mediaFoundSoFar = allMessages.filter(m => m.hasMedia && !m.fromMe).length;
                                    console.log(`[EMERGENCY] 📜 Iter ${emIter}: ${allMessages.length} pesan (+${newFound}) | ${mediaFoundSoFar} foto`);

                                    if (!hasMore || newFound === 0) break;
                                    if (mediaFoundSoFar >= 500) break;
                                    await new Promise(r => setTimeout(r, 600));
                                } catch (loadErr) {
                                    console.warn(`[EMERGENCY] ⚠️ loadEarlier iter ${emIter} gagal:`, loadErr.message);
                                    break;
                                }
                            }

                            console.log(`[EMERGENCY] 📊 ${c.phone_number}@${targetChatId}: ${allMessages.length} pesan total`);

                            // Build cached context
                            let cachedContext = null;
                            try {
                                let pushname = 'Pelanggan';
                                let lidNet = targetChatId.includes('@lid');
                                try {
                                    const contact = await withTimeout(chat.getContact(), 5000, 'getPushname');
                                    if (contact && contact.pushname) pushname = contact.pushname;
                                } catch (e) {}
                                cachedContext = {
                                    chat: chat,
                                    customerPhoneNumber: c.phone_number,
                                    contactPushname: pushname,
                                    isLidNetwork: lidNet
                                };
                            } catch (e) {}

                            let mediaCount = 0;
                            for (const msg of allMessages) {
                                // Ekstrak teks ke database untuk dibaca
                                if (msg.type === 'chat' && msg.body) {
                                    db.prepare(`INSERT OR IGNORE INTO messages (id, customer_id, body, is_from_me, created_at) VALUES (?, ?, ?, ?, ?)`)
                                        .run(msg.id.id, c.id, msg.body, msg.fromMe ? 1 : 0, new Date(msg.timestamp * 1000).toISOString());

                                    // [CRITICAL PINTAR] Baca Nomor Order dari pesan pelanggan yang baru digali!
                                    if (!msg.fromMe && !c.order_id) {
                                        // [BUG FIX] Gunakan detectOrderId (14-20 digit) — bukan 10-20 yang bisa tangkap nomor HP!
                                        const foundOrderId = detectOrderId(msg.body);
                                        if (foundOrderId) {
                                            console.log(`[EMERGENCY] 🔎 Ditemukan No Order dari chat lama: ${foundOrderId}`);
                                            db.prepare('UPDATE customers SET order_id = ? WHERE id = ?').run(foundOrderId, c.id);
                                            c.order_id = foundOrderId;

                                            // Segera cek ke Spreadsheet agar mendapat resi!
                                            const lookup = await lookupOrder(c.order_id, { bypassCache: true });
                                            if (lookup && lookup.found) {
                                                db.prepare('UPDATE customers SET resi = ?, store_name = ?, order_detail = ? WHERE id = ?')
                                                    .run(lookup.resi, lookup.storeName, JSON.stringify(lookup.items), c.id);
                                                c.resi = lookup.resi;
                                                c.store_name = lookup.storeName;
                                                c.order_detail = JSON.stringify(lookup.items);
                                                console.log(`[EMERGENCY] ✅ Berhasil mengaitkan Resi dari chat: ${c.resi}`);
                                            }
                                        }
                                    }
                                }

                                // Ekstrak media
                                if (msg.hasMedia && msg.timestamp >= Math.floor(targetDate.getTime() / 1000)) {
                                    await processMessageCommand(msg, true, false, cachedContext);
                                    mediaCount++;
                                }
                            }
                            if (mediaCount > 0) {
                                console.log(`[EMERGENCY] 📸 ${mediaCount} media dari ${targetChatId} masuk antrean.`);
                            }
                        } catch (e) {
                            console.warn(`[EMERGENCY] ⚠️ Gagal Gali titik ${targetChatId} untuk ${c.phone_number}: ${e.message}`);
                        }
                    }

                    // 3. MASUKKAN SEMUA MEDIA KE ANTREAN DRIVE (Paced / Terkontrol)
                    // [CRITICAL FIX] Jangan dorong ke Drive jika resi/toko kosong (mencegah folder null/LAINNYA/null)
                    if (!c.resi || !c.store_name) {
                        console.log(`[EMERGENCY] ⏭️ Melewati antrean Drive untuk ${c.phone_number}: Resi/Toko belum ada di Spreadsheet (Tidak ada No Order di chat).`);
                        successCount++;
                        await sleep(1000);
                        continue;
                    }

                    const mediaList = db.prepare(`
                        SELECT * FROM media
                        WHERE customer_id = ?
                          AND COALESCE(excluded_from_production, 0) = 0
                    `).all(c.id);
                    let pushedDrive = 0;


                    if (mediaList.length > 0) {
                        // [FIX FOLDER LAINNYA] Ambil productAbbr (POLAROID) dan SKU dari detail pesanan
                        let productAbbr = 'LAINNYA';
                        let sku = '';
                        try {
                            const items = JSON.parse(c.order_detail || '[]');
                            const mainItem = items.find(i => i.isPolaroid) || items[0];
                            if (mainItem) {
                                productAbbr = mainItem.productAbbr || 'LAINNYA';
                                sku = mainItem.sku || '';
                            }
                        } catch (e) {
                            console.warn(`[EMERGENCY] Gagal parse order_detail untuk ${c.phone_number}`);
                        }

                        db.transaction(() => {
                            for (const media of mediaList) {
                                const existing = db.prepare('SELECT id, status FROM drive_upload_queue WHERE media_id = ?').get(media.id);
                                if (!existing) {
                                    db.prepare(`INSERT INTO drive_upload_queue (customer_id, media_id, file_url, storage_key, storage_type, order_id, store_name, resi, product_abbr, sku, photo_index, customer_phone, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`)
                                        .run(c.id, media.id, media.file_url, media.storage_key, media.storage_type, c.order_id, c.store_name, c.resi, productAbbr, sku, media.id, c.phone_number);
                                    pushedDrive++;
                                } else if (existing.status !== 'DONE' && existing.status !== 'SKIPPED') {
                                    db.prepare(`UPDATE drive_upload_queue SET status = 'PENDING', resi = ?, store_name = ?, product_abbr = ?, sku = ?, retry_count = 0 WHERE id = ?`)
                                        .run(c.resi, c.store_name, productAbbr, sku, existing.id);
                                    pushedDrive++;
                                }
                            }
                        })();
                        if (pushedDrive > 0) {
                            console.log(`[EMERGENCY] 🚀 Mendorong ${pushedDrive} foto ke antrean Google Drive.`);
                        } else {
                            console.log(`[EMERGENCY] ⏭️ Semua ${mediaList.length} foto sudah aman (DONE) di Drive.`);
                        }
                    }

                    successCount++;
                    // [PENTING] Jeda 1 detik agar tidak meng-DDoS Chrome / CPU VPS
                    await sleep(1000);
                } catch (err) {
                    console.error(`[EMERGENCY] ❌ Error memproses customer ${c.phone_number}:`, err.message);
                }
            }

            console.log('\\n=========================================================');
            console.log(`[EMERGENCY] ✅ SAPU JAGAT SELESAI! Memproses: ${successCount}/${customers.length} customer.`);
            console.log('=========================================================\\n');
        } catch (fatal) {
            console.error('[EMERGENCY] ❌ Fatal Error:', fatal.message);
        } finally {
            isEmergencyRunning = false;
        }
    })();
});

app.use('/api/local', localApiRouter);

// Setup URL Publik untuk menayangkan Foto dari VPS
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || 'https://api.kirimfoto.com';

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

// ─── Deteksi Chrome/Chromium Cross-Platform (Windows & Linux VPS) ───────────────
function detectChromePath() {
    const fs = require('fs');
    const CHROME_ENV = process.env.CHROME_PATH;

    // Prioritas: env override dulu
    if (CHROME_ENV && fs.existsSync(CHROME_ENV)) {
        console.log(`[PUPPETEER] ✅ Chrome dari CHROME_PATH env: ${CHROME_ENV}`);
        return CHROME_ENV;
    }

    const candidates = [
        // ── Linux VPS (urutan prioritas: Chrome stable → Chromium → snap) ──
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
        '/usr/lib/chromium-browser/chromium-browser',
        // ── Windows (lokal dev) ──
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];

    const found = candidates.find(p => p && fs.existsSync(p));
    if (found) {
        console.log(`[PUPPETEER] ✅ Menggunakan browser: ${found}`);
        return found;
    }

    // Tidak ada yang ditemukan — pakai bundled Chromium dari puppeteer
    console.warn('[PUPPETEER] ⚠️ Tidak ada Chrome/Chromium di system. Menggunakan bundled Chromium.');
    console.warn('[PUPPETEER] 💡 TIP: Install Chrome di VPS → apt-get install -y google-chrome-stable');
    return undefined;
}

const client = new Client({
    authStrategy: new LocalAuth({ clientId: "crm-polaroid" }),
    puppeteer: {
        headless: true,
        executablePath: detectChromePath(),
        // [v4 CRITICAL] protocolTimeout — Default Puppeteer = 30 detik.
        // Di VPS, Chrome sering butuh lebih lama untuk merespons karena CPU/RAM terbatas.
        // Tanpa ini: 15 worker download → Chrome kewalahan → "Runtime.callFunctionOn timed out"
        // → Chrome crash → "Execution context destroyed" → Session mati → QR ulang.
        protocolTimeout: 300000, // 300 detik (5 menit) — untuk menampung 10 media workers

        // [BEST PRACTICE] Args optimasi untuk VPS Linux 24/7
        args: [
            '--no-sandbox',               // Wajib di Linux tanpa root sandboxing
            '--disable-setuid-sandbox',   // Wajib di Linux
            '--disable-dev-shm-usage',    // Cegah crash RAM /dev/shm kecil di VPS
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',                // Cegah proses zombie di VPS
            '--disable-gpu',              // VPS tidak punya GPU
            '--disable-extensions',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--js-flags=--max-old-space-size=4096' // [CRITICAL FIX] 4GB agar WA Web tidak crash saat loading ribuan kontak (Target closed)
        ]
    }
});

// [WATCHDOG v3] Inisialisasi Penjaga Stabilitas — Threshold 3 jam (bukan 45 menit)
// 45 menit terlalu agresif → false-positive restart di jam sepi → PM2 restart → session mati
const stability = new StabilityManager(client, {
    staleThreshold: 3 * 60 * 60 * 1000 // 3 JAM tanpa aktifitas = Restart (v3: dari 45 menit)
});

// [MEDIA-QUEUE v4] Antrian Media Asinkron
// ⚠️ JANGAN NAIKKAN CONCURRENCY DI ATAS 3!
// Semua download media melewati SATU instance Chrome (DevTools Protocol).
// 15 worker = 15 panggilan simultan ke Chrome = Chrome kewalahan = crash = session mati.
// 3 worker = beban ringan, Chrome stabil, session aman.
const mediaQueue = new MediaQueueService(client, supabase, {
    publicUrl: PUBLIC_API_URL,
    concurrency: 3,          // [v4] 3 worker (dari 15) — cegah Chrome crash
    pollingInterval: 2000,   // [v4] Jeda 2 detik antar job (dari 1 detik)
    downloadTimeout: 90000,  // [v4] 90 detik untuk download (dari 60 detik)
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
async function processMessageCommand(message, skipCustomerUpdate = false, isPriority = false, cachedContext = null) {
    try {
        const isFromMe = message.fromMe;
        let waMessageId = message.id?._serialized || `false_${message.from}_${message.id?.id || Date.now()}`;
        const msgTimestamp = new Date(message.timestamp * 1000).toISOString();
        const secureMessageHash = message.id?.id || waMessageId.split('_').pop();

        stability.heartbeat(); // Kirim detak jantung ke Watchdog
        console.log(`[DEBUG] 📩 Masuk processMessageCommand | Dari: ${message.from} | Tipe: ${message.type}`);

        // Abaikan notifikasi sistem LID atau broadcast agar tidak memicu error getChat 'r'
        const IGNORED_TYPES = ['e2e_notification', 'notification_template', 'protocol', 'gp2'];
        if (message.from === 'status@broadcast' || IGNORED_TYPES.includes(message.type)) {
            console.log(`[DEBUG] 🚫 Mengabaikan pesan sistem: ${message.type} dari ${message.from}`);
            return;
        }

        let chat;
        let customerPhoneNumber;
        let contactPushname = 'Pelanggan Baru';
        let isLidNetwork = false;

        if (cachedContext) {
            // [OPTIMASI GALI ULANG] Bypass panggilan berat ke Chrome (getChat, getContact) jika context sudah di-cache!
            chat = cachedContext.chat;
            customerPhoneNumber = cachedContext.customerPhoneNumber;
            contactPushname = cachedContext.contactPushname;
            isLidNetwork = cachedContext.isLidNetwork;
            
            // Masih butuh skip broadcast
            if (chat.isGroup) return;
        } else {
            let chatRetry = 0;
            // Langsung gunakan fallback untuk @lid karena getChat sering gagal/timeout
            if (message.from.includes('@lid')) {
                chat = {
                    isGroup: false,
                    id: {
                        user: message.from.split('@')[0],
                        server: 'lid',
                        _serialized: message.from
                    },
                    getContact: async () => ({ pushname: 'Pelanggan Baru' })
                };
            } else {
                while (chatRetry < 3) {
                    try {
                        // [CHROME-SEM] Priority 1 = incoming messages (highest priority)
                        chat = await chromeSemaphore.acquire('getChat', () => {
                            return withTimeout(message.getChat(), 60000, 'getChat');
                        }, { priority: 1, timeout: 90000 });
                        break;
                    } catch (e) {
                        const errMsg = e?.message || String(e);
                        console.warn(`[TIMEOUT-GUARD] getChat gagal iterasi ${chatRetry + 1}: ${errMsg === 'r' ? 'Internal Error WA (r)' : errMsg}`);
                        chatRetry++;
                        if (chatRetry >= 3) {
                            console.warn(`[TIMEOUT-GUARD] Menggunakan fallback untuk ${message.from} karena gagal getChat berulang kali.`);
                            // [FALLBACK] Jika gagal mendapatkan chat, gunakan dummy object
                            chat = {
                                isGroup: message.from.includes('@g.us'),
                                id: {
                                    user: message.from.split('@')[0],
                                    server: message.from.split('@')[1] || 'c.us',
                                    _serialized: message.from
                                },
                                getContact: async () => ({ pushname: 'Pelanggan Baru' })
                            };
                            break;
                        }
                        // Tunggu 2 detik, beri Chrome waktu memuat chat model sebelum mencoba lagi
                        await new Promise(res => setTimeout(res, 2000));
                    }
                }
            }

            if (chat.isGroup) return;

            if (chat.id && (chat.id.server === 'lid' || chat.id._serialized.includes('@lid'))) {
                isLidNetwork = true;
            }

            // PENENTUAN NOMOR HP CUSTOMER: Menggunakan getContact() dari WA memastikan kita dapat nomor asli
            customerPhoneNumber = chat.id.user; // Fallback "628xxx" (tanpa @c.us)
            
            // [AGRESIVE RESOLVER] Memastikan kita dapat nomor asli, bukan LID
            customerPhoneNumber = await resolveIdentifier(chat.id._serialized, chat);

            try {
                const contact = await withTimeout(chat.getContact(), 5000, 'getPushname');
                if (contact && contact.pushname) contactPushname = contact.pushname;
            } catch (err) { /* silent fallback untuk pushname */ }
            
            console.log(`[DEBUG] 🔍 Resolved Phone Number: ${customerPhoneNumber} (LID Network: ${isLidNetwork})`);
            
            // [CRITICAL FIX] Ensure message.id._serialized is ALWAYS set so downloadMedia works!
            if (!message.id) message.id = {};
            if (!message.id._serialized) {
                message.id._serialized = waMessageId;
                console.log(`[DEBUG] 🔧 Injected missing _serialized ID for downloadMedia: ${waMessageId}`);
            }
        }

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
                // [FIX ORDER-DETECTION] Jika ada nomor pesanan di teks, jangan blok
                // Mengatasi: customer kirim nomor pesanan lewat jaringan LID WA baru
                const { detectOrderId: _detectLid } = require('./utils/orderIdUtils');
                const _lidOrderId = _detectLid(message.body || '');
                if (!_lidOrderId) {
                    console.log(`[DEBUG] 🛑 [BLOCK] Teks LID tanpa nomor pesanan: ${customerPhoneNumber}`);
                    return;
                }
                console.log(`[DEBUG] ✅ [ALLOW-LID-ORDER] Teks LID berisi nomor pesanan ${_lidOrderId} — diloloskan.`);
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

                // LAYER 2: Hapus dari Object Storage/Disk (Non-Blocking). LAYER 3: Hapus DB Media
                const { data: mediaData } = await supabase.from('media').select('id, file_name, storage_key, storage_type').eq('message_id', dbMsg.id);
                if (mediaData && mediaData.length > 0) {
                    for (const m of mediaData) {
                        const storageType = m.storage_type || 'local';
                        const storageKey = m.storage_key || m.file_name;
                        await objectStorage.deleteMedia(storageKey, storageType).catch(() => { });
                        await supabase.from('media').delete().eq('id', m.id);
                    }
                }
                // LAYER 1: Soft Delete pesan di tabel
                await supabase.from('messages').update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', dbMsg.id);
            }
            return;
        }

        let customer = null;
        try {
            const { data } = await safeDbCall(
                () => supabase.from('customers').select('*').eq('phone_number', customerPhoneNumber).single(),
                'fetchCustomer'
            );
            customer = data;
        } catch (e) {
            if (e.code !== 'PGRST116') { // PGRST116 is "no rows returned", which is fine
                console.error(`[DEBUG] ❌ Gagal fetch customer:`, e.message);
            }
        }

        if (!customer) {
            console.log(`[DEBUG] 🆕 Menciptakan customer baru di DB...`);
            try {
                const { data: newCustomer } = await safeDbCall(
                    () => supabase.from('customers').insert({
                        phone_number: customerPhoneNumber,
                        name: contactPushname,
                        status: 'BELUM_KIRIM_FOTO',
                        created_at: msgTimestamp
                    }).select().single(),
                    'createCustomer'
                );
                customer = newCustomer;
            } catch (createError) {
                console.log(`[DEBUG] ⚠️ Gagal create customer:`, createError.message);
                if (createError.code === '23505') {
                    const { data: existing } = await supabase.from('customers').select('*').eq('phone_number', customerPhoneNumber).single();
                    customer = existing;
                } else {
                    throw createError;
                }
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

            // ── HEALING MODE: pesan sudah di DB tapi media belum tersimpan ──
            // Cek apakah media sudah ada (mungkin sebelumnya sukses)
            const { data: secureMedia } = await safeDbCall(
                () => supabase.from('media').select('id').eq('message_id', messageRecord.id).limit(1),
                'checkMediaHealing'
            );

            if (secureMedia && secureMedia.length > 0) {
                // Media sudah ada di DB — jangan proses ulang
                return;
            }

            // Media BELUM ada → antri dengan PRIORITAS TINGGI
            // [FIX] isPriority=true: langsung ke depan antrian
            // [FIX] Bypass Disk Guard: healing tidak perlu cek disk (foto sudah seharusnya masuk)
            console.log(`🩹 HEALING: Re-antri media ${waMessageId} untuk customer ${customerPhoneNumber}`);
            if (customer && customer.id) {
                mediaQueue.addToQueue(waMessageId, customer, msgTimestamp, true, message);
            }
            return; // [FIX KRITIS] STOP di sini — jangan jatuh ke blok if(message.hasMedia) di bawah
        }


        // Pesan BARU (bukan duplikat) — insert ke DB
        try {
            const { data: msgData } = await safeDbCall(
                () => supabase.from('messages').insert({
                    customer_id: customer.id,
                    wa_id: waMessageId,
                    message_hash: secureMessageHash,
                    body: message.body || (message.hasMedia ? '[Attachment Dokumen/Gambar]' : ''),
                    is_from_me: isFromMe,
                    created_at: msgTimestamp
                }).select().single(),
                'insertMessage'
            );
            messageRecord = msgData;
        } catch (msgError) {
            console.error("❌ ERROR FATAL INSERT DATABASE MESSAGE:", msgError.message);
            console.error("❌ ERROR FATAL INSERT DATABASE MESSAGE:", msgError.message);
        }
        if (message.hasMedia) {
            if (!isFromMe) {
                // [DISK GUARD v2] Cek apakah media bisa diterima
                // Logika baru: Jika Object Storage AKTIF → SELALU terima media (foto ke cloud, bukan disk)
                //              Jika Object Storage MATI (fallback disk) → cek disk usage
                let diskOk = true;
                try {
                    const objStorageActive = await objectStorage.isObjectStorageAvailable();
                    if (objStorageActive) {
                        // Object Storage aktif → foto ke cloud, disk tidak relevan
                        diskOk = true;
                    } else {
                        // Fallback ke disk → cek disk usage
                        const { execSync } = require('child_process');
                        const pct = parseInt(execSync("df / --output=pcent | tail -1").toString().trim(), 10);
                        if (pct >= 96) {
                            console.error(`[DISK-GUARD] 🚨 Disk ${pct}%! Object Storage MATI & disk penuh — Media dari ${customerPhoneNumber} DITOLAK sementara.`);
                            diskOk = false;
                            // Cleanup dengan cooldown 5 menit (cegah spam)
                            const now = Date.now();
                            if (!global._lastDiskCleanupTime || (now - global._lastDiskCleanupTime) > 5 * 60 * 1000) {
                                global._lastDiskCleanupTime = now;
                                console.log('[DISK-GUARD] 🧹 Memicu cleanup darurat (cooldown 5 menit)...');
                                cleanupService(true).catch(() => { });
                            }
                        }
                    }
                } catch (e) { /* df tidak tersedia di Windows dev, skip */ }

                if (diskOk) {
                    console.log(`[QUEUE] Menambahkan media dari ${customerPhoneNumber} ke antrian latar belakang (Prioritas: ${isPriority})...`);
                    mediaQueue.addToQueue(waMessageId, customer, msgTimestamp, isPriority, message);
                    
                    // [ANTI-SPAM FIX] Jangan trigger AI Bot jika ini adalah pesan lama hasil Gali Ulang/Resync
                    if (!skipCustomerUpdate) {
                        setImmediate(() => checkAndRespondMedia(client, customer, supabase));
                    }
                }
            } else {
                console.log(`[DEBUG] ⏭️ Media dari Bot/Admin dideteksi. Abaikan antrian.`);
            }
        }
        // ─── AI FOLLOW-UP: Alur teks — tagih no pesanan, konfirmasi foto, dst ──
        // Hanya berjalan untuk pesan TEKS dari customer (bukan media, bukan fromMe)
        if (!message.hasMedia && !isFromMe && customer) {
            // [ANTI-SPAM FIX] Jangan trigger AI Bot jika ini adalah pesan lama hasil Gali Ulang/Resync
            if (!skipCustomerUpdate) {
                await checkAndRespond(client, customer, message, supabase);
            }
        }
        // ───────────────────────────────────────────────────────────────────────

    } catch (error) {
        console.error('Terjadi error memproses pesan (Skip):', error);
    }
}


// [WATCHDOG LEVEL 1] Penjaga Inisialisasi
// Jika WA stuck loading lebih dari 3 menit tanpa QR atau Ready, paksa restart.
let initializationTimer = null;

client.on('qr', (qr) => {
    if (initializationTimer) clearTimeout(initializationTimer); // Jangan restart jika sedang tunggu QR
    qrCodeData = qr;
    isConnected = false;
    global.waConnected = false;
    global.waQrPending = true;
    console.log('New QR code generated - please scan');
    // Print QR ke terminal agar bisa scan langsung dari SSH
    try { qrcode.generate(qr, { small: true }); } catch (e) { }
});

client.on('ready', async () => {
    if (initializationTimer) clearTimeout(initializationTimer); // Matikan timer darurat
    console.log('✅ WhatsApp Client is ready!');
    isConnected = true;
    qrCodeData = '';
    global.waConnected = true;
    global.waQrPending = false;

    stability.start();
    await hydrateContactCache();

    // [PENDING-ORDER] Inject dependensi ke pending order service
    pendingOrderSvc.init(client, supabase);
    console.log('[SYSTEM] 📦 Pending Order Service siap — retry otomatis setiap 5 menit.');

    // [OBJECT-STORAGE] Cek koneksi object storage saat startup
    objectStorage.healthCheck().catch(() => { });

    // [STARTUP SYNC] DINONAKTIFKAN PERMANEN.
    // Menjalankan fetchMessages pada ribuan chat saat startup akan membekukan Chrome
    // sehingga pesan real-time tidak bisa masuk.
    // Gunakan backend/scripts/sweep.js untuk menyisir pesan secara manual.
    console.log('[SYNC] Startup Sync dinonaktifkan untuk menjaga kestabilan memori WhatsApp Web.');
    return;

    try {
        let chats = [];
        try {
            chats = await withTimeout(client.getChats(), 60000, 'getChats_startup');
        } catch (getChatsErr) {
            console.error('❌ Gagal mengambil daftar chat saat startup:', getChatsErr.message);
            return;
        }

        const targetDate = new Date();
        // [OPTIMASI EXTREME] Ubah dari 48 jam (2 hari) menjadi 6 jam saja!
        // Jika server mati sebentar, 6 jam sudah sangat cukup untuk mengejar chat yang terlewat.
        // 48 jam akan memaksa Chrome memproses ribuan chat, menyebabkan TIMEOUT dan CRASH.
        targetDate.setHours(targetDate.getHours() - 6);
        const limitTimestamp = Math.floor(targetDate.getTime() / 1000);
        console.log(`[SYNC] 🕐 Menyinkronkan pesan sejak: ${targetDate.toLocaleString('id-ID')} (6 Jam Terakhir) | Total chat: ${chats.length}`);

        let processedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (const chat of chats) {
            if (chat.isGroup || chat.id.user === 'status' || chat.id.user === 'broadcast') continue;

            // [OPT] Skip chat tanpa lastMessage atau pesan sudah lama — sebelum buka Chrome
            if (!chat.lastMessage || chat.lastMessage.timestamp < limitTimestamp) {
                skippedCount++;
                continue;
            }

            try {
                // Heartbeat per chat — reset Watchdog consecutiveFailures
                stability.heartbeat();

                // [OPT] Limit 15 (dari 30) — cukup untuk healing pesan-pesan terakhir yang terlewat, tidak memblokir event loop Chrome
                let historyMessages = [];
                try {
                    historyMessages = await chromeSemaphore.acquire('SYNC:fetchMessages', () => {
                        return withTimeout(
                            chat.fetchMessages({ limit: 15 }),
                            45000,
                            'fetchMessages_startup'
                        );
                    }, { priority: 2, timeout: 90000 });
                } catch (fetchErr) {
                    console.warn(`[SYNC] ⚠️ Skip chat ${chat.id.user}: ${fetchErr.message.substring(0, 60)}`);
                    errorCount++;
                    continue;
                }

                for (const msg of historyMessages) {
                    if (msg.timestamp >= limitTimestamp) {
                        processedCount++;
                        await processMessageCommand(msg, true);
                    }
                }

                // Log progress setiap 50 chat aktif
                const totalDone = processedCount + skippedCount + errorCount;
                if (totalDone > 0 && totalDone % 50 === 0) {
                    console.log(`[SYNC] 📊 Progress: ${totalDone}/${chats.length} | Pesan: ${processedCount} | Skip: ${skippedCount} | Err: ${errorCount}`);
                }

                // [CRITICAL FIX] Jeda 300ms setiap selesai 1 chat. 
                // Ini mencegah Node.js Event Loop dan main thread Chrome dari pembekuan (DDoS internal).
                await sleep(300);

            } catch (chatErr) {
                errorCount++;
                console.error(`⚠️ Gagal menyisir chat ${chat.id.user}:`, chatErr.message);
            }
        }
        console.log(`✅ [SYNC] Selesai! Diproses: ${processedCount} pesan | Dilewati: ${skippedCount} chat lama | Error: ${errorCount} chat`);
    } catch (e) {
        console.error('⚠️ Gagal total sinkronisasi pesan offline:', e.message);
    }
});


// [v3 SESSION-FIX] Reconnect handler dengan Exponential Backoff
// SEBELUMNYA: Langsung reinit setelah 10 detik → WA server curiga → session invalid → QR lagi
// SEKARANG: Backoff 15s → 30s → 60s, max 3 percobaan. Jika semua gagal → PM2 restart.
client.on('disconnected', async (reason) => {
    console.log(`[WA] ⚠️ WhatsApp Client disconnected: ${reason}`);
    isConnected = false;
    global.waConnected = false;
    stability.stop();

    // Jika LOGOUT (bukan sekedar disconnect jaringan), session sudah mati di server WA
    if (reason === 'LOGOUT') {
        console.log('[WA] 🔒 Session LOGOUT terdeteksi dari WhatsApp server. QR scan baru diperlukan.');
        console.log('[WA] ℹ️ Kemungkinan penyebab: unlink dari HP, atau akun mencapai batas linked device.');
        return; // Biarkan PM2 restart secara alami
    }

    // Disconnect sementara (jaringan putus, WA server maintenance, dll)
    // Gunakan Exponential Backoff agar WA server tidak menganggap suspicious
    const MAX_RECONNECT_ATTEMPTS = 3;
    const INITIAL_DELAY_MS = 15000; // 15 detik (bukan 10)

    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
        const delay = INITIAL_DELAY_MS * Math.pow(2, attempt - 1); // 15s → 30s → 60s
        console.log(`[WA] 🔄 Reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} dalam ${delay / 1000} detik...`);
        await sleep(delay);

        try {
            console.log(`[WA] 🔄 Menjalankan client.initialize() ulang (Attempt ${attempt})...`);
            await client.initialize();
            console.log(`[WA] ✅ Reconnect berhasil pada attempt ${attempt}!`);
            return; // Berhasil — keluar dari loop
        } catch (reinitErr) {
            console.error(`[WA] ❌ Attempt ${attempt} gagal: ${reinitErr.message}`);
            if (attempt === MAX_RECONNECT_ATTEMPTS) {
                console.error('[WA] 🔥 Semua percobaan reconnect habis. PM2 akan restart proses...');
                process.exit(1);
            }
        }
    }
});

// Gunakan message_create agar menangkap pesan dari kita juga (yang dikirim lewat HP)
client.on('message_create', async (message) => {
    // REAL-TIME selalu PRIORITAS UTAMA (isPriority = true)
    await processMessageCommand(message, false, true);
});

// Menangkap event Penghapusan Pesan (Tarik Pesan) secara Real-time
client.on('message_revoke_everyone', async (after, before) => {
    try {
        if (!after) return;

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
            // console.log(`❌ [REVOKE GAGAL] Pesan Hash ${targetHash} tidak ditemukan dalam penyimpanan DB.`);
            return;
        }

        if (dbMsg.is_deleted) {
            console.log(`⏭️ [REVOKE SKIP] Idempotent: Pesan Hash ${targetHash} sudah pernah ditandai terhapus.`);
            return;
        }

        // Poin 1 Lanjutan: Validasi Ruang Obrolan
        try {
            const chat = await withTimeout(after.getChat(), 60000, 'getChat_revoke');
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

        // LAYER 2: Hapus dari Object Storage/Disk (Non-Blocking). LAYER 3: Hapus DB Media
        const { data: mediaData } = await supabase.from('media').select('id, file_name, storage_key, storage_type').eq('message_id', dbMsg.id);
        if (mediaData && mediaData.length > 0) {
            for (const m of mediaData) {
                const storageType = m.storage_type || 'local';
                const storageKey = m.storage_key || m.file_name;
                await objectStorage.deleteMedia(storageKey, storageType).catch(e => {
                    console.log(`ℹ️ Media ${m.file_name} tidak dapat dihapus: ${e.message}`);
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

// Deep Resync Endpoint: Menjalankan di Background agar tidak timeout di sisi Client
app.post('/api/wa/deep-resync', async (req, res) => {
    const { start_date, end_date } = req.body;
    if (!isConnected) return res.status(400).json({ error: 'WhatsApp is not connected' });

    const startTs = Math.floor(new Date(start_date).getTime() / 1000);
    const endTs = end_date ? Math.floor(new Date(end_date).getTime() / 1000) : Math.floor(Date.now() / 1000);

    // Kirim respons segera (Background Task)
    res.json({
        success: true,
        message: 'Deep Resync dimulai di latar belakang. Pantau progres di PM2 Logs.'
    });

    // Jalankan proses di background
    (async () => {
        try {
            console.log(`[BACKGROUND-RESYNC] 🚀 Memulai penyisiran...`);
            const chats = await client.getChats();
            let totalProcessed = 0;

            for (const chat of chats) {
                if (chat.isGroup || chat.id.user === 'status') continue;
                if (chat.lastMessage && chat.lastMessage.timestamp < startTs) continue;

                console.log(`[BACKGROUND-RESYNC] Menyisir chat ${chat.id.user}...`);

                // [STABILITAS] Retry loop untuk menangani Detached Frame
                let success = false;
                let retries = 0;

                while (!success && retries < 2) {
                    try {
                        // Re-fetch chat object untuk menyegarkan Frame context jika ini adalah retry
                        const activeChat = (retries > 0) ? await client.getChatById(chat.id._serialized) : chat;
                        const messages = await withTimeout(activeChat.fetchMessages({ limit: 100 }), 30000, 'fetchMessages_deep');

                        for (const msg of messages) {
                            if (msg.timestamp >= startTs && msg.timestamp <= endTs) {
                                // Background Resync masal menggunakan Prioritas Normal (false)
                                await processMessageCommand(msg, false, false);
                                totalProcessed++;
                                await new Promise(r => setTimeout(r, 500));
                                stability.heartbeat();
                            }
                        }
                        success = true;
                    } catch (chatErr) {
                        retries++;
                        if (chatErr.message.includes('detached') || chatErr.message.includes('context')) {
                            console.warn(`[WATCHDOG] ⚠️ Detached frame detected pada ${chat.id.user}. Retrying (${retries}/2)...`);
                            await new Promise(r => setTimeout(r, 2000));
                        } else {
                            console.error(`[BACKGROUND-RESYNC ERROR] Chat ${chat.id.user}:`, chatErr.message);
                            break; // Keluar dari loop retry untuk error lain
                        }
                    }
                }
                await new Promise(r => setTimeout(r, 1000));
            }
            console.log(`[BACKGROUND-RESYNC] ✅ SELESAI. Total ${totalProcessed} pesan diproses.`);
        } catch (bgErr) {
            console.error(`[BACKGROUND-RESYNC] ❌ Terhenti vatal:`, bgErr.message);
        }
    })();
});

// ═══════════════════════════════════════════════════════════════════════════════
// [PRE-FLIGHT v3] Pembersihan Cache Chromium AMAN sebelum start
// ═══════════════════════════════════════════════════════════════════════════════
// KRITIS: Hanya hapus cache HTTP biasa (Cache, GPUCache).
//
// JANGAN PERNAH HAPUS:
//   - Service Worker  → Menyimpan token autentikasi WA Web (hapus = QR ulang)
//   - Code Cache      → Menyimpan compiled JS WA Web (hapus = session patah)
//   - IndexedDB       → Database session WA Web
//   - Local Storage   → State persistence WA Web
//   - Session Storage → Active session tokens
//
// Bug lama: clearBrowserCache() menghapus Service Worker + Code Cache
// → Setiap PM2 restart → session mati → harus scan QR lagi.
// ═══════════════════════════════════════════════════════════════════════════════
async function clearBrowserCache() {
    const authPath = path.join(__dirname, '.wwebjs_auth', 'session-crm-polaroid', 'Default');

    // [v3] HANYA cache yang AMAN dihapus (tidak mengandung auth token)
    const SAFE_TO_DELETE = [
        path.join(authPath, 'Cache'),          // HTTP cache biasa — AMAN
        path.join(authPath, 'GPUCache'),        // GPU shader cache — AMAN
        path.join(authPath, 'DawnGraphiteCache'), // Graphics cache — AMAN
        path.join(authPath, 'DawnWebGPUCache'),   // WebGPU cache — AMAN
    ];

    let cleaned = 0;
    let totalBytes = 0;
    for (const dir of SAFE_TO_DELETE) {
        if (fs.existsSync(dir)) {
            try {
                // Hitung ukuran sebelum hapus (untuk logging)
                const stat = await fs.promises.stat(dir).catch(() => null);
                await fs.promises.rm(dir, { recursive: true, force: true });
                cleaned++;
            } catch (e) { /* Abaikan jika file sedang terkunci oleh proses lain */ }
        }
    }

    // [v3] Bersihkan WAL files yang membengkak (>1MB = anomali, checkpoint gagal)
    // DIPS-wal yang membengkak bisa menyebabkan session corrupt saat load ulang
    const WAL_FILES = ['DIPS-wal', 'SharedStorage-wal'];
    for (const walName of WAL_FILES) {
        const walPath = path.join(authPath, walName);
        try {
            if (fs.existsSync(walPath)) {
                const stat = await fs.promises.stat(walPath);
                if (stat.size > 1 * 1024 * 1024) { // >1MB = anomali
                    console.warn(`[PRE-FLIGHT] ⚠️ WAL file ${walName} abnormal (${(stat.size / 1024).toFixed(0)}KB). Membersihkan...`);
                    await fs.promises.unlink(walPath);
                    cleaned++;
                }
            }
        } catch (e) { /* WAL mungkin terkunci, skip */ }
    }

    if (cleaned > 0) {
        console.log(`[PRE-FLIGHT] 🧹 ${cleaned} item cache browser berhasil dibersihkan (session data DIPERTAHANKAN).`);
    } else {
        console.log('[PRE-FLIGHT] ✅ Tidak ada cache yang perlu dibersihkan. Session data utuh.');
    }
}

// [v3] Verifikasi integritas session sebelum initialize
// Cek apakah file-file kritis session masih ada dan valid
function verifySessionIntegrity() {
    const sessionBase = path.join(__dirname, '.wwebjs_auth', 'session-crm-polaroid');
    const defaultPath = path.join(sessionBase, 'Default');

    // Cek keberadaan folder session
    if (!fs.existsSync(sessionBase)) {
        console.log('[SESSION-CHECK] 🆕 Tidak ada session tersimpan — QR scan pertama kali diperlukan.');
        return { exists: false, healthy: false };
    }

    // Cek file-file kritis untuk session yang valid
    const criticalPaths = [
        { path: path.join(defaultPath, 'Local Storage'), name: 'Local Storage' },
        { path: path.join(defaultPath, 'IndexedDB'), name: 'IndexedDB' },
        { path: path.join(defaultPath, 'Service Worker'), name: 'Service Worker' },
    ];

    let healthyCount = 0;
    for (const check of criticalPaths) {
        const exists = fs.existsSync(check.path);
        if (exists) healthyCount++;
        else console.warn(`[SESSION-CHECK] ⚠️ ${check.name} TIDAK DITEMUKAN — session mungkin invalid.`);
    }

    const isHealthy = healthyCount === criticalPaths.length;
    if (isHealthy) {
        console.log(`[SESSION-CHECK] ✅ Session integrity OK — semua ${criticalPaths.length} komponen kritis ditemukan.`);
    } else {
        console.warn(`[SESSION-CHECK] ⚠️ Session hanya ${healthyCount}/${criticalPaths.length} komponen kritis. QR scan ulang mungkin diperlukan.`);
    }

    return { exists: true, healthy: isHealthy, components: healthyCount, total: criticalPaths.length };
}

// Inisialisasi WA dengan Proteksi Penuh
(async () => {
    try {
        // [v3] Bersihkan HANYA cache aman (session data dipertahankan)
        await clearBrowserCache();

        // [v3] Verifikasi integritas session sebelum init
        const sessionStatus = verifySessionIntegrity();

        console.log('[SYSTEM] 🚀 Memulai inisialisasi WA Engine v3...');

        // [v3] Timer 7 menit (dari 3 menit). VPS yang sibuk butuh waktu lebih lama.
        // 3 menit terlalu agresif → timeout saat VPS high load → restart → QR lagi.
        const INIT_TIMEOUT_MS = 7 * 60 * 1000;
        initializationTimer = setTimeout(() => {
            console.error(`🔥 [FATAL] WA Engine nyangkut saat inisialisasi (Timeout ${INIT_TIMEOUT_MS / 60000} Menit). Memicu Auto-Restart...`);
            process.exit(1);
        }, INIT_TIMEOUT_MS);

        await client.initialize();
    } catch (error) {
        console.error('❌ [FATAL] Gagal menginisialisasi client WA:', error.message);
        process.exit(1);
    }
})();

// Health check endpoint (untuk monitoring + Cloudflare)
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        connected: isConnected,
        memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
        chrome: chromeSemaphore.getStats(),
    });
});

// Endpoint status
app.get('/api/wa/status', (req, res) => {
    res.json({
        connected: isConnected,
        qr: qrCodeData
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [v3] SESSION HEALTH ENDPOINT — Monitor kesehatan session WA secara detail
// ═══════════════════════════════════════════════════════════════════════════════
// Gunakan ini untuk debugging dan monitoring eksternal (cron, uptime checker).
// Menampilkan: status koneksi, watchdog stats, session integrity, uptime.
app.get('/api/wa/session-health', (req, res) => {
    try {
        const sessionStatus = verifySessionIntegrity();
        const watchdogStatus = stability.getStatus();
        const uptimeSeconds = process.uptime();

        const health = {
            // Status koneksi WA
            whatsapp: {
                connected: isConnected,
                hasQrPending: !!qrCodeData,
            },
            // Status session di disk
            session: sessionStatus,
            // Status watchdog
            watchdog: watchdogStatus,
            // Uptime proses Node.js
            process: {
                uptimeFormatted: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`,
                uptimeSeconds: Math.round(uptimeSeconds),
                memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                pid: process.pid,
            },
            // Media queue stats
            mediaQueue: {
                pending: mediaQueue.getPendingCount ? mediaQueue.getPendingCount() : 'N/A',
            },
            // Timestamp server
            timestamp: new Date().toISOString(),
        };

        // HTTP status code berdasarkan kesehatan
        const httpStatus = isConnected ? 200 : 503;
        res.status(httpStatus).json({ success: isConnected, ...health });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/wa/send', authenticateToken, async (req, res) => {
    const { phone_number, message, customer_id } = req.body;
    
    // [FIX] Validasi input — cegah kirim ke undefined atau pesan kosong
    if (!phone_number || typeof phone_number !== 'string' || !phone_number.trim()) {
        return res.status(400).json({ error: 'phone_number wajib diisi' });
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'message wajib diisi' });
    }
    
    if (!isConnected) return res.status(400).json({ error: 'WhatsApp is not connected' });

    try {
        // [FIX] Kirim via outgoingQueue (anti-spam system) — tidak bypass rate limiter
        // sendWAMessageDirect() menggunakan outgoingQueue.enqueue() dengan:
        // - Serial queue (1 pesan per waktu)
        // - Cooldown 45 detik per customer
        // - Hourly cap 40 pesan/jam
        // - Quiet hours 23:00–07:00 WIB
        await sendWAMessageDirect(client, phone_number, message);

        // [FIX] TIDAK perlu insert manual ke DB di sini!
        // Saat sendMessage berhasil, event 'message_create' otomatis terpicu
        // dan processMessageCommand() sudah menghandle insert ke tabel messages.
        // Insert manual di sini = DOBEL di web app (karena event handler juga insert).
        //
        // Update timestamp customer saja untuk sorting di dashboard
        if (customer_id) {
            await supabase.from('customers').update({ created_at: new Date().toISOString() }).eq('id', customer_id);
        }

        res.json({ success: true, message: 'Sent' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/wa/resync', async (req, res) => {
    const { phone_number, customer_id } = req.body;

    if (!phone_number) {
        return res.status(400).json({ error: 'phone_number diperlukan.' });
    }

    // Kirim respon awal (non-blocking) — frontend tidak perlu tunggu lama
    res.json({ success: true, message: 'Gali ulang dimulai. Foto akan muncul secara bertahap.' });

    // Proses di background (non-blocking)
    setImmediate(async () => {
        // Helper emit progress ke semua frontend yang terbuka (real-time update)
        const emitProgress = (event, data) => {
            try { if (global._io) global._io.emit(event, data); } catch (e) {}
        };

        emitProgress('resync_started', { phone_number, customer_id });

        try {
            // Tunggu WA siap — retry 3x tiap 10 detik
            let ready = isConnected;
            if (!ready) {
                console.log(`[RESYNC] ⏳ WA belum konek, tunggu max 30 detik...`);
                for (let attempt = 1; attempt <= 3; attempt++) {
                    await new Promise(r => setTimeout(r, 10000));
                    if (isConnected) { ready = true; break; }
                    console.log(`[RESYNC] ⏳ Attempt ${attempt}/3 — masih menunggu koneksi...`);
                }
            }

            if (!ready) {
                console.error(`[RESYNC] ❌ ${phone_number}: WA masih tidak konek setelah 30 detik. Batal.`);
                emitProgress('resync_done', { phone_number, customer_id, totalMessages: 0, totalMedia: 0, error: 'WA tidak konek' });
                return;
            }

            // [UPGRADE GALI ULANG v3] - Multi-ChatID Resolution (LID & C.US)
            // Banyak kasus di mana 50 foto masuk lewat @lid (Facebook Ads), lalu 50 foto sisanya lewat @c.us (setelah dibalas)
            // Jika kita hanya melacak 1 Chat ID, 50 foto lainnya akan gaib. Kita harus menyisir SEMUA Chat ID milik pelanggan ini!
            let chatIdsToSync = new Set([phone_number + '@c.us']);
            try {
                const { data: dbMsgs } = await supabase.from('messages')
                    .select('wa_id')
                    .eq('customer_id', customer_id)
                    .not('wa_id', 'is', null);
                    
                if (dbMsgs && dbMsgs.length > 0) {
                    for (const msg of dbMsgs) {
                        if (msg.wa_id) {
                            const parts = msg.wa_id.split('_');
                            if (parts.length >= 2) {
                                chatIdsToSync.add(parts[1]); // Masukkan semua unik Chat ID (baik @lid maupun @c.us)
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn('[RESYNC] ⚠️ Gagal melacak Real Chat ID dari DB, fallback ke standar.');
            }

            console.log(`[RESYNC] 🎯 Ditemukan ${chatIdsToSync.size} titik riwayat (LID/C.US) untuk ${phone_number}. Akan menggali semuanya...`);
            emitProgress('resync_progress', { phone_number, message: `Ditemukan ${chatIdsToSync.size} titik riwayat chat. Menggali semua...` });

            let totalPesanDiproses = 0;
            let totalMediaDitemukan = 0;
            const processedMsgIds = new Set(); // Global deduplication across all targets

            for (const targetChatId of chatIdsToSync) {
                console.log(`[RESYNC] 🔍 Menggali: ${phone_number} (Target: ${targetChatId})`);
                emitProgress('resync_progress', { phone_number, message: `Mengambil riwayat dari ${targetChatId}...` });
                
                try {
                    const chat = await chromeSemaphore.acquire('API:resync_getChat', () => {
                        return withTimeout(client.getChatById(targetChatId), 30000, 'getChatById_resync');
                    }, { priority: 2, timeout: 40000 });

                    // ═══════════════════════════════════════════════════════════════
                    // [GALI ULANG v9] DOUBLE-ATTEMPT OPEN CHAT (SEARCH & SIDEBAR)
                    // ═══════════════════════════════════════════════════════════════
                    // Untuk mengatasi chat yang tidak ada di daftar sidebar teratas,
                    // kita coba cari via Search Box dulu. Jika gagal, baru sisir sidebar.
                    // ═══════════════════════════════════════════════════════════════
                    let openResult = 'NOT_ATTEMPTED';

                    // 🛠️ CARA 1: Gunakan Kolom Pencarian (Search Box)
                    try {
                        emitProgress('resync_progress', { phone_number, message: `Mencari chat ${phone_number} via kolom pencarian...` });
                        
                        const searchStatus = await client.pupPage.evaluate(async (phone) => {
                            try {
                                const searchBox = document.querySelector('div[contenteditable="true"][data-tab="3"]') || 
                                                  document.querySelector('div[title="Search or start new chat"]') ||
                                                  document.querySelector('div[aria-label="Search or start new chat"]');
                                                  
                                if (!searchBox) return 'NO_SEARCH_BOX';
                                
                                searchBox.focus();
                                document.execCommand('selectAll', false, null);
                                document.execCommand('delete', false, null);
                                document.execCommand('insertText', false, phone);
                                
                                return 'TYPED';
                            } catch (e) {
                                return 'ERROR: ' + e.message;
                            }
                        }, phone_number);

                        console.log(`[RESYNC] 🔍 Search box status:`, searchStatus);

                        if (searchStatus === 'TYPED') {
                            // Tunggu hasil pencarian muncul di layar
                            await new Promise(r => setTimeout(r, 2500));
                            
                            const clickStatus = await client.pupPage.evaluate((phone) => {
                                try {
                                    // Cari di hasil pencarian yang muncul
                                    const elements = Array.from(document.querySelectorAll('div[data-id]'));
                                    const chatElem = elements.find(el => el.getAttribute('data-id').includes(phone));
                                    if (chatElem) {
                                        chatElem.click();
                                        return 'SUCCESS_SEARCH_CLICK';
                                    }
                                    return 'SEARCH_RESULT_NOT_FOUND';
                                } catch (e) {
                                    return 'ERROR_CLICK: ' + e.message;
                                }
                            }, phone_number);
                            
                            console.log(`[RESYNC] 📱 Click search result status:`, clickStatus);
                            if (clickStatus === 'SUCCESS_SEARCH_CLICK') {
                                openResult = 'SUCCESS_VIA_SEARCH';
                            }
                        }
                    } catch (searchErr) {
                        console.log(`[RESYNC] ⚠️ Gagal metode search box:`, searchErr.message);
                    }

                    // 🛠️ CARA 2: Sisir Sidebar (Jika Cara 1 gagal)
                    if (!openResult.includes('SUCCESS')) {
                        emitProgress('resync_progress', { phone_number, message: `Chat tidak ketemu di pencarian. Menyisir sidebar secara agresif...` });
                        
                        openResult = await client.pupPage.evaluate((chatId) => {
                            try {
                                const phonePart = chatId.split('@')[0];
                                
                                // Sub-Cara A: Cari berdasarkan data-id
                                const elements = Array.from(document.querySelectorAll('div[data-id]'));
                                const chatElem = elements.find(el => el.getAttribute('data-id').includes(chatId));
                                if (chatElem) {
                                    chatElem.click();
                                    return 'SUCCESS_DATA_ID';
                                }
                                
                                // Sub-Cara B: Cari berdasarkan teks nomor di semua span
                                const spans = Array.from(document.querySelectorAll('span'));
                                const targetSpan = spans.find(s => s.innerText && s.innerText.includes(phonePart));
                                if (targetSpan) {
                                    let el = targetSpan;
                                    for (let i = 0; i < 7; i++) {
                                        if (el.hasAttribute('data-id') || el.getAttribute('role') === 'row') {
                                            el.click();
                                            return 'SUCCESS_DOM_PARENT';
                                        }
                                        if (el.parentElement) el = el.parentElement;
                                        else break;
                                    }
                                    targetSpan.click();
                                    return 'SUCCESS_DIRECT_SPAN';
                                }
                                
                                return 'CHAT_ELEMENT_NOT_FOUND';
                            } catch (e) {
                                return 'ERROR: ' + e.message;
                            }
                        }, targetChatId);
                        
                        console.log(`[RESYNC] 📱 Hasil sisir sidebar untuk ${targetChatId}:`, openResult);
                    }

                    if (openResult.includes('SUCCESS')) {
                        // Tunggu jendela chat terbuka sempurna
                        await new Promise(r => setTimeout(r, 2000));

                        // 2. Scroll ke atas beberapa kali untuk memicu loadEarlier
                        let scrollAttempts = 0;
                        const MAX_SCROLLS = 5;
                        emitProgress('resync_progress', { phone_number, message: `Men-scroll riwayat ke atas...` });

                        while (scrollAttempts < MAX_SCROLLS) {
                            scrollAttempts++;
                            
                            const scrolled = await client.pupPage.evaluate(() => {
                                try {
                                    // Cari kontainer pesan yang scrollable
                                    const divs = Array.from(document.querySelectorAll('div'));
                                    const scrollable = divs.find(el => {
                                        const style = window.getComputedStyle(el);
                                        return (style.overflowY === 'scroll' || style.overflowY === 'auto') && 
                                               el.scrollHeight > el.clientHeight;
                                    });
                                    
                                    if (scrollable) {
                                        scrollable.scrollTop = 0; // Scroll ke paling atas
                                        return true;
                                    }
                                    return false;
                                } catch (e) {
                                    return false;
                                }
                            });

                            console.log(`[RESYNC] 📜 Scroll up attempt ${scrollAttempts}:`, scrolled);
                            if (!scrolled) break;

                            // Tunggu loading spinner WA selesai memuat pesan baru
                            await new Promise(r => setTimeout(r, 1500));
                        }
                    } else {
                        console.log(`[RESYNC] ⚠️ Gagal membuka chat di UI, lanjut tarik apa adanya.`);
                    }

                    // ─────────────────────────────────────────────────────────────────
                    // [F2-FEAT3] DEEP PAGINATION — loadEarlierMessages() Loop
                    // Untuk customer dengan 1000+ foto, fetchMessages({ limit: 1500 })
                    // tidak cukup. loadEarlierMessages() scroll ke atas dan memuat lebih banyak.
                    // MAX_ITER=40 → bisa tangkap hingga ~2000-4000 pesan per chat.
                    // ─────────────────────────────────────────────────────────────────
                    console.log('[RESYNC] 📥 Mengambil pesan awal (100 terakhir)...');
                    let allMessagesForTarget = await chromeSemaphore.acquire('API:resync_fetchInit', () => {
                        return withTimeout(chat.fetchMessages({ limit: 100 }), 60000, 'fetchMessages_init');
                    }, { priority: 2, timeout: 90000 });

                    let prevCount = allMessagesForTarget.length;
                    const MAX_ITER = 40; // 40 iterasi × ~50-100 pesan = 2000-4000 pesan
                    let deepIter = 0;

                    emitProgress('resync_progress', { phone_number, message: 'Menggali pesan-pesan lama (Deep Pagination)...' });

                    while (deepIter < MAX_ITER) {
                        deepIter++;
                        try {
                            // Muat pesan lebih lama dari WA server
                            const hasMore = await chromeSemaphore.acquire('API:resync_loadEarlier', () => {
                                return withTimeout(chat.loadEarlierMessages(), 25000, 'loadEarlier_' + deepIter);
                            }, { priority: 2, timeout: 35000 });

                            // Tunggu WA selesai render pesan baru
                            await new Promise(r => setTimeout(r, 1200));

                            // Ambil semua pesan yang sekarang tersedia di memori WA
                            const refreshed = await chromeSemaphore.acquire('API:resync_refresh', () => {
                                return withTimeout(chat.fetchMessages({ limit: 8000 }), 90000, 'fetchMessages_refresh_' + deepIter);
                            }, { priority: 2, timeout: 120000 });

                            const newFound = refreshed.length - prevCount;

                            if (newFound > 0) {
                                allMessagesForTarget = refreshed;
                                prevCount = refreshed.length;
                                emitProgress('resync_progress', {
                                    phone_number,
                                    message: 'Iterasi ' + deepIter + ': ' + refreshed.length + ' pesan total (+' + newFound + ' baru)'
                                });
                            }

                            // Berhenti jika tidak ada pesan baru atau WA bilang tidak ada lagi
                            if (!hasMore || newFound === 0) {
                                console.log('[RESYNC] 🏁 Deep pagination selesai di iterasi ' + deepIter + ': ' + allMessagesForTarget.length + ' pesan total.');
                                break;
                            }

                            await new Promise(r => setTimeout(r, 600)); // Jeda antar iterasi
                        } catch (loadErr) {
                            console.warn('[RESYNC] ⚠️ loadEarlier iterasi ' + deepIter + ' gagal:', loadErr.message);
                            break; // Stop gracefully jika error
                        }
                    }

                    if (deepIter >= MAX_ITER) {
                        console.log('[RESYNC] ⚠️ Mencapai batas iterasi (' + MAX_ITER + 'x). Total: ' + allMessagesForTarget.length + ' pesan. Ada kemungkinan pesan lebih lama belum terbaca.');
                        emitProgress('resync_progress', { phone_number, message: 'Catatan: Batas iterasi tercapai. Pesan sangat lama mungkin tidak terbaca semua.' });
                    }

                    console.log('[RESYNC] 📊 Total dari ' + targetChatId + ': ' + allMessagesForTarget.length + ' pesan (setelah ' + deepIter + ' iterasi deep pagination)');

                    // Build cached context SEKALI saja sebelum loop pemrosesan
                    let cachedContext = null;
                    try {
                        let resolvedPhone = chat.id.user;
                        let pushname = 'Pelanggan';
                        let lidNet = false;
                        
                        if (chat.id && (chat.id.server === 'lid' || chat.id._serialized.includes('@lid'))) {
                            lidNet = true;
                        }
                        
                        resolvedPhone = await resolveIdentifier(chat.id._serialized, chat);
                        try {
                            const contact = await withTimeout(chat.getContact(), 5000, 'getPushname');
                            if (contact && contact.pushname) pushname = contact.pushname;
                        } catch (e) {}

                        cachedContext = {
                            chat: chat,
                            customerPhoneNumber: resolvedPhone,
                            contactPushname: pushname,
                            isLidNetwork: lidNet
                        };
                        console.log(`[RESYNC] ⚡ Cached Context: ${resolvedPhone} (LID: ${lidNet})`);
                    } catch (e) {
                        console.log(`[RESYNC] ⚠️ Gagal build cached context: ${e.message}`);
                    }

                    let count = 0;
                    for (const msg of allMessagesForTarget) {
                        // 1. DEDUPLIKASI GLOBAL: Jika sudah diproses di target sebelumnya, skip!
                        if (processedMsgIds.has(msg.id._serialized)) continue;
                        processedMsgIds.add(msg.id._serialized);

                        // 2. Filter pesan sistem kosong
                        if (msg.type === 'unknown' && !msg.hasMedia && !msg.body) continue;
                        if (msg.type === 'e2e_notification') continue;
                        if (msg.type === 'notification_template') continue;

                        await processMessageCommand(msg, true, false, cachedContext);
                        count++;
                        if (msg.hasMedia && !msg.fromMe) totalMediaDitemukan++;
                        totalPesanDiproses++;
                    }

                    console.log(`[RESYNC] ✅ ${count} pesan baru diproses dari titik ${targetChatId}.`);
                } catch (err) {
                    console.error(`[RESYNC ERROR] Gagal menyisir titik ${targetChatId}:`, err.message);
                    emitProgress('resync_progress', { phone_number, message: `⚠️ Gagal baca ${targetChatId}: ${err.message}` });
                }
            }

            // [HEALING PASS] Cari media di DB yg sudah tercatat tapi belum ter-upload
            // [FIX] Pakai raw SQLite (db) langsung — BUKAN supabase shim yang tidak support .is()
            try {
                const missingMedia = db.prepare(
                    `SELECT m.id, m.message_id, m.storage_key
                     FROM media m
                     WHERE m.customer_id = ?
                       AND (m.storage_key IS NULL OR m.storage_key = '')`
                ).all(customer_id);

                if (missingMedia && missingMedia.length > 0) {
                    console.log(`[RESYNC] 🩹 HEALING: ${missingMedia.length} media di DB belum ter-upload. Memasukkan ulang ke antrean...`);
                    emitProgress('resync_progress', { phone_number, message: `🩹 Ditemukan ${missingMedia.length} foto yg pernah gagal diunduh. Mencoba lagi...` });

                    const custData = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id);
                    if (custData) {
                        for (const m of missingMedia) {
                            try {
                                const msgRecord = db.prepare('SELECT wa_id, created_at FROM messages WHERE id = ?').get(m.message_id);
                                if (msgRecord && msgRecord.wa_id) {
                                    mediaQueue.addToQueue(
                                        msgRecord.wa_id,
                                        custData,
                                        msgRecord.created_at || new Date().toISOString(),
                                        true // PRIORITY: langsung ke depan antrean!
                                    );
                                }
                            } catch (healItemErr) { /* skip item gagal */ }
                        }
                    }
                }
            } catch (healingErr) {
                console.warn(`[RESYNC] ⚠️ Healing pass gagal:`, healingErr.message);
            }


            // ═══════════════════════════════════════════════════════════════════
            // [F1-BUG4] POST-RESYNC ORDER DETECTION PASS
            // Scan semua pesan text yang sudah disimpan ke DB — cari nomor pesanan
            // yang tidak terdeteksi sebelumnya (karena skipCustomerUpdate=true saat resync).
            // ═══════════════════════════════════════════════════════════════════
            if (customer_id) {
                try {
                    const freshCustomer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id);
                    if (freshCustomer && !freshCustomer.order_id) {
                        // Ambil semua pesan teks customer dari DB
                        const savedMessages = db.prepare(
                            `SELECT body FROM messages WHERE customer_id = ? AND is_from_me = 0 ORDER BY created_at ASC`
                        ).all(customer_id);

                        let foundOrderInOldMessages = null;
                        for (const msgRow of savedMessages) {
                            const foundId = detectOrderId(msgRow.body);
                            if (foundId) {
                                foundOrderInOldMessages = foundId;
                                break; // Gunakan yang pertama ditemukan
                            }
                        }

                        if (foundOrderInOldMessages) {
                            console.log(`[RESYNC] 🔎 Post-resync: Ditemukan order ID dari pesan lama: ${foundOrderInOldMessages}`);
                            emitProgress('resync_progress', { phone_number, message: `🔎 Nomor pesanan ditemukan di pesan lama: ${foundOrderInOldMessages}` });

                            db.prepare('UPDATE customers SET order_id = ? WHERE id = ?').run(foundOrderInOldMessages, customer_id);

                            // Langsung lookup di spreadsheet
                            try {
                                const lookup = await lookupOrder(foundOrderInOldMessages, { bypassCache: true });
                                if (lookup && lookup.found && !lookup.cancelled) {
                                    db.prepare('UPDATE customers SET resi = ?, store_name = ?, order_detail = ? WHERE id = ?')
                                        .run(lookup.resi, lookup.storeName, JSON.stringify(lookup.items), customer_id);

                                    // Lepas foto yang WAITING_RESI ke PENDING
                                    db.prepare(`
                                        UPDATE drive_upload_queue
                                        SET status = 'PENDING', resi = ?, store_name = ?, updated_at = datetime('now')
                                        WHERE customer_id = ? AND status = 'WAITING_RESI'
                                    `).run(lookup.resi, lookup.storeName, customer_id);

                                    emitProgress('resync_progress', { phone_number, message: `✅ Pesanan terhubung: ${lookup.storeName} | Resi: ${lookup.resi}` });
                                    console.log(`[RESYNC] ✅ Post-resync order lookup sukses: ${lookup.storeName} | ${lookup.resi}`);
                                }
                            } catch (lookupErr) {
                                console.warn('[RESYNC] ⚠️ Post-resync lookup gagal:', lookupErr.message);
                            }
                        }
                    }
                } catch (orderDetectErr) {
                    console.warn('[RESYNC] ⚠️ Post-resync order detection gagal:', orderDetectErr.message);
                }
            }

            const summary = `Gali Ulang selesai! ${totalPesanDiproses} pesan diproses, ${totalMediaDitemukan} foto/video ditemukan dan dimasukkan ke antrean download.`;
            console.log(`[RESYNC] 🏆 ${summary}`);
            emitProgress('resync_done', { 
                phone_number, 
                customer_id,
                totalMessages: totalPesanDiproses, 
                totalMedia: totalMediaDitemukan,
                message: summary
            });
        } catch (err) {
            console.error(`[RESYNC ERROR] ${phone_number}:`, err.message);
            emitProgress('resync_done', { phone_number, customer_id, totalMessages: 0, totalMedia: 0, error: err.message });
        }
    });
});




// ─── Bulk Resync (Gali Ulang Massal dari Dashboard) ──────────────────────────
// [F3-FEAT3] Proses sequential untuk max 20 customer sekaligus.
// Setiap customer diresync menggunakan logika yang sama dengan resync individual.
// Emits: bulk_resync_progress, bulk_resync_done via Socket.IO
app.post('/api/wa/bulk-resync', async (req, res) => {
    const { customer_ids } = req.body;

    if (!customer_ids || !Array.isArray(customer_ids) || customer_ids.length === 0) {
        return res.status(400).json({ error: 'customer_ids (array) diperlukan.' });
    }
    if (customer_ids.length > 20) {
        return res.status(400).json({ error: 'Maksimal 20 customer per batch. Kurangi pilihan Anda.' });
    }
    if (!isConnected) {
        return res.status(503).json({ error: 'WhatsApp belum konek. Tunggu WA terhubung dulu.' });
    }

    // Ambil data customer dari DB
    const customers = [];
    for (const cid of customer_ids) {
        const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(cid);
        if (c) customers.push(c);
    }

    if (customers.length === 0) {
        return res.status(404).json({ error: 'Customer tidak ditemukan di database.' });
    }

    // Respons langsung — proses di background
    res.json({
        success: true,
        message: 'Gali Ulang Massal dimulai untuk ' + customers.length + ' customer. Progress akan tampil real-time di dashboard.',
        count: customers.length
    });

    setImmediate(async () => {
        const emitBulk = (event, data) => {
            try { if (global._io) global._io.emit(event, data); } catch (e) {}
        };

        emitBulk('bulk_resync_started', { total: customers.length, customer_ids });
        console.log('[BULK-RESYNC] 🔄 Memulai Gali Ulang Massal untuk ' + customers.length + ' customer...');

        let done = 0;
        let totalMedia = 0;

        for (const customer of customers) {
            try {
                emitBulk('bulk_resync_progress', {
                    current: done + 1,
                    total: customers.length,
                    customer_id: customer.id,
                    phone_number: customer.phone_number,
                    name: customer.name,
                    message: 'Menggali ulang: ' + (customer.name || customer.phone_number) + ' (' + (done + 1) + '/' + customers.length + ')'
                });

                // Trigger resync untuk customer ini via internal HTTP call (reuse logic)
                const resyncUrl = 'http://localhost:' + (process.env.PORT || 3001) + '/api/wa/resync';
                const http = require('http');
                const payload = JSON.stringify({ phone_number: customer.phone_number, customer_id: customer.id });

                await new Promise((resolve) => {
                    const reqHttp = http.request(resyncUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                    }, (httpRes) => {
                        httpRes.resume();
                        httpRes.on('end', resolve);
                    });
                    reqHttp.on('error', resolve); // non-fatal
                    reqHttp.write(payload);
                    reqHttp.end();
                });

                // Tunggu resync selesai via event (max 5 menit per customer)
                await new Promise((resolve) => {
                    const timeout = setTimeout(resolve, 5 * 60 * 1000); // 5 menit timeout
                    const handler = (data) => {
                        if (data.phone_number === customer.phone_number || data.customer_id === customer.id) {
                            clearTimeout(timeout);
                            if (data.totalMedia) totalMedia += (data.totalMedia || 0);
                            if (global._io) global._io.off('resync_done', handler);
                            resolve();
                        }
                    };
                    if (global._io) global._io.on('resync_done', handler);
                    else setTimeout(resolve, 30000); // fallback jika socket tidak ada
                });

                done++;
                await new Promise(r => setTimeout(r, 2000)); // Jeda 2 detik antar customer

            } catch (err) {
                console.warn('[BULK-RESYNC] ⚠️ Skip ' + customer.phone_number + ': ' + err.message);
                done++;
            }
        }

        const summary = 'Gali Ulang Massal selesai! ' + done + '/' + customers.length + ' customer diproses, ' + totalMedia + ' media ditemukan.';
        console.log('[BULK-RESYNC] 🏆 ' + summary);
        emitBulk('bulk_resync_done', { total: customers.length, done, totalMedia, message: summary });
    });
});

app.post('/api/wa/global-sweep', async (req, res) => {
    res.json({ success: true, message: 'Global Sweep dimulai di latar belakang. Proses ini akan menyisir semua chat aktif dan menarik foto yang terlewat.' });

    setImmediate(async () => {
        try {
            console.log(`[GLOBAL-SWEEP] 🌍 Memulai penyisiran massal ke semua chat...`);
            
            // Ambil semua chat yang ada di sidebar WhatsApp Web
            const chats = await chromeSemaphore.acquire('API:getChats', () => {
                return withTimeout(client.getChats(), 60000, 'getChats_global');
            }, { priority: 2, timeout: 90000 });

            console.log(`[GLOBAL-SWEEP] Ditemukan ${chats.length} chat. Mulai memfilter dan menyisir...`);

            let processedChats = 0;
            let totalMediaProcessed = 0;

            for (const chat of chats) {
                // Abaikan grup dan broadcast
                if (chat.isGroup || chat.id.user === 'status' || chat.id.user === 'broadcast') continue;

                console.log(`[GLOBAL-SWEEP] 🔍 Menyisir chat: ${chat.name || chat.id.user}`);
                
                try {
                    // Ambil 200 pesan terakhir dari setiap chat agar riwayat 2-3 hari lalu aman
                    const historyMessages = await chromeSemaphore.acquire('API:sweep_fetchMsg', () => {
                        return withTimeout(chat.fetchMessages({ limit: 200 }), 60000, 'fetchMessages_sweep');
                    }, { priority: 3, timeout: 90000 });

                    for (const msg of historyMessages) {
                        // Prioritaskan hanya pesan yang memiliki media (foto/video/dokumen)
                        if (msg.hasMedia) {
                            await processMessageCommand(msg, true, false);
                            totalMediaProcessed++;
                        }
                    }
                    processedChats++;
                } catch (err) {
                    console.error(`[GLOBAL-SWEEP] ⚠️ Lewati chat ${chat.id.user}:`, err.message);
                }
            }

            console.log(`[GLOBAL-SWEEP] ✅ SELESAI! Berhasil menyisir ${processedChats} chat dan memproses ${totalMediaProcessed} media terlewat.`);
        } catch (err) {
            console.error(`[GLOBAL-SWEEP] ❌ Gagal total:`, err.message);
        }
    });
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
                // FASE 1: Hapus media dari Object Storage/Disk (Zero Leakage)
                const { data: custMedia } = await supabase
                    .from('media')
                    .select('id, file_name, storage_key, storage_type')
                    .eq('customer_id', customerId);
                if (custMedia && custMedia.length > 0) {
                    for (const m of custMedia) {
                        const sType = m.storage_type || 'local';
                        const sKey = m.storage_key || m.file_name;
                        await objectStorage.deleteMedia(sKey, sType).catch(() => { });
                    }
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
const {
    scanImageForOrderId,
    scanImageBufferForOrderId,
    markMediaAsOrderProof,
    continueOrderFlowFromDetectedImage,
    deleteMediaBulk
} = require('./services/media_service');

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
            .select('id, file_name, file_url, storage_type, customer_id')
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
        if (media.storage_type !== 'object' && !fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File fisik tidak ditemukan di server. Coba resync terlebih dahulu.' });
        }

        console.log(`[MEDIA-SCAN] 🔍 Memindai gambar ${media.file_name} untuk Customer ${customer_id}...`);
        let result;
        if (media.storage_type === 'object' && media.file_url) {
            const response = await fetch(media.file_url, { signal: AbortSignal.timeout(60000) });
            if (!response.ok) {
                return res.status(502).json({ error: `Gagal mengambil gambar dari storage: HTTP ${response.status}` });
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            const ext = (media.file_name || media.file_url || 'jpg').split('.').pop();
            result = await scanImageBufferForOrderId(buffer, ext, { model: 'gpt-4o', detail: 'high' });
        } else {
            result = await scanImageForOrderId(filePath);
        }

        if (result.found) {
            markMediaAsOrderProof(media.id, result.orderId, 'manual_scan_order_id');

            const { data: custData } = await supabase.from('customers').select('*').eq('id', customer_id).single();
            if (custData && isConnected) {
                await continueOrderFlowFromDetectedImage({
                    waClient: client,
                    supabase,
                    customer: custData,
                    orderId: result.orderId,
                });
            } else {
                await supabase.from('customers').update({ order_id: result.orderId }).eq('id', customer_id);
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
        // [FIX] Sertakan storage_key & storage_type agar file terhapus dari tempat yang benar
        const { data: mediaItems, error: fetchErr } = await supabase
            .from('media')
            .select('id, file_name, storage_key, storage_type')
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
// POST /api/media/exclude-bulk — Tandai foto dikecualikan dari produksi (file TIDAK dihapus)
app.post('/api/media/exclude-bulk', async (req, res) => {
    const { media_ids, customer_id } = req.body;
    if (!Array.isArray(media_ids) || media_ids.length === 0 || !customer_id) {
        return res.status(400).json({ error: 'media_ids (array) dan customer_id diperlukan.' });
    }
    try {
        const { error } = await supabase
            .from('media')
            .update({ excluded_from_production: true })
            .in('id', media_ids)
            .eq('customer_id', customer_id);
        if (error) throw error;
        console.log('[MEDIA-EXCLUDE] OK ' + media_ids.length + ' foto dikecualikan — customer ' + customer_id);
        return res.json({ success: true, excluded: media_ids.length });
    } catch (err) {
        console.error('[MEDIA-EXCLUDE] Error:', err.message);
        return res.status(500).json({ error: 'Gagal mengecualikan media: ' + err.message });
    }
});

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

// ── API: Media Proxy ────────────────────────────────────────────────────────
// Proxy gambar melalui backend agar frontend tidak kena CORS
// saat download ZIP dari Object Storage domain yang berbeda.
// GET /api/media/proxy/:mediaId
app.get('/api/media/proxy/:mediaId', async (req, res) => {
    try {
        const { mediaId } = req.params;
        const { data: media } = await supabase
            .from('media')
            .select('file_url, file_name, storage_type')
            .eq('id', mediaId)
            .single();

        if (!media) return res.status(404).json({ error: 'Media tidak ditemukan' });

        // Jika file lokal, langsung kirim dari disk
        if (media.storage_type === 'local' || !media.storage_type) {
            const filePath = path.join(__dirname, 'uploads', media.file_name);
            if (fs.existsSync(filePath)) {
                return res.sendFile(filePath);
            }
        }

        // Jika object storage, fetch dan stream ke client
        const response = await fetch(media.file_url);
        if (!response.ok) {
            return res.status(502).json({ error: 'Gagal mengambil file dari storage' });
        }

        // Forward content type
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache 24 jam

        // Stream response body ke client
        const buffer = await response.arrayBuffer();
        res.send(Buffer.from(buffer));

    } catch (err) {
        console.error('[MEDIA-PROXY] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── API: Pending Order Stats ───────────────────────────────────────────────
// GET /api/pending-orders/stats — Monitor berapa order yang masih antri
app.get('/api/pending-orders/stats', (req, res) => {
    try {
        const stats = pendingOrderSvc.getPendingStats();
        res.json({ success: true, ...stats });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3001;
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
setIo(io);
global._io = io; // [UPGRADE] Expose globally agar resync/emergency bisa emit progress ke frontend

io.on('connection', (socket) => {
    console.log('[SOCKET] Frontend Client connected');
    socket.on('disconnect', () => {
        // silent disconnect — normal saat browser refresh
    });
});

global.serverStartTime = Date.now();
global.waConnected = false;
global.waQrPending = false;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend WA Engine & API running on port ${PORT}`);

    // ── THE JANITOR: Cleanup rutin setiap jam 02:00 pagi ──────────────────
    cron.schedule('0 2 * * *', () => {
        console.log('[CRON] 🕐 Menjalankan cleanup rutin jam 02:00...');
        cleanupService(false).catch(e => console.error('[CRON] Cleanup error:', e.message));
    });
    console.log('🧹 The Janitor v4 dijadwalkan: cleanup rutin jam 02:00 pagi.');

    // ── PENDING ORDER RETRY: Cek setiap 5 menit ────────────────────────────
    // Jika customer kirim nomor pesanan sebelum tim update spreadsheet,
    // sistem akan retry otomatis sampai 6x (30 menit total).
    cron.schedule('*/5 * * * *', async () => {
        if (!isConnected) return; // Jangan proses jika WA belum konek
        // [FIX] Jangan proses saat startup sync — Chrome penuh, sendMessage akan timeout
        if (stability.isBusy()) {
            console.log('[PENDING-ORDER] ⏳ Sistem BUSY (startup sync) — pending order ditunda.');
            return;
        }
        try {
            await pendingOrderSvc.processPendingOrders();
        } catch (e) {
            console.error('[CRON] Pending order retry error:', e.message);
        }
    });
    console.log('📦 Pending Order Retry aktif: cek setiap 5 menit, max 30 menit per order.');

    // ── DISK MONITOR: Cek setiap 1 jam, darurat jika >90% ─────────────────
    cron.schedule('0 * * * *', () => {
        try {
            const { execSync } = require('child_process');
            const pct = parseInt(execSync("df / --output=pcent | tail -1").toString().trim(), 10);
            if (pct >= 90) {
                console.error(`[DISK-MONITOR] 🚨 Disk ${pct}%! Cleanup darurat dijalankan...`);
                cleanupService(true).catch(e => console.error('[DISK-MONITOR] Cleanup error:', e.message));
            } else if (pct >= 80) {
                console.warn(`[DISK-MONITOR] ⚠️ Disk ${pct}% — mendekati batas aman.`);
            }
        } catch (e) { /* silent — df mungkin tidak tersedia di Windows */ }
    });
    console.log('💾 Disk Monitor aktif: cek tiap jam, cleanup darurat otomatis jika >90%.');

    // ── GOOGLE DRIVE UPLOAD: Proses antrian setiap 30 detik ─────────────
    // Foto dari Object Storage di-upload ke Google Drive dengan hierarki:
    // PESANAN → TOKO → PRODUK → RESI_SKU → foto.jpg
    const driveService = require('./services/google_drive_service');
    setInterval(async () => {
        // [BUG FIX F1-BUG1] Drive upload TIDAK butuh WA connected — pakai Google API!
        try {
            await driveService.processUploadQueue();
        } catch (e) {
            console.error('[CRON] Drive upload error:', e.message);
        }
    }, 30000); // Setiap 30 detik — tidak perlu WA konek
    const driveStatus = driveService.getDrive() ? '🟢 AKTIF' : '🔴 TIDAK AKTIF (cek .env + service-account.json)';
    console.log(`☁️ Google Drive Upload: ${driveStatus} — proses antrian setiap 30 detik (tidak perlu WA konek).`);

    // ── AUTO-SWEEP: DINONAKTIFKAN SESUAI PERMINTAAN USER ──────
    // cron.schedule('0 */4 * * *', async () => { ... });
    console.log('🔄 Auto-Sweep dinonaktifkan.');
});
