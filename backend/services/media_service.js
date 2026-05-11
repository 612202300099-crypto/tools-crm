/**
 * Media Service
 * Tugas:
 * 1. Scan gambar menggunakan OpenAI Vision untuk mengekstrak Nomor Pesanan (18 digit).
 * 2. Hapus massal media (file VPS + record database).
 */

const OpenAI = require('openai');
const fs     = require('fs');
const path   = require('path');
const db     = require('../db');
const objectStorage = require('./object_storage_service');

// [BEST PRACTICE] Lazy-init: Jangan buat client saat module di-load.
// Ini mencegah crash jika OPENAI_API_KEY tidak diisi di .env.
let _openaiClient = null;
function getOpenAiClient() {
    if (_openaiClient) return _openaiClient;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey.includes('sk-test') || apiKey.includes('fake')) {
        throw new Error('[MEDIA-SVC] OPENAI_API_KEY tidak diisi. Fitur scan gambar tidak tersedia.');
    }
    _openaiClient = new OpenAI({ apiKey });
    return _openaiClient;
}

function getMimeTypeFromExt(ext) {
    const clean = String(ext || '').toLowerCase().replace('.', '');
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
    return mimeMap[clean] || 'image/jpeg';
}

async function scanImageBufferForOrderId(imageBuffer, ext = 'jpg', options = {}) {
    const base64Image = imageBuffer.toString('base64');
    const mimeType = getMimeTypeFromExt(ext);
    const model = options.model || process.env.OPENAI_VISION_MODEL || 'gpt-4o';

    const completion = await getOpenAiClient().chat.completions.create({
        model,
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
2. Jika menemukan kandidat 18 digit, BACA ULANG setiap digit satu per satu dari kiri ke kanan untuk memastikan tidak ada digit yang salah baca.
3. Jika yakin 100% dengan setiap digit, balas HANYA dengan 18 digit angka tersebut.
4. Jika TIDAK menemukan atau RAGU pada satu digit pun, balas HANYA: NOT_FOUND
5. DILARANG KERAS mengarang, menebak, atau menginterpolasi digit yang tidak terbaca jelas.`
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Temukan nomor pesanan 18 digit dari gambar ini. Jawab hanya 18 digit atau NOT_FOUND.' },
                    {
                        type: 'image_url',
                        image_url: {
                            url: `data:${mimeType};base64,${base64Image}`,
                            detail: options.detail || 'high'
                        }
                    }
                ]
            }
        ],
        max_tokens: 50,
        temperature: 0,
    });

    const rawReply = (completion.choices[0]?.message?.content || '').trim();
    const match = rawReply.match(/\b(\d{18})\b/);
    if (match) return { found: true, orderId: match[1], raw: rawReply };
    return { found: false, orderId: null, raw: rawReply };
}

function incrementUsage(provider, purpose, windowKey) {
    db.prepare(`
        INSERT INTO ai_usage_counters (provider, purpose, window_key, count, updated_at)
        VALUES (?, ?, ?, 1, datetime('now'))
        ON CONFLICT(provider, purpose, window_key)
        DO UPDATE SET count = count + 1, updated_at = datetime('now')
    `).run(provider, purpose, windowKey);
}

function getUsageCount(provider, purpose, windowKey) {
    const row = db.prepare(`
        SELECT count FROM ai_usage_counters
        WHERE provider = ? AND purpose = ? AND window_key = ?
    `).get(provider, purpose, windowKey);
    return row ? row.count : 0;
}

function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

function canAutoScanOrderImage(customerId) {
    if (String(process.env.ORDER_IMAGE_AUTO_SCAN_ENABLED || 'true').toLowerCase() === 'false') {
        return { ok: false, reason: 'disabled' };
    }
    if (!process.env.OPENAI_API_KEY) return { ok: false, reason: 'OPENAI_API_KEY missing' };

    const day = todayKey();
    const maxGlobal = parseInt(process.env.OPENAI_VISION_AUTO_MAX_PER_DAY || '50', 10);
    const maxCustomer = parseInt(process.env.OPENAI_VISION_AUTO_MAX_PER_CUSTOMER_DAY || '2', 10);
    const globalCount = getUsageCount('openai', 'vision_auto_day', day);
    const customerCount = db.prepare(`
        SELECT COUNT(*) as c FROM media
        WHERE customer_id = ?
          AND classification_status IN ('AUTO_SCANNED', 'ORDER_ID_FOUND')
          AND substr(classified_at, 1, 10) = ?
    `).get(customerId, day).c;

    if (maxGlobal >= 0 && globalCount >= maxGlobal) return { ok: false, reason: `global limit ${globalCount}/${maxGlobal}` };
    if (maxCustomer >= 0 && customerCount >= maxCustomer) return { ok: false, reason: `customer limit ${customerCount}/${maxCustomer}` };
    return { ok: true, day };
}

function markMediaAsOrderProof(mediaId, orderId, reason = 'order_id_detected') {
    const classifiedAt = new Date().toISOString();
    db.prepare(`
        UPDATE media
        SET excluded_from_production = 1,
            media_kind = 'order_proof',
            detected_order_id = ?,
            classification_status = 'ORDER_ID_FOUND',
            classification_reason = ?,
            classified_at = ?
        WHERE id = ?
    `).run(orderId, reason, classifiedAt, mediaId);

    db.prepare(`
        UPDATE drive_upload_queue
        SET status = 'SKIPPED', error_msg = 'Excluded: order proof image'
        WHERE media_id = ? AND status != 'DONE'
    `).run(mediaId);

    try {
        const updated = db.prepare('SELECT * FROM media WHERE id = ?').get(mediaId);
        if (global._io && updated) {
            global._io.emit('db_change', { table: 'media', eventType: 'UPDATE', new: updated });
        }
    } catch (e) { /* best effort realtime update */ }
}

function markMediaScannedNoOrder(mediaId, reason = 'not_found') {
    db.prepare(`
        UPDATE media
        SET classification_status = 'AUTO_SCANNED',
            classification_reason = ?,
            classified_at = ?
        WHERE id = ?
    `).run(reason, new Date().toISOString(), mediaId);

    try {
        const updated = db.prepare('SELECT * FROM media WHERE id = ?').get(mediaId);
        if (global._io && updated) {
            global._io.emit('db_change', { table: 'media', eventType: 'UPDATE', new: updated });
        }
    } catch (e) { /* best effort realtime update */ }
}

async function continueOrderFlowFromDetectedImage({ waClient, supabase, customer, orderId }) {
    await supabase.from('customers').update({ order_id: orderId }).eq('id', customer.id);

    const { lookupOrder } = require('./spreadsheet_service');
    const orderResult = await lookupOrder(orderId);
    const aiFollowup = require('./ai_followup_service');
    const updatedCustomer = { ...customer, order_id: orderId };

    if (!orderResult) {
        if (aiFollowup.handleOrderNotFound) {
            await aiFollowup.handleOrderNotFound(waClient, updatedCustomer, orderId, supabase);
        }
        return;
    }
    if (orderResult.cancelled) {
        await aiFollowup.handleOrderCancelled(waClient, updatedCustomer, orderResult, supabase);
        return;
    }
    await aiFollowup.handleOrderFound(waClient, updatedCustomer, orderResult, supabase);
}

async function autoClassifyOrderImage(params) {
    const { mediaId, customerId, buffer, ext, supabase, waClient } = params;
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer || customer.order_id) return { scanned: false, reason: 'customer_has_order_or_missing' };

    const limit = canAutoScanOrderImage(customerId);
    if (!limit.ok) {
        db.prepare(`
            UPDATE media
            SET classification_status = COALESCE(classification_status, 'SKIPPED'),
                classification_reason = ?,
                classified_at = COALESCE(classified_at, ?)
            WHERE id = ?
        `).run(`auto_scan_${limit.reason}`, new Date().toISOString(), mediaId);
        return { scanned: false, reason: limit.reason };
    }

    incrementUsage('openai', 'vision_auto_day', limit.day);
    const result = await scanImageBufferForOrderId(buffer, ext, {
        model: process.env.OPENAI_VISION_AUTO_MODEL || 'gpt-4o-mini',
        detail: 'high',
    });

    if (!result.found) {
        markMediaScannedNoOrder(mediaId, `not_found:${String(result.raw || '').substring(0, 60)}`);
        return { scanned: true, found: false };
    }

    markMediaAsOrderProof(mediaId, result.orderId, 'auto_scan_order_id');
    await continueOrderFlowFromDetectedImage({ waClient, supabase, customer, orderId: result.orderId });
    return { scanned: true, found: true, orderId: result.orderId };
}

/**
 * Scan satu gambar menggunakan OpenAI Vision untuk menemukan 18-digit Nomor Pesanan.
 *
 * @param {string} filePath - Path absolut ke file gambar di VPS
 * @returns {Promise<{found: boolean, orderId: string|null, raw: string}>}
 */
async function scanImageForOrderId(filePath) {
    // Baca file gambar dan konversi ke base64
    const imageBuffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    return scanImageBufferForOrderId(imageBuffer, ext, { model: 'gpt-4o', detail: 'high' });
}

/**
 * Hapus massal file media dari Object Storage/disk dan database.
 *
 * @param {Array<{id: string, file_name: string, storage_key?: string, storage_type?: string}>} mediaItems
 * @param {object} supabase
 * @returns {Promise<{deleted: number, failed: number}>}
 */
async function deleteMediaBulk(mediaItems, supabase) {
    let deleted = 0;
    let failed  = 0;

    for (const item of mediaItems) {
        try {
            // Hapus dari object storage ATAU disk lokal berdasarkan storage_type
            const storageType = item.storage_type || 'local';
            const storageKey  = item.storage_key  || item.file_name;
            await objectStorage.deleteMedia(storageKey, storageType);

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
    scanImageBufferForOrderId,
    autoClassifyOrderImage,
    markMediaAsOrderProof,
    markMediaScannedNoOrder,
    continueOrderFlowFromDetectedImage,
    deleteMediaBulk,
};
