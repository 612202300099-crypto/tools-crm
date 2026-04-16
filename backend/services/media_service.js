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
        model: 'gpt-4o',
        messages: [
            {
                role: 'system',
                content: `Kamu adalah sistem OCR presisi tinggi yang bertugas mengekstrak Nomor Pesanan dari screenshot marketplace Indonesia (Shopee, Tokopedia, TikTok Shop, Lazada, dll).

DEFINISI NOMOR PESANAN:
- Deretan TEPAT 18 digit angka (0-9) berurutan tanpa spasi, huruf, atau karakter lain di antaranya.
- Contoh VALID: 240416987654321012
- Contoh TIDAK VALID: 2404-1698-7654-3210 (ada strip), INV240416987654 (ada huruf)

PROSEDUR WAJIB:
1. Pindai seluruh area gambar dengan teliti, termasuk pojok dan area kecil.
2. Jika menemukan kandidat 18 digit, BACA ULANG setiap digit satu per satu dari kiri ke kanan untuk memastikan tidak ada digit yang salah baca (misal: 8 vs 0, 1 vs 7, 6 vs 8, 5 vs 6).
3. Jika yakin 100% dengan setiap digit, balas HANYA dengan 18 digit angka tersebut (tanpa teks, spasi, atau karakter lain).
4. Jika TIDAK menemukan atau RAGU pada satu digit pun, balas HANYA: NOT_FOUND
5. DILARANG KERAS mengarang, menebak, atau menginterpolasi digit yang tidak terbaca jelas.`
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Temukan dan baca dengan sangat teliti nomor pesanan (18 digit angka) dari screenshot ini. Periksa ulang setiap digit sebelum menjawab.' },
                    {
                        type: 'image_url',
                        image_url: {
                            url: `data:${mimeType};base64,${base64Image}`,
                            detail: 'high' // High-res: resolusi penuh untuk akurasi maksimal
                        }
                    }
                ]
            }
        ],
        max_tokens: 50,
        temperature: 0,
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
