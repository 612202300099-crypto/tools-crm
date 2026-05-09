const fs = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');
const { convertHeicToJpg } = require('../utils/heicConverter');
const objectStorage = require('./object_storage_service');
const chromeSemaphore = require('./chrome_semaphore');

// [PERFORMANCE] Lazy-load sharp agar tidak crash jika belum terinstall
let _sharp = null;
function getSharp() {
    if (_sharp !== null) return _sharp;
    try {
        _sharp = require('sharp');
        console.log('[MEDIA-QUEUE] 🖼️ Sharp image processor siap (kompresi aktif).');
    } catch (e) {
        _sharp = false; // false = sudah dicek tapi tidak ada
        console.warn('[MEDIA-QUEUE] ⚠️ Sharp tidak terinstall — foto disimpan tanpa kompresi. Jalankan: npm install');
    }
    return _sharp;
}

// [v4] Helper: Cek disk usage (Linux). Return persentase (0-100) atau -1 jika gagal.
function getDiskUsagePercent() {
    try {
        const { execSync } = require('child_process');
        const output = execSync("df / --output=pcent | tail -1", { encoding: 'utf8', timeout: 5000 });
        return parseInt(output.trim().replace('%', ''), 10);
    } catch (e) {
        return -1; // Gagal cek (mungkin bukan Linux)
    }
}

/**
 * MediaQueueService v4
 * ─────────────────────────────────────────────────────────────
 * PERUBAHAN v4 dari v3:
 * - Concurrency: 15 → 3 (satu Chrome TIDAK BISA handle 15 download paralel)
 * - Download timeout: 60s → 90s (configurable)
 * - Polling interval: 1s → 2s (kurangi beban Chrome)
 * - Disk check sebelum setiap job (jika >96%, skip job)
 * - Worker jeda antar job WAJIB (tidak boleh 0ms)
 * - getPendingCount() untuk monitoring endpoint
 *
 * KENAPA 15 WORKER ITU BERBAHAYA:
 * Semua download melewati SATU instance Chrome via DevTools Protocol.
 * 15 panggilan simultan = Chrome harus handle 15 WebSocket messages sekaligus.
 * Chrome kewalahan → "Runtime.callFunctionOn timed out" → crash →
 * "Execution context destroyed" → WA session mati → harus scan QR ulang.
 */
class MediaQueueService {
    constructor(client, supabase, options = {}) {
        this.client = client;
        this.supabase = supabase;
        this.PUBLIC_API_URL = options.publicUrl || 'https://api.kirimfoto.com';
        this.queueFile = path.join(__dirname, '../media_queue_state.json');
        
        // Konfigurasi Performa v5 — configurable via .env
        // VPS 2GB: MEDIA_WORKERS=5 | VPS 8GB: MEDIA_WORKERS=10
        this.concurrency = parseInt(process.env.MEDIA_WORKERS) || options.concurrency || 5;
        this.pollingInterval = parseInt(process.env.MEDIA_POLL_MS) || options.pollingInterval || 1500;
        this.downloadTimeout = parseInt(process.env.MEDIA_TIMEOUT_MS) || options.downloadTimeout || 90000;
        this.maxRetries = 3;
        this.dbTimeout = 15000;
        this.maxQueueSize = parseInt(process.env.MEDIA_MAX_QUEUE) || 300;
        this.maxAgeMs = 2 * 60 * 60 * 1000; // 2 jam — item lebih tua pasti gagal
        
        this.queue = this.loadQueue();
        this.activeWorkers = 0;
        this.isProcessing = false;
        
        console.log(`[MEDIA-QUEUE] 🛠️ Inisialisasi v5: ${this.concurrency} worker, max antrian ${this.maxQueueSize}, timeout ${this.downloadTimeout / 1000}s.`);
    }

    loadQueue() {
        try {
            if (fs.existsSync(this.queueFile)) {
                let queue = JSON.parse(fs.readFileSync(this.queueFile, 'utf8'));
                const before = queue.length;

                // [v5] PRUNE: Hapus item lebih tua dari 2 jam
                // WhatsApp tidak menyimpan media di cache Chrome lebih dari ~2 jam.
                // Item lama PASTI gagal → buang agar tidak buang waktu worker.
                const cutoff = Date.now() - (2 * 60 * 60 * 1000);
                queue = queue.filter(job => {
                    const addedTime = job.addedAt ? new Date(job.addedAt).getTime() : 0;
                    return addedTime > cutoff;
                });

                // [v5] CAP: Batasi ukuran antrian
                if (queue.length > 300) {
                    queue = queue.slice(-300); // Ambil 300 terbaru
                }

                const pruned = before - queue.length;
                if (pruned > 0) {
                    console.log(`[MEDIA-QUEUE] 🧹 Pruned ${pruned} item expired dari antrian (${before} → ${queue.length}).`);
                }
                return queue;
            }
        } catch (e) {
            console.error('[MEDIA-QUEUE] ❌ Gagal memuat state antrian:', e.message);
        }
        return [];
    }

    saveQueue() {
        try {
            // [v4] Cek disk sebelum write — jangan sampai ENOSPC crash proses
            const diskPct = getDiskUsagePercent();
            if (diskPct > 98) {
                console.warn('[MEDIA-QUEUE] ⚠️ Disk >98% — skip saveQueue untuk cegah ENOSPC crash.');
                return;
            }
            fs.writeFileSync(this.queueFile, JSON.stringify(this.queue, null, 2));
        } catch (e) {
            console.error('[MEDIA-QUEUE] ❌ Gagal menyimpan state antrian:', e.message);
        }
    }

    /**
     * [v4] Cek berapa item yang sedang menunggu (untuk monitoring endpoint)
     */
    getPendingCount() {
        return this.queue.length;
    }

    /**
     * Tambah pekerjaan ke antrian
     */
    async addToQueue(messageId, customer, messageTimestamp, isPriority = false) {
        if (this.queue.some(job => job.messageId === messageId)) return;

        const newJob = {
            messageId,
            customerId: customer.id,
            customerPhone: customer.phone_number,
            timestamp: messageTimestamp,
            retryCount: 0,
            status: 'PENDING',
            isPriority,
            addedAt: new Date().toISOString()
        };

        if (isPriority) {
            this.queue.unshift(newJob);
            console.log(`[MEDIA-QUEUE] 🚀 PRIORITAS: ${customer.phone_number} masuk jalur cepat!`);
        } else {
            this.queue.push(newJob);
        }

        // [v5] Enforce max queue size — buang item TERLAMA jika penuh
        if (this.queue.length > this.maxQueueSize) {
            const dropped = this.queue.length - this.maxQueueSize;
            this.queue = this.queue.slice(-this.maxQueueSize);
            console.warn(`[MEDIA-QUEUE] ⚠️ Antrian melebihi ${this.maxQueueSize} — ${dropped} item terlama dibuang.`);
        }

        this.saveQueue();
        console.log(`[MEDIA-QUEUE] 📥 Antrian: ${this.queue.length} | Worker aktif: ${this.activeWorkers}/${this.concurrency} | Baru: ${messageId.split('_').pop()}`);

        // [BUG FIX] Panggil spawnWorkers langsung (BUKAN startProcessing)
        // sehingga worker baru bisa di-spawn meskipun sudah ada worker yang jalan.
        this.spawnWorkers();
    }

    /**
     * Spawn worker baru hingga batas concurrency.
     * Method ini aman dipanggil kapan saja — idempotent.
     */
    spawnWorkers() {
        if (this.queue.length === 0) return;

        // Spawn worker baru selama masih di bawah batas concurrency
        while (this.activeWorkers < this.concurrency && this.queue.length > 0) {
            this.activeWorkers++;
            const workerId = this.activeWorkers; // snapshot ID sebelum async

            if (this.activeWorkers === 1) {
                console.log(`[MEDIA-QUEUE] 🔥 Worker Pool aktif. Concurrency: ${this.concurrency}`);
            }

            this.runWorker(workerId).finally(() => {
                this.activeWorkers--;
                // Saat worker selesai, coba spawn lagi jika masih ada antrian
                if (this.queue.length > 0) {
                    this.spawnWorkers();
                } else if (this.activeWorkers === 0) {
                    console.log('[MEDIA-QUEUE] 🏁 Semua worker selesai. Antrian bersih.');
                }
            });
        }
    }

    /**
     * Individual Worker Loop
     */
    async runWorker(workerId) {
        while (this.queue.length > 0) {
            const job = this.queue.shift();
            if (!job) break;

            this.saveQueue();
            
            try {
                const success = await this.processJob(job, workerId);
                if (!success) {
                    if (job.retryCount < this.maxRetries) {
                        job.retryCount++;
                        job.status = 'RETRYING';
                        this.queue.push(job);
                        console.log(`[W-${workerId}] 🔄 Retry (${job.retryCount}/${this.maxRetries}) -> ${job.customerPhone}`);
                    } else {
                        console.error(`[W-${workerId}] ❌ Menyerah pada ${job.customerPhone}`);
                    }
                }
            } catch (e) {
                console.error(`[W-${workerId}] ❌ Error Fatal:`, e.message);
            }

            // [v4] Jeda WAJIB antar job — beri Chrome waktu bernapas
            // Tanpa jeda: worker langsung ambil job berikutnya → Chrome belum pulih → timeout → crash
            const jitter = Math.floor(Math.random() * 1000); // 0-1 detik random
            await new Promise(r => setTimeout(r, this.pollingInterval + jitter));
        }
    }

    async processJob(job, workerId = 0) {
        try {
            // [v4] DISK GUARD — Cek disk sebelum proses
            // Jika disk >96% DAN Object Storage TIDAK aktif, skip job
            // (jika Object Storage aktif, foto ke cloud, disk lokal tidak terpakai)
            const diskPct = getDiskUsagePercent();
            if (diskPct > 96) {
                const objStorageActive = await objectStorage.isObjectStorageAvailable();
                if (!objStorageActive) {
                    console.warn(`[W-${workerId}] 🚨 Disk ${diskPct}% + Object Storage MATI — skip job ${job.customerPhone} (cegah ENOSPC crash).`);
                    return true; // Return true = jangan retry (sia-sia kalau disk penuh)
                }
                // Object Storage aktif → aman lanjut (foto ke cloud)
            }

            console.log(`[W-${workerId}] ⏳ Processing ${job.customerPhone}...`);
            
            // ═══════════════════════════════════════════════════════════
            // CHROME SEMAPHORE: Semua operasi Chrome di-wrap di sini.
            // Max 5 concurrent Chrome calls → sisanya ANTRI (bukan timeout).
            // Setelah download selesai, semaphore DILEPAS → compress/upload
            // jalan TANPA blocking Chrome untuk worker lain.
            // ═══════════════════════════════════════════════════════════
            const { message, media } = await chromeSemaphore.acquire(
                `W-${workerId}:download`,
                async () => {
                    // 1. Dapatkan object pesan asli dari WA
                    let msg;
                    try {
                        msg = await this.withTimeout(
                            this.client.getMessageById(job.messageId),
                            30000,
                            'getMessageById'
                        );
                    } catch (e) {
                        msg = null;
                    }
                    
                    // Deep search jika cache hilang
                    if (!msg) {
                        try {
                            const chatId = job.messageId.split('_')[1];
                            const chat = await this.withTimeout(
                                this.client.getChatById(chatId),
                                30000,
                                'getChatById_deepSearch'
                            );
                            await this.withTimeout(
                                chat.fetchMessages({ limit: 20 }),
                                30000,
                                'fetchMessages_deepSearch'
                            );
                            msg = await this.withTimeout(
                                this.client.getMessageById(job.messageId),
                                15000,
                                'getMessageById_retry'
                            );
                        } catch (e) { /* silent */ }
                    }

                    if (!msg || !msg.hasMedia) {
                        return { message: null, media: null };
                    }

                    // 2. Unduh Media (Chrome-bound)
                    const mediaData = await this.withTimeout(
                        msg.downloadMedia(),
                        this.downloadTimeout,
                        'downloadMedia'
                    );
                    return { message: msg, media: mediaData };
                },
                { priority: 2, timeout: 180000 }
            );
            // ═══════════════════════════════════════════════════════════
            // CHROME SEMAPHORE RELEASED — dari sini tidak pakai Chrome lagi
            // Compress + Upload S3 + DB berjalan parallel dengan download lain
            // ═══════════════════════════════════════════════════════════

            if (!message || !media) {
                console.warn(`[W-${workerId}] ⚠️ Skip: Pesan/Media tidak ditemukan.`);
                return true; 
            }
            if (!media.data) throw new Error('Data media kosong');

            // 3. Proses buffer
            let buffer = Buffer.from(media.data, 'base64');
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E6);
            let fileExt = (media.mimetype || 'image/jpeg').split('/')[1].split(';')[0];
            let ext = fileExt === 'jpeg' ? 'jpg' : fileExt;

            // 🔄 DETEKSI DAN KONVERSI HEIC
            if (ext.toLowerCase() === 'heic' || (media.filename && media.filename.toLowerCase().endsWith('.heic'))) {
                console.log(`[W-${workerId}] 🔄 Memulai konversi HEIC -> JPG...`);
                try {
                    buffer = await convertHeicToJpg(buffer);
                    ext = 'jpg';
                    console.log(`[W-${workerId}] ✅ Konversi HEIC sukses!`);
                } catch (err) {
                    console.error(`[W-${workerId}] ❌ Gagal konversi HEIC:`, err.message);
                }
            }

            // [🖥️ DISK SAVER] Kompres foto sebelum disimpan menggunakan sharp
            const isImage = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext.toLowerCase());
            if (isImage) {
                const sharp = getSharp();
                if (sharp) {
                    try {
                        const originalSize = buffer.length;
                        buffer = await sharp(buffer)
                            .rotate()                              // Auto-rotate berdasarkan EXIF
                            .resize(1920, 1920, {                  // Max 1920px
                                fit: 'inside',
                                withoutEnlargement: true
                            })
                            .jpeg({ quality: 82, progressive: true })
                            .toBuffer();
                        ext = 'jpg';
                        const savedKB = Math.round((originalSize - buffer.length) / 1024);
                        const savePct = Math.round((1 - buffer.length / originalSize) * 100);
                        console.log(`[W-${workerId}] 🖼️ Kompres: ${Math.round(originalSize/1024)}KB → ${Math.round(buffer.length/1024)}KB (hemat ${savePct}%, -${savedKB}KB)`);
                    } catch (sharpErr) {
                        console.warn(`[W-${workerId}] ⚠️ Kompres gagal, simpan asli: ${sharpErr.message.substring(0, 60)}`);
                    }
                }
            }

            const fileName = `${job.customerId}/foto-${uniqueSuffix}.${ext}`;
            const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;

            // [OBJECT STORAGE] Upload ke object storage (S3-compatible)
            const { url: publicUrl, key: storageKey, storageType } = await objectStorage.uploadMedia(
                buffer,
                fileName,
                mimeType
            );

            console.log(`[W-${workerId}] ☁️ Tersimpan di ${storageType === 'object' ? 'Object Storage' : 'Disk Lokal'}: ${fileName}`);

            // 4. Cari Message di DB (Timeout Guard)
            const { data: msgRecord, error: msgFindError } = await this.withTimeout(
                this.supabase.from('messages').select('id').eq('wa_id', job.messageId).single(),
                this.dbTimeout, 'findMessageDB'
            );

            if (msgFindError || !msgRecord) {
                console.error(`[W-${workerId}] ❌ Message ID ${job.messageId} tidak ada di DB.`);
                return true; 
            }

            // 5. Simpan ke media (Timeout Guard)
            const { error: mediaError } = await this.withTimeout(
                this.supabase.from('media').insert({
                    customer_id:  job.customerId,
                    message_id:   msgRecord.id,
                    file_url:     publicUrl,
                    file_name:    fileName,
                    storage_key:  storageKey,
                    storage_type: storageType,
                    created_at:   job.timestamp
                }),
                this.dbTimeout, 'insertMediaDB'
            );

            if (mediaError) throw new Error(`DB Insert Error: ${mediaError.message}`);

            // 6. Update Status Customer
            await this.withTimeout(
                this.supabase.from('customers').update({ status: 'SUDAH_KIRIM_FOTO' }).eq('id', job.customerId),
                this.dbTimeout, 'updateCustomerDB'
            );

            // 7. Queue upload ke Google Drive (non-blocking, decoupled)
            // [FIX v3] SELALU queue ke Drive meski order_id/resi belum ada.
            // Foto tanpa resi -> WAITING_RESI, diupgrade otomatis saat resi tersedia.
            try {
                const driveService = require('./google_drive_service');
                const { data: custData } = await this.withTimeout(
                    this.supabase.from('customers').select('order_id, store_name, resi, order_detail').eq('id', job.customerId).single(),
                    this.dbTimeout, 'getCustomerForDrive'
                );

                // Parse order_detail untuk productAbbr dan sku
                let productAbbr = 'LAINNYA';
                let sku = '';
                try {
                    const detail = JSON.parse((custData && custData.order_detail) || '[]');
                    const mainItem = detail.find(i => i.isPolaroid) || detail[0];
                    if (mainItem) { productAbbr = mainItem.productAbbr || 'LAINNYA'; sku = mainItem.sku || ''; }
                } catch (e) {}

                // Hitung nomor urut foto untuk nama file informatif di Drive
                let photoIndex = 1;
                try {
                    const { data: prevMedia } = await this.supabase
                        .from('media').select('id').eq('customer_id', job.customerId);
                    photoIndex = prevMedia ? prevMedia.length : 1;
                } catch (e) {}

                // [FIX] Tidak ada lagi guard `if (custData.order_id)` — queue SELALU
                driveService.queueUpload({
                    customerId:    job.customerId,
                    mediaId:       msgRecord.id,
                    fileUrl:       publicUrl,
                    storageKey,
                    storageType,
                    orderId:       custData ? custData.order_id : null,
                    storeName:     custData ? custData.store_name : null,
                    resi:          custData ? custData.resi : null,
                    productAbbr,
                    sku,
                    photoIndex,
                    customerPhone: job.customerPhone,
                });
            } catch (driveErr) {
                console.warn(`[W-${workerId}] ⚠️ Drive queue skip: ${driveErr.message.substring(0, 60)}`);
            }

            console.log(`[W-${workerId}] ✅ Sukses! ${job.customerPhone}`);
            return true;
        } catch (err) {
            console.error(`[W-${workerId}] ⚠️ Gagal:`, err.message);
            return false;
        }
    }

    withTimeout(promise, ms, label) {
        let timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`[TIMEOUT] ${label} (${ms/1000}s)`)), ms)
        );
        return Promise.race([promise, timeout]);
    }
}

module.exports = MediaQueueService;
