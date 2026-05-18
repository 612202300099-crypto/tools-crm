# 📐 RULES & STANDARDS — Kirimfoto CRM Development

> **Dokumen ini adalah PANDUAN WAJIB bagi semua perubahan pada sistem.**  
> Setiap fitur baru, bugfix, atau refactor HARUS mengikuti rules di bawah ini.  
> Ini memastikan konsistensi, kestabilan, dan keamanan sistem.

---

## 🎯 PRINSIP UTAMA (Non-Negotiable)

```
1. DATA TIDAK BOLEH HILANG      — Foto customer adalah aset utama. Zero data loss.
2. WA SESSION TIDAK BOLEH MATI  — Session mati = semua customer tidak terlayani.
3. TIDAK SPAM KE CUSTOMER       — Setiap pesan bot harus melewati outgoing_queue.
4. TIDAK CRASH CHROME           — Semua akses ke WA client harus via chromeSemaphore.
5. FALLBACK SELALU ADA          — Setiap fitur kritis harus punya path alternatif.
```

---

## 📁 STRUKTUR FILE & TANGGUNG JAWAB

### Satu Fungsi, Satu Tanggung Jawab
- Setiap service (`/services/`) memiliki tanggung jawab tunggal yang jelas
- Tidak boleh ada "god function" yang mengurus A sampai Z dalam 1 blok kode
- Jika satu fungsi >100 baris, pertimbangkan untuk dipecah

### Naming Convention
```javascript
// Fungsi async: camelCase, verb pertama
async function processUploadQueue() { ... }
async function detectOrderId() { ... }

// Handler event: camelCase dengan prefix 'handle'
async function handleOrderFound() { ... }
async function handleMediaPhotoCheck() { ... }

// Helper/utility: camelCase, descriptive
function getProductAbbreviation() { ... }
function formatOrderDetailMessage() { ... }

// Konstanta: SCREAMING_SNAKE_CASE
const MAX_RETRIES = 5;
const RETRY_INTERVAL = 5 * 60 * 1000;
```

---

## 💾 DATABASE RULES

### Schema Changes
1. **WAJIB** menggunakan `IF NOT EXISTS` untuk CREATE TABLE
2. **WAJIB** menggunakan migration pattern di `db.js` untuk ALTER TABLE:
   ```javascript
   const cols = db.prepare("PRAGMA table_info(table_name)").all().map(c => c.name);
   if (!cols.includes('new_column')) {
       db.exec(`ALTER TABLE table_name ADD COLUMN new_column TEXT;`);
       console.log('[DB] ✅ Migration: kolom new_column ditambahkan.');
   }
   ```
3. **JANGAN** hapus atau rename kolom tanpa melalui review menyeluruh
4. **WAJIB** membuat index untuk kolom yang digunakan di WHERE clause yang sering

### Query Best Practice
```javascript
// ✅ BENAR — Menggunakan prepared statement
const stmt = db.prepare('SELECT * FROM customers WHERE id = ?');
const customer = stmt.get(customerId);

// ❌ SALAH — String interpolation (SQL Injection risk)
const customer = db.prepare(`SELECT * FROM customers WHERE id = '${customerId}'`).get();

// ✅ BENAR — Menggunakan transaction untuk multi-insert
db.transaction(() => {
    for (const item of items) {
        db.prepare('INSERT INTO ...').run(...);
    }
})();

// ✅ BENAR — INSERT OR IGNORE untuk idempotent operation
db.prepare('INSERT OR IGNORE INTO messages (id, ...) VALUES (?, ...)').run(...);
```

### Anti-Duplikat
- Setiap tabel dengan potensi duplikat HARUS memiliki UNIQUE constraint
- Gunakan `INSERT OR IGNORE` atau `INSERT ... ON CONFLICT DO UPDATE` (UPSERT)
- Message deduplication menggunakan `message_hash` (bukan `wa_id`)

---

## 🤖 WHATSAPP CLIENT RULES

### Chrome Semaphore — WAJIB untuk semua operasi WA
```javascript
// ✅ BENAR — Semua akses Chrome via semaphore
const chat = await chromeSemaphore.acquire('label', () => {
    return withTimeout(client.getChatById(chatId), 30000, 'getChatById');
}, { priority: 1, timeout: 40000 });

// ❌ SALAH — Akses langsung tanpa semaphore
const chat = await client.getChatById(chatId);
```

### Priority Levels
| Priority | Digunakan untuk |
|----------|-----------------|
| 1 | Pesan real-time masuk (TERTINGGI) |
| 2 | Gali Ulang / Emergency Sync |
| 3 | Global Sweep / Low-priority background |

### Timeout Rules
- `getChat()` → 60s timeout, 90s semaphore timeout
- `fetchMessages()` → 60-120s timeout, 150s semaphore timeout  
- `loadEarlierMessages()` → 25s timeout, 35s semaphore timeout
- `sendMessage()` → 45s timeout

### Jangan Restart WA tanpa Alasan
- Jangan panggil `client.initialize()` kecuali memang disconnect
- Jangan hapus folder session tanpa konfirmasi explicit
- Watchdog hanya boleh restart setelah 3 JAM tanpa aktivitas

---

## 📤 OUTGOING MESSAGE RULES

### Semua Pesan Bot WAJIB via outgoing_queue
```javascript
// ✅ BENAR
await sendWAMessage(waClient, customer.phone_number, message);
// (sendWAMessage memanggil outgoingQueue.enqueue() di dalamnya)

// ❌ SALAH — Direct send tanpa queue (bisa kena ban WA)
await waClient.sendMessage(phone + '@c.us', message);
```

**Pengecualian:** Pesan manual dari admin via dashboard boleh langsung (bukan bot).

### Anti-Spam Checks (sudah built-in di outgoing_queue)
- Max 40 pesan/jam
- Cooldown 45 detik per customer
- Tidak kirim jam 23:00–07:00 WIB
- Jeda natural 5–15 detik antar customer berbeda

---

## 📦 MEDIA & STORAGE RULES

### Object Storage Priority
1. Foto SELALU masuk ke Object Storage (S3) jika tersedia
2. Fallback ke disk lokal HANYA jika Object Storage down
3. Jangan gabungkan storage type dalam 1 operasi

### File Naming
```
Format: {timestamp}_{customerId}.{ext}
Contoh: 1715748123456_abc123.jpg
```

### Media Queue Concurrency
- **JANGAN** naikkan concurrency melebihi `MEDIA_WORKERS` env var
- Default: 5 workers di VPS 8GB
- Maximum aman: 10 workers (kalau VPS >16GB)
- Chrome limit: TIDAK bisa handle >10 download paralel tanpa crash

---

## ☁️ GOOGLE DRIVE RULES

### Folder Hierarchy (TIDAK BOLEH DIUBAH)
```
PESANAN (ROOT_FOLDER_ID)
└── {TOKO_UPPERCASE}         (e.g., VENTURA)
    └── {PRODUCT_ABBR}       (e.g., POLAROID)
        └── {RESI}_{SKU}     (e.g., JKT123_Polaroid50)
            ├── 628xxx_foto01.jpg
            └── 628xxx_foto02.jpg
```

### Rate Limit Protection
- Jeda minimal 500ms antara setiap request ke Drive API
- Jika kena 429: pause 30 detik
- Max 5 workers paralel (Google API limit: 12 req/detik)
- Selalu gunakan anti-duplikat check sebelum queue (`file_url` atau `storage_key` + status DONE)

### Status Flow
```
WAITING_RESI → (resi tersedia) → PENDING → UPLOADING → DONE
                                               ↓ (error)
                                          retry → FAILED (setelah 5x)
```

---

## 🔢 NOMOR PESANAN RULES

### Regex Standar (SATU untuk semua tempat)
```javascript
// ✅ BENAR — Import dari utility terpusat
const { detectOrderId } = require('../utils/orderIdUtils');
const orderId = detectOrderId(message.body);

// ❌ SALAH — Regex inline (inkonsisten, sulit maintain)
const match = text.match(/\d{10,20}/); // JANGAN — bisa tangkap nomor HP!
```

**File utility:** `backend/utils/orderIdUtils.js`  
**⚠️ WAJIB import dari sana — JANGAN buat regex order ID baru inline.**  
Nomor pesanan valid: **14-20 digit** (`\b(\d{14,20})\b`)

### Alur Lookup (TIDAK BOLEH DILEWATI)
```
Deteksi order_id dari pesan
    → simpan ke DB dulu (update customers.order_id)
    → lookup di 3 spreadsheet PARALEL
        → FOUND: update semua data customer + kirim detail WA
        → NOT_FOUND: masuk pending_orders queue (retry max 6x × 5 menit)
        → CANCELLED: informasikan customer + hapus order_id
```

---

## 🔁 CRON JOBS & BACKGROUND TASKS

### Interval yang Sudah Ditetapkan
| Cron | Interval | Fungsi |
|------|----------|--------|
| Drive Upload | Setiap 30 detik | `driveService.processUploadQueue()` |
| Pending Order Retry | Setiap 5 menit | `pendingOrderSvc.processPendingOrders()` |
| Cleanup File | Setiap jam 02:00 | `cleanupService()` |
| Disk Monitor | Setiap 1 jam | Cek disk, cleanup darurat jika >90% |

### Menambah Cron Job Baru
1. Gunakan `node-cron` untuk cron berbasis waktu (jam/menit/hari)
2. Gunakan `setInterval` untuk polling (setiap N detik/menit)
3. **WAJIB** ada guard: `if (!isConnected) return;` hanya untuk yang butuh WA
4. **JANGAN** taruh guard `isConnected` untuk tugas yang tidak butuh WA (misal: Drive upload)
5. Beri log di awal dan akhir setiap cron run

---

## 🔒 SECURITY RULES

### Authentication
- Semua endpoint `/api/local/` harus melewati `authenticateToken` middleware
- Token JWT disimpan di `localStorage` sisi frontend (sudah ada)
- Untuk streaming download (ZIP), token boleh di URL query param (`?token=`) karena tidak ada header option

### Input Validation
- Selalu validasi input sebelum query DB
- Gunakan prepared statements (bukan string concat)
- Validasi tipe data, panjang, dan format sebelum proses

### Error Handling
```javascript
// ✅ Pattern yang benar
try {
    const result = await someAsyncOperation();
    // handle success
} catch (err) {
    console.error('[SERVICE-NAME] ❌ Pesan error:', err.message);
    // jangan throw lagi jika ini adalah background job
    // throw lagi jika ini adalah request handler (agar bisa return 500 ke client)
} finally {
    // cleanup (flag, lock, dll)
    isProcessing = false;
}
```

---

## 🎨 LOGGING RULES

### Format Log
```javascript
// Format: [NAMA-SERVICE] [EMOJI] Pesan deskriptif: detail
console.log('[DRIVE] ✅ Upload SUKSES: POLAROID/JKT123/foto01.jpg');
console.warn('[MEDIA-QUEUE] ⚠️ Disk 95%! Melewati antrian.');
console.error('[AI-BOT] ❌ Gagal kirim pesan: timeout setelah 30s');
```

### Emoji Konvensi
| Emoji | Makna |
|-------|-------|
| ✅ | Sukses |
| ❌ | Error/Gagal |
| ⚠️ | Warning/Perlu perhatian |
| 🔄 | Proses sedang berjalan |
| 📥 | Data masuk/diterima |
| 📤 | Data keluar/dikirim |
| 🩹 | Auto-healing/recovery |
| ⏳ | Menunggu/cooldown |
| 🚨 | Critical/Emergency |
| 📊 | Statistik/progress |

### Yang TIDAK boleh di-log
- Password, API key, token dalam bentuk plain text
- Data pribadi customer secara lengkap
- Media binary (foto) ke log

---

## 🚀 DEPLOYMENT RULES

### Sebelum Deploy ke VPS
1. Test lokal terlebih dahulu (kalau bisa)
2. Commit dengan pesan yang jelas: `fix: [DRIVE] remove isConnected guard from Drive upload cron`
3. Push ke repo
4. Pull di VPS: `git pull origin main`
5. Jika ada perubahan dependencies: `npm install`
6. Jika ada perubahan schema DB: restart PM2 (migration berjalan otomatis saat startup)
7. Restart PM2: `pm2 restart WA-Engine`
8. Monitor log selama 2-5 menit: `pm2 logs WA-Engine --lines 50`

### PM2 Process Names
```bash
pm2 restart WA-Engine     # Backend WhatsApp Engine (index.js)
pm2 restart CRM-Frontend  # Frontend Next.js (jika berjalan terpisah)
```

### Tidak Boleh Disentuh Saat Sistem Aktif Melayani Customer
- Jangan restart PM2 saat jam sibuk (08:00–22:00 WIB) kecuali emergency
- Jika harus restart, pastikan tidak ada antrian media yang sedang berjalan
- Jangan hapus/modify file database.sqlite secara manual

---

## 📐 FITUR BARU — CHECKLIST SEBELUM MERGE

```
□ Apakah fitur ini membutuhkan akses Chrome? → Gunakan chromeSemaphore
□ Apakah fitur ini mengirim pesan WA? → Gunakan outgoingQueue
□ Apakah ada perubahan schema DB? → Tambahkan migration di db.js
□ Apakah ada endpoint API baru? → Tambahkan authenticateToken jika butuh auth
□ Apakah ada perubahan regex order_id? → Samakan di semua tempat
□ Apakah ada background job baru? → Pertimbangkan dampak ke beban CPU/RAM
□ Apakah ada perubahan logika Drive upload? → Test dengan foto nyata
□ Apakah ada kemungkinan data hilang jika server restart di tengah proses?
□ Apakah error sudah ditangani dengan try-catch-finally yang benar?
□ Apakah ada log yang memadai untuk debugging produksi?
```
