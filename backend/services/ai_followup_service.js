const chromeSemaphore = require('./chrome_semaphore');
const outgoingQueue = require('./outgoing_queue_service'); // Anti-spam serial queue
/**
 * AI Follow-Up Service v2
 * ─────────────────────────────────────────────────────────────
 * Alur Lengkap:
 *
 * 1. Customer chat masuk tanpa nomor pesanan
 *    → Bot tagih nomor pesanan (sopan) menggunakan AI
 *
 * 2. Customer kirim nomor pesanan (14-20 digit)
 *    → Lookup di 3 spreadsheet (Ventura, Giftyours, Custombase)
 *    → Jika TIDAK DITEMUKAN → masuk Pending Queue (retry otomatis 5 menit)
 *    → Jika DIBATALKAN → beritahu customer
 *    → Jika DITEMUKAN → simpan ke DB + kirim detail + minta foto
 *
 * 3. Customer kirim foto (media)
 *    → Hitung media yang masuk di DB
 *    → Jika Polaroid & kurang → tagih sisa foto (maks 3x)
 *    → Jika sudah >3x tagihan → tanya konfirmasi (proses/belum)
 *    → Jika non-Polaroid → tanya konfirmasi langsung
 *    → Jika sudah cukup / konfirmasi → update status → selesai
 */

const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');
const { lookupOrder, formatOrderDetailMessage } = require('./spreadsheet_service');
const pendingOrderService = require('./pending_order_service');

// ─── Inisialisasi AI Client (Lazy — dibuat saat pertama kali dipakai) ─────────
const isUsingGroq = !!process.env.GROQ_API_KEY;
let _aiClient = null;
let _aiModel = null;

// [RATE LIMIT GUARD] Simpan waktu kapan AI boleh dipanggil lagi
// Mencegah spam call ke API saat sudah kena 429 dan membuang token
let _aiRateLimitUntil = 0;

function getAiClient() {
    if (_aiClient) return { client: _aiClient, model: _aiModel };

    const apiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey.includes('ISI_') || apiKey === 'sk-test-fake-key') {
        console.warn('[AI-BOT] ⚠️ GROQ_API_KEY / OPENAI_API_KEY belum diisi di .env. AI Bot dinonaktifkan.');
        return null;
    }

    const isGroq = !!process.env.GROQ_API_KEY;
    _aiClient = new OpenAI({
        apiKey,
        baseURL: isGroq ? 'https://api.groq.com/openai/v1' : undefined,
    });
    _aiModel = isGroq ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini';
    console.log(`[AI-BOT] 🚀 Intelligence Engine: ${isGroq ? 'GROQ (Llama 3.3 70B)' : 'OPENAI (GPT-4o-Mini)'}`);
    return { client: _aiClient, model: _aiModel };
}

// ─── Utilities ──────────────────────────────────────────────────────────────────

// New provider chain. The old getAiClient remains for compatibility, but chat
// replies below use this chain so OpenAI is only a controlled backup.
const _providerClients = new Map();
const _providerCooldownUntil = new Map();

function boolEnv(name, defaultValue = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return defaultValue;
    return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function intEnv(name, defaultValue) {
    const parsed = parseInt(process.env[name], 10);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}

function isUsableApiKey(key) {
    return !!key && !key.includes('ISI_') && !key.includes('fake') && key !== 'sk-test-fake-key';
}

function getProvider(name) {
    if (_providerClients.has(name)) return _providerClients.get(name);

    let provider = null;
    if (name === 'groq' && isUsableApiKey(process.env.GROQ_API_KEY)) {
        provider = {
            name: 'groq',
            label: 'GROQ (Llama)',
            model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
            client: new OpenAI({
                apiKey: process.env.GROQ_API_KEY,
                baseURL: 'https://api.groq.com/openai/v1',
            }),
        };
    } else if (name === 'openai' && isUsableApiKey(process.env.OPENAI_API_KEY)) {
        provider = {
            name: 'openai',
            label: 'OPENAI (fallback)',
            model: process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini',
            client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
        };
    }

    _providerClients.set(name, provider);
    if (provider) console.log(`[AI-BOT] Provider siap: ${provider.label} / ${provider.model}`);
    return provider;
}

function getProviderChain() {
    const chain = [];
    const groq = getProvider('groq');
    const openai = getProvider('openai');
    if (groq) chain.push({ ...groq, isFallback: false });
    if (openai) chain.push({ ...openai, isFallback: !!groq });
    return chain;
}

function parseRetryAfterMs(err) {
    const msg = err.message || '';
    let waitMs = 5 * 60 * 1000;
    const match = msg.match(/(\d+)m([\d.]+)s/);
    if (match) {
        waitMs = (parseInt(match[1], 10) * 60 + parseFloat(match[2])) * 1000 + 5000;
    } else {
        const secMatch = msg.match(/(\d+\.?\d*)s/);
        if (secMatch) waitMs = parseFloat(secMatch[1]) * 1000 + 5000;
    }
    return waitMs;
}

function isRateLimitError(err) {
    const msg = err.message || '';
    return err.status === 429 || msg.includes('429') || msg.includes('Rate limit') || msg.includes('rate_limit');
}

function isTransientAiError(err) {
    const msg = err.message || '';
    return isRateLimitError(err) ||
        [408, 409, 500, 502, 503, 504].includes(err.status) ||
        msg.includes('[TIMEOUT]') || msg.toLowerCase().includes('timeout') ||
        msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') ||
        msg.includes('fetch failed') || msg.toLowerCase().includes('network');
}

function usageWindowKey(type, now = new Date()) {
    const iso = now.toISOString();
    return type === 'hour' ? iso.slice(0, 13) : iso.slice(0, 10);
}

function getUsageCount(provider, purpose, windowKey) {
    try {
        const db = require('../db');
        const row = db.prepare(`
            SELECT count FROM ai_usage_counters
            WHERE provider = ? AND purpose = ? AND window_key = ?
        `).get(provider, purpose, windowKey);
        return row ? row.count : 0;
    } catch (e) {
        console.warn('[AI-BOT] Gagal membaca usage counter:', e.message);
        return 0;
    }
}

function incrementUsage(provider, purpose, windowKey) {
    try {
        const db = require('../db');
        db.prepare(`
            INSERT INTO ai_usage_counters (provider, purpose, window_key, count, updated_at)
            VALUES (?, ?, ?, 1, datetime('now'))
            ON CONFLICT(provider, purpose, window_key)
            DO UPDATE SET count = count + 1, updated_at = datetime('now')
        `).run(provider, purpose, windowKey);
    } catch (e) {
        console.warn('[AI-BOT] Gagal update usage counter:', e.message);
    }
}

function canUseOpenAiFallback() {
    if (!boolEnv('AI_FALLBACK_ENABLED', true)) return { ok: false, reason: 'disabled' };
    const maxHour = intEnv('OPENAI_FALLBACK_MAX_PER_HOUR', 20);
    const maxDay = intEnv('OPENAI_FALLBACK_MAX_PER_DAY', 100);
    const hourKey = usageWindowKey('hour');
    const dayKey = usageWindowKey('day');
    const hourCount = getUsageCount('openai', 'chat_fallback_hour', hourKey);
    const dayCount = getUsageCount('openai', 'chat_fallback_day', dayKey);
    if (maxHour >= 0 && hourCount >= maxHour) return { ok: false, reason: `hourly limit ${hourCount}/${maxHour}` };
    if (maxDay >= 0 && dayCount >= maxDay) return { ok: false, reason: `daily limit ${dayCount}/${maxDay}` };
    return { ok: true, hourKey, dayKey };
}

function recordOpenAiFallbackUsage(limitInfo) {
    incrementUsage('openai', 'chat_fallback_hour', limitInfo.hourKey || usageWindowKey('hour'));
    incrementUsage('openai', 'chat_fallback_day', limitInfo.dayKey || usageWindowKey('day'));
}

/** Bungkus promise dengan batas waktu agar tidak hang selamanya */
function withTimeout(promise, ms, label = 'Operation') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`[TIMEOUT] ${label} melebihi ${ms / 1000}s`)), ms)
        ),
    ]);
}

/** Delay sederhana */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Delay acak 2-5 detik agar bot terlihat seperti manusia (Anti-Ban WA) */
const humanJitter = () => sleep(2000 + Math.floor(Math.random() * 3000));

// ─── Cache Konfigurasi In-Memory (Refresh tiap 5 menit) ──────────────────────
let configCache = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

async function getCachedAiConfig(supabase) {
    const now = Date.now();
    if (configCache && (now - configCacheTime) < CONFIG_CACHE_TTL_MS) {
        return configCache;
    }
    const { data, error } = await supabase
        .from('ai_config')
        .select('is_enabled, system_prompt, order_image_url, post_order_message')
        .eq('id', 1)
        .single();

    if (error || !data) {
        console.error('[AI-BOT] Gagal membaca config dari DB:', error?.message);
        return { is_enabled: false, system_prompt: '', order_image_url: null, post_order_message: '' };
    }
    configCache = data;
    configCacheTime = now;
    return configCache;
}

function invalidateConfigCache() {
    configCache = null;
    configCacheTime = 0;
}

// ─── Deteksi Nomor Pesanan ────────────────────────────────────────────────────
/** Cari angka 14-20 digit berurutan (Tokopedia, Shopee, TikTok) */
function detectOrderId(text) {
    if (!text) return null;
    const match = text.match(/\b(\d{14,20})\b/);
    return match ? match[1] : null;
}

// ─── Deteksi Kata Konfirmasi Foto ────────────────────────────────────────────
/**
 * Apakah customer menjawab konfirmasi foto sudah cukup?
 * [BUG FIX] Kata 'sudah' dan 'iya' dihapus karena terlalu umum
 * dan bisa memicu false-positive (misal customer chat "sudah ya kak").
 * Hanya kata yang spesifik dan jelas yang diterima.
 */
function isPhotoConfirmYes(text) {
    if (!text) return false;
    const lower = text.toLowerCase().trim();
    // Hanya kata yang sangat spesifik bermakna "proses saja"
    return lower === 'proses' || lower === 'cukup' || lower === 'selesai' ||
        lower.includes('sudah cukup') || lower.includes('udah cukup') ||
        lower.includes('foto sudah') || lower.includes('proses saja') ||
        lower.includes('langsung proses') || lower.includes('cukup kak');
}

/** Apakah customer menjawab "belum" / "kurang" */
function isPhotoConfirmNo(text) {
    if (!text) return false;
    const lower = text.toLowerCase().trim();
    return lower === 'belum' || lower === 'kurang' || lower === 'blm' ||
        lower.includes('belum cukup') || lower.includes('masih kurang') ||
        lower.includes('belum semua') || lower.includes('mau tambah');
}

// ─── Fungsi AI Balasan Umum (Tagih Nomor Pesanan) ────────────────────────────
async function getAIReply(conversationHistory, systemPrompt) {
    const ai = getAiClient();
    if (!ai) throw new Error('AI client tidak tersedia — periksa GROQ_API_KEY / OPENAI_API_KEY di .env');

    // [RATE LIMIT GUARD] Cek apakah masih dalam masa cooldown 429
    if (Date.now() < _aiRateLimitUntil) {
        const waitSec = Math.ceil((_aiRateLimitUntil - Date.now()) / 1000);
        console.warn(`[AI-BOT] ⏳ Rate limit aktif — tunggu ${waitSec}s lagi. Pesan diabaikan sementara.`);
        throw new Error(`RATE_LIMITED: tunggu ${waitSec} detik`);
    }

    const messages = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
    ];

    try {
        const completion = await withTimeout(
            ai.client.chat.completions.create({
                model: ai.model,
                messages,
                max_tokens: 300,
                temperature: 0.7,
            }),
            30000,
            'AI_Provider_getAIReply'
        );
        const reply = completion.choices[0]?.message?.content?.trim();
        if (!reply) throw new Error('AI returned empty response');
        return reply;
    } catch (err) {
        // [RATE LIMIT HANDLER] Deteksi 429 dan parse retry-after
        const msg = err.message || '';
        if (msg.includes('429') || msg.includes('Rate limit') || msg.includes('rate_limit')) {
            // Coba parse waktu tunggu dari pesan error Groq
            // Format: "Please try again in 3m44.64s"
            let waitMs = 5 * 60 * 1000; // Default 5 menit
            const match = msg.match(/(\d+)m([\d.]+)s/);
            if (match) {
                waitMs = (parseInt(match[1]) * 60 + parseFloat(match[2])) * 1000 + 5000; // +5s buffer
            } else {
                const secMatch = msg.match(/(\d+\.?\d*)s/);
                if (secMatch) waitMs = parseFloat(secMatch[1]) * 1000 + 5000;
            }
            _aiRateLimitUntil = Date.now() + waitMs;
            const readableWait = Math.ceil(waitMs / 1000);
            console.error(`[AI-BOT] 🚫 Groq Rate Limit 429! Bot AI diam selama ${readableWait}s. (Akan aktif kembali otomatis)`);
            throw new Error(`RATE_LIMITED: tunggu ${readableWait} detik`);
        }
        throw err;
    }
}

// ─── Kirim Pesan WA via Antrean Anti-Spam ────────────────────────────────────
/**
 * Semua pesan bot WAJIB melewati outgoingQueue.
 * Queue memastikan:
 *   - Hanya 1 pesan dikirim pada satu waktu (tidak paralel)
 *   - Jeda natural 5-15 detik antar customer berbeda
 *   - Cooldown 45 detik per customer
 *   - Tidak kirim di jam 23:00-07:00 WIB
 *   - Batas max 40 pesan/jam
 */
async function getAIReplyWithFallback(conversationHistory, systemPrompt) {
    const messages = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
    ];

    const providers = getProviderChain();
    if (providers.length === 0) {
        throw new Error('AI client tidak tersedia - periksa GROQ_API_KEY / OPENAI_API_KEY di .env');
    }

    let lastTransientError = null;
    for (const provider of providers) {
        const now = Date.now();
        const cooldownUntil = _providerCooldownUntil.get(provider.name) || 0;
        if (now < cooldownUntil) {
            const waitSec = Math.ceil((cooldownUntil - now) / 1000);
            console.warn(`[AI-BOT] Provider ${provider.name} cooldown - tunggu ${waitSec}s.`);
            lastTransientError = new Error(`RATE_LIMITED: ${provider.name} tunggu ${waitSec} detik`);
            if (!provider.isFallback) continue;
            throw lastTransientError;
        }

        let fallbackLimit = null;
        if (provider.isFallback) {
            fallbackLimit = canUseOpenAiFallback();
            if (!fallbackLimit.ok) {
                console.warn(`[AI-BOT] OpenAI fallback dilewati: ${fallbackLimit.reason}`);
                throw lastTransientError || new Error(`OPENAI_FALLBACK_LIMITED: ${fallbackLimit.reason}`);
            }
        }

        try {
            const completion = await withTimeout(
                provider.client.chat.completions.create({
                    model: provider.model,
                    messages,
                    max_tokens: 300,
                    temperature: 0.7,
                }),
                30000,
                `AI_Provider_${provider.name}_getAIReply`
            );
            const reply = completion.choices[0]?.message?.content?.trim();
            if (!reply) throw new Error('AI returned empty response');
            if (provider.isFallback) {
                recordOpenAiFallbackUsage(fallbackLimit);
                console.warn('[AI-BOT] OpenAI fallback dipakai 1x karena provider utama sedang bermasalah.');
            }
            return reply;
        } catch (err) {
            if (isRateLimitError(err)) {
                const waitMs = parseRetryAfterMs(err);
                _providerCooldownUntil.set(provider.name, Date.now() + waitMs);
                const readableWait = Math.ceil(waitMs / 1000);
                console.error(`[AI-BOT] ${provider.name} rate limit. Cooldown ${readableWait}s.`);
                lastTransientError = new Error(`RATE_LIMITED: ${provider.name} tunggu ${readableWait} detik`);
                continue;
            }
            if (isTransientAiError(err)) {
                console.warn(`[AI-BOT] ${provider.name} error sementara: ${err.message}`);
                lastTransientError = err;
                continue;
            }
            throw err;
        }
    }

    throw lastTransientError || new Error('Semua provider AI gagal dipakai.');
}

async function sendWAMessage(waClient, phoneNumber, message) {
    try {
        await outgoingQueue.enqueue(waClient, phoneNumber, message);
        console.log(`[AI-BOT] 💬 Pesan diantrekan → ${phoneNumber}: "${message.substring(0, 50)}..."`);
    } catch (err) {
        // HOURLY_LIMIT atau QUEUE_FULL tidak perlu throw — cukup log
        if (err.message === 'HOURLY_LIMIT_REACHED' || err.message === 'QUEUE_FULL') {
            console.warn(`[AI-BOT] ⏭️ Pesan ke ${phoneNumber} dilewati: ${err.message}`);
            return;
        }
        throw err;
    }
}

// ─── Kirim Gambar Contoh (Hanya Sekali di Awal) ──────────────────────────────
async function sendExampleImage(waClient, phoneNumber, config, supabase, customer) {
    if (!config.order_image_url) return;

    const { data: prevReplies } = await supabase
        .from('messages')
        .select('id')
        .eq('customer_id', customer.id)
        .eq('is_from_me', true)
        .limit(1);

    if (prevReplies && prevReplies.length > 0) return; // Sudah pernah kirim

    try {
        const { MessageMedia } = require('whatsapp-web.js');
        const chatId = phoneNumber + '@c.us';
        const filename = config.order_image_url.split('/').pop();
        const localPath = path.join(__dirname, '..', 'uploads', 'ai-config', filename);

        let media;
        if (fs.existsSync(localPath)) {
            media = MessageMedia.fromFilePath(localPath);
        } else {
            media = await withTimeout(
                MessageMedia.fromUrl(config.order_image_url, { unsafeMime: true }),
                60000,
                'WA_fromUrl_image'
            );
        }
        await humanJitter();
        await withTimeout(
            waClient.sendMessage(chatId, media, { caption: 'Contoh tampilan nomor pesanan 👆' }),
            60000,
            'WA_sendImage'
        );
        console.log(`[AI-BOT] 🖼️ Gambar contoh terkirim ke ${phoneNumber}`);
    } catch (err) {
        console.error('[AI-BOT] ⚠️ Gagal kirim gambar contoh:', err.message);
    }
}

// ─── Handler: Nomor Pesanan Ditemukan di Spreadsheet ─────────────────────────
async function handleOrderFound(waClient, customer, orderResult, supabase) {
    const { store, storeName, items, totalPhotosNeeded, hasPolaroid, resi } = orderResult;

    // Buat label SKU untuk kolom nama di dashboard
    // Format: SKU produk pertama (utamakan yang Polaroid)
    const polaroidItem = items.find(i => i.isPolaroid);
    const mainItem = polaroidItem || items[0];
    const skuLabel = mainItem ? (mainItem.sku || mainItem.productName.substring(0, 20)) : '';

    // [v2] Format nama customer: "Polaroid200 - Giftyours"
    // Sebelumnya: "Nama Asli | SKU: KODE_SKU" → kurang informatif
    // Sekarang: SKU langsung sebagai nama + toko, agar dashboard mudah dibaca
    const newName = skuLabel ? `${skuLabel} - ${storeName}` : (customer.name || 'Pelanggan');

    // [v2] Simpan resi ke customer record (untuk Google Drive folder naming)
    // Resi diambil dari kolom AP/AN di spreadsheet
    await supabase.from('customers').update({
        name: newName,
        store_name: store,
        resi: resi || null,            // [v2] Nomor resi pengiriman
        order_detail: JSON.stringify(items),
        required_photos: totalPhotosNeeded,
        status: 'BELUM_KIRIM_FOTO',
    }).eq('id', customer.id);

    // Kirim pesan detail pesanan + permintaan foto JIKA bot aktif
    const config = await getCachedAiConfig(supabase);
    if (config && config.is_enabled) {
        const detailMsg = formatOrderDetailMessage(orderResult);
        await sendWAMessage(waClient, customer.phone_number, detailMsg);
    } else {
        console.log(`[AI-BOT] 🤫 Stealth Mode: Ditemukan order ${customer.order_id}, pesan WA ditahan.`);
    }

    const orderId = customer.order_id || '(dari spreadsheet)';
    console.log(`[AI-BOT] ✅ Detail pesanan ${orderId} dikirim ke ${customer.phone_number} (${storeName}, resi: ${resi || '-'}, foto: ${totalPhotosNeeded}, SKU: ${skuLabel})`);
}


// ─── Handler: Nomor Pesanan Tidak Ditemukan ───────────────────────────────────
/**
 * [v2 - RACE CONDITION FIX]
 * Daripada langsung menolak customer, kita masukkan ke Pending Queue.
 * Sistem akan retry otomatis setiap 5 menit (max 6x = 30 menit).
 * Customer mendapat pesan ramah, BUKAN pesan error.
 */
async function handleOrderNotFound(waClient, customer, orderId, supabase) {
    // [PENTING] Simpan order_id ke DB — jangan di-null!
    // Kita butuh ini agar pending_order_service bisa update customer setelah found.
    await supabase.from('customers').update({ order_id: orderId }).eq('id', customer.id);

    // Masukkan ke antrian pending untuk di-retry otomatis
    pendingOrderService.addPendingOrder(customer.id, orderId, customer.phone_number);

    // Kirim pesan ramah JIKA bot aktif
    const config = await getCachedAiConfig(supabase);
    if (config && config.is_enabled) {
        const msg =
            `✅ Nomor pesanan *${orderId}* sudah kami catat kak!\n\n` +
            `Saat ini pesanan Anda sedang dalam proses sinkronisasi sistem 🔄\n\n` +
            `Kami akan otomatis mengirimkan konfirmasi dan detail pesanan dalam beberapa menit ya kak 🙏\n\n` +
            `_Tidak perlu kirim ulang nomor pesanannya ya kak_ 😊`;
        await sendWAMessage(waClient, customer.phone_number, msg);
    }

    console.log(`[AI-BOT] 📥 Order ${orderId} masuk Pending Queue — retry otomatis 5 menit.`);
}

// ─── Handler: Pesanan Dibatalkan ──────────────────────────────────────────────
async function handleOrderCancelled(waClient, customer, orderResult, supabase) {
    // Reset order_id
    await supabase.from('customers').update({ order_id: null }).eq('id', customer.id);

    const config = await getCachedAiConfig(supabase);
    if (config && config.is_enabled) {
        const msg = `❌ Maaf kak, pesanan *${customer.order_id}* tercatat sudah *${orderResult.status}*.\n\n` +
            `Jika ada pertanyaan lebih lanjut, silakan hubungi toko kami secara langsung ya kak 🙏`;
        await sendWAMessage(waClient, customer.phone_number, msg);
    }
}

// ─── Handler: Cek Jumlah Foto yang Sudah Masuk ───────────────────────────────
async function handleMediaPhotoCheck(waClient, customer, supabase) {
    try {
        // Ambil customer data terbaru dari DB
        const { data: freshCustomer } = await supabase
            .from('customers')
            .select('*')
            .eq('id', customer.id)
            .single();

        if (!freshCustomer) return;

        // Jika customer sudah konfirmasi foto → tidak perlu cek lagi
        if (freshCustomer.photo_confirmed) return;

        // Jika tidak ada nomor pesanan → tidak perlu cek
        if (!freshCustomer.order_id) return;

        // Hitung total media (foto) yang sudah masuk dari customer ini
        const { data: mediaList } = await supabase
            .from('media')
            .select('id')
            .eq('customer_id', freshCustomer.id)
            .eq('excluded_from_production', 0);

        const currentPhotoCount = mediaList ? mediaList.length : 0;
        const requiredPhotos = freshCustomer.required_photos || 0;
        const followupCount = freshCustomer.photo_followup_count || 0;

        // Parse detail pesanan
        let orderDetail = null;
        try {
            orderDetail = freshCustomer.order_detail ? JSON.parse(freshCustomer.order_detail) : null;
        } catch (e) { /* silent */ }

        const hasPolaroid = orderDetail ? orderDetail.some(item => item.isPolaroid) : false;

        console.log(`[AI-BOT] 📸 Cek foto ${freshCustomer.phone_number}: ${currentPhotoCount}/${requiredPhotos} (Polaroid: ${hasPolaroid})`);

        if (hasPolaroid && requiredPhotos > 0) {
            // ── PRODUK POLAROID: Harus sesuai jumlah ─────────────────────────
            if (currentPhotoCount >= requiredPhotos) {
                // Foto sudah cukup!
                await supabase.from('customers').update({
                    photo_confirmed: 1,
                    status: 'SUDAH_KIRIM_FOTO',
                }).eq('id', freshCustomer.id);

                const config = await getCachedAiConfig(supabase);
                if (config && config.is_enabled) {
                    const msg = `✅ *${currentPhotoCount} foto* Anda sudah kami terima dengan lengkap!\n\n` +
                        `Pesanan Anda akan segera kami proses. Terima kasih sudah mempercayakan kepada kami! 😊🎉`;
                    await sendWAMessage(waClient, freshCustomer.phone_number, msg);
                }

            } else if (followupCount < 3) {
                // Foto masih kurang, tagih lagi (maks 3x)
                const remaining = requiredPhotos - currentPhotoCount;
                await supabase.from('customers').update({
                    photo_followup_count: followupCount + 1,
                }).eq('id', freshCustomer.id);

                const config = await getCachedAiConfig(supabase);
                if (config && config.is_enabled) {
                    const msg = `📸 Foto Anda sudah masuk *${currentPhotoCount} dari ${requiredPhotos}* lembar.\n\n` +
                        `Masih kurang *${remaining} foto* lagi ya kak. Silakan kirimkan sisa fotonya 🙏`;
                    await sendWAMessage(waClient, freshCustomer.phone_number, msg);
                }

            } else {
                // Sudah 3x ditagih, tanya konfirmasi
                await supabase.from('customers').update({
                    photo_followup_count: followupCount + 1,
                }).eq('id', freshCustomer.id);

                const config = await getCachedAiConfig(supabase);
                if (config && config.is_enabled) {
                    const msg = `📸 Saat ini kami sudah menerima *${currentPhotoCount} foto* dari total *${requiredPhotos}* yang dibutuhkan.\n\n` +
                        `Apakah foto yang Anda kirimkan sudah *cukup*? 🤔\n\n` +
                        `Balas:\n` +
                        `• *"proses"* atau *"cukup"* → Jika foto sudah selesai dikirim\n` +
                        `• *"belum"* atau *"kurang"* → Jika masih ada foto yang akan dikirim`;
                    await sendWAMessage(waClient, freshCustomer.phone_number, msg);
                }
            }

        } else {
            // ── PRODUK NON-POLAROID: Bebas jumlah, tanya konfirmasi ──────────
            // Hanya kirim konfirmasi 1x (followupCount 0 = belum pernah ditanya)
            if (followupCount === 0) {
                await supabase.from('customers').update({
                    photo_followup_count: 1,
                }).eq('id', freshCustomer.id);

                const config = await getCachedAiConfig(supabase);
                if (config && config.is_enabled) {
                    const msg = `✅ Foto Anda sudah kami terima!\n\n` +
                        `Apakah foto yang Anda kirimkan sudah *lengkap*? 🤔\n\n` +
                        `Balas:\n` +
                        `• *"proses"* atau *"cukup"* → Jika foto sudah selesai\n` +
                        `• *"belum"* atau *"kurang"* → Jika masih ada foto lain`;
                    await sendWAMessage(waClient, freshCustomer.phone_number, msg);
                }
            }
            // followupCount > 0 = sudah pernah ditanya, tunggu jawaban customer (jangan spam)
        }
    } catch (err) {
        console.error('[AI-BOT] ⚠️ Error di handleMediaPhotoCheck:', err.message);
    }
}

// ─── FUNGSI UTAMA: Dipanggil setiap ada PESAN TEKS masuk dari customer ───────
async function checkAndRespond(waClient, customer, message, supabase) {
    try {
        // Guard: Jangan proses pesan dari diri sendiri
        if (message.fromMe) return;

        const msgText = (message.body || '').trim();

        // ── FASE A: Customer belum punya nomor pesanan ─────────────────────────
        if (!customer.order_id) {
            const foundOrderId = detectOrderId(msgText);

            if (foundOrderId) {
                // [CRITICAL FIX] Deteksi nomor pesanan SELALU diproses ke spreadsheet
                // TIDAK bergantung pada is_enabled. Customer yang kirim nomor pesanan
                // WAJIB mendapat balasan detail, apapun kondisi bot.
                console.log(`[AI-BOT] 🔢 Nomor pesanan ditemukan: ${foundOrderId} dari ${customer.phone_number}`);

                // Simpan order_id dulu ke DB agar tidak diproses duplikat
                await supabase.from('customers').update({ order_id: foundOrderId }).eq('id', customer.id);

                // Lookup ke spreadsheet (tidak perlu API key Sheets jika belum diisi = return null)
                const orderResult = await lookupOrder(foundOrderId);

                if (!orderResult) {
                    await handleOrderNotFound(waClient, customer, foundOrderId, supabase);
                    return;
                }

                if (orderResult.cancelled) {
                    await handleOrderCancelled(waClient, customer, orderResult, supabase);
                    return;
                }

                await handleOrderFound(waClient, customer, orderResult, supabase);
                return;
            }

            // Tidak ada nomor pesanan → cek apakah bot aktif sebelum balas
            const config = await getCachedAiConfig(supabase);

            // [BEST PRACTICE] is_enabled hanya mengontrol "apakah bot mengejar customer"
            // Jika false, biarkan admin handle manual. Tidak error, hanya diam.
            if (!config || !config.is_enabled) {
                console.log(`[AI-BOT] ℹ️ Bot dinonaktifkan (is_enabled=false). Pesan dari ${customer.phone_number} diabaikan.`);
                return;
            }

            // System prompt kosong = tidak bisa balas AI. Skip dengan aman.
            if (!config.system_prompt || !config.system_prompt.trim()) {
                console.log(`[AI-BOT] ⚠️ system_prompt kosong di ai_config. Isi di dashboard Admin → Settings.`);
                return;
            }

            const { data: recentMessages } = await supabase
                .from('messages')
                .select('body, is_from_me')
                .eq('customer_id', customer.id)
                .eq('is_deleted', false)
                .not('body', 'is', null)
                .not('body', 'eq', '')
                .order('created_at', { ascending: false })
                .limit(5);

            const history = (recentMessages || []).reverse().map(msg => ({
                role: msg.is_from_me ? 'assistant' : 'user',
                content: msg.body,
            }));

            const aiReply = await getAIReplyWithFallback(history, config.system_prompt);
            await sendWAMessage(waClient, customer.phone_number, aiReply);
            await sendExampleImage(waClient, customer.phone_number, config, supabase, customer);
            return;
        }

        // ── FASE B: Customer sudah punya order_id, cek jawaban konfirmasi foto ──
        // Ambil data customer terbaru
        const { data: freshCustomer } = await supabase
            .from('customers')
            .select('*')
            .eq('id', customer.id)
            .single();

        if (!freshCustomer) return;

        // Jika foto sudah dikonfirmasi → tidak ada yang perlu dilakukan
        if (freshCustomer.photo_confirmed) return;

        // Cek apakah pesan ini adalah jawaban konfirmasi foto
        if (isPhotoConfirmYes(msgText)) {
            await supabase.from('customers').update({
                photo_confirmed: 1,
                status: 'SUDAH_KIRIM_FOTO',
            }).eq('id', freshCustomer.id);

            const config = await getCachedAiConfig(supabase);
            if (config && config.is_enabled) {
                const msg = `✅ Baik kak, foto Anda sudah kami tandai *lengkap* dan akan segera diproses!\n\nTerima kasih sudah berbelanja bersama kami! 🎉😊`;
                await sendWAMessage(waClient, freshCustomer.phone_number, msg);
            } else {
                console.log(`[AI-BOT] 🤫 Stealth Mode: Konfirmasi "proses" diterima dari ${freshCustomer.phone_number}, pesan balasan ditahan.`);
            }
            return;
        }

        if (isPhotoConfirmNo(msgText)) {
            const config = await getCachedAiConfig(supabase);
            if (config && config.is_enabled) {
                const msg = `👍 Oke kak, silakan kirimkan sisa fotonya ya. Kami tunggu! 🙏`;
                await sendWAMessage(waClient, freshCustomer.phone_number, msg);
            }
            return;
        }

        // Pesan teks biasa saat sudah punya order_id → tidak dibalas otomatis (biarkan admin)
        console.log(`[AI-BOT] ℹ️ Pesan teks dari ${customer.phone_number} (sudah ada order_id, diabaikan bot).`);

    } catch (err) {
        console.error('[AI-BOT] ❌ Error di checkAndRespond (Skip aman):', err.message);
    }
}

// ─── FUNGSI PUBLIK: Dipanggil dari index.js setiap ada MEDIA masuk ───────────
async function checkAndRespondMedia(waClient, customer, supabase) {
    // Tunggu sebentar agar DB sempat menyimpan media sebelum kita hitung
    await sleep(3000);
    await handleMediaPhotoCheck(waClient, customer, supabase);
}

// ─── Fungsi lama dipertahankan agar tidak ada yang broken ────────────────────
async function sendPostOrderFollowUp(waClient, phoneNumber, orderId, supabase) {
    const config = await getCachedAiConfig(supabase);
    if (!config.post_order_message || !config.post_order_message.trim()) return;
    const finalMessage = config.post_order_message
        .replace(/\{order_id\}/g, orderId)
        .replace(/\{nomor_pesanan\}/g, orderId);
    await sendWAMessage(waClient, phoneNumber, finalMessage);
}

// ─── Direct WA Message sender (untuk pending_order_service) ─────────────────
/**
 * Versi publik dari sendWAMessage — tidak perlu akses ke closure.
 * Dipakai oleh pending_order_service.js untuk kirim notifikasi retry.
 */
async function sendWAMessageDirect(waClient, phoneNumber, message) {
    return sendWAMessage(waClient, phoneNumber, message);
}

module.exports = {
    checkAndRespond,
    checkAndRespondMedia,
    sendPostOrderFollowUp,
    invalidateConfigCache,
    detectOrderId,
    withTimeout,
    // Diekspor agar bisa dipakai oleh pending_order_service
    handleOrderFound,
    handleOrderNotFound,
    handleOrderCancelled,
    sendWAMessageDirect,
};
