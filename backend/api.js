const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('./db');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver'); // ZIP generator — must be top-level CJS require

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'crm-super-secret-key-2026';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@polaroid.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'polaroid123';

// [BEST PRACTICE] Peringatan Keamanan jika menggunakan default credentials di Production
if (!process.env.JWT_SECRET || !process.env.ADMIN_PASSWORD || !process.env.ADMIN_EMAIL) {
    console.warn('\\n⚠️ [SECURITY WARNING] Menggunakan Kredensial Admin Default!');
    console.warn('Sangat disarankan mengatur JWT_SECRET, ADMIN_EMAIL, dan ADMIN_PASSWORD di file .env.\\n');
}

// Middleware Auth
const authenticateToken = (req, res, next) => {
    // [FIX] Support token via query parameter for large file downloads (ZIP)
    const authHeader = req.headers['authorization'];
    const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;
    
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

router.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ access_token: token });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// GET Customers with search, filter, and media count
router.get('/customers', authenticateToken, (req, res) => {
    try {
        const { search, status, order, start, end, limit = 1000 } = req.query;
        let query = `
            SELECT c.*, 
                   (SELECT COUNT(*) FROM media m WHERE m.customer_id = c.id AND COALESCE(m.excluded_from_production, 0) = 0) as media_count
            FROM customers c
            WHERE 1=1
        `;
        const params = [];

        if (search) {
            query += ` AND (c.name LIKE ? OR c.phone_number LIKE ? OR c.order_id LIKE ?)`;
            const s = `%${search}%`;
            params.push(s, s, s);
        }
        if (status && status !== 'ALL') {
            query += ` AND c.status = ?`;
            params.push(status);
        }
        if (order === 'SENT') {
            query += ` AND c.order_id IS NOT NULL`;
        } else if (order === 'NOT_SENT') {
            query += ` AND c.order_id IS NULL`;
        }
        if (start && end) {
            query += ` AND c.created_at >= ? AND c.created_at <= ?`;
            params.push(new Date(start).toISOString(), new Date(end).toISOString());
        }

        query += ` ORDER BY c.created_at DESC LIMIT ?`;
        params.push(parseInt(limit));

        const customers = db.prepare(query).all(...params);
        
        // Format to match Supabase shape for frontend compatibility
        const formatted = customers.map(c => {
            const { media_count, ...rest } = c;
            return {
                ...rest,
                is_valid: Boolean(rest.is_valid),
                media: [{ count: media_count }]
            };
        });

        res.json(formatted);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/customers/:id', authenticateToken, (req, res) => {
    try {
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
        if (!customer) return res.status(404).json({ error: 'Not found' });
        customer.is_valid = Boolean(customer.is_valid);
        res.json(customer);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/customers/:id', authenticateToken, (req, res) => {
    try {
        const { name, order_id, status, is_valid, created_at } = req.body;
        const updates = [];
        const params = [];

        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (order_id !== undefined) { updates.push('order_id = ?'); params.push(order_id); }
        if (status !== undefined) { updates.push('status = ?'); params.push(status); }
        if (is_valid !== undefined) { updates.push('is_valid = ?'); params.push(is_valid ? 1 : 0); }
        if (created_at !== undefined) { updates.push('created_at = ?'); params.push(created_at); }

        if (updates.length > 0) {
            params.push(req.params.id);
            db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        }
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/customers/:id/messages', authenticateToken, (req, res) => {
    try {
        const messages = db.prepare('SELECT * FROM messages WHERE customer_id = ? ORDER BY created_at ASC').all(req.params.id);
        const formatted = messages.map(m => ({ ...m, is_from_me: Boolean(m.is_from_me) }));
        res.json(formatted);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/customers/:id/media', authenticateToken, (req, res) => {
    try {
        const media = db.prepare('SELECT * FROM media WHERE customer_id = ? ORDER BY created_at DESC').all(req.params.id);
        res.json(media);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const { lookupOrder } = require('./services/spreadsheet_service');

router.post('/customers/:id/drive-sync', authenticateToken, async (req, res) => {
    try {
        const { mediaIds } = req.body;
        if (!mediaIds || !Array.isArray(mediaIds) || mediaIds.length === 0) {
            return res.status(400).json({ error: 'Tidak ada foto yang dipilih' });
        }

        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
        if (!customer) return res.status(404).json({ error: 'Customer tidak ditemukan' });
        
        if (!customer.order_id) {
            return res.status(400).json({ error: 'Gagal: Customer ini belum memiliki Nomor Order (Scan ID atau ketik manual terlebih dahulu)' });
        }

        // 1. Cek Spreadsheet Terlebih Dahulu secara langsung (Bypass Cache)
        const lookup = await lookupOrder(customer.order_id, { bypassCache: true });
        
        if (!lookup || !lookup.found) {
            return res.status(400).json({ error: 'Gagal: Pesanan tidak ditemukan di Spreadsheet. Pastikan admin sudah mengisi data pesanan ini di Google Sheets.' });
        }

        const finalResi = lookup.resi || customer.order_id;
        const finalStoreName = lookup.storeName;
        
        // Simpan detail terbaru dari spreadsheet ke tabel customers
        db.prepare('UPDATE customers SET resi = ?, store_name = ?, order_detail = ? WHERE id = ?')
            .run(finalResi, finalStoreName, JSON.stringify(lookup.items), customer.id);

        let productAbbr = 'LAINNYA';
        let sku = '';
        const mainItem = lookup.items.find(i => i.isPolaroid) || lookup.items[0];
        if (mainItem) {
            productAbbr = mainItem.productAbbr || 'LAINNYA';
            sku = mainItem.sku || '';
        }

        let pushed = 0;
        let skipped = 0;
        const insertStmt = db.prepare(`
            INSERT INTO drive_upload_queue
                (customer_id, media_id, file_url, storage_key, storage_type,
                 order_id, store_name, resi, product_abbr, sku,
                 photo_index, customer_phone, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const updateStmt = db.prepare(`
            UPDATE drive_upload_queue 
            SET status = 'PENDING', resi = ?, store_name = ?, product_abbr = ?, sku = ?, retry_count = 0
            WHERE media_id = ?
        `);

        db.transaction(() => {
            // Ambil detail media
            const placeholders = mediaIds.map(() => '?').join(',');
            const excludedSelected = db.prepare(`
                SELECT COUNT(*) as c FROM media
                WHERE id IN (${placeholders})
                  AND COALESCE(excluded_from_production, 0) = 1
            `).get(...mediaIds);
            skipped += excludedSelected ? excludedSelected.c : 0;
            const mediaList = db.prepare(`
                SELECT * FROM media
                WHERE id IN (${placeholders})
                  AND COALESCE(excluded_from_production, 0) = 0
            `).all(...mediaIds);

            for (const media of mediaList) {
                // Cek apakah sudah ada di antrean
                const existing = db.prepare('SELECT id, status FROM drive_upload_queue WHERE media_id = ?').get(media.id);
                
                if (existing) {
                    if (existing.status === 'DONE') {
                        // CEGAH DUPLIKASI: Jika sudah sukses di Drive, jangan di-upload ulang!
                        skipped++;
                    } else {
                        // Jika FAILED atau PENDING/UPLOADING yang macet, kita paksa PENDING ulang
                        updateStmt.run(finalResi, finalStoreName, productAbbr, sku, media.id);
                        pushed++;
                    }
                } else {
                    // Insert baru.
                    insertStmt.run(
                        customer.id, media.id, media.file_url, media.storage_key, media.storage_type,
                        customer.order_id || null, finalStoreName || null, finalResi, productAbbr, sku,
                        media.id, customer.phone_number, 'PENDING'
                    );
                    pushed++;
                }
            }
        })();

        res.json({ success: true, pushed, skipped });
    } catch (err) {
        console.error('[API] Error manual drive sync:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Endpoint Baru untuk Frontend Mengecek Status Upload Drive secara Live
router.get('/customers/:id/drive-status', authenticateToken, (req, res) => {
    try {
        const statuses = db.prepare('SELECT media_id, status FROM drive_upload_queue WHERE customer_id = ? AND media_id IS NOT NULL').all(req.params.id);
        
        // Bentuk menjadi object map: { "media_123": "DONE", "media_456": "PENDING" }
        const statusMap = {};
        for (const row of statuses) {
            statusMap[row.media_id] = row.status;
        }
        res.json(statusMap);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Endpoint Server-Side ZIP: Mengunduh foto dengan kecepatan tinggi tanpa membebani browser
router.get('/customers/:id/fast-zip', async (req, res) => {
    try {
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
        if (!customer) return res.status(404).json({ error: 'Customer tidak ditemukan' });

        let mediaList = [];
        if (req.query.mediaIds) {
            const ids = req.query.mediaIds.split(',').filter(Boolean);
            if (ids.length > 0) {
                const placeholders = ids.map(() => '?').join(',');
                mediaList = db.prepare(`
                    SELECT * FROM media
                    WHERE customer_id = ?
                      AND id IN (${placeholders})
                      AND COALESCE(excluded_from_production, 0) = 0
                    ORDER BY created_at ASC
                `).all(req.params.id, ...ids);
            }
        } else {
            mediaList = db.prepare(`
                SELECT * FROM media
                WHERE customer_id = ?
                  AND COALESCE(excluded_from_production, 0) = 0
                ORDER BY created_at ASC
            `).all(req.params.id);
        }

        if (mediaList.length === 0) return res.status(404).json({ error: 'Tidak ada foto yang valid untuk didownload' });

        const orderName = customer.order_id || customer.phone_number || 'Pesanan';
        const zipFilename = `${orderName}.zip`;

        res.attachment(zipFilename);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Transfer-Encoding', 'chunked');

        const archive = archiver('zip', {
            zlib: { level: 1 } // Low compression = High speed
        });

        archive.on('error', (err) => {
            console.error('[API] Archiver error:', err.message);
            if (!res.headersSent) res.status(500).end();
        });

        // Pipe archive stream langsung ke response HTTP (Streaming)
        archive.pipe(res);

        // [TURBO] Parallel Download Pool — Download 15 foto sekaligus
        const MAX_CONCURRENT = 15;
        let index = 0;
        const objectStorage = require('./services/object_storage_service');

        const worker = async () => {
            while (index < mediaList.length) {
                const i = index++;
                const media = mediaList[i];
                
                const rawExt = (media.file_url || '').split('.').pop().split('?')[0];
                const ext = ['jpg','jpeg','png','webp','heic','gif','mp4'].includes(rawExt?.toLowerCase()) ? rawExt : 'jpg';
                const fileName = `foto_${String(i + 1).padStart(4, '0')}.${ext}`;

                try {
                    let buffer;
                    if (media.storage_type === 'object') {
                        // Jalur dalam (Direct S3 Buffer) — Anti 403 & Cepat
                        const storageKey = media.storage_key || (media.file_url ? media.file_url.split('/').pop() : null);
                        buffer = await objectStorage.getMediaBuffer(storageKey, 'object');
                    } else {
                        // Jalur lokal
                        let localPath = null;
                        const publicUrl = process.env.PUBLIC_API_URL || 'https://api.kirimfoto.com';
                        if (media.file_url && media.file_url.startsWith(publicUrl)) {
                            const relativePath = media.file_url.replace(publicUrl, '').replace(/^\//, '');
                            localPath = path.join(__dirname, relativePath);
                        } else if (media.file_name) {
                            localPath = path.join(__dirname, 'uploads', media.file_name);
                        }
                        
                        if (localPath && fs.existsSync(localPath)) {
                            buffer = fs.readFileSync(localPath);
                        }
                    }

                    if (buffer) {
                        archive.append(buffer, { name: fileName });
                    }
                } catch (err) {
                    console.error(`[ZIP] Gagal ambil file ${media.id}:`, err.message);
                }
            }
        };

        // Jalankan pool workers
        const workers = [];
        for (let i = 0; i < Math.min(MAX_CONCURRENT, mediaList.length); i++) {
            workers.push(worker());
        }

        await Promise.all(workers);
        await archive.finalize();
        console.log(`[ZIP] ✅ Berhasil buat ZIP ${zipFilename} (${mediaList.length} foto)`);

    } catch (err) {
        console.error('[API] Error fast-zip:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
});


module.exports = { router, authenticateToken };
