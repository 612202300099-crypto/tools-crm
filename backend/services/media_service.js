/**
 * Media Service
 * Tugas:
 * 1. Scan gambar menggunakan OpenAI Vision untuk mengekstrak Nomor Pesanan (18 digit).
 * 2. Hapus massal media (file VPS + record database).
 */

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Scan satu gambar menggunakan OpenAI Vision untuk menemukan 18-digit Nomor Pesanan.
 * 
 * @param {string} filePath - Path absolut ke file gambar di VPS
 * @returns {Promise<{found: boolean, orderId: string|null, raw: string}>}
 */
async function scanImageForOrderId(filePath) {
    // Baca file gambar dan konversi ke base64
    const imageBuffer = fs.readFileSync(filePath);
    const base64Image = imageBuffer.toString('base64');

    // Deteksi mimetype dari ekstensi
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
    const mimeType = mimeMap[ext] || 'image/jpeg';

    const completion = await openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: `Kamu adalah sistem OCR yang bertugas mengekstrak Nomor Pesanan dari screenshot marketplace Indonesia (Shopee, Tokopedia, TikTok Shop, dll).
Nomor pesanan adalah deretan TEPAT 18 digit angka berurutan (contoh: 241216ABCDEFGH1234 TIDAK valid, tapi 241216123456789012 VALID).
ATURAN:
- Cari angka yang terdiri dari TEPAT 18 digit berurutan di dalam gambar.
- Jika menemukan, balas HANYA dengan angka 18 digit tersebut (tanpa teks lain).
- Jika TIDAK menemukan 18 digit angka berurutan, balas HANYA dengan teks: NOT_FOUND
- Jangan mengarang atau menebak. Hanya lapor apa yang terlihat di gambar.`
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Temukan nomor pesanan (18 digit angka) dari screenshot ini.' },
                    {
                        type: 'image_url',
                        image_url: {
                            url: `data:${mimeType};base64,${base64Image}`,
                            detail: 'low' // Hemat biaya: low-res cukup untuk membaca angka
                        }
                    }
                ]
            }
        ],
        max_tokens: 50,
        temperature: 0, // Deterministik: Tidak ada kreativitas, hanya fakta
    });

    const rawReply = (completion.choices[0]?.message?.content || '').trim();

    // Validasi ketat: Harus tepat 18 digit angka
    const match = rawReply.match(/\b(\d{18})\b/);

    if (match) {
        return { found: true, orderId: match[1], raw: rawReply };
    }
    return { found: false, orderId: null, raw: rawReply };
}

/**
 * Hapus massal file media dari VPS dan database.
 * 
 * @param {Array<{id: string, file_name: string}>} mediaItems - Daftar media yang akan dihapus
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<{deleted: number, failed: number}>}
 */
async function deleteMediaBulk(mediaItems, supabase) {
    let deleted = 0;
    let failed = 0;

    for (const item of mediaItems) {
        try {
            // Hapus file fisik di VPS
            const filePath = path.join(__dirname, '..', 'uploads', item.file_name);
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath);
            }

            // Hapus record dari database
            await supabase.from('media').delete().eq('id', item.id);
            deleted++;
        } catch (err) {
            console.error(`[MEDIA-SVC] ⚠️ Gagal hapus media ${item.id}:`, err.message);
            failed++;
        }
    }

    return { deleted, failed };
}

module.exports = {
    scanImageForOrderId,
    deleteMediaBulk,
};
