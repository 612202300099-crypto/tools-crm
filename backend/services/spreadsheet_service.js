/**
 * Spreadsheet Service
 * ─────────────────────────────────────────────────────────────
 * Tugas: Mencari nomor pesanan di 3 Google Spreadsheet (Ventura,
 * Giftyours, Custombase) dan mengembalikan detail pesanan
 * terstruktur beserta kalkulasi kebutuhan foto.
 *
 * Best Practice:
 * - In-memory cache per order_id (TTL 15 menit) → hemat API quota
 * - bypassCache=true → untuk pending order retry (data selalu fresh)
 * - Fail-safe per toko (error 1 toko tidak menghentikan pencarian)
 * - Offset kolom berbeda per toko ditangani secara deklaratif
 * - Deteksi produk Polaroid otomatis dari nama produk / SKU
 */

// ─── Konfigurasi Toko & Mapping Kolom ──────────────────────────────────────────
// Ventura & Giftyours: kolom mulai dari C (index 2)
// Custombase: kolom mulai dari A (index 0) — shift -2
const STORES = [
    {
        name: 'ventura',
        displayName: 'Ventura',
        spreadsheetId: process.env.SPREADSHEET_VENTURA,
        sheetName: 'EKSPORT',
        colOffset: 2,  // Data dimulai dari kolom C (index 2)
        dataStartRow: 4, // Baris pertama data (setelah header)
    },
    {
        name: 'giftyours',
        displayName: 'Giftyours',
        spreadsheetId: process.env.SPREADSHEET_GIFTYOURS,
        sheetName: 'EKSPORT',
        colOffset: 2,
        dataStartRow: 4,
    },
    {
        name: 'custombase',
        displayName: 'Custombase',
        spreadsheetId: process.env.SPREADSHEET_CUSTOMBASE,
        sheetName: 'EKSPORT',
        colOffset: 0,  // Data dimulai dari kolom A (index 0)
        dataStartRow: 4,
    },
];

// ─── Mapping Kolom (0-indexed, sebelum ditambah offset) ─────────────────────────
// Kolom absolut = colIndex + colOffset
// Contoh Ventura: ORDER_ID_COL = 0 + 2 = 2 (kolom C)
// Contoh Custombase: ORDER_ID_COL = 0 + 0 = 0 (kolom A)
const COL = {
    ORDER_ID:    0,  // C untuk Ventura, A untuk Custombase
    STATUS:      2,  // E untuk Ventura, C untuk Custombase
    SKU:         6,  // I untuk Ventura, G untuk Custombase
    PRODUCT:     7,  // J untuk Ventura, H untuk Custombase
    QUANTITY:    9,  // L untuk Ventura, J untuk Custombase
};

// ─── In-Memory Cache ─────────────────────────────────────────────────────────────
const orderCache = new Map(); // key: orderId, value: { result, timestamp }
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 menit

// ─── Helper: Ambil nilai kolom dengan benar berdasarkan offset ──────────────────
function getCol(row, colKey, offset) {
    const absoluteIndex = COL[colKey] + offset;
    return (row[absoluteIndex] || '').toString().trim();
}

// ─── Helper: Deteksi apakah produk adalah Polaroid ──────────────────────────────
function isPolaroidProduct(productName, sku) {
    const nameUpper = (productName || '').toUpperCase();
    const skuUpper  = (sku || '').toUpperCase();
    return nameUpper.includes('POLAROID') || skuUpper.includes('POLAROID');
}

// ─── Helper: Ekstrak jumlah pcs dari SKU/nama varian Polaroid ───────────────────
// Contoh SKU: "Polaroid50", "POLAROID25", "POL-25PCS", atau nama produk "Polaroid 25 pcs"
// Return angka pcs, atau 0 jika tidak ditemukan
//
// [BUG FIX] Regex lama: \b(25|50|...)\b
// GAGAL pada "Polaroid50" karena \b tidak match antara 'D' dan '5'
// (keduanya word char → tidak ada word boundary).
// Fix: Cari angka langsung setelah kata "POLAROID" (dengan/tanpa separator).
function extractPolaroidPcs(productName, sku, variation) {
    const combined = `${productName} ${sku} ${variation}`.toUpperCase();

    // PASS 1: Cari angka yang menempel/dekat kata POLAROID
    // Match: "POLAROID50", "POLAROID-25", "POLAROID 75", "POL50", "POL-25PCS"
    const polaroidMatch = combined.match(/POLAROID[-_ ]?(\d+)/);
    if (polaroidMatch) {
        const pcs = parseInt(polaroidMatch[1], 10);
        if (pcs > 0) return pcs;
    }

    // PASS 2: Fallback — cari angka berdiri sendiri (word boundary)
    const match = combined.match(/\b(25|50|75|100|125|150|175|200)\b/);
    return match ? parseInt(match[1], 10) : 0;
}

// ─── Fungsi Utama: Fetch satu sheet dari Google Sheets API ───────────────────────
async function fetchSheetData(spreadsheetId, sheetName, apiKey) {
    // [BEST PRACTICE] Ambil A:N (14 kolom) untuk mengakomodasi Variation di kolom K-M
    const range = encodeURIComponent(`${sheetName}!A:N`);
    const url   = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?key=${apiKey}`;

    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText.substring(0, 200)}`);
    }

    const json = await response.json();
    return json.values || [];
}

// ─── Fungsi Utama: Cari nomor pesanan di satu toko ───────────────────────────────
async function lookupInStore(store, orderId, apiKey) {
    const rows   = await fetchSheetData(store.spreadsheetId, store.sheetName, apiKey);
    const offset = store.colOffset;

    // Lewati baris header (mulai dari dataStartRow - 1 karena 0-indexed)
    const dataRows = rows.slice(store.dataStartRow - 1);

    // Kumpulkan semua baris yang cocok dengan order ID (bisa multi-row untuk multi-item)
    const matchedRows = dataRows.filter(row => {
        const cellOrderId = getCol(row, 'ORDER_ID', offset);
        return cellOrderId === orderId.toString();
    });

    if (matchedRows.length === 0) return null;

    // Cek status dari baris pertama yang cocok
    const statusRaw   = getCol(matchedRows[0], 'STATUS', offset);
    const isCancelled = statusRaw.toLowerCase().includes('batal') ||
                        statusRaw.toLowerCase().includes('cancel');

    if (isCancelled) {
        return {
            found: true,
            cancelled: true,
            store: store.name,
            storeName: store.displayName,
            status: statusRaw,
            items: [],
        };
    }

    // Parse semua item pesanan
    const items = matchedRows.map(row => {
        const sku         = getCol(row, 'SKU', offset);
        const productName = getCol(row, 'PRODUCT', offset);
        const qty         = parseInt(getCol(row, 'QUANTITY', offset), 10) || 1;
        const variation   = (row[COL.SKU + offset + 1] || '').toString().trim(); // Kolom Variation (K untuk Ventura)
        const isPolaroid  = isPolaroidProduct(productName, sku);
        const polaroidPcs = isPolaroid ? extractPolaroidPcs(productName, sku, variation) : 0;

        return {
            sku,
            productName,
            qty,
            variation,
            isPolaroid,
            polaroidPcs,
            // Jumlah foto jika Polaroid: pcs × qty
            photosNeeded: isPolaroid ? (polaroidPcs * qty) : 0,
        };
    });

    // Total foto yang dibutuhkan (hanya dari item Polaroid)
    const totalPhotosNeeded = items.reduce((sum, item) => sum + item.photosNeeded, 0);
    const hasPolaroid       = items.some(item => item.isPolaroid);

    return {
        found: true,
        cancelled: false,
        store: store.name,
        storeName: store.displayName,
        status: statusRaw,
        items,
        totalPhotosNeeded,
        hasPolaroid,
    };
}

// ─── EXPORT: Fungsi Publik Utama ─────────────────────────────────────────────────
/**
 * Cari nomor pesanan di seluruh 3 toko.
 *
 * @param {string} orderId
 * @param {object} [options]
 * @param {boolean} [options.bypassCache=false]
 *   Paksa fetch ulang dari Sheets, lewati cache 15 menit.
 *   WAJIB true saat dipanggil dari pending_order_service (retry)
 *   agar selalu mendapat data terbaru jika tim sudah update spreadsheet.
 *
 * @returns {{ found, cancelled, store, storeName, status, items,
 *             totalPhotosNeeded, hasPolaroid } | null}
 */
async function lookupOrder(orderId, { bypassCache = false } = {}) {
    const apiKey = process.env.GOOGLE_SHEETS_API_KEY;

    // Guard: belum diisi atau masih placeholder
    if (!apiKey || apiKey.includes('ISI_API_KEY')) {
        console.warn('[SHEET] ⚠️ GOOGLE_SHEETS_API_KEY belum diisi di .env. Fitur cek spreadsheet dinonaktifkan.');
        return null;
    }

    const cacheKey = orderId.toString();

    // Cek cache — skip jika bypassCache=true (pending order retry selalu fresh)
    if (!bypassCache) {
        const cached = orderCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
            console.log(`[SHEET] 📦 Cache hit untuk order ${orderId}`);
            return cached.result;
        }
    } else {
        console.log(`[SHEET] 🔄 Bypass cache untuk order ${orderId} (pending retry — ambil data terbaru)`);
        orderCache.delete(cacheKey); // Hapus cache lama agar hasil baru tersimpan
    }

    console.log(`[SHEET] 🔍 Mencari nomor pesanan ${orderId} di 3 spreadsheet...`);

    // Cari di semua toko secara paralel untuk kecepatan
    const promises = STORES.map(store =>
        lookupInStore(store, orderId, apiKey)
            .catch(err => {
                console.error(`[SHEET] ❌ Gagal cari di ${store.displayName}: ${err.message}`);
                return null; // Fail-safe: error 1 toko tidak blokir yang lain
            })
    );

    const results = await Promise.all(promises);
    const found   = results.find(r => r !== null && r.found === true);
    const result  = found || null;

    // Simpan ke cache (termasuk null = tidak ditemukan — berlaku juga 15 menit)
    orderCache.set(cacheKey, { result, timestamp: Date.now() });

    if (result) {
        const label = result.cancelled ? '❌ DIBATALKAN' : '✅ DITEMUKAN';
        console.log(`[SHEET] ${label} — Order ${orderId} di toko ${result.storeName} (Status: ${result.status})`);
    } else {
        console.log(`[SHEET] ⚠️ Order ${orderId} tidak ditemukan di ketiga spreadsheet.`);
    }

    return result;
}

/**
 * Format detail pesanan menjadi teks WhatsApp yang rapi dan ramah.
 */
function formatOrderDetailMessage(orderResult) {
    const { storeName, status, items, totalPhotosNeeded, hasPolaroid } = orderResult;

    let itemsText = items.map((item, i) => {
        let line = `   ${i + 1}. ${item.productName}`;
        if (item.sku) line += ` (SKU: ${item.sku})`;
        if (item.qty > 1) line += `\n      Qty: ${item.qty}`;
        if (item.isPolaroid && item.polaroidPcs > 0) {
            line += `\n      Varian: ${item.polaroidPcs} pcs × ${item.qty} = *${item.photosNeeded} foto*`;
        }
        return line;
    }).join('\n');

    let message = `✅ *Pesanan Ditemukan!*\n\n`;
    message += `🏪 *Toko:* ${storeName}\n`;
    message += `📦 *Status:* ${status}\n`;
    message += `\n🛍️ *Detail Pesanan:*\n${itemsText}\n`;

    if (hasPolaroid && totalPhotosNeeded > 0) {
        message += `\n📸 *Total Foto Dibutuhkan: ${totalPhotosNeeded} lembar*\n`;
        message += `\nMohon kirimkan *${totalPhotosNeeded} foto* yang ingin Anda cetak di sini ya kak 🙏`;
        message += `\nPastikan kualitas foto jernih dan tidak buram agar hasil cetakan maksimal! 😊`;
    } else {
        message += `\nSilakan kirimkan foto yang ingin Anda cetak di sini ya kak 🙏`;
        message += `\nPastikan kualitas foto jernih dan tidak buram agar hasil cetakan maksimal! 😊`;
    }

    return message;
}

module.exports = { lookupOrder, formatOrderDetailMessage, isPolaroidProduct };
