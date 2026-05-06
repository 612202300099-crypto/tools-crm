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
 *    → Jika TIDAK DITEMUKAN → beritahu customer
 *    → Jika DIBATALKAN → beritahu customer
 *    → Jika DITEMUKAN → simpan ke DB + kirim detail + minta foto
 *
 * 3. Customer kirim foto (media)
 *    → Hitung media yang masuk di DB
 *    → Jika Polaroid & kurang → tagih sisa foto (maks 3x)
 *    → Jika sudah >3x tagiha → tanya konfirmasi (proses/belum)
 *    → Jika non-Polaroid → tanya konfirmasi langsung
 *    → Jika sudah cukup / konfirmasi → update status → selesai
 */

const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');
const { lookupOrder, formatOrderDetailMessage } = require('./spreadsheet_service');

// ─── Inisialisasi AI Client (Lazy — dibuat saat pertama kali dipakai) ─────────
// Ini mencegah crash saat module di-load sebelum dotenv memuat variabel ENV.
const isUsingGroq = !!process.env.GROQ_API_KEY;
let _aiClient = null;
let _aiModel = null;

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

    const messages = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
    ];
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
}

// ─── Kirim Pesan WA dengan Jitter ────────────────────────────────────────────
async function sendWAMessage(waClient, phoneNumber, message) {
    const chatId = phoneNumber + '@c.us';
    await humanJitter();
    await withTimeout(
        waClient.sendMessage(chatId, message),
        60000,
        'WA_sendMessage'
    );
    console.log(`[AI-BOT] 💬 Pesan terkirim ke ${phoneNumber}: "${message.substring(0, 60)}..."`);
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
    const { store, storeName, items, totalPhotosNeeded, hasPolaroid } = orderResult;

    // Buat label SKU untuk kolom nama di dashboard
    // Format: SKU produk pertama (utamakan yang Polaroid)
    const polaroidItem = items.find(i => i.isPolaroid);
    const mainItem = polaroidItem || items[0];
    const skuLabel = mainItem ? (mainItem.sku || mainItem.productName.substring(0, 20)) : '';

    // [FEATURE] Update nama customer dengan info SKU agar terlihat di dashboard
    // Format: "Nama Asli | SKU: KODE_SKU"
    const currentName = customer.name || 'Pelanggan';
    const baseName = currentName.includes(' | SKU:') ? currentName.split(' | SKU:')[0] : currentName;
    const newName = skuLabel ? `${baseName} | SKU: ${skuLabel}` : baseName;

    // [BUG FIX] Status harus BELUM_KIRIM_FOTO karena kita baru minta foto,
    // bukan SUDAH_KIRIM_FOTO. Status diubah ke SUDAH hanya setelah foto diterima.
    await supabase.from('customers').update({
        name: newName,
        store_name: store,
        order_detail: JSON.stringify(items),
        required_photos: totalPhotosNeeded,
        status: 'BELUM_KIRIM_FOTO',
    }).eq('id', customer.id);

    // Kirim pesan detail pesanan + permintaan foto
    const detailMsg = formatOrderDetailMessage(orderResult);
    await sendWAMessage(waClient, customer.phone_number, detailMsg);

    console.log(`[AI-BOT] ✅ Detail pesanan ${customer.order_id} dikirim ke ${customer.phone_number} (${storeName}, foto dibutuhkan: ${totalPhotosNeeded}, SKU: ${skuLabel})`);
}


// ─── Handler: Nomor Pesanan Tidak Ditemukan ───────────────────────────────────
async function handleOrderNotFound(waClient, customer, orderId, supabase) {
    // Reset order_id agar customer bisa coba lagi
    await supabase.from('customers').update({ order_id: null }).eq('id', customer.id);

    const msg = `⚠️ Maaf kak, nomor pesanan *${orderId}* tidak kami temukan di sistem kami.\n\n` +
        `Mohon periksa kembali:\n` +
        `• Nomor pesanan biasanya 14-20 digit angka\n` +
        `• Pastikan pesanan melalui Tokopedia, Shopee, atau TikTok Shop\n\n` +
        `Silakan coba kirimkan nomor pesanan Anda kembali 🙏`;
    await sendWAMessage(waClient, customer.phone_number, msg);
}

// ─── Handler: Pesanan Dibatalkan ──────────────────────────────────────────────
async function handleOrderCancelled(waClient, customer, orderResult, supabase) {
    // Reset order_id
    await supabase.from('customers').update({ order_id: null }).eq('id', customer.id);

    const msg = `❌ Maaf kak, pesanan *${customer.order_id}* tercatat sudah *${orderResult.status}*.\n\n` +
        `Jika ada pertanyaan lebih lanjut, silakan hubungi toko kami secara langsung ya kak 🙏`;
    await sendWAMessage(waClient, customer.phone_number, msg);
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
            .eq('customer_id', freshCustomer.id);

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

                const msg = `✅ *${currentPhotoCount} foto* Anda sudah kami terima dengan lengkap!\n\n` +
                    `Pesanan Anda akan segera kami proses. Terima kasih sudah mempercayakan kepada kami! 😊🎉`;
                await sendWAMessage(waClient, freshCustomer.phone_number, msg);

            } else if (followupCount < 3) {
                // Foto masih kurang, tagih lagi (maks 3x)
                const remaining = requiredPhotos - currentPhotoCount;
                await supabase.from('customers').update({
                    photo_followup_count: followupCount + 1,
                }).eq('id', freshCustomer.id);

                const msg = `📸 Foto Anda sudah masuk *${currentPhotoCount} dari ${requiredPhotos}* lembar.\n\n` +
                    `Masih kurang *${remaining} foto* lagi ya kak. Silakan kirimkan sisa fotonya 🙏`;
                await sendWAMessage(waClient, freshCustomer.phone_number, msg);

            } else {
                // Sudah 3x ditagih, tanya konfirmasi
                await supabase.from('customers').update({
                    photo_followup_count: followupCount + 1,
                }).eq('id', freshCustomer.id);

                const msg = `📸 Saat ini kami sudah menerima *${currentPhotoCount} foto* dari total *${requiredPhotos}* yang dibutuhkan.\n\n` +
                    `Apakah foto yang Anda kirimkan sudah *cukup*? 🤔\n\n` +
                    `Balas:\n` +
                    `• *"proses"* atau *"cukup"* → Jika foto sudah selesai dikirim\n` +
                    `• *"belum"* atau *"kurang"* → Jika masih ada foto yang akan dikirim`;
                await sendWAMessage(waClient, freshCustomer.phone_number, msg);
            }

        } else {
            // ── PRODUK NON-POLAROID: Bebas jumlah, tanya konfirmasi ──────────
            // Hanya kirim konfirmasi 1x (followupCount 0 = belum pernah ditanya)
            if (followupCount === 0) {
                await supabase.from('customers').update({
                    photo_followup_count: 1,
                }).eq('id', freshCustomer.id);

                const msg = `✅ Foto Anda sudah kami terima!\n\n` +
                    `Apakah foto yang Anda kirimkan sudah *lengkap*? 🤔\n\n` +
                    `Balas:\n` +
                    `• *"proses"* atau *"cukup"* → Jika foto sudah selesai\n` +
                    `• *"belum"* atau *"kurang"* → Jika masih ada foto lain`;
                await sendWAMessage(waClient, freshCustomer.phone_number, msg);
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

            const aiReply = await getAIReply(history, config.system_prompt);
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

            const msg = `✅ Baik kak, foto Anda sudah kami tandai *lengkap* dan akan segera diproses!\n\nTerima kasih sudah berbelanja bersama kami! 🎉😊`;
            await sendWAMessage(waClient, freshCustomer.phone_number, msg);
            return;
        }

        if (isPhotoConfirmNo(msgText)) {
            const msg = `👍 Oke kak, silakan kirimkan sisa fotonya ya. Kami tunggu! 🙏`;
            await sendWAMessage(waClient, freshCustomer.phone_number, msg);
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

module.exports = {
    checkAndRespond,
    checkAndRespondMedia,
    sendPostOrderFollowUp,
    invalidateConfigCache,
    detectOrderId,
    withTimeout,
};
