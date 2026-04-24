const fs = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');

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
        this.concurrency = options.concurrency || 10; // Default 10 worker simultan
        this.pollingInterval = options.pollingInterval || 1000; // Jeda antar cek (lebih cepat)
        this.maxRetries = 3;
        this.dbTimeout = 15000; // Timeout DB 15 detik
        
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
        console.log(`[MEDIA-QUEUE] 📥 Antrian: ${this.queue.length} | Baru: ${messageId.split('_').pop()}`);
        
        this.startProcessing();
    }

    /**
     * Memulai Worker Pool
     */
    async startProcessing() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;

        console.log(`[MEDIA-QUEUE] 🔥 Mengaktifkan Worker Pool (Target: ${this.concurrency} concurrent)...`);
        
        const spawnWorkers = async () => {
            while (this.activeWorkers < this.concurrency && this.queue.length > 0) {
                this.activeWorkers++;
                this.runWorker(this.activeWorkers).finally(() => {
                    this.activeWorkers--;
                    // Jika masih ada antrian, panggil lagi
                    if (this.queue.length > 0) {
                        spawnWorkers();
                    } else if (this.activeWorkers === 0) {
                        this.isProcessing = false;
                        console.log(`[MEDIA-QUEUE] 🏁 Semua worker selesai. Antrian bersih.`);
                    }
                });
            }
        };

        spawnWorkers();
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

            // 2. Unduh Media (Timeout 45s agar tidak gantung)
            const media = await this.withTimeout(message.downloadMedia(), 45000, 'downloadMedia');
            if (!media || !media.data) throw new Error('Data media kosong');

            // 3. Simpan ke VPS
            const buffer = Buffer.from(media.data, 'base64');
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E6);
            let fileExt = (media.mimetype || 'image/jpeg').split('/')[1].split(';')[0];
            const ext = fileExt === 'jpeg' ? 'jpg' : fileExt; 
            
            const fileName = `${job.customerId}/foto-${uniqueSuffix}.${ext}`;
            const uploadsDir = path.join(__dirname, '../uploads', job.customerId.toString());
            
            if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
            
            const filePath = path.join(__dirname, '../uploads', fileName);
            fs.writeFileSync(filePath, buffer);

            const publicUrl = `${this.PUBLIC_API_URL}/uploads/${fileName}`;

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
                    customer_id: job.customerId,
                    message_id: msgRecord.id,
                    file_url: publicUrl,
                    file_name: fileName,
                    created_at: job.timestamp
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
