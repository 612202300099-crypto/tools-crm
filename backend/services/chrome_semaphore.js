/**
 * Chrome Semaphore — Traffic control untuk Chrome DevTools Protocol
 * ─────────────────────────────────────────────────────────────────
 * 
 * MASALAH:
 * Chrome hanya punya 1 event loop. Jika 10+ operasi (downloadMedia,
 * getChat, sendMessage) jalan bersamaan → Chrome macet → timeout.
 * 
 * SOLUSI:
 * Semaphore membatasi jumlah operasi Chrome yang jalan bersamaan.
 * Operasi yang melebihi limit akan ANTRI (bukan timeout/crash).
 * 
 * PRIORITAS:
 * 1. Incoming messages (getChat) — highest, selalu dapat slot
 * 2. Media download — medium, antri jika penuh
 * 3. Pending order / AI bot — lowest, antri jika penuh
 * 
 * USAGE:
 *   const result = await chromeSemaphore.acquire('media', async () => {
 *       return await msg.downloadMedia();
 *   });
 */

class ChromeSemaphore {
    constructor(maxConcurrent = 5) {
        this.maxConcurrent = maxConcurrent;
        this.running = 0;
        this.queue = [];       // { resolve, priority, label }
        this.stats = { acquired: 0, queued: 0, completed: 0, timeouts: 0 };
    }

    /**
     * Acquire a Chrome slot. Waits if all slots are busy.
     * @param {string} label - Nama operasi (untuk logging)
     * @param {Function} fn - Async function yang butuh Chrome
     * @param {object} options - { priority: 1-3, timeout: ms }
     * @returns {*} Return value dari fn
     */
    async acquire(label, fn, options = {}) {
        const { priority = 2, timeout = 120000 } = options;

        // Tunggu slot tersedia
        if (this.running >= this.maxConcurrent) {
            this.stats.queued++;
            const queueSize = this.queue.length;
            if (queueSize > 0 && queueSize % 5 === 0) {
                console.log(`[CHROME-SEM] ⏳ ${label} antri (${queueSize} waiting, ${this.running}/${this.maxConcurrent} active)`);
            }

            await new Promise((resolve, reject) => {
                const entry = { resolve, priority, label };
                
                // Insert berdasarkan prioritas (1 = highest)
                const idx = this.queue.findIndex(q => q.priority > priority);
                if (idx === -1) {
                    this.queue.push(entry);
                } else {
                    this.queue.splice(idx, 0, entry);
                }

                // Timeout guard — jangan antri selamanya
                setTimeout(() => {
                    const qIdx = this.queue.indexOf(entry);
                    if (qIdx !== -1) {
                        this.queue.splice(qIdx, 1);
                        this.stats.timeouts++;
                        reject(new Error(`[CHROME-SEM] Timeout antri ${label} (${timeout / 1000}s)`));
                    }
                }, timeout);
            });
        }

        this.running++;
        this.stats.acquired++;

        try {
            return await fn();
        } finally {
            this.running--;
            this.stats.completed++;

            // Release: beri slot ke yang antri berikutnya
            if (this.queue.length > 0) {
                const next = this.queue.shift();
                next.resolve();
            }
        }
    }

    getStats() {
        return {
            ...this.stats,
            running: this.running,
            queued: this.queue.length,
            maxConcurrent: this.maxConcurrent,
        };
    }
}

// Singleton — satu semaphore untuk seluruh aplikasi
const chromeSemaphore = new ChromeSemaphore(
    parseInt(process.env.CHROME_MAX_CONCURRENT) || 5
);

module.exports = chromeSemaphore;
