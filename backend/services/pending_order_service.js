/**
 * Pending Order Service — v1
 * ─────────────────────────────────────────────────────────────
 * Menangani race condition: customer kirim nomor pesanan SEBELUM
 * tim sempat update spreadsheet.
 *
 * Alur:
 * 1. Order tidak ditemukan di sheets → masuk queue (pending_orders)
 * 2. Cron setiap 5 menit → retry lookup ke sheets (bypass cache)
 * 3. Jika ditemukan → kirim detail pesanan + minta foto ke customer
 * 4. Jika 6x retry (~30 menit) tetap tidak ada → escalation message
 * 5. Data persisten di SQLite → tidak hilang kalau PM2 restart
 */

const path = require('path');

// ── Lazy-load agar tidak circular dependency ──────────────────────────────────
function getDb() { return require('../db'); }

// Catatan: tabel pending_orders sudah dibuat oleh db.js saat startup.
// Tidak perlu initTable() di sini agar tidak ada schema ganda.

// ── Konstanta ─────────────────────────────────────────────────────────────────
const MAX_RETRIES     = 6;         // 6 × 5 menit = 30 menit total
const RETRY_INTERVAL  = 5 * 60 * 1000; // 5 menit (untuk guard di processPendingOrders)

// ── Deps yang di-inject dari luar (dihindari require circular) ─────────────────
let _waClient  = null;
let _supabase  = null;

/**
 * Inject dependensi: harus dipanggil dari index.js setelah client ready.
 * @param {object} waClient  - whatsapp-web.js client
 * @param {object} supabase  - supabase shim instance
 */
function init(waClient, supabase) {
    _waClient = waClient;
    _supabase = supabase;
    console.log('[PENDING-ORDER] ✅ Service diinisialisasi.');
}

// ── Tambah nomor pesanan ke antrian ──────────────────────────────────────────
/**
 * Dipanggil dari handleOrderNotFound() di ai_followup_service.js
 * @param {string} customerId
 * @param {string} orderId
 * @param {string} phoneNumber
 */
function addPendingOrder(customerId, orderId, phoneNumber) {
    try {
        const db = getDb();
        // UPSERT: jika sudah ada (customer kirim ulang nomor yang sama), reset retry count
        const stmt = db.prepare(`
            INSERT INTO pending_orders (customer_id, order_id, phone_number, retry_count, last_retry_at, resolved_at)
            VALUES (?, ?, ?, 0, NULL, NULL)
            ON CONFLICT(order_id) DO UPDATE SET
                retry_count   = 0,
                last_retry_at = NULL,
                resolved_at   = NULL,
                created_at    = datetime('now')
        `);
        stmt.run(customerId, orderId, phoneNumber);
        console.log(`[PENDING-ORDER] 📥 Order ${orderId} masuk antrian pending (Customer: ${phoneNumber})`);
    } catch (e) {
        console.error('[PENDING-ORDER] ❌ Gagal addPendingOrder:', e.message);
    }
}

// ── Hapus dari antrian (setelah selesai) ─────────────────────────────────────
function resolvePendingOrder(orderId) {
    try {
        const db = getDb();
        db.prepare(`
            UPDATE pending_orders SET resolved_at = datetime('now') WHERE order_id = ?
        `).run(orderId);
        console.log(`[PENDING-ORDER] ✅ Order ${orderId} resolved & dikeluarkan dari antrian.`);
    } catch (e) {
        console.error('[PENDING-ORDER] ❌ Gagal resolvePendingOrder:', e.message);
    }
}

// ── Ambil semua yang masih pending ───────────────────────────────────────────
function getActivePendingOrders() {
    try {
        const db = getDb();
        return db.prepare(`
            SELECT * FROM pending_orders
            WHERE resolved_at IS NULL
              AND retry_count < max_retries
            ORDER BY created_at ASC
        `).all();
    } catch (e) {
        console.error('[PENDING-ORDER] ❌ Gagal getActivePendingOrders:', e.message);
        return [];
    }
}

// ── Update retry count ────────────────────────────────────────────────────────
function incrementRetry(orderId) {
    try {
        const db = getDb();
        db.prepare(`
            UPDATE pending_orders
            SET retry_count   = retry_count + 1,
                last_retry_at = datetime('now')
            WHERE order_id = ?
        `).run(orderId);
    } catch (e) {
        console.error('[PENDING-ORDER] ❌ Gagal incrementRetry:', e.message);
    }
}

// ── PROSES UTAMA: Dipanggil oleh cron setiap 5 menit ─────────────────────────
/**
 * Iterasi semua pending order, retry lookup ke Google Sheets.
 * Jika ditemukan → kirim detail ke customer via WA.
 * Jika maks retry tercapai → kirim pesan eskalasi.
 */
async function processPendingOrders() {
    const pendingList = getActivePendingOrders();

    if (pendingList.length === 0) return; // Tidak ada yang pending, skip
    console.log(`[PENDING-ORDER] 🔄 Memproses ${pendingList.length} pending order...`);

    // Lazy-load untuk menghindari circular dependency
    const { lookupOrder, formatOrderDetailMessage } = require('./spreadsheet_service');
    const { handleOrderFound, handleOrderCancelled, sendWAMessageDirect } = require('./ai_followup_service');

    for (const pending of pendingList) {
        try {
            console.log(`[PENDING-ORDER] 🔍 Retry #${pending.retry_count + 1}/${pending.max_retries} — Order ${pending.order_id} (${pending.phone_number})`);

            // [KRITIS] Bypass cache karena kita tahu data spreadsheet mungkin sudah diupdate
            const orderResult = await lookupOrder(pending.order_id, { bypassCache: true });

            if (orderResult && orderResult.found && !orderResult.cancelled) {
                // ✅ DITEMUKAN! Kirim detail ke customer
                console.log(`[PENDING-ORDER] 🎉 Order ${pending.order_id} DITEMUKAN setelah ${pending.retry_count + 1} retry!`);

                // Ambil data customer terbaru dari DB
                const { data: customer } = await _supabase
                    .from('customers')
                    .select('*')
                    .eq('id', pending.customer_id)
                    .single();

                if (customer) {
                    // Perbarui order_id customer (mungkin sempat di-null oleh handler lama)
                    await _supabase
                        .from('customers')
                        .update({ order_id: pending.order_id })
                        .eq('id', pending.customer_id);

                    await handleOrderFound(_waClient, customer, orderResult, _supabase);
                }
                resolvePendingOrder(pending.order_id);

            } else if (orderResult && orderResult.cancelled) {
                // ❌ DIBATALKAN — kasih tahu customer, keluarkan dari antrian
                const { data: customer } = await _supabase
                    .from('customers')
                    .select('*')
                    .eq('id', pending.customer_id)
                    .single();

                if (customer) {
                    await handleOrderCancelled(_waClient, customer, orderResult, _supabase);
                }
                resolvePendingOrder(pending.order_id);

            } else {
                // Masih tidak ditemukan — increment retry
                incrementRetry(pending.order_id);
                const nextRetry = pending.retry_count + 1;

                if (nextRetry >= pending.max_retries) {
                    // ⚠️ MAX RETRY TERCAPAI — Eskalasi ke customer
                    console.warn(`[PENDING-ORDER] ⚠️ Order ${pending.order_id} tidak ditemukan setelah ${nextRetry} retry. Eskalasi!`);
                    
                    const { data: config } = await _supabase.from('ai_config').select('is_enabled').eq('id', 1).single();
                    if (config && config.is_enabled) {
                        await sendWAMessageDirect(
                            _waClient,
                            pending.phone_number,
                            `⚠️ Halo kak! Kami sudah mencoba memproses nomor pesanan *${pending.order_id}* namun belum berhasil ditemukan di sistem kami.\n\n` +
                            `Kemungkinan penyebabnya:\n` +
                            `• Pesanan melalui platform lain (bukan TikTok, Tokopedia, atau Shopee yang terdaftar)\n` +
                            `• Nomor pesanan mungkin salah ketik\n\n` +
                            `Mohon hubungi tim kami langsung untuk bantuan lebih lanjut ya kak 🙏\n` +
                            `Tim kami akan membantu secepatnya! 😊`
                        );
                    } else {
                        console.log(`[PENDING-ORDER] 🤫 Stealth Mode: Order ${pending.order_id} gagal eskalasi, pesan WA ditahan.`);
                    }
                    resolvePendingOrder(pending.order_id); // Tutup tiket agar tidak loop terus
                }
            }

            // Jeda antar order — beri Chrome waktu bernapas (10 workers media juga jalan)
            await new Promise(r => setTimeout(r, 5000));

        } catch (err) {
            console.error(`[PENDING-ORDER] ❌ Error memproses order ${pending.order_id}:`, err.message);
            incrementRetry(pending.order_id); // Tetap increment agar tidak loop selamanya
        }
    }

    console.log(`[PENDING-ORDER] ✅ Selesai memproses batch pending orders.`);
}

// ── Status summary untuk monitoring ──────────────────────────────────────────
function getPendingStats() {
    try {
        const db = getDb();
        const active  = db.prepare(`SELECT COUNT(*) as c FROM pending_orders WHERE resolved_at IS NULL`).get();
        const resolved= db.prepare(`SELECT COUNT(*) as c FROM pending_orders WHERE resolved_at IS NOT NULL`).get();
        return { active: active.c, resolved: resolved.c };
    } catch (e) {
        return { active: 0, resolved: 0 };
    }
}

module.exports = {
    init,
    addPendingOrder,
    resolvePendingOrder,
    processPendingOrders,
    getPendingStats,
};
