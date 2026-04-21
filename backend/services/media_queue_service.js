const fs = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');

/**
 * MediaQueueService
 * Arsitektur Jangka Panjang untuk menangani unduhan media secara asinkron.
 * Fitur: Throttling, Persistence, Retry, dan Non-blocking.
 */
class MediaQueueService {
    constructor(client, supabase, options = {}) {
        this.client = client;
        this.supabase = supabase;
        this.PUBLIC_API_URL = options.publicUrl || 'https://api-wa.parecustom.com';
        this.queueFile = path.join(__dirname, '../media_queue_state.json');
        this.queue = this.loadQueue();
        this.currentJob = null; // Melacak pekerjaan yang sedang berjalan
        this.isProcessing = false;
        this.pollingInterval = options.pollingInterval || 5000; // 5 detik per unduhan agar tidak diblokir WA
        this.maxRetries = 3;
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
            fs.writeFileSync(this.queueFile, JSON.stringify(this.queue, null, 2));
        } catch (e) {
            console.error('[MEDIA-QUEUE] ❌ Gagal menyimpan state antrian:', e.message);
        }
    }

    /**
     * Tambah pekerjaan ke antrian
     */
    async addToQueue(messageId, customer, messageTimestamp, isPriority = false) {
        // Cek apakah sudah ada di antrian (termasuk yang sedang diproses)
        if (this.queue.some(job => job.messageId === messageId)) return;
        if (this.currentJob && this.currentJob.messageId === messageId) return;

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
        console.log(`[MEDIA-QUEUE] 📥 Antrian bertambah: ${messageId.split('_').pop()}... Total: ${this.queue.length}`);
        
        if (!this.isProcessing) {
            this.startProcessing();
        }
    }

    async startProcessing() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;

        console.log(`[MEDIA-QUEUE] 🚀 Worker Aktif (${this.queue.length} antrian)...`);
        
        while (this.queue.length > 0) {
            // Pindahkan dari antrian ke 'currentJob' agar aman dari race condition saat unshift
            this.currentJob = this.queue.shift();
            this.saveQueue();
            
            try {
                const success = await this.processJob(this.currentJob);
                if (!success) {
                    // Jika gagal, cek apakah berhak retry
                    if (this.currentJob.retryCount < this.maxRetries) {
                        this.currentJob.retryCount++;
                        this.currentJob.status = 'RETRYING';
                        // Masukkan ke belakang antrian normal
                        this.queue.push(this.currentJob);
                        console.log(`[MEDIA-QUEUE] 🔄 Retry (${this.currentJob.retryCount}/${this.maxRetries}) untuk ${this.currentJob.customerPhone}`);
                    } else {
                        console.error(`[MEDIA-QUEUE] ❌ Menyerah pada ${this.currentJob.customerPhone} (Gagal total).`);
                    }
                }
            } catch (e) {
                console.error('[MEDIA-QUEUE] ❌ Error vatal Worker:', e.message);
            }

            this.currentJob = null;
            this.saveQueue();
            
            // Jeda antar unduhan (Throttling)
            if (this.queue.length > 0) {
                await new Promise(r => setTimeout(r, this.pollingInterval));
            }
        }

        this.isProcessing = false;
        console.log(`[MEDIA-QUEUE] 🏁 Antrian bersih. Standby.`);
    }

    async processJob(job) {
        try {
            console.log(`[MEDIA-QUEUE] ⏳ Memproses unduhan untuk ${job.customerPhone}...`);
            
            // 1. Dapatkan object pesan asli dari WA
            const message = await this.client.getMessageById(job.messageId);
            if (!message || !message.hasMedia) {
                console.warn(`[MEDIA-QUEUE] ⚠️ Pesan tidak ditemukan atau tidak memiliki media: ${job.messageId}`);
                return true; // Skip saja
            }

            // 2. Unduh Media dengan Timeout
            const media = await this.withTimeout(message.downloadMedia(), 55000, 'downloadMedia_Worker');
            if (!media || !media.data) {
                throw new Error('Data media kosong atau timeout');
            }

            // 3. Simpan ke VPS (Sama seperti sebelumnya)
            const buffer = Buffer.from(media.data, 'base64');
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            let fileExt = media.mimetype ? media.mimetype.split('/')[1] : 'jpg';
            if (fileExt && fileExt.includes(';')) fileExt = fileExt.split(';')[0];
            const ext = fileExt === 'jpeg' ? 'jpg' : fileExt; 
            
            const fileName = `${job.customerId}/foto-${uniqueSuffix}.${ext}`;
            const uploadsDir = path.join(__dirname, '../uploads', job.customerId.toString());
            
            if (!fs.existsSync(uploadsDir)) {
                fs.mkdirSync(uploadsDir, { recursive: true });
            }
            
            const filePath = path.join(__dirname, '../uploads', fileName);
            fs.writeFileSync(filePath, buffer);

            const publicUrl = `${this.PUBLIC_API_URL}/uploads/${fileName}`;

            // 4. Dapatkan UUID internal dari tabel messages
            const { data: msgRecord, error: msgFindError } = await this.supabase
                .from('messages')
                .select('id')
                .eq('wa_id', job.messageId)
                .single();

            if (msgFindError || !msgRecord) {
                console.error(`[MEDIA-QUEUE] ❌ Pesan ${job.messageId} tidak ditemukan di DB. Tidak bisa menautkan media.`);
                return true; // Skip karena datanya tidak ada
            }

            // 5. Simpan ke database media (Gunakan UUID yang ditemukan)
            const { error: mediaError } = await this.supabase.from('media').insert({
                 customer_id: job.customerId,
                 message_id: msgRecord.id,
                 file_url: publicUrl,
                 file_name: fileName,
                 created_at: job.timestamp
            });

            if (mediaError) {
                throw new Error(`Gagal simpan ke tabel media: ${mediaError.message}`);
            }

            // 6. Update Status Customer
            const { error: custError } = await this.supabase.from('customers').update({ status: 'SUDAH_KIRIM_FOTO' }).eq('id', job.customerId);
            if (custError) {
                console.warn(`[MEDIA-QUEUE] ⚠️ Gagal update status customer: ${custError.message}`);
            }

            console.log(`[MEDIA-QUEUE] ✅ Sukses! Foto tersimpan & ditautkan untuk ${job.customerPhone}`);
            return true;
        } catch (err) {
            console.error(`[MEDIA-QUEUE] ⚠️ Gagal mengolah media untuk ${job.customerPhone}:`, err.message);
            return false;
        }
    }

    withTimeout(promise, ms, label) {
        let timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`[TIMEOUT] ${label} melebihi ${ms / 1000}s`)), ms)
        );
        return Promise.race([promise, timeout]);
    }
}

module.exports = MediaQueueService;
