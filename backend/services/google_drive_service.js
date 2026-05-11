/**
 * Google Drive Service v1
 * ─────────────────────────────────────────────────────────────
 * Upload foto customer ke Google Drive dengan hierarki folder:
 *
 *   PESANAN (root)
 *   └── VENTURA              ← nama toko (uppercase)
 *       └── POLAROID          ← singkatan produk
 *           └── JKT123_Polaroid50  ← resi_sku
 *               ├── foto1.jpg
 *               └── foto2.jpg
 *
 * Arsitektur:
 * - DECOUPLED dari media queue (jika Drive down, foto tetap masuk Object Storage)
 * - Background queue di SQLite (persistent, survive restart)
 * - Proses satu-satu (Google API rate limit ketat: 12 req/detik)
 * - Folder cache di memory + SQLite (tidak buat folder duplikat)
 * - Retry dengan exponential backoff (max 5x)
 *
 * Auth: Google Service Account (JSON key file)
 */

const path = require('path');
const fs = require('fs');

// ─── Lazy-load googleapis agar tidak crash jika belum terinstall ──────────────
let _google = null;
let _drive = null;
let _initFailed = false;

function getDrive() {
    if (_drive) return _drive;
    if (_initFailed) return null;

    try {
        const { google } = require('googleapis');
        _google = google;

        const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
        if (!rootFolderId) {
            console.warn('[DRIVE] ⚠️ GOOGLE_DRIVE_FOLDER_ID belum diisi di .env');
            _initFailed = true;
            return null;
        }

        let auth;

        // ── PRIORITAS 1: OAuth2 (user's own account — PUNYA kuota storage) ──
        // Service Account punya kuota 0 byte → TIDAK BISA upload file.
        // OAuth2 pakai akun Google user → kuota 15GB+ → BISA upload.
        const clientId     = process.env.GOOGLE_OAUTH2_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_OAUTH2_CLIENT_SECRET;
        const refreshToken = process.env.GOOGLE_OAUTH2_REFRESH_TOKEN;

        if (clientId && clientSecret && refreshToken) {
            const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
            oauth2Client.setCredentials({ refresh_token: refreshToken });
            auth = oauth2Client;
            console.log('[DRIVE] 🔑 Menggunakan OAuth2 (akun user — ada kuota storage).');
        } else {
            // ── FALLBACK: Service Account ──────────────────────────────────
            // Hanya bisa upload ke Shared Drive (Team Drive).
            // Jika Drive biasa → error "no storage quota".
            const rawKeyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || './service-account.json';
            const keyPath = path.isAbsolute(rawKeyPath)
                ? rawKeyPath
                : path.resolve(path.join(__dirname, '..'), rawKeyPath);

            if (!fs.existsSync(keyPath)) {
                console.warn(`[DRIVE] ⚠️ Tidak ada OAuth2 DAN Service Account key.`);
                console.warn('[DRIVE] 💡 Jalankan: node setup_drive_auth.js');
                _initFailed = true;
                return null;
            }

            auth = new google.auth.GoogleAuth({
                keyFile: keyPath,
                scopes: ['https://www.googleapis.com/auth/drive'],
            });
            console.log('[DRIVE] 🔑 Menggunakan Service Account (hanya Shared Drive).');
        }

        _drive = google.drive({ version: 'v3', auth });
        console.log(`[DRIVE] ✅ Google Drive API siap. Root folder: ${rootFolderId}`);
        return _drive;

    } catch (e) {
        console.error(`[DRIVE] ❌ Gagal inisialisasi: ${e.message}`);
        if (e.message.includes('Cannot find module')) {
            console.error('[DRIVE] 💡 Jalankan: npm install googleapis');
        }
        _initFailed = true;
        return null;
    }
}

// ─── Folder Cache (In-Memory + SQLite) ──────────────────────────────────────
// Key: folderPath (e.g., "VENTURA/POLAROID/JKT123_Pol50")
// Value: Google Drive folder ID
const folderCache = new Map();

// [BUG FIX] Mutex lock per folderPath — cegah race condition folder duplikat
// Tanpa ini: 2 worker yang buat folder bersamaan → Drive punya 2 folder sama!
// Dengan ini: worker ke-2 menunggu promise dari worker ke-1, lalu pakai hasil yang sama
const _folderCreationLocks = new Map();

function getDb() { return require('../db'); }

function getCachedFolderId(folderPath) {
    // 1. In-memory (fastest)
    if (folderCache.has(folderPath)) return folderCache.get(folderPath);

    // 2. SQLite (persistent)
    try {
        const db = getDb();
        const row = db.prepare('SELECT drive_id FROM drive_folders WHERE folder_path = ?').get(folderPath);
        if (row) {
            folderCache.set(folderPath, row.drive_id);
            return row.drive_id;
        }
    } catch (e) { /* silent */ }

    return null;
}

function saveFolderToCache(folderPath, driveId, parentId) {
    folderCache.set(folderPath, driveId);
    try {
        const db = getDb();
        db.prepare(`
            INSERT OR REPLACE INTO drive_folders (folder_path, drive_id, parent_id)
            VALUES (?, ?, ?)
        `).run(folderPath, driveId, parentId);
    } catch (e) {
        console.warn('[DRIVE] ⚠️ Gagal simpan folder cache ke DB:', e.message);
    }
}

// ─── Folder Operations ──────────────────────────────────────────────────────

/**
 * Cari folder berdasarkan nama di parent tertentu.
 * Jika tidak ada, buat baru.
 * [FIX] Menggunakan mutex lock per folderPath untuk mencegah race condition.
 * @returns {string} Google Drive folder ID
 */
async function getOrCreateFolder(folderName, parentId, folderPath) {
    // 1. Cache check (fastest)
    const cached = getCachedFolderId(folderPath);
    if (cached) return cached;

    // 2. Mutex: jika sedang dalam proses pembuatan, TUNGGU hasilnya (jangan buat baru)
    if (_folderCreationLocks.has(folderPath)) {
        return _folderCreationLocks.get(folderPath);
    }

    // 3. Buat promise dan lock dulu SEBELUM async operation
    const promise = _doGetOrCreateFolder(folderName, parentId, folderPath);
    _folderCreationLocks.set(folderPath, promise);

    try {
        const result = await promise;
        return result;
    } finally {
        _folderCreationLocks.delete(folderPath);
    }
}

/**
 * Implementasi aktual get-or-create folder (dipanggil melalui mutex).
 */
async function _doGetOrCreateFolder(folderName, parentId, folderPath) {
    const drive = getDrive();
    if (!drive) throw new Error('Drive API tidak tersedia');

    // Search for existing folder in parent
    try {
        const searchRes = await drive.files.list({
            q: `name='${folderName.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id, name)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            corpora: 'allDrives',
        });

        if (searchRes.data.files && searchRes.data.files.length > 0) {
            // [FIX] Jika ada beberapa folder duplikat, gunakan yang pertama
            if (searchRes.data.files.length > 1) {
                console.warn(`[DRIVE] ⚠️ Ditemukan ${searchRes.data.files.length} folder duplikat "${folderName}" — menggunakan yang pertama.`);
            }
            const folderId = searchRes.data.files[0].id;
            saveFolderToCache(folderPath, folderId, parentId);
            return folderId;
        }
    } catch (searchErr) {
        console.warn(`[DRIVE] ⚠️ Search gagal untuk "${folderName}":`, searchErr.message);
    }

    // Create new folder
    const createRes = await drive.files.create({
        requestBody: {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId],
        },
        fields: 'id',
        supportsAllDrives: true,
    });

    const newFolderId = createRes.data.id;
    saveFolderToCache(folderPath, newFolderId, parentId);
    console.log(`[DRIVE] 📁 Folder dibuat: ${folderPath} (ID: ${newFolderId})`);
    return newFolderId;
}

/**
 * Buat hierarki folder lengkap dan return ID folder terdalam.
 *
 * Hierarki: ROOT → TOKO → PRODUK → RESI_SKU
 *
 * @param {string} storeName   - "ventura", "giftyours", "custombase"
 * @param {string} productAbbr - "POLAROID", "GANCI", "STIKERFOTO"
 * @param {string} resi        - Nomor resi pengiriman
 * @param {string} sku         - SKU produk (untuk folder name)
 * @returns {string} Google Drive folder ID dari folder RESI_SKU
 */
async function ensureFolderHierarchy(storeName, productAbbr, resi, sku) {
    const rootId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!rootId) throw new Error('GOOGLE_DRIVE_FOLDER_ID tidak ada di .env');

    const storeUpper = (storeName || 'UNKNOWN').toUpperCase();
    const prodFolder = productAbbr || 'LAINNYA';
    const resiSku    = `${resi || 'NORESI'}_${sku || 'NOSKU'}`;

    // Level 1: TOKO (e.g., "VENTURA")
    const storePath = storeUpper;
    const storeFolderId = await getOrCreateFolder(storeUpper, rootId, storePath);

    // Jeda 500ms antar API call (Google rate limit: 12 req/s)
    await sleep(500);

    // Level 2: PRODUK (e.g., "POLAROID")
    const prodPath = `${storeUpper}/${prodFolder}`;
    const prodFolderId = await getOrCreateFolder(prodFolder, storeFolderId, prodPath);

    await sleep(500);

    // Level 3: RESI_SKU (e.g., "JKT1234567890_Polaroid50")
    const resiPath = `${storeUpper}/${prodFolder}/${resiSku}`;
    const resiFolderId = await getOrCreateFolder(resiSku, prodFolderId, resiPath);

    return resiFolderId;
}

// ─── File Upload ────────────────────────────────────────────────────────────

/**
 * Upload satu file ke Google Drive.
 * @param {Buffer} buffer    - File content
 * @param {string} fileName  - Nama file (e.g., "foto-123456.jpg")
 * @param {string} mimeType  - MIME type (e.g., "image/jpeg")
 * @param {string} folderId  - Target folder ID di Drive
 * @returns {{ fileId: string, webViewLink: string }}
 */
async function uploadFile(buffer, fileName, mimeType, folderId) {
    const drive = getDrive();
    if (!drive) throw new Error('Drive API tidak tersedia');

    const { Readable } = require('stream');
    const stream = Readable.from(buffer);

    const res = await drive.files.create({
        requestBody: {
            name: fileName,
            parents: [folderId],
        },
        media: {
            mimeType: mimeType || 'image/jpeg',
            body: stream,
        },
        fields: 'id, webViewLink',
        supportsAllDrives: true,
    });

    return {
        fileId: res.data.id,
        webViewLink: res.data.webViewLink || null,
    };
}

// ─── Queue Operations ───────────────────────────────────────────────────────

/**
 * Tambah foto ke antrian upload Drive.
 * Dipanggil dari media_queue_service setelah Object Storage sukses.
 */
function queueUpload(params) {
    const {
        customerId, mediaId, fileUrl, storageKey, storageType,
        orderId, storeName, resi, productAbbr, sku,
        photoIndex, customerPhone,
    } = params;

    try {
        const db = getDb();
        db.prepare(`
            INSERT INTO drive_upload_queue
                (customer_id, media_id, file_url, storage_key, storage_type,
                 order_id, store_name, resi, product_abbr, sku,
                 photo_index, customer_phone, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            customerId, mediaId || null, fileUrl, storageKey || null, storageType || 'local',
            orderId || null, storeName || null, resi || null, productAbbr || 'LAINNYA', sku || null,
            photoIndex || 1, customerPhone || null,
            resi ? 'PENDING' : 'WAITING_RESI'
        );
        console.log(`[DRIVE] 📥 Queued: ${productAbbr} foto-${photoIndex} | resi: ${resi || 'WAITING'} | ${storageKey || fileUrl}`);
    } catch (e) {
        // Jika kolom photo_index/customer_phone belum ada di tabel lama, fallback
        if (e.message && e.message.includes('no column')) {
            try {
                const db = getDb();
                db.prepare(`ALTER TABLE drive_upload_queue ADD COLUMN photo_index INTEGER DEFAULT 1`).run();
                db.prepare(`ALTER TABLE drive_upload_queue ADD COLUMN customer_phone TEXT`).run();
                // Retry
                db.prepare(`
                    INSERT INTO drive_upload_queue
                        (customer_id, media_id, file_url, storage_key, storage_type,
                         order_id, store_name, resi, product_abbr, sku,
                         photo_index, customer_phone, status)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    customerId, mediaId || null, fileUrl, storageKey || null, storageType || 'local',
                    orderId || null, storeName || null, resi || null, productAbbr || 'LAINNYA', sku || null,
                    photoIndex || 1, customerPhone || null,
                    resi ? 'PENDING' : 'WAITING_RESI'
                );
                console.log(`[DRIVE] 📥 Queued (after schema upgrade): ${storageKey || fileUrl}`);
            } catch (retryErr) {
                console.error('[DRIVE] ❌ Gagal queue upload (retry):', retryErr.message);
            }
        } else {
            console.error('[DRIVE] ❌ Gagal queue upload:', e.message);
        }
    }
}

/**
 * Proses antrian upload Drive.
 * Dipanggil oleh cron setiap 30 detik dari index.js.
 *
 * PENTING: Proses SATU-SATU, bukan paralel!
 * Google Drive API rate limit = 12 requests/detik.
 * Jika paralel → 429 Too Many Requests → semua gagal.
 */
let isProcessingQueue = false;
let lastBatchSync = 0;

async function processUploadQueue() {
    if (isProcessingQueue) return;

    const drive = getDrive();
    if (!drive) return; // Drive tidak dikonfigurasi — skip silently

    isProcessingQueue = true;
    try {

    const db = getDb();

    // 0. BATCH SYNC: Cek Google Sheets untuk customer yang resinya masih kosong (max 1x per 5 menit)
    const now = Date.now();
    if (now - lastBatchSync > 5 * 60 * 1000) {
        try {
            lastBatchSync = now;
            const missingResiOrders = db.prepare(`
                SELECT DISTINCT c.order_id 
                FROM drive_upload_queue duq
                JOIN customers c ON c.id = duq.customer_id
                WHERE duq.status = 'WAITING_RESI' 
                  AND (c.resi IS NULL OR c.resi = '') 
                  AND c.order_id IS NOT NULL 
                  AND c.order_id != ''
            `).all().map(r => r.order_id);

            if (missingResiOrders.length > 0) {
                console.log(`[DRIVE] 🔄 Memulai Batch Sync Resi untuk ${missingResiOrders.length} pesanan...`);
                const spreadsheetService = require('./spreadsheet_service');
                const newResis = await spreadsheetService.batchSyncResi(missingResiOrders);
                
                if (newResis.size > 0) {
                    const updateStmt = db.prepare(`UPDATE customers SET resi = ? WHERE order_id = ?`);
                    let updatedCount = 0;
                    for (const [orderId, resi] of newResis.entries()) {
                        updateStmt.run(resi, orderId);
                        updatedCount++;
                    }
                    console.log(`[DRIVE] ✅ Batch Sync berhasil mengupdate ${updatedCount} resi dari Spreadsheet!`);
                } else {
                    console.log(`[DRIVE] ℹ️ Batch Sync selesai, belum ada resi baru di Spreadsheet.`);
                }
            }
        } catch (syncErr) {
            console.error('[DRIVE] ⚠️ Gagal menjalankan Batch Sync Resi:', syncErr.message);
        }
    }

    // 1. Cek apakah ada WAITING_RESI yang sekarang sudah punya resi (di DB lokal)
    try {
        const waitingList = db.prepare(`
            SELECT duq.id, duq.customer_id, c.resi, c.store_name, c.order_detail
            FROM drive_upload_queue duq
            JOIN customers c ON c.id = duq.customer_id
            WHERE duq.status = 'WAITING_RESI' AND c.resi IS NOT NULL AND c.resi != ''
        `).all();

        for (const item of waitingList) {
            // Parse order_detail untuk ambil productAbbr dan sku
            let productAbbr = 'LAINNYA';
            let sku = '';
            try {
                const detail = JSON.parse(item.order_detail || '[]');
                const mainItem = detail.find(i => i.isPolaroid) || detail[0];
                if (mainItem) {
                    productAbbr = mainItem.productAbbr || 'LAINNYA';
                    sku = mainItem.sku || '';
                }
            } catch (e) { /* silent */ }

            db.prepare(`
                UPDATE drive_upload_queue
                SET status = 'PENDING', resi = ?, store_name = ?, product_abbr = ?, sku = ?
                WHERE id = ?
            `).run(item.resi, item.store_name, productAbbr, sku, item.id);
            console.log(`[DRIVE] ✅ WAITING_RESI → PENDING: customer ${item.customer_id} (resi: ${item.resi})`);
        }
    } catch (e) {
        console.warn('[DRIVE] ⚠️ Error cek WAITING_RESI:', e.message);
    }

    // 2. Ambil PENDING items (max 10 per batch)
    // [FIX] Hanya proses foto dari customer yang SUDAH KONFIRMASI (photo_confirmed=1)
    // Ini mencegah upload foto ke Drive sebelum customer selesai kirim semua foto.
    // Untuk non-Polaroid (required_photos=0): izinkan langsung upload setelah status SUDAH_KIRIM_FOTO
    let pendingItems;
    try {
        pendingItems = db.prepare(`
            SELECT duq.*
            FROM drive_upload_queue duq
            WHERE duq.status = 'PENDING'
              AND duq.retry_count < duq.max_retries
            ORDER BY duq.created_at DESC
            LIMIT 50
        `).all();
    } catch (e) {
        // Fallback jika kolom customers tidak cocok (e.g., kolom lama)
        try {
            pendingItems = db.prepare(`
                SELECT * FROM drive_upload_queue
                WHERE status = 'PENDING' AND retry_count < max_retries
                ORDER BY created_at DESC
                LIMIT 50
            `).all();
        } catch (e2) {
            console.error('[DRIVE] ❌ Gagal query pending:', e2.message);
            return;
        }
    }

    if (pendingItems.length === 0) return;

    // [FIX] Cek jumlah foto Polaroid per customer sebelum upload
    // Kelompokkan item per customer untuk validasi hitungan
    const customerPhotoMap = {}; // customerId -> { uploaded: 0, limit: N }
    for (const item of pendingItems) {
        if (!customerPhotoMap[item.customer_id]) {
            try {
                // Ambil required_photos dari SQLite (jika ada kolom di customers lokal)
                // atau pakai 0 = tidak terbatas (non-Polaroid)
                let required = 0;
                try {
                    const custRow = db.prepare(
                        `SELECT required_photos FROM customers WHERE id = ? LIMIT 1`
                    ).get(item.customer_id);
                    required = custRow ? (custRow.required_photos || 0) : 0;
                } catch (e) { /* kolom tidak ada di local DB, skip */ }
                customerPhotoMap[item.customer_id] = { uploaded: 0, limit: required };
            } catch (e) {
                customerPhotoMap[item.customer_id] = { uploaded: 0, limit: 0 };
            }
        }
    }

    console.log(`[DRIVE] 🔄 Memproses ${pendingItems.length} upload ke Google Drive...`);

    for (const item of pendingItems) {
        // [FIX] Polaroid: lewati foto berlebih (lebih dari required_photos)
        const photoStats = customerPhotoMap[item.customer_id];
        if (photoStats && photoStats.limit > 0 && photoStats.uploaded >= photoStats.limit) {
            // Tandai sebagai SKIPPED (jangan upload foto berlebih)
            db.prepare(`UPDATE drive_upload_queue SET status = 'SKIPPED' WHERE id = ?`).run(item.id);
            console.warn(`[DRIVE] ⏭️ [${item.id}] SKIP foto berlebih: customer ${item.customer_id} sudah ${photoStats.uploaded}/${photoStats.limit}`);
            continue;
        }

        try {
            // Mark as UPLOADING
            db.prepare(`UPDATE drive_upload_queue SET status = 'UPLOADING' WHERE id = ?`).run(item.id);

            // 1. Download file dari Object Storage / local disk
            console.log(`[DRIVE] ⬇️ [${item.id}] Download: ${item.storage_type} | ${(item.storage_key || item.file_url).split('/').pop()}`);
            let buffer;
            if (item.storage_type === 'object' && item.file_url) {
                // Download dari Object Storage via public URL
                const response = await fetch(item.file_url, {
                    signal: AbortSignal.timeout(60000),
                });
                if (!response.ok) throw new Error(`HTTP ${response.status} download gagal: ${item.file_url}`);
                const arrayBuf = await response.arrayBuffer();
                buffer = Buffer.from(arrayBuf);
                console.log(`[DRIVE] ✅ [${item.id}] Download OK: ${Math.round(buffer.length / 1024)}KB`);
            } else {
                // Baca dari disk lokal
                // file_url bisa berupa: https://api.kirimfoto.com/uploads/xxx/foto.jpg
                // atau path relatif: uploads/xxx/foto.jpg
                let localPath;
                const publicUrl = process.env.PUBLIC_API_URL || 'https://api.kirimfoto.com';
                if (item.file_url && item.file_url.startsWith(publicUrl)) {
                    // URL publik → convert ke path lokal
                    const relativePath = item.file_url.replace(publicUrl, '').replace(/^\//, '');
                    localPath = path.join(__dirname, '..', relativePath);
                } else if (item.file_name) {
                    localPath = path.join(__dirname, '..', 'uploads', item.file_name);
                } else {
                    localPath = path.join(__dirname, '..', 'uploads', item.file_url);
                }
                if (!fs.existsSync(localPath)) {
                    throw new Error(`File lokal tidak ditemukan: ${localPath}`);
                }
                buffer = fs.readFileSync(localPath);
                console.log(`[DRIVE] ✅ [${item.id}] Baca lokal OK: ${Math.round(buffer.length / 1024)}KB`);
            }

            // 2. Buat hierarki folder
            console.log(`[DRIVE] 📁 [${item.id}] Folder: ${item.store_name}/${item.product_abbr}/${item.resi}_${item.sku}`);
            const folderId = await ensureFolderHierarchy(
                item.store_name,
                item.product_abbr,
                item.resi,
                item.sku
            );
            console.log(`[DRIVE] ✅ [${item.id}] Folder OK: ${folderId}`);

            await sleep(500);

            // 3. Upload file ke Drive
            // [FIX] Nama file informatif: {phone}_{urutan}.jpg bukan foto-randomhex.jpg
            const phone = (item.customer_phone || item.customer_id || 'unknown').replace(/[^0-9a-zA-Z]/g, '');
            const idx = item.photo_index || 1;
            const baseName = `${phone}_foto${String(idx).padStart(2, '0')}.jpg`;
            console.log(`[DRIVE] ⬆️ [${item.id}] Uploading ${baseName} (${Math.round(buffer.length / 1024)}KB)...`);
            const { fileId } = await uploadFile(
                buffer,
                baseName,
                'image/jpeg',
                folderId
            );

            // 4. Mark as DONE + increment counter untuk validasi foto Polaroid
            db.prepare(`
                UPDATE drive_upload_queue
                SET status = 'DONE', drive_file_id = ?
                WHERE id = ?
            `).run(fileId, item.id);

            // [FIX] Tambah counter agar foto berikutnya bisa dicek batasnya
            if (customerPhotoMap[item.customer_id]) {
                customerPhotoMap[item.customer_id].uploaded++;
            }

            console.log(`[DRIVE] ✅ [${item.id}] Upload SUKSES: ${item.product_abbr}/${item.resi}_${item.sku}/${baseName} (${photoStats?.uploaded || '?'}/${photoStats?.limit || '∞'})`);

            // Jeda antar upload (rate limit protection)
            await sleep(500);

        } catch (err) {
            // Handle errors with retry logic
            const retryCount = (item.retry_count || 0) + 1;
            const isRateLimit = err.message && (err.message.includes('429') || err.message.includes('Rate Limit'));

            if (isRateLimit) {
                console.warn(`[DRIVE] ⏳ Rate limit! Pause 60 detik...`);
                await sleep(60000);
            }

            db.prepare(`
                UPDATE drive_upload_queue
                SET status = 'PENDING', retry_count = ?, error_msg = ?
                WHERE id = ?
            `).run(retryCount, err.message.substring(0, 200), item.id);

            if (retryCount >= (item.max_retries || 5)) {
                db.prepare(`UPDATE drive_upload_queue SET status = 'FAILED' WHERE id = ?`).run(item.id);
                console.error(`[DRIVE] ❌ Gagal setelah ${retryCount}x: ${item.file_url} — ${err.message}`);
            } else {
                console.warn(`[DRIVE] 🔄 Retry ${retryCount}/${item.max_retries}: ${err.message.substring(0, 80)}`);
            }
        }
    }

    console.log('[DRIVE] ✅ Batch selesai.');
    } finally {
        isProcessingQueue = false;
    }
}

// ─── Status / Stats ─────────────────────────────────────────────────────────

function getStats() {
    try {
        const db = getDb();
        const pending  = db.prepare(`SELECT COUNT(*) as c FROM drive_upload_queue WHERE status = 'PENDING'`).get();
        const waiting  = db.prepare(`SELECT COUNT(*) as c FROM drive_upload_queue WHERE status = 'WAITING_RESI'`).get();
        const done     = db.prepare(`SELECT COUNT(*) as c FROM drive_upload_queue WHERE status = 'DONE'`).get();
        const failed   = db.prepare(`SELECT COUNT(*) as c FROM drive_upload_queue WHERE status = 'FAILED'`).get();
        return {
            pending: pending.c,
            waitingResi: waiting.c,
            done: done.c,
            failed: failed.c,
            driveAvailable: !!getDrive(),
        };
    } catch (e) {
        return { pending: 0, waitingResi: 0, done: 0, failed: 0, driveAvailable: false };
    }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
    queueUpload,
    processUploadQueue,
    getStats,
    getDrive,         // Expose for health check
    getOrCreateFolder,
    ensureFolderHierarchy,
};
