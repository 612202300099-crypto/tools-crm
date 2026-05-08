/**
 * Stability Manager (Watchdog) — v3
 * ─────────────────────────────────────────────────────────────
 * Penjaga stabilitas WhatsApp Engine 24/7 di VPS.
 *
 * Perbaikan dari v2:
 *
 * [FIX 1] STALE threshold lebih realistis: 45 menit → 3 jam
 *   Bisnis tidak selalu ramai, 45 menit false-positive di jam sepi.
 *
 * [FIX 2] Jam aktif lebih ketat: 06-23 → 08-21 (WIB)
 *   Di luar jam ini, pelanggan hampir pasti tidak aktif.
 *
 * [FIX 3] Loop Guard — restart counter per jam
 *   Mencegah siklus restart tanpa akhir jika ada masalah persisten.
 *   Max 3 restart per jam. Setelah itu, diam sampai jam reset berikutnya.
 *
 * [FIX 4] Graceful Health Check — Toleransi Puppeteer "noise"
 *   getState() bisa gagal karena Puppeteer context transient error,
 *   bukan berarti engine mati. Harus dibedakan.
 *
 * [FIX 5] setBusy() lebih robust — auto-clear jika lupa
 *   Durasi busy dibatasi max 30 menit agar tidak selamanya di-skip.
 */

class StabilityManager {
    constructor(client, options = {}) {
        this.client = client;
        this.lastActivity = Date.now();
        this.checkInterval = options.checkInterval || 5 * 60 * 1000;   // Cek tiap 5 menit
        this.staleThreshold = options.staleThreshold || 3 * 60 * 60 * 1000; // 3 jam stale (v3)
        this.isMonitoring = false;
        this.consecutiveFailures = 0;
        this.MAX_FAILURES = 3;
        this._busyUntil = 0;
        this._intervalRef = null;

        // [v3] Loop Guard — Mencegah restart tanpa akhir
        this._restartTimestamps = []; // Array of timestamps saat restart dipicu
        this.MAX_RESTARTS_PER_HOUR = 3;
        this.RESTART_WINDOW_MS = 60 * 60 * 1000; // 1 jam

        // [v3] Jam aktif STALE check (WIB = UTC+7)
        this.ACTIVE_HOUR_START = options.activeHourStart ?? 8;  // 08:00 WIB
        this.ACTIVE_HOUR_END   = options.activeHourEnd   ?? 21; // 21:00 WIB
    }

    /**
     * Panggil ini setiap ada aktifitas (pesan masuk/keluar)
     */
    heartbeat() {
        this.lastActivity = Date.now();
        this.consecutiveFailures = 0;
    }

    /**
     * Tandai sistem sebagai "busy" selama durasi tertentu.
     * Saat busy: health check di-skip (tidak ada false-restart).
     * Gunakan ini saat startup sync, bulk processing, dll.
     *
     * @param {number} durationMs - Durasi busy dalam millisecond (max 30 menit)
     */
    setBusy(durationMs = 5 * 60 * 1000) {
        // [v3] Cap di 30 menit agar tidak selamanya di-skip jika caller lupa clear
        const maxBusy = 30 * 60 * 1000;
        const safeDuration = Math.min(durationMs, maxBusy);
        this._busyUntil = Date.now() + safeDuration;
        console.log(`[WATCHDOG] 🔄 Mode BUSY aktif selama ${Math.round(safeDuration / 60000)} menit (health check di-pause).`);
    }

    isBusy() {
        return Date.now() < this._busyUntil;
    }

    /**
     * Mulai pemantauan
     */
    start() {
        if (this.isMonitoring) return;
        this.isMonitoring = true;
        this.lastActivity = Date.now(); // Reset saat start agar tidak langsung STALE
        console.log(`[WATCHDOG] 🛡️ Monitoring dimulai (v3). STALE threshold: ${this.staleThreshold / 60000} menit, Jam aktif: ${this.ACTIVE_HOUR_START}:00-${this.ACTIVE_HOUR_END}:00 WIB.`);

        this._intervalRef = setInterval(async () => {
            await this.checkHealth();
        }, this.checkInterval);
    }

    /**
     * Hentikan pemantauan (saat disconnect, dll)
     */
    stop() {
        if (this._intervalRef) {
            clearInterval(this._intervalRef);
            this._intervalRef = null;
        }
        this.isMonitoring = false;
        console.log('[WATCHDOG] ⏹️ Monitoring dihentikan.');
    }

    /**
     * [v3] Cek apakah loop guard mengizinkan restart.
     * Mencegah >3 restart dalam 1 jam (siklus restart tanpa akhir).
     */
    _canRestart() {
        const now = Date.now();
        // Bersihkan timestamp lama (>1 jam)
        this._restartTimestamps = this._restartTimestamps.filter(
            ts => (now - ts) < this.RESTART_WINDOW_MS
        );
        return this._restartTimestamps.length < this.MAX_RESTARTS_PER_HOUR;
    }

    async checkHealth() {
        // [FIX 1] Skip health check saat sistem sedang busy (startup sync, bulk processing)
        if (this.isBusy()) {
            console.log('[WATCHDOG] ⏳ Sistem sedang BUSY — health check dilewati.');
            return;
        }

        try {
            // Cek responsivitas via getState (timeout 15 detik)
            const state = await Promise.race([
                this.client.getState(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('TIMEOUT_GET_STATE')), 15000)
                )
            ]);

            // [FIX 2] Cek STALE: hanya saat jam aktif (08:00-21:00 WIB)
            // Di luar jam aktif tidak ada customer → tidak ada heartbeat → bukan STALE
            const now = new Date();
            const hourWIB = (now.getUTCHours() + 7) % 24; // Wrap-around aman
            const isActiveHours = hourWIB >= this.ACTIVE_HOUR_START && hourWIB < this.ACTIVE_HOUR_END;

            if (isActiveHours) {
                const timeSinceLastActivity = Date.now() - this.lastActivity;
                if (timeSinceLastActivity > this.staleThreshold) {
                    console.warn(`[WATCHDOG] ⚠️ Engine STALE: Tidak ada aktifitas ${Math.round(timeSinceLastActivity / 60000)} menit. (Threshold: ${Math.round(this.staleThreshold / 60000)} menit)`);
                    this.triggerRestart('ENGINE_STALE');
                    return;
                }
            }

            this.consecutiveFailures = 0;

        } catch (err) {
            // [v3 FIX 4] Bedakan Puppeteer noise vs error asli
            const TRANSIENT_ERRORS = [
                'Execution context was destroyed',
                'Session closed',
                'Target closed',
                'detached Frame',
                'Protocol error',
                'TIMEOUT_GET_STATE',
            ];
            const isTransient = TRANSIENT_ERRORS.some(noise => err.message?.includes(noise));

            this.consecutiveFailures++;
            const maxFail = isTransient ? 5 : this.MAX_FAILURES; // Transient error lebih toleran
            console.error(`[WATCHDOG] ❌ Health check failed (${this.consecutiveFailures}/${maxFail}): ${err.message} ${isTransient ? '[transient]' : '[critical]'}`);

            if (this.consecutiveFailures >= maxFail) {
                this.triggerRestart('CONSECUTIVE_FAILURES');
            }
        }
    }

    triggerRestart(reason) {
        // [v3 FIX 3] Loop Guard — cegah restart tanpa akhir
        if (!this._canRestart()) {
            console.error(`[WATCHDOG] 🛑 LOOP GUARD: Sudah ${this._restartTimestamps.length} restart dalam 1 jam terakhir! Menolak restart untuk mencegah siklus tanpa akhir. Alasan: ${reason}`);
            console.error(`[WATCHDOG] ℹ️ Engine akan diam sampai interval restart mereda. Cek PM2 logs untuk investigasi.`);
            // Reset failure counter agar tidak terus menumpuk
            this.consecutiveFailures = 0;
            return;
        }

        this._restartTimestamps.push(Date.now());
        console.error(`[WATCHDOG] 🔥 Restart otomatis dipicu (${this._restartTimestamps.length}/${this.MAX_RESTARTS_PER_HOUR} dalam 1 jam). Alasan: ${reason}`);
        process.exit(1);
    }

    /**
     * [v3] Dapatkan status watchdog untuk monitoring/debugging.
     */
    getStatus() {
        const now = Date.now();
        const hourWIB = (new Date().getUTCHours() + 7) % 24;
        return {
            isMonitoring: this.isMonitoring,
            isBusy: this.isBusy(),
            busyUntil: this._busyUntil > now ? new Date(this._busyUntil).toISOString() : null,
            lastActivity: new Date(this.lastActivity).toISOString(),
            minutesSinceActivity: Math.round((now - this.lastActivity) / 60000),
            staleThresholdMinutes: Math.round(this.staleThreshold / 60000),
            consecutiveFailures: this.consecutiveFailures,
            restartsInLastHour: this._restartTimestamps.filter(ts => (now - ts) < this.RESTART_WINDOW_MS).length,
            maxRestartsPerHour: this.MAX_RESTARTS_PER_HOUR,
            currentHourWIB: hourWIB,
            isActiveHours: hourWIB >= this.ACTIVE_HOUR_START && hourWIB < this.ACTIVE_HOUR_END,
        };
    }
}

module.exports = StabilityManager;
