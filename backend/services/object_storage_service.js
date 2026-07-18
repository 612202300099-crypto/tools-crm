/**
 * Object Storage Service — v1
 * ─────────────────────────────────────────────────────────────
 * Abstraksi layer untuk penyimpanan media di Object Storage
 * (S3-compatible: IDCloudHost, BiznetGio, DigitalOcean Spaces,
 *  Niaga Cloud, AWS S3, Cloudflare R2, dll).
 *
 * ARSITEKTUR FAILSAFE:
 * ┌─────────────────────────────────────────────────┐
 * │  Upload foto customer                           │
 * │      ↓                                         │
 * │  [1] Coba upload ke Object Storage             │
 * │      ├── Sukses → return URL publik            │
 * │      └── Gagal (3x retry) → FALLBACK           │
 * │              ↓                                  │
 * │          [2] Simpan ke disk lokal VPS           │
 * │              → TIDAK ADA FOTO YANG HILANG       │
 * └─────────────────────────────────────────────────┘
 *
 * ENV VARS yang dibutuhkan di .env:
 *   OBJECT_STORAGE_ENDPOINT   = https://sgp1.digitaloceanspaces.com
 *   OBJECT_STORAGE_REGION     = sgp1
 *   OBJECT_STORAGE_BUCKET     = nama-bucket-anda
 *   OBJECT_STORAGE_ACCESS_KEY = xxx
 *   OBJECT_STORAGE_SECRET_KEY = xxx
 *   OBJECT_STORAGE_PUBLIC_URL = https://nama-bucket.sgp1.cdn.digitaloceanspaces.com
 */

const path = require('path');
const fs   = require('fs');

// ── Lazy-load AWS SDK v3 (S3 client) ─────────────────────────────────────────
let _s3Client    = null;
let _s3Commands  = null;
let _isAvailable = null; // null = belum dicek, true/false = hasil cek

let _envWarningLogged = false;
let _sdkWarningLogged = false;

function getS3() {
    if (_s3Client) return { client: _s3Client, cmds: _s3Commands };
    try {
        const { S3Client }         = require('@aws-sdk/client-s3');
        const { PutObjectCommand,
                DeleteObjectCommand,
                GetObjectCommand,
                HeadBucketCommand  } = require('@aws-sdk/client-s3');

        const endpoint   = process.env.OBJECT_STORAGE_ENDPOINT;
        const region     = process.env.OBJECT_STORAGE_REGION     || 'us-east-1';
        const accessKey  = process.env.OBJECT_STORAGE_ACCESS_KEY;
        const secretKey  = process.env.OBJECT_STORAGE_SECRET_KEY;

        if (!endpoint || !accessKey || !secretKey) {
            // [v2] Log SPESIFIK field mana yang kosong agar mudah debug
            const missing = [];
            if (!endpoint)  missing.push('OBJECT_STORAGE_ENDPOINT');
            if (!accessKey) missing.push('OBJECT_STORAGE_ACCESS_KEY');
            if (!secretKey) missing.push('OBJECT_STORAGE_SECRET_KEY');
            if (missing.length > 0) {
                if (!_envWarningLogged) {
                    console.log(`[OBJ-STORAGE] ⚠️ ENV kosong: ${missing.join(', ')}. Pastikan .env terbaca oleh dotenv. (Peringatan ini hanya muncul sekali)`);
                    _envWarningLogged = true;
                }
                return null; // Belum dikonfigurasi
            }
        }

        _s3Client = new S3Client({
            endpoint,
            region,
            credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
            forcePathStyle: false, // true hanya untuk MinIO self-hosted
        });

        _s3Commands = { PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand };
        console.log(`[OBJ-STORAGE] ✅ S3 Client berhasil dibuat. Endpoint: ${endpoint}`);
        return { client: _s3Client, cmds: _s3Commands };

    } catch (e) {
        if (!_sdkWarningLogged) {
            // SDK belum terinstall — log detail agar tidak bingung
            console.error(`[OBJ-STORAGE] ❌ Gagal load @aws-sdk/client-s3: ${e.message}`);
            console.error(`[OBJ-STORAGE] 💡 Jalankan: npm install @aws-sdk/client-s3`);
            _sdkWarningLogged = true;
        }
        return null;
    }
}

// ── Cek apakah Object Storage tersedia dan bisa dipakai ──────────────────────
async function isObjectStorageAvailable() {
    if (_isAvailable !== null) return _isAvailable; // Cache hasil cek

    const s3 = getS3();
    if (!s3) {
        console.log('[OBJ-STORAGE] ⚠️ AWS SDK tidak ditemukan atau env belum diisi. Jalankan: npm install @aws-sdk/client-s3');
        _isAvailable = false;
        return false;
    }

    try {
        const bucket = process.env.OBJECT_STORAGE_BUCKET;
        if (!bucket) {
            console.warn('[OBJ-STORAGE] ⚠️ OBJECT_STORAGE_BUCKET belum diisi di .env');
            _isAvailable = false;
            return false;
        }

        await s3.client.send(new s3.cmds.HeadBucketCommand({ Bucket: bucket }));
        console.log(`[OBJ-STORAGE] ✅ Koneksi ke bucket "${bucket}" berhasil!`);
        _isAvailable = true;
        return true;
    } catch (e) {
        console.error(`[OBJ-STORAGE] ❌ Gagal koneksi ke bucket: ${e.message}`);
        _isAvailable = false;
        return false;
    }
}

// ── Reset cache ketersediaan (untuk retry setelah error) ─────────────────────
function resetAvailabilityCache() {
    _isAvailable = null;
    _s3Client    = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNGSI UTAMA: Upload media ke Object Storage
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Upload buffer ke Object Storage.
 * @param {Buffer} buffer      - Data file (sudah dikompresi oleh sharp)
 * @param {string} fileName    - Path relatif di bucket, contoh: "123/foto-1234567890.jpg"
 * @param {string} mimeType    - MIME type, contoh: "image/jpeg"
 * @param {number} [retries=3] - Jumlah retry jika gagal
 * @returns {{ url: string, key: string, storageType: 'object'|'local' }}
 */
async function uploadMedia(buffer, fileName, mimeType = 'image/jpeg', retries = 3) {
    const s3     = getS3();
    const bucket = process.env.OBJECT_STORAGE_BUCKET;
    const pubUrl = process.env.OBJECT_STORAGE_PUBLIC_URL;

    // ── JALUR OBJECT STORAGE ──────────────────────────────────────────────────
    if (s3 && bucket && pubUrl) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                await s3.client.send(new s3.cmds.PutObjectCommand({
                    Bucket:      bucket,
                    Key:         fileName,
                    Body:        buffer,
                    ContentType: mimeType,
                    ACL:         'public-read', // File bisa diakses publik via URL
                }));

                const url = `${pubUrl.replace(/\/$/, '')}/${fileName}`;
                console.log(`[OBJ-STORAGE] ☁️ Upload sukses (Attempt ${attempt}): ${fileName}`);
                return { url, key: fileName, storageType: 'object' };

            } catch (err) {
                console.error(`[OBJ-STORAGE] ⚠️ Upload gagal (${attempt}/${retries}): ${err.message}`);
                if (attempt < retries) {
                    await new Promise(r => setTimeout(r, attempt * 2000)); // Backoff: 2s, 4s
                }
            }
        }
        // Semua retry object storage gagal → fallback ke disk
        console.error(`[OBJ-STORAGE] 🔄 Object storage gagal total — FALLBACK ke disk lokal.`);
        _isAvailable = false; // Reset cache, akan cek ulang nanti
    }

    // ── FALLBACK: Simpan ke disk lokal ────────────────────────────────────────
    return await saveToLocalDisk(buffer, fileName);
}

/**
 * Simpan ke disk lokal (fallback) — memastikan foto customer tidak pernah hilang.
 */
async function saveToLocalDisk(buffer, fileName) {
    const PUBLIC_API_URL = process.env.PUBLIC_API_URL || 'https://api.kirimfoto.com';
    const uploadsDir     = path.join(__dirname, '..', 'uploads', path.dirname(fileName));
    const filePath       = path.join(__dirname, '..', 'uploads', fileName);

    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }
    fs.writeFileSync(filePath, buffer);

    const url = `${PUBLIC_API_URL}/uploads/${fileName}`;
    console.log(`[OBJ-STORAGE] 💾 Disimpan ke disk lokal (fallback): ${fileName}`);
    return { url, key: fileName, storageType: 'local' };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNGSI UTAMA: Hapus media dari Object Storage
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Hapus file dari Object Storage (atau disk lokal jika storageType='local').
 * @param {string} storageKey  - Key/path file (sama dengan fileName saat upload)
 * @param {string} [storageType='object'] - 'object' atau 'local'
 */
async function deleteMedia(storageKey, storageType = 'object') {
    if (!storageKey) return;

    // ── Hapus dari Object Storage ─────────────────────────────────────────────
    if (storageType === 'object') {
        const s3     = getS3();
        const bucket = process.env.OBJECT_STORAGE_BUCKET;

        if (s3 && bucket) {
            try {
                await s3.client.send(new s3.cmds.DeleteObjectCommand({
                    Bucket: bucket,
                    Key:    storageKey,
                }));
                console.log(`[OBJ-STORAGE] 🗑️ Hapus dari object storage: ${storageKey}`);
                return;
            } catch (err) {
                console.error(`[OBJ-STORAGE] ⚠️ Gagal hapus dari object storage (${storageKey}): ${err.message}`);
                // Jangan throw — lanjut coba hapus lokal jika ada
            }
        }
    }

    // ── Hapus dari disk lokal (fallback atau storageType='local') ─────────────
    const filePath = path.join(__dirname, '..', 'uploads', storageKey);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`[OBJ-STORAGE] 🗑️ Hapus dari disk lokal: ${storageKey}`);
        }
    } catch (err) {
        console.error(`[OBJ-STORAGE] ⚠️ Gagal hapus dari disk (${storageKey}): ${err.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNGSI UTAMA: Ambil file dari Object Storage sebagai Buffer (Jalur Dalam / Anti 403)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Ambil file buffer dari S3 (via SDK) atau disk lokal.
 * Mencegah error HTTP 403 Forbidden dari URL publik.
 * 
 * @param {string} storageKey  - Key/path file di bucket
 * @param {string} storageType - 'object' atau 'local'
 * @returns {Promise<Buffer>}
 */
async function getMediaBuffer(storageKey, storageType = 'object') {
    if (!storageKey) throw new Error('storageKey kosong');

    if (storageType === 'local') {
        const filePath = path.join(__dirname, '..', 'uploads', storageKey);
        if (!fs.existsSync(filePath)) throw new Error(`File lokal tidak ditemukan: ${filePath}`);
        return fs.readFileSync(filePath);
    }

    // Ambil via S3 Client (Aman, butuh kredensial valid)
    const s3 = getS3();
    const bucket = process.env.OBJECT_STORAGE_BUCKET;

    if (!s3 || !bucket) {
        throw new Error('S3 Client tidak tersedia untuk download media');
    }

    try {
        const command = new s3.cmds.GetObjectCommand({
            Bucket: bucket,
            Key: storageKey,
        });

        const response = await s3.client.send(command);
        
        // Konversi stream AWS ke Buffer
        return new Promise((resolve, reject) => {
            const chunks = [];
            response.Body.on('data', (chunk) => chunks.push(chunk));
            response.Body.on('error', reject);
            response.Body.on('end', () => resolve(Buffer.concat(chunks)));
        });
    } catch (err) {
        throw new Error(`Gagal download buffer S3 (${storageKey}): ${err.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup Health Check — dipanggil saat server start
// ─────────────────────────────────────────────────────────────────────────────
async function healthCheck() {
    const available = await isObjectStorageAvailable();
    if (available) {
        const bucket = process.env.OBJECT_STORAGE_BUCKET;
        const pubUrl = process.env.OBJECT_STORAGE_PUBLIC_URL;
        console.log(`[OBJ-STORAGE] 🟢 Object Storage AKTIF — Bucket: ${bucket} | URL: ${pubUrl}`);
    } else {
        console.warn(`[OBJ-STORAGE] 🟡 Object Storage TIDAK AKTIF — Foto akan disimpan ke disk lokal VPS.`);
        console.warn(`[OBJ-STORAGE] 💡 Isi OBJECT_STORAGE_* di .env dan jalankan: npm install @aws-sdk/client-s3`);
    }
    return available;
}

module.exports = {
    uploadMedia,
    deleteMedia,
    getMediaBuffer,
    saveToLocalDisk,
    isObjectStorageAvailable,
    resetAvailabilityCache,
    healthCheck,
};
