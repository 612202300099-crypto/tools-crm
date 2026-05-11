/**
 * Outgoing Message Queue — Anti-Spam & Natural Delay System
 * ──────────────────────────────────────────────────────────
 * MASALAH TANPA SISTEM INI:
 *   10 customer chat barengan → bot balas ke semua dalam 1 detik
 *   WhatsApp: pola broadcast → akun dibatasi/banned
 *
 * SOLUSI: Semua pesan bot melewati satu antrean global. Diproses
 * satu per satu dengan jeda alami layaknya manusia sungguhan.
 *
 * PERLINDUNGAN YANG DIIMPLEMENTASIKAN:
 *  1. Serial queue         — hanya 1 pesan dikirim pada satu waktu
 *  2. Natural inter-delay  — 5–15 detik acak antar customer berbeda
 *  3. Intra-delay          — 1.5–3.5 detik untuk pesan berantai (customer sama)
 *  4. Per-customer cooldown— min 45 detik antara 2 balasan ke 1 customer
 *  5. Hourly cap           — max 40 pesan bot per jam (dapat diubah)
 *  6. Quiet hours          — tidak kirim 23:00–07:00 WIB
 *  7. Re-queue graceful    — pesan yg kena cooldown diantri ulang, tidak hilang
 */

'use strict';

const chromeSemaphore = require('./chrome_semaphore');

// ─── Konfigurasi (dapat disesuaikan) ──────────────────────────────────────────
const CFG = {
    MAX_PER_HOUR: 40,         // Batas pesan bot per jam
    QUIET_HOUR_START: 23,     // Jam tenang mulai (WIB) — tidak kirim
    QUIET_HOUR_END: 7,        // Jam tenang selesai (WIB)
    COOLDOWN_SAME_CUSTOMER: 45_000,   // 45 detik min antar pesan ke customer yang sama
    DELAY_DIFF_CUSTOMER_MIN: 5_000,   // 5 detik min jeda antar customer berbeda
    DELAY_DIFF_CUSTOMER_MAX: 15_000,  // 15 detik max jeda antar customer berbeda
    DELAY_SAME_CUSTOMER_MIN: 1_500,   // 1.5 detik min untuk pesan lanjutan ke customer sama
    DELAY_SAME_CUSTOMER_MAX: 3_500,   // 3.5 detik max
    SEND_TIMEOUT_MS: 60_000,          // Batas waktu satu pengiriman
    MAX_QUEUE_SIZE: 200,              // Batas ukuran antrean (cegah memory leak)
    REQUEUE_MAX_ATTEMPTS: 3,          // Berapa kali pesan cooldown boleh diantri ulang
};

class OutgoingMessageQueue {
    constructor() {
        this._queue = [];          // Array of job objects
        this._processing = false;
        this._lastSentPhone = null;
        this._lastSentAt = 0;
        this._perCustomer = new Map();   // phone → { lastSentAt, requeueCount }
        this._hourlyCount = 0;
        this._hourlyResetAt = Date.now() + 3_600_000;
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    /** Jam WIB sekarang (0-23) */
    _wibHour() {
        return (new Date().getUTCHours() + 7) % 24;
    }

    /** Apakah sekarang jam tenang? */
    _isQuietHour() {
        const h = this._wibHour();
        return h >= CFG.QUIET_HOUR_START || h < CFG.QUIET_HOUR_END;
    }

    /** Reset counter per jam jika sudah waktunya */
    _tickHourly() {
        if (Date.now() > this._hourlyResetAt) {
            this._hourlyCount = 0;
            this._hourlyResetAt = Date.now() + 3_600_000;
            console.log('[OUT-QUEUE] 🔄 Hourly counter direset.');
        }
    }

    /** Hitung berapa ms harus delay sebelum kirim */
    _naturalDelay(targetPhone) {
        const now = Date.now();
        if (this._lastSentPhone === targetPhone) {
            // Pesan ke customer yang SAMA → jeda singkat (sedang "mengetik lanjutan")
            return CFG.DELAY_SAME_CUSTOMER_MIN +
                Math.floor(Math.random() * (CFG.DELAY_SAME_CUSTOMER_MAX - CFG.DELAY_SAME_CUSTOMER_MIN));
        }
        // Customer BERBEDA → jeda lebih panjang (simulasi manusia berpindah chat)
        const elapsed = now - this._lastSentAt;
        const wantedGap = CFG.DELAY_DIFF_CUSTOMER_MIN +
            Math.floor(Math.random() * (CFG.DELAY_DIFF_CUSTOMER_MAX - CFG.DELAY_DIFF_CUSTOMER_MIN));
        return Math.max(0, wantedGap - elapsed);
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Tambahkan pesan ke antrean.
     * @param {object} waClient  - WhatsApp Web client
     * @param {string} phone     - nomor HP tanpa @c.us
     * @param {string} message   - isi pesan
     * @returns {Promise<void>}  - resolve saat pesan berhasil dikirim
     */
    enqueue(waClient, phone, message) {
        if (this._queue.length >= CFG.MAX_QUEUE_SIZE) {
            console.warn(`[OUT-QUEUE] ⚠️ Antrean penuh (${CFG.MAX_QUEUE_SIZE}). Pesan ke ${phone} dibuang.`);
            return Promise.reject(new Error('QUEUE_FULL'));
        }

        return new Promise((resolve, reject) => {
            this._queue.push({ waClient, phone, message, resolve, reject, requeueCount: 0, addedAt: Date.now() });
            if (!this._processing) this._runNext();
        });
    }

    /** Laporan status antrean saat ini */
    status() {
        return {
            queueLength: this._queue.length,
            processing: this._processing,
            hourlyCount: this._hourlyCount,
            hourlyMax: CFG.MAX_PER_HOUR,
            lastSentPhone: this._lastSentPhone,
        };
    }

    // ── Internal Loop ──────────────────────────────────────────────────────────

    async _runNext() {
        if (this._queue.length === 0) {
            this._processing = false;
            return;
        }
        this._processing = true;
        const job = this._queue.shift();

        try {
            this._tickHourly();

            // ─ Guard 1: Quiet Hours ─────────────────────────────────────────
            if (this._isQuietHour()) {
                console.warn(`[OUT-QUEUE] 🌙 Jam tenang (${this._wibHour()}:xx WIB). Pesan ke ${job.phone} dilewati.`);
                job.resolve(); // skip gracefully — jangan reject, biarkan alur lanjut
                return this._runNext();
            }

            // ─ Guard 2: Hourly cap ──────────────────────────────────────────
            if (this._hourlyCount >= CFG.MAX_PER_HOUR) {
                const minLeft = Math.ceil((this._hourlyResetAt - Date.now()) / 60_000);
                console.warn(`[OUT-QUEUE] ⛔ Batas ${CFG.MAX_PER_HOUR} pesan/jam tercapai. Reset dalam ~${minLeft} menit.`);
                job.reject(new Error('HOURLY_LIMIT_REACHED'));
                return this._runNext();
            }

            // ─ Guard 3: Per-customer cooldown ───────────────────────────────
            const cust = this._perCustomer.get(job.phone) || { lastSentAt: 0, requeueCount: 0 };
            const sinceLastMs = Date.now() - cust.lastSentAt;

            if (sinceLastMs < CFG.COOLDOWN_SAME_CUSTOMER) {
                const waitLeft = CFG.COOLDOWN_SAME_CUSTOMER - sinceLastMs;

                if (job.requeueCount >= CFG.REQUEUE_MAX_ATTEMPTS) {
                    // Sudah terlalu banyak diantri ulang — buang
                    console.warn(`[OUT-QUEUE] 🗑️ Pesan ke ${job.phone} dibuang setelah ${job.requeueCount}x requeue.`);
                    job.resolve();
                    return this._runNext();
                }

                // Antri ulang di posisi akhir
                job.requeueCount++;
                console.log(`[OUT-QUEUE] ⏱️ Cooldown ${Math.ceil(waitLeft / 1000)}s untuk ${job.phone} — requeue #${job.requeueCount}`);
                await new Promise(r => setTimeout(r, Math.min(waitLeft, 8_000)));
                this._queue.push(job);
                return this._runNext();
            }

            // ─ Natural delay ────────────────────────────────────────────────
            const delay = this._naturalDelay(job.phone);
            if (delay > 500) {
                console.log(`[OUT-QUEUE] ⏳ Jeda ${(delay / 1000).toFixed(1)}s → ${job.phone}`);
                await new Promise(r => setTimeout(r, delay));
            }

            // ─ Kirim pesan ──────────────────────────────────────────────────
            const chatId = `${job.phone}@c.us`;
            await chromeSemaphore.acquire('AI:sendMsg', () =>
                job.waClient.sendMessage(chatId, job.message)
            , { priority: 3, timeout: CFG.SEND_TIMEOUT_MS + 30_000 });

            // Update state
            this._lastSentPhone = job.phone;
            this._lastSentAt = Date.now();
            this._perCustomer.set(job.phone, { lastSentAt: Date.now(), requeueCount: 0 });
            this._hourlyCount++;

            console.log(`[OUT-QUEUE] ✅ Terkirim → ${job.phone} | Sisa: ${this._queue.length} | Jam: ${this._hourlyCount}/${CFG.MAX_PER_HOUR}`);
            job.resolve();

        } catch (err) {
            console.error(`[OUT-QUEUE] ❌ Gagal kirim → ${job.phone}:`, err.message);
            job.reject(err);
        }

        // Proses berikutnya
        setImmediate(() => this._runNext());
    }
}

// Singleton — satu antrean global untuk seluruh proses Node.js
const outgoingQueue = new OutgoingMessageQueue();
module.exports = outgoingQueue;
