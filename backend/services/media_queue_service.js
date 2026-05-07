const fs = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');
const { convertHeicToJpg } = require('../utils/heicConverter');
const objectStorage = require('./object_storage_service');

// [PERFORMANCE] Lazy-load sharp agar tidak crash jika belum terinstall
let _sharp = null;
function getSharp() {
    if (_sharp !== null) return _sharp;
    try {
        _sharp = require('sharp');
        console.log('[MEDIA-QUEUE] 🗌️ Sharp image processor siap (kompresi aktif).');
    } catch (e) {
        _sharp = false; // false = sudah dicek tapi tidak ada
        console.warn('[MEDIA-QUEUE] ⚠️ Sharp tidak terinstall — foto disimpan tanpa kompresi. Jalankan: npm install');
    }
    return _sharp;
}

/**
 * MediaQueueService
 * Arsitektur Jangka Panjang untuk menangani unduhan media secara asinkron.
 * Dioptimasi dengan Worker Pool untuk menangani antrian ribuan secara cepat.
 */
class MediaQueueService {
    constructor(client, supabase, options = {}) {
        this.client = client;
        this.supabase = supabase;
        this.PUBLIC_API_URL = options.publicUrl || 'https://api-wa.parecustom.com';
        this.queueFile = path.join(__dirname, '../media_queue_state.json');
        
        // Konfigurasi Performa
        this.concurrency = options.concurrency || 15; // [FIX] 15 worker (dari 10)
        this.pollingInterval = options.pollingInterval || 1000;
        this.maxRetries = 3;
        this.dbTimeout = 15000;
        
        this.queue = this.loadQueue();
        this.activeWorkers = 0;
        this.isProcessing = false;
        
        console.log(`[MEDIA-QUEUE] 🛠️ Inisialisasi dengan ${this.concurrency} worker.`);
    }

    loadQueue() {
        try {
            if (fs.existsSync(this.queueFile)) {
                return JSON.parse(fs.readFileSync(this.queueFile, 'utf8'));
            }
        } catch (e) {
            console.error('[MEDIA-QUEUE] ❌ Gagal memuat state antrian:', e.message);
        }
        return [];
    }

    saveQueue() {
        try {
            // Kita simpan berkala agar tidak berat di I/O
            fs.writeFileSync(this.queueFile, JSON.stringify(this.queue, null, 2));
        } catch (e) {
            console.error('[MEDIA-QUEUE] ❌ Gagal menyimpan state antrian:', e.message);
        }
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

        this.saveQueue();
        console.log(`[MEDIA-QUEUE] 📥 Antrian: ${this.queue.length} | Worker aktif: ${this.activeWorkers}/${this.concurrency} | Baru: ${messageId.split('_').pop()}`);

        // [BUG FIX] Panggil spawnWorkers langsung (BUKAN startProcessing)
        // sehingga worker baru bisa di-spawn meskipun sudah ada worker yang jalan.
        this.spawnWorkers();
    }

    /**
     * Spawn worker baru hingga batas concurrency.
     * Method ini aman dipanggil kapan saja — idempotent.
     * [FIX] Ini adalah perbaikan dari arsitektur lama yang hanya
     * memanggil startProcessing() (yang return early jika isProcessing=true).
     */
    spawnWorkers() {
        if (this.queue.length === 0) return;

        // Spawn worker baru selama masih di bawah batas concurrency
        while (this.activeWorkers < this.concurrency && this.queue.length > 0) {
            this.activeWorkers++;
            const workerId = this.activeWorkers; // snapshot ID sebelum async

            if (this.activeWorkers === 1) {
                // Log hanya saat worker pertama spawn (tidak spam)
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

            // Jeda dinamis: Jika prioritas, jangan kasih jeda. Jika normal, kasih jeda pendek.
            if (this.queue.length > 0 && !job.isPriority) {
                await new Promise(r => setTimeout(r, this.pollingInterval));
            }
        }
    }

    async processJob(job, workerId = 0) {
        try {
            console.log(`[W-${workerId}] ⏳ Processing ${job.customerPhone}...`);
            
            // 1. Dapatkan object pesan asli dari WA
            let message = await this.client.getMessageById(job.messageId);
            
            // Deep search jika cache hilang
            if (!message) {
                try {
                    const chatId = job.messageId.split('_')[1];
                    const chat = await this.client.getChatById(chatId);
                    await chat.fetchMessages({ limit: 20 });
                    message = await this.client.getMessageById(job.messageId);
                } catch (e) { /* silent */ }
            }

            if (!message || !message.hasMedia) {
                console.warn(`[W-${workerId}] ⚠️ Skip: Pesan/Media tidak ditemukan.`);
                return true; 
            }

            // 2. Unduh Media (Timeout 60s)
            const media = await this.withTimeout(message.downloadMedia(), 60000, 'downloadMedia');
            if (!media || !media.data) throw new Error('Data media kosong');

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
            // Foto WhatsApp biasanya 2-5MB. Setelah kompres: 300-500KB (hemat 80%!)
            // Ini adalah fix utama untuk mencegah disk penuh akibat foto tidak terkompresi.
            const isImage = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext.toLowerCase());
            if (isImage) {
                const sharp = getSharp();
                if (sharp) {
                    try {
                        const originalSize = buffer.length;
                        buffer = await sharp(buffer)
                            .rotate()                              // Auto-rotate berdasarkan EXIF
                            .resize(1920, 1920, {                  // Max 1920px (Full HD cukup untuk review)
                                fit: 'inside',
                                withoutEnlargement: true           // Jangan perbesar foto kecil
                            })
                            .jpeg({ quality: 82, progressive: true }) // JPEG 82% quality — tidak terlihat beda
                            .toBuffer();
                        ext = 'jpg'; // Selalu simpan sebagai JPG setelah kompres
                        const savedKB = Math.round((originalSize - buffer.length) / 1024);
                        const savePct = Math.round((1 - buffer.length / originalSize) * 100);
                        console.log(`[W-${workerId}] 🗌️ Kompres: ${Math.round(originalSize/1024)}KB → ${Math.round(buffer.length/1024)}KB (hemat ${savePct}%, -${savedKB}KB)`);
                    } catch (sharpErr) {
                        // Sharp gagal (misal: file corrupt) — simpan file asli, jangan crash
                        console.warn(`[W-${workerId}] ⚠️ Kompres gagal, simpan asli: ${sharpErr.message.substring(0, 60)}`);
                    }
                }
            }

            const fileName = `${job.customerId}/foto-${uniqueSuffix}.${ext}`;
            const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;

            // [OBJECT STORAGE] Upload ke object storage (S3-compatible)
            // Jika gagal total setelah 3 retry, otomatis fallback ke disk lokal.
            // TIDAK ADA FOTO CUSTOMER YANG HILANG.
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
