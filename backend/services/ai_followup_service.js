/**
 * AI Follow-Up Service
 * Tugas: Membalas customer yang belum kirim nomor pesanan menggunakan OpenAI.
 * Auto-OFF ketika customer sudah mengirim nomor pesanan (18 digit).
 */

const OpenAI = require('openai');
const path = require('path');

// ─── Inisialisasi Client OpenAI ───────────────────────────────────────────────
const openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// ─── Cache Konfigurasi In-Memory (Refresh tiap 5 menit) ───────────────────────
// Tujuan: Tidak query database setiap ada pesan masuk. Hemat resource server.
let configCache = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 menit

/**
 * Ambil konfigurasi AI dari Supabase, tapi cahced di memori.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<{is_enabled: boolean, system_prompt: string, order_image_url: string|null}>}
 */
async function getCachedAiConfig(supabase) {
    const now = Date.now();
    if (configCache && (now - configCacheTime) < CONFIG_CACHE_TTL_MS) {
        return configCache;
    }

    const { data, error } = await supabase
        .from('ai_config')
        .select('is_enabled, system_prompt, order_image_url')
        .eq('id', 1)
        .single();

    if (error || !data) {
        console.error('[AI-BOT] Gagal membaca konfigurasi dari DB:', error?.message);
        // Fallback aman: bot dinonaktifkan jika config tidak bisa dibaca
        return { is_enabled: false, system_prompt: '', order_image_url: null };
    }

    configCache = data;
    configCacheTime = now;
    console.log('[AI-BOT] 🔄 Config cache berhasil diperbarui dari database.');
    return configCache;
}

/**
 * Invalidate cache — dipanggil setiap kali user update config dari dashboard.
 */
function invalidateConfigCache() {
    configCache = null;
    configCacheTime = 0;
    console.log('[AI-BOT] 🗑️ Config cache dihapus (akan refresh dari DB saat pesan berikutnya).');
}

/**
 * Deteksi apakah teks berisi nomor pesanan valid (18 digit angka berurutan).
 * @param {string} text
 * @returns {string|null} nomor pesanan jika ditemukan, null jika tidak
 */
function detectOrderId(text) {
    if (!text) return null;
    // Cari 18 digit angka berurutan (bisa diawali/diakhiri dengan spasi atau teks lain)
    const match = text.match(/\b(\d{18})\b/);
    return match ? match[1] : null;
}

/**
 * Minta OpenAI untuk membuat balasan berdasarkan konteks percakapan.
 * @param {Array<{role: string, content: string}>} conversationHistory - Max 5 pesan terakhir
 * @param {string} systemPrompt
 * @returns {Promise<string>} teks balasan dari AI
 */
async function getAIReply(conversationHistory, systemPrompt) {
    const messages = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
    ];

    const completion = await openaiClient.chat.completions.create({
        model: 'gpt-4o-mini', // Paling hemat biaya, cukup untuk kasus CS bot
        messages,
        max_tokens: 200,      // Balasan singkat, tidak perlu panjang
        temperature: 0.7,     // Sedikit variasi agar tidak robotik
    });

    return completion.choices[0]?.message?.content?.trim() || 'Halo kak, bisa kirim nomor pesanannya dulu ya 😊🙏';
}

/**
 * FUNGSI UTAMA — dipanggil dari index.js setiap ada pesan masuk dari customer.
 *
 * Flow:
 * 1. Guard: Lewati jika pesan dari kita sendiri (fromMe)
 * 2. Guard: Lewati jika customer sudah punya order_id di DB
 * 3. Deteksi: Apakah pesan mengandung 18 digit? → Update DB, hentikan bot
 * 4. Guard: Cek apakah bot aktif di konfigurasi
 * 5. Bangun konteks percakapan (5 pesan terakhir) → panggil OpenAI → kirim balasan
 * 6. (Hanya sekali) Kirim gambar contoh nomor pesanan jika ada
 *
 * @param {import('whatsapp-web.js').Client} waClient - WhatsApp client
 * @param {object} customer - Data customer dari DB {id, phone_number, order_id, ...}
 * @param {import('whatsapp-web.js').Message} message - Pesan WA yang masuk
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function checkAndRespond(waClient, customer, message, supabase) {
    try {
        // ── GUARD 1: Jangan balas pesan yang dikirim dari HP kita sendiri ──────
        if (message.fromMe) return;

        // ── GUARD 2: Customer sudah punya nomor pesanan → Bot tidak perlu aktif ─
        if (customer.order_id) return;

        // ── GUARD 3: Deteksi apakah pesan ini berisi nomor pesanan (18 digit) ──
        const foundOrderId = detectOrderId(message.body);
        if (foundOrderId) {
            console.log(`[AI-BOT] ✅ Nomor pesanan ${foundOrderId} ditemukan dari ${customer.phone_number}. Bot dinonaktifkan.`);
            // Simpan nomor pesanan ke database
            await supabase
                .from('customers')
                .update({ order_id: foundOrderId })
                .eq('id', customer.id);
            return; // Bot berhenti, manusia ambil alih
        }

        // ── GUARD 4: Cek apakah fitur AI aktif ───────────────────────────────────
        const config = await getCachedAiConfig(supabase);
        if (!config.is_enabled) {
            console.log('[AI-BOT] ⏸️ Bot sedang dinonaktifkan via konfigurasi. Skip.');
            return;
        }

        // ── STEP 5: Bangun Konteks Percakapan (max 5 pesan terakhir) ─────────────
        const { data: recentMessages } = await supabase
            .from('messages')
            .select('body, is_from_me')
            .eq('customer_id', customer.id)
            .eq('is_deleted', false)
            .not('body', 'is', null)
            .not('body', 'eq', '')
            .order('created_at', { ascending: false })
            .limit(5);

        // Balik urutan agar percakapan runut (lama → baru)
        const history = (recentMessages || []).reverse().map(msg => ({
            role: msg.is_from_me ? 'assistant' : 'user',
            content: msg.body,
        }));

        console.log(`[AI-BOT] 🤖 Membuat balasan untuk ${customer.phone_number} (Konteks: ${history.length} pesan)...`);

        // ── STEP 6: Panggil OpenAI ────────────────────────────────────────────────
        const aiReply = await getAIReply(history, config.system_prompt);

        // ── STEP 7: Kirim balasan teks ke WA customer ─────────────────────────────
        const chatId = customer.phone_number + '@c.us';
        await waClient.sendMessage(chatId, aiReply);
        console.log(`[AI-BOT] 💬 Balasan terkirim ke ${customer.phone_number}: "${aiReply.substring(0, 60)}..."`);

        // ── STEP 8: Kirim gambar contoh HANYA jika belum pernah bot menjawab ──────
        // Logika: Cek apakah ada pesan is_from_me dari bot sebelumnya
        // (jika ini adalah BALASAN PERTAMA bot, kirim gambar)
        if (config.order_image_url) {
            const { data: prevBotMessages } = await supabase
                .from('messages')
                .select('id')
                .eq('customer_id', customer.id)
                .eq('is_from_me', true)
                .limit(1);

            const isFirstBotReply = !prevBotMessages || prevBotMessages.length === 0;

            if (isFirstBotReply) {
                try {
                    const { MessageMedia } = require('whatsapp-web.js');
                    const media = await MessageMedia.fromUrl(config.order_image_url, { unsafeMime: true });
                    await waClient.sendMessage(chatId, media, { caption: 'Contoh tampilan nomor pesanan 👆' });
                    console.log(`[AI-BOT] 🖼️ Gambar contoh berhasil dikirim ke ${customer.phone_number}`);
                } catch (imgErr) {
                    console.error('[AI-BOT] ⚠️ Gagal mengirim gambar contoh:', imgErr.message);
                }
            }
        }

    } catch (err) {
        // Fail-safe: error di bot tidak boleh crash server
        console.error('[AI-BOT] ❌ Error di checkAndRespond (Skip aman):', err.message);
    }
}

module.exports = {
    checkAndRespond,
    invalidateConfigCache,
    detectOrderId,
};
