/**
 * AI Follow-Up Service
 * Tugas: Membalas customer yang belum kirim nomor pesanan menggunakan OpenAI.
 * Auto-OFF ketika customer sudah mengirim nomor pesanan (18 digit).
 * Setelah nomor pesanan ditemukan → kirim pesan follow-up (ketentuan + link video).
 */

const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');

// ─── Inisialisasi Client OpenAI ───────────────────────────────────────────────
const openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// ─── Timeout Utility ──────────────────────────────────────────────────────────
// Membungkus promise dengan batas waktu agar tidak hang selamanya.
function withTimeout(promise, ms, label = 'Operation') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`[TIMEOUT] ${label} melebihi ${ms / 1000}s`)), ms)
        ),
    ]);
}

// ─── Cache Konfigurasi In-Memory (Refresh tiap 5 menit) ───────────────────────
let configCache = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 menit

/**
 * Ambil konfigurasi AI dari Supabase, tapi cached di memori.
 */
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
        console.error('[AI-BOT] Gagal membaca konfigurasi dari DB:', error?.message);
        return { is_enabled: false, system_prompt: '', order_image_url: null, post_order_message: '' };
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
 */
function detectOrderId(text) {
    if (!text) return null;
    const match = text.match(/\b(\d{18})\b/);
    return match ? match[1] : null;
}

/**
 * Minta OpenAI untuk membuat balasan berdasarkan konteks percakapan.
 */
async function getAIReply(conversationHistory, systemPrompt) {
    const messages = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
    ];

    const completion = await withTimeout(
        openaiClient.chat.completions.create({
            model: 'gpt-4o-mini',
            messages,
            max_tokens: 200,
            temperature: 0.7,
        }),
        30000, // 30 detik timeout
        'OpenAI getAIReply'
    );

    return completion.choices[0]?.message?.content?.trim() || 'Halo kak, bisa kirim nomor pesanannya dulu ya 😊🙏';
}

/**
 * Kirim pesan follow-up setelah nomor pesanan ditemukan.
 * Berisi ketentuan kirim foto + link video TikTok (jika ada).
 * 
 * @param {import('whatsapp-web.js').Client} waClient
 * @param {string} phoneNumber - Nomor HP customer (tanpa @c.us)
 * @param {string} orderId - Nomor pesanan yang ditemukan
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function sendPostOrderFollowUp(waClient, phoneNumber, orderId, supabase) {
    try {
        const config = await getCachedAiConfig(supabase);
        
        if (!config.post_order_message || !config.post_order_message.trim()) {
            console.log('[AI-BOT] ℹ️ Pesan follow-up kosong — skip pengiriman.');
            return;
        }

        const chatId = phoneNumber + '@c.us';
        
        // Replace placeholder {order_id} jika ada di template
        const finalMessage = config.post_order_message
            .replace(/\{order_id\}/g, orderId)
            .replace(/\{nomor_pesanan\}/g, orderId);

        await withTimeout(
            waClient.sendMessage(chatId, finalMessage),
            30000,
            'WA sendPostOrderFollowUp'
        );

        console.log(`[AI-BOT] 📋 Pesan follow-up (ketentuan + link) terkirim ke ${phoneNumber}`);
    } catch (err) {
        // Fail-safe: Gagal kirim follow-up tidak boleh mengganggu operasi lain
        console.error('[AI-BOT] ⚠️ Gagal kirim pesan follow-up:', err.message);
    }
}

/**
 * FUNGSI UTAMA — dipanggil dari index.js setiap ada pesan masuk dari customer.
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
            console.log(`[AI-BOT] ✅ Nomor pesanan ${foundOrderId} ditemukan dari ${customer.phone_number}. Menyimpan & follow-up...`);
            // Simpan nomor pesanan ke database
            await supabase
                .from('customers')
                .update({ order_id: foundOrderId })
                .eq('id', customer.id);

            // Kirim pesan follow-up (ketentuan + link TikTok)
            await sendPostOrderFollowUp(waClient, customer.phone_number, foundOrderId, supabase);
            return;
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

        const history = (recentMessages || []).reverse().map(msg => ({
            role: msg.is_from_me ? 'assistant' : 'user',
            content: msg.body,
        }));

        console.log(`[AI-BOT] 🤖 Membuat balasan untuk ${customer.phone_number} (Konteks: ${history.length} pesan)...`);

        // ── STEP 6: Panggil OpenAI ────────────────────────────────────────────────
        const aiReply = await getAIReply(history, config.system_prompt);

        // ── STEP 7: Kirim balasan teks ke WA customer ─────────────────────────────
        const chatId = customer.phone_number + '@c.us';
        await withTimeout(
            waClient.sendMessage(chatId, aiReply),
            30000,
            'WA sendMessage AI reply'
        );
        console.log(`[AI-BOT] 💬 Balasan terkirim ke ${customer.phone_number}: "${aiReply.substring(0, 60)}..."`);

        // ── STEP 8: Kirim gambar contoh HANYA jika bot BELUM PERNAH kirim ────
        if (config.order_image_url) {
            const { data: prevReplies } = await supabase
                .from('messages')
                .select('id')
                .eq('customer_id', customer.id)
                .eq('is_from_me', true)
                .limit(1);

            const isFirstBotReply = !prevReplies || prevReplies.length === 0;

            if (isFirstBotReply) {
                try {
                    const { MessageMedia } = require('whatsapp-web.js');
                    
                    const filename = config.order_image_url.split('/').pop();
                    const localPath = path.join(__dirname, '..', 'uploads', 'ai-config', filename);
                    
                    if (fs.existsSync(localPath)) {
                        const media = MessageMedia.fromFilePath(localPath);
                        await withTimeout(
                            waClient.sendMessage(chatId, media, { caption: 'Contoh tampilan nomor pesanan 👆' }),
                            30000,
                            'WA sendImage contoh'
                        );
                        console.log(`[AI-BOT] 🖼️ Gambar contoh berhasil dikirim ke ${customer.phone_number}`);
                    } else {
                        const media = await withTimeout(
                            MessageMedia.fromUrl(config.order_image_url, { unsafeMime: true }),
                            30000,
                            'WA fromUrl fallback'
                        );
                        await withTimeout(
                            waClient.sendMessage(chatId, media, { caption: 'Contoh tampilan nomor pesanan 👆' }),
                            30000,
                            'WA sendImage URL fallback'
                        );
                        console.log(`[AI-BOT] 🖼️ Gambar contoh (URL-Fallback) berhasil dikirim ke ${customer.phone_number}`);
                    }
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
    sendPostOrderFollowUp,
    invalidateConfigCache,
    detectOrderId,
    withTimeout,
};
