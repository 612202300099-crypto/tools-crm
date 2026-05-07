/**
 * Stability Manager (Watchdog) — v2
 * ─────────────────────────────────────────────────────────────
 * Perbaikan dari v1:
 *
 * [FIX 1] TIMEOUT_GET_STATE selama startup sync:
 *   - Tambah flag isBusy() untuk memberi tahu watchdog bahwa sistem
 *     sedang dalam mode sibuk (startup sync, bulk processing)
 *   - Saat busy, health check di-skip agar tidak false-positive restart
 *
 * [FIX 2] STALE threshold lebih realistis:
 *   - Malam hari tanpa customer = tidak ada heartbeat = false restart
 *   - Tambah jam aktif (06:00-23:00) untuk STALE check
 *
 * [FIX 3] consecutiveFailures lebih toleran saat busy:
 *   - Saat busy, toleransi 5 kali gagal (bukan 3)
 */

class StabilityManager {
    constructor(client, options = {}) {
        this.client = client;
        this.lastActivity = Date.now();
        this.checkInterval = options.checkInterval || 5 * 60 * 1000;  // Cek tiap 5 menit
        this.staleThreshold = options.staleThreshold || 45 * 60 * 1000; // 45 menit stale
        this.isMonitoring = false;
        this.consecutiveFailures = 0;
        this.MAX_FAILURES = 3;
        this._busyUntil = 0; // Timestamp sampai kapan sistem dianggap "busy"
        this._intervalRef = null;
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
     * @param {number} durationMs - Durasi busy dalam millisecond
     */
    setBusy(durationMs = 5 * 60 * 1000) {
        this._busyUntil = Date.now() + durationMs;
        console.log(`[WATCHDOG] 🔄 Mode BUSY aktif selama ${Math.round(durationMs / 60000)} menit (health check di-pause).`);
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
        console.log(`[WATCHDOG] 🛡️ Monitoring dimulai. Threshold: ${this.staleThreshold / 60000} menit.`);

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

            // [FIX 2] Cek STALE: hanya saat jam aktif (06:00-23:00 WIB)
            // Di luar jam aktif tidak ada customer → tidak ada heartbeat → bukan STALE
            const hourWIB = new Date().getUTCHours() + 7; // UTC+7
            const isActiveHours = hourWIB >= 6 && hourWIB < 23;

            if (isActiveHours) {
                const timeSinceLastActivity = Date.now() - this.lastActivity;
                if (timeSinceLastActivity > this.staleThreshold) {
                    console.warn(`[WATCHDOG] ⚠️ Engine STALE: Tidak ada aktifitas ${Math.round(timeSinceLastActivity / 60000)} menit.`);
                    this.triggerRestart('ENGINE_STALE');
                    return;
                }
            }

            this.consecutiveFailures = 0;

        } catch (err) {
            this.consecutiveFailures++;
            const maxFail = this.isBusy() ? 5 : this.MAX_FAILURES;
            console.error(`[WATCHDOG] ❌ Health check failed (${this.consecutiveFailures}/${maxFail}): ${err.message}`);

            if (this.consecutiveFailures >= maxFail) {
                this.triggerRestart('CONSECUTIVE_FAILURES');
            }
        }
    }

    triggerRestart(reason) {
        console.error(`[WATCHDOG] 🔥 Restart otomatis dipicu. Alasan: ${reason}`);
        process.exit(1);
    }
}

module.exports = StabilityManager;
