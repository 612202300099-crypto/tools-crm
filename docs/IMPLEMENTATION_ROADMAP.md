# 🗺️ IMPLEMENTATION ROADMAP — Kirimfoto CRM Upgrade

**Prioritas:** Kritis → Penting → Nice to Have  
**Estimasi Total:** ~3-4 hari kerja penuh

---

## FASE 1 — BUGFIX KRITIS (Hari 1) 🔴

### [F1-BUG1] Fix: Drive Upload Cron Guard yang Salah
**File:** `backend/index.js` — baris 2081  
**Dampak:** Foto tidak diupload ke Drive saat WA disconnect/restart

**Before:**
```javascript
setInterval(async () => {
    if (!isConnected) return; // ← HAPUS INI
    await driveService.processUploadQueue();
}, 30000);
```
**After:**
```javascript
setInterval(async () => {
    // Drive upload TIDAK butuh WA connected
    try {
        await driveService.processUploadQueue();
    } catch (e) {
        console.error('[CRON] Drive upload error:', e.message);
    }
}, 30000);
```

---

### [F1-BUG2] Fix: Regex Nomor Pesanan Inkonsisten
**File:** `backend/index.js` — Emergency Mass Sync (~baris 237)  

**Before:**
```javascript
const orderIdMatch = msg.body.match(/\b\d{10,20}\b/);
```
**After:**
```javascript
const orderIdMatch = msg.body.match(/\b(\d{14,20})\b/);
if (orderIdMatch) {
    const foundOrderId = orderIdMatch[1]; // Ambil capture group
```

---

### [F1-BUG3] Fix: Healing UPLOADING Stuck — Pakai updated_at bukan created_at
**File:** `backend/services/google_drive_service.js` — baris ~513  
**Catatan:** Perlu tambah kolom `updated_at` ke tabel `drive_upload_queue` dan update saat status berubah.

**Migrasi DB di `db.js`:**
```javascript
const driveQueueCols = db.prepare(`PRAGMA table_info(drive_upload_queue)`).all().map(c => c.name);
if (!driveQueueCols.includes('updated_at')) {
    db.exec(`ALTER TABLE drive_upload_queue ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))`);
    console.log('[DB] ✅ Migration: updated_at ditambahkan ke drive_upload_queue.');
}
```

**Fix di google_drive_service.js:**
```javascript
// Update status + updated_at setiap kali status berubah
db.prepare(`UPDATE drive_upload_queue SET status = 'UPLOADING', updated_at = datetime('now') WHERE id = ?`).run(item.id);

// Healing: gunakan updated_at dan window 30 menit (bukan created_at 1 jam)
const stuckItems = db.prepare(`
    UPDATE drive_upload_queue
    SET status = 'PENDING', updated_at = datetime('now')
    WHERE status = 'UPLOADING'
      AND updated_at < datetime('now', '-30 minutes')
`).run();
```

---

### [F1-BUG4] Fix: Post-Resync Order Detection Pass
**Masalah:** Nomor pesanan di pesan lama (yang di-resync) tidak terdeteksi karena `skipCustomerUpdate=true`  
**File:** `backend/index.js` — endpoint `/api/wa/resync`

Setelah loop pemrosesan selesai, tambahkan:
```javascript
// [NEW] POST-RESYNC ORDER DETECTION PASS
// Scan semua pesan customer ini yang belum punya order_id
if (!customer_id) return; // guard
const freshCustomer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id);
if (freshCustomer && !freshCustomer.order_id) {
    const allMessages = db.prepare(
        `SELECT body FROM messages WHERE customer_id = ? AND is_from_me = 0 ORDER BY created_at ASC`
    ).all(customer_id);
    
    for (const msg of allMessages) {
        const match = msg.body?.match(/\b(\d{14,20})\b/);
        if (match) {
            const foundOrderId = match[1];
            console.log(`[RESYNC] 🔎 Post-resync: Ditemukan order ID dari pesan lama: ${foundOrderId}`);
            db.prepare('UPDATE customers SET order_id = ? WHERE id = ?').run(foundOrderId, customer_id);
            
            // Trigger spreadsheet lookup
            const lookup = await lookupOrder(foundOrderId, { bypassCache: true });
            if (lookup && lookup.found) {
                db.prepare('UPDATE customers SET resi = ?, store_name = ?, order_detail = ? WHERE id = ?')
                    .run(lookup.resi, lookup.storeName, JSON.stringify(lookup.items), customer_id);
                
                // Emit update ke frontend
                if (global._io) global._io.emit('db_change', {
                    table: 'customers', eventType: 'UPDATE',
                    new: db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id)
                });
                
                console.log(`[RESYNC] ✅ Order ID dari resync berhasil diproses: ${foundOrderId}`);
            }
            break; // Gunakan order ID pertama yang ditemukan
        }
    }
}
```

---

## FASE 2 — FITUR PENTING (Hari 2) 🟡

### [F2-FEAT1] Tambah Auto-Sweep Terjadwal (Pengganti Startup Sync)
**File:** `backend/index.js` — tambah cron job baru  
**Tujuan:** Setiap 4 jam, auto-sweep chat yang aktif dalam 24 jam terakhir untuk mengambil foto/pesan yang terlewat

```javascript
// Setiap 4 jam: auto-sweep chat aktif 24 jam terakhir
cron.schedule('0 */4 * * *', async () => {
    if (!isConnected) return;
    console.log('[AUTO-SWEEP] 🕐 Memulai auto-sweep chat aktif (24 jam terakhir)...');
    
    try {
        const chats = await chromeSemaphore.acquire('AUTO-SWEEP:getChats', () => {
            return withTimeout(client.getChats(), 60000, 'getChats_autosweep');
        }, { priority: 3, timeout: 90000 });
        
        const cutoff = Math.floor(Date.now() / 1000) - (24 * 60 * 60); // 24 jam lalu
        const activeChats = chats.filter(c => 
            !c.isGroup && c.id.user !== 'status' && 
            c.lastMessage && c.lastMessage.timestamp >= cutoff
        );
        
        console.log(`[AUTO-SWEEP] ${activeChats.length} chat aktif dalam 24 jam. Mulai menyisir...`);
        
        for (const chat of activeChats) {
            try {
                const messages = await chromeSemaphore.acquire('AUTO-SWEEP:fetchMsg', () => {
                    return withTimeout(chat.fetchMessages({ limit: 100 }), 45000, 'fetchMessages_autosweep');
                }, { priority: 3, timeout: 60000 });
                
                for (const msg of messages) {
                    if (msg.timestamp >= cutoff) {
                        await processMessageCommand(msg, true, false); // skipCustomerUpdate=true, isPriority=false
                    }
                }
                await sleep(500); // Jeda antar chat
            } catch (err) {
                console.warn(`[AUTO-SWEEP] ⚠️ Skip ${chat.id.user}: ${err.message}`);
            }
        }
        console.log('[AUTO-SWEEP] ✅ Auto-sweep selesai.');
    } catch (err) {
        console.error('[AUTO-SWEEP] ❌ Error:', err.message);
    }
});
console.log('🔄 Auto-Sweep dijadwalkan: setiap 4 jam untuk chat aktif 24 jam terakhir.');
```

---

### [F2-FEAT2] Endpoint Update Customer — Trigger Spreadsheet Lookup
**File:** `backend/api.js` — endpoint `PUT /customers/:id`  
**Tujuan:** Ketika admin isi order_id manual → sistem otomatis cari di spreadsheet

```javascript
// Di endpoint PUT /customers/:id, tambahkan:
if (updates.order_id && updates.order_id !== existingCustomer.order_id) {
    // order_id baru diisi/diubah — trigger lookup
    setImmediate(async () => {
        try {
            const { lookupOrder } = require('./services/spreadsheet_service');
            const result = await lookupOrder(updates.order_id, { bypassCache: true });
            if (result && result.found && !result.cancelled) {
                const { resi, storeName: store_name, items } = result;
                db.prepare('UPDATE customers SET resi = ?, store_name = ?, order_detail = ? WHERE id = ?')
                    .run(resi || null, store_name || null, JSON.stringify(items), id);
                
                // Trigger re-queue foto ke Drive yang masih WAITING_RESI
                db.prepare(`
                    UPDATE drive_upload_queue SET status = 'PENDING' 
                    WHERE customer_id = ? AND status = 'WAITING_RESI'
                `).run(id);
                
                console.log(`[API] ✅ Auto-lookup setelah update order_id: ${updates.order_id} → ${store_name}`);
            }
        } catch (e) {
            console.warn('[API] ⚠️ Auto-lookup gagal:', e.message);
        }
    });
}
```

---

### [F2-FEAT3] Endpoint "Gali Ulang" — Tambah Deep Pagination
**File:** `backend/index.js` — endpoint `/api/wa/resync` (~baris 1557)

Ganti `fetchMessages({ limit: 1500 })` dengan loop `loadEarlierMessages()`:
```javascript
// Setelah chat berhasil dibuka, deep paginate:
let allMessages = await chromeSemaphore.acquire('API:resync_fetchInit', () => {
    return withTimeout(chat.fetchMessages({ limit: 100 }), 60000, 'fetchMessages_init');
}, { priority: 2, timeout: 90000 });

// Loop loadEarlierMessages untuk mendapat pesan lama
let iter = 0;
const MAX_ITER = 20; // max 20x scroll ke atas per chat
while (iter < MAX_ITER) {
    iter++;
    try {
        const hasMore = await chromeSemaphore.acquire('API:resync_loadEarlier', () => {
            return withTimeout(chat.loadEarlierMessages(), 20000, 'loadEarlier_resync');
        }, { priority: 2, timeout: 30000 });
        
        const refreshed = await chromeSemaphore.acquire('API:resync_fetchRefresh', () => {
            return withTimeout(chat.fetchMessages({ limit: 5000 }), 90000, 'fetchMessages_refresh');
        }, { priority: 2, timeout: 120000 });
        
        const newFound = refreshed.length - allMessages.length;
        emitProgress('resync_progress', { phone_number, message: `Iterasi ${iter}: ${refreshed.length} pesan (+${newFound} baru)` });
        
        if (newFound > 0) allMessages = refreshed;
        if (!hasMore || newFound === 0) break;
        
        await sleep(500); // Jeda antar iterasi
    } catch (loadErr) {
        console.warn(`[RESYNC] ⚠️ loadEarlier iter ${iter} gagal:`, loadErr.message);
        break;
    }
}
```

---

## FASE 3 — FITUR MONITORING & UI (Hari 3) 🟢

### [F3-FEAT1] Panel "Sync Drive Massal" di Dashboard
**File:** `frontend/src/app/dashboard/page.tsx`  
**Tujuan:** Admin bisa trigger Emergency Mass Sync dari UI tanpa perlu curl

Tambahkan tombol di halaman dashboard utama:
```tsx
// Tombol "⚡ Sync Drive Massal" dengan modal konfirmasi
// Memanggil POST /api/local/emergency-mass-sync dengan { days: 1 atau 3 atau 7 }
// Tampilkan progres via Socket.IO
```

---

### [F3-FEAT2] Stats Drive di Dashboard Utama
**File:** `frontend/src/app/dashboard/page.tsx`  
**Tujuan:** Admin bisa melihat status antrian Drive sekilas

```tsx
// Fetch GET /api/local/drive-stats setiap 30 detik
// Tampilkan: PENDING | WAITING_RESI | DONE | FAILED
// Warna hijau jika semua DONE, kuning jika ada PENDING, merah jika ada FAILED
```

---

### [F3-FEAT3] Tombol "Gali Ulang Semua" di Dashboard List
**File:** `frontend/src/app/dashboard/page.tsx`  
**Tujuan:** Untuk customer yang chat/medianya kurang, bisa di-resync dari list tanpa masuk ke halaman individual

---

## FASE 4 — HARDENING & OPTIMASI (Hari 4) ⚡

### [F4-OPT1] Unified Order ID Detection Utility
Buat file `backend/utils/orderIdUtils.js`:
```javascript
const ORDER_ID_REGEX = /\b(\d{14,20})\b/;
function detectOrderId(text) {
    if (!text) return null;
    const match = text.match(ORDER_ID_REGEX);
    return match ? match[1] : null;
}
module.exports = { detectOrderId, ORDER_ID_REGEX };
```

Ganti semua penggunaan regex order ID di:
- `ai_followup_service.js` (~baris 244-247)
- `index.js` Emergency Sync (~baris 237)
- `index.js` emergency_mass_sync lain

---

### [F4-OPT2] Monitoring Endpoint — Drive Stats
**File:** `backend/api.js` — tambah endpoint baru (atau expose di endpoint existing)
```javascript
// GET /api/local/drive-stats
router.get('/drive-stats', authenticateToken, (req, res) => {
    try {
        const driveService = require('./services/google_drive_service');
        const stats = driveService.getStats();
        res.json({ success: true, ...stats });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
```

---

### [F4-OPT3] Update Comments di google_drive_service.js
Hapus komentar yang menyesatkan tentang `photo_confirmed` (bug #7).

---

## CHECKLIST VERIFIKASI SETELAH IMPLEMENTASI

```
□ Drive upload berjalan walau WA disconnect (test: matikan WA, foto tetap ke Drive setelah konek kembali)
□ Nomor pesanan di pesan lama terdeteksi setelah Gali Ulang
□ Admin isi order_id manual → foto otomatis ke Drive dalam 5-10 menit
□ Auto-sweep berjalan setiap 4 jam (check PM2 logs)
□ Tombol Sync Drive Massal muncul di dashboard
□ Stats Drive tampil di dashboard
□ Tidak ada spam ke customer
□ WA session tidak mati setelah deploy
□ DB schema migration berjalan mulus (log "✅ Migration:" muncul saat startup)
```

---

## ESTIMASI WAKTU

| Fase | Estimasi | Risiko |
|------|----------|--------|
| F1: Bugfix Kritis (4 item) | 3-4 jam | Rendah |
| F2: Fitur Penting (3 item) | 4-6 jam | Sedang |
| F3: UI Monitoring (3 item) | 4-5 jam | Rendah |
| F4: Hardening (3 item) | 2-3 jam | Rendah |
| **Total** | **~15-20 jam** | |

**Urutan pengerjaan yang disarankan:**  
F1-BUG1 → F1-BUG2 → F1-BUG3 → F1-BUG4 → F2-FEAT2 → F2-FEAT1 → F2-FEAT3 → F3 → F4
