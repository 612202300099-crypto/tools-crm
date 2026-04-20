/**
 * Stability Manager (Watchdog)
 * Tugas: Memantau kesehatan engine dan melakukan restart otomatis jika terdeteksi macet.
 */

class StabilityManager {
    constructor(client, options = {}) {
        this.client = client;
        this.lastActivity = Date.now();
        this.checkInterval = options.checkInterval || 5 * 60 * 1000; // Cek tiap 5 menit
        this.staleThreshold = options.staleThreshold || 45 * 60 * 1000; // Dianggap macet jika 45 menit tanpa aktifitas
        this.isMonitoring = false;
        this.consecutiveFailures = 0;
        this.MAX_FAILURES = 3;
    }

    /**
     * Panggil ini setiap ada aktifitas (pesan masuk/keluar)
     */
    heartbeat() {
        this.lastActivity = Date.now();
        this.consecutiveFailures = 0;
        // console.log(`[WATCHDOG] ❤️ Heartbeat received at ${new Date().toLocaleTimeString()}`);
    }

    /**
     * Mulai pemantauan
     */
    start() {
        if (this.isMonitoring) return;
        this.isMonitoring = true;
        console.log(`[WATCHDOG] 🛡️ Monitoring engine started. (Threshold: ${this.staleThreshold / 60000} min)`);
        
        setInterval(async () => {
            await this.checkHealth();
        }, this.checkInterval);
    }

    async checkHealth() {
        try {
            // 1. Cek Responsivitas via getState
            const state = await Promise.race([
                this.client.getState(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_GET_STATE')), 15000))
            ]);

            // 2. Cek Stale (Macet Tanpa Error tapi tidak ada pesan masuk)
            const now = Date.now();
            const timeSinceLastActivity = now - this.lastActivity;

            if (timeSinceLastActivity > this.staleThreshold) {
                console.warn(`[WATCHDOG] ⚠️ Engine terdeteksi STALE (Tidak ada aktifitas selama ${Math.round(timeSinceLastActivity / 60000)} menit).`);
                this.triggerRestart('ENGINE_STALE');
                return;
            }

            this.consecutiveFailures = 0;
            // console.log(`[WATCHDOG] ✅ Health check passed. State: ${state}`);

        } catch (err) {
            this.consecutiveFailures++;
            console.error(`[WATCHDOG] ❌ Health check failed (${this.consecutiveFailures}/${this.MAX_FAILURES}):`, err.message);

            if (this.consecutiveFailures >= this.MAX_FAILURES) {
                this.triggerRestart('CONSECUTIVE_FAILURES');
            }
        }
    }

    triggerRestart(reason) {
        console.error(`[WATCHDOG] 🔥 FATAL: Memicu restart otomatis. Alasan: ${reason}`);
        
        // Kirim sinyal ke sistem agar PM2 melakukan restart
        // Keluar dengan error code agar PM2 merestart proses
        process.exit(1); 
    }
}

module.exports = StabilityManager;
