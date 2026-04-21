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
    async addToQueue(messageId, customer, messageTimestamp) {
        // Cek apakah sudah ada di antrian
        if (this.queue.some(job => job.messageId === messageId)) return;

        this.queue.push({
            messageId,
            customerId: customer.id,
            customerPhone: customer.phone_number,
            timestamp: messageTimestamp,
            retryCount: 0,
            status: 'PENDING',
            addedAt: new Date().toISOString()
        });

        this.saveQueue();
        console.log(`[MEDIA-QUEUE] 📥 Antrian bertambah: ${messageId} (Customer: ${customer.phone_number}). Total: ${this.queue.length}`);
        
        if (!this.isProcessing) {
            this.startProcessing();
        }
    }

    async startProcessing() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;

        console.log(`[MEDIA-QUEUE] 🚀 Memulai pemrosesan antrian media (${this.queue.length} pekerjaan)...`);
        
        while (this.queue.length > 0) {
            const job = this.queue[0];
            
            try {
                const success = await this.processJob(job);
                if (success) {
                    this.queue.shift(); // Hapus yang sukses
                } else {
                    // Pindahkan ke belakang antrian untuk dicoba nanti jika masih ada jatah retry
                    const completedJob = this.queue.shift();
                    if (completedJob.retryCount < this.maxRetries) {
                        completedJob.retryCount++;
                        completedJob.status = 'RETRYING';
                        this.queue.push(completedJob);
                        console.log(`[MEDIA-QUEUE] 🔄 Menjadwal ulang retry (${completedJob.retryCount}/${this.maxRetries}) untuk ${completedJob.customerPhone}`);
                    } else {
                        console.error(`[MEDIA-QUEUE] ❌ Menyerah pada ${completedJob.customerPhone} setelah ${this.maxRetries} kali percobaan.`);
                    }
                }
            } catch (e) {
                console.error('[MEDIA-QUEUE] ❌ Error vatal pada worker:', e.message);
                this.queue.shift(); // Amankan agar loop tidak macet
            }

            this.saveQueue();
            
            // Jeda antar unduhan (Throttling) - CRITICAL untuk Scalability
            if (this.queue.length > 0) {
                await new Promise(r => setTimeout(r, this.pollingInterval));
            }
        }

        this.isProcessing = false;
        console.log(`[MEDIA-QUEUE] 🏁 Antrian kosong. Worker masuk mode standby.`);
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
