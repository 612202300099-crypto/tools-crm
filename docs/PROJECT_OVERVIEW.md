# 📋 PROJECT OVERVIEW — Kirimfoto CRM System

## Deskripsi Sistem
Kirimfoto CRM adalah sistem CRM berbasis WhatsApp untuk mengelola pesanan cetak foto. 
Sistem ini menerima foto dari customer melalui WhatsApp, mengidentifikasi nomor pesanan, 
menyimpan media ke Object Storage (S3), lalu mengunggah ke Google Drive secara otomatis.

---

## Arsitektur Sistem

```
[Customer WA] 
    ↓ (pesan/foto masuk)
[WhatsApp Web Client — whatsapp-web.js]
    ↓
[processMessageCommand() — Core Engine]
    ├── [AI Follow-Up Service] — Deteksi no. pesanan, balas otomatis
    ├── [Media Queue Service] — Download & simpan foto ke Object Storage
    └── [Google Drive Service] — Upload foto ke folder terstruktur di Drive
    
[Frontend Dashboard — Next.js]
    ↔ (Socket.IO real-time + REST API)
[Backend API — Express.js]
    ↕
[SQLite Database — better-sqlite3]
    ↕
[Object Storage — S3-Compatible (Cloudflare R2 / AWS S3)]
```

---

## Komponen Utama

### Backend (`backend/`)
| File | Fungsi |
|------|--------|
| `index.js` | Engine utama — WA Client, message handler, cron jobs, API endpoints |
| `api.js` | REST API untuk frontend dashboard (customers, media, drive status, ZIP download) |
| `db.js` | SQLite schema, migrations, indeks performa |
| `services/ai_followup_service.js` | AI bot, deteksi nomor pesanan, tagihan foto, anti-spam |
| `services/media_queue_service.js` | Download media WA ke Object Storage secara paralel |
| `services/google_drive_service.js` | Upload foto ke Google Drive, folder hierarki, retry queue |
| `services/spreadsheet_service.js` | Lookup nomor pesanan di Google Sheets (Ventura/Giftyours/Custombase) |
| `services/pending_order_service.js` | Retry otomatis nomor pesanan yang belum ada di spreadsheet |
| `services/outgoing_queue_service.js` | Anti-spam: serial queue pesan bot dengan natural delay |
| `services/chrome_semaphore.js` | Kontrol konkurensi ke Chrome/WA agar tidak crash |
| `services/object_storage_service.js` | Abstraksi S3-compatible storage (upload, download, delete) |
| `services/stability_manager.js` | Watchdog — restart otomatis jika WA tidak aktif >3 jam |
| `services/cleanup_service.js` | Hapus file lama untuk menjaga disk usage |

### Frontend (`frontend/src/app/`)
| File | Fungsi |
|------|--------|
| `dashboard/page.tsx` | Halaman daftar customer + status media |
| `dashboard/[customerId]/page.tsx` | Halaman detail customer — chat, media, validasi, ZIP download |
| `(auth)/login/page.tsx` | Halaman login |
| `lib/apiClient.ts` | Axios client + Socket.IO initializer |

---

## Alur Data Lengkap

### 1. Customer Kirim Foto
```
Customer WA → message_create event → processMessageCommand()
    → resolve phone number (LID/C.US mapping)
    → upsert customer di DB
    → anti-duplikat check (message_hash)
    → mediaQueue.addToQueue()
        → download media via WA (Chrome Semaphore)
        → convert HEIC → JPEG (jika perlu)
        → enhance via Sharp
        → upload ke Object Storage (S3)
        → insert ke tabel `media` di SQLite
        → google_drive_service.queueUpload()
            → insert ke `drive_upload_queue` (status PENDING/WAITING_RESI)
    → checkAndRespondMedia() — AI check foto sudah cukup?
```

### 2. Customer Kirim Nomor Pesanan
```
Customer WA → message teks → processMessageCommand()
    → checkAndRespond()
        → detectOrderId() — regex \b(\d{14,20})\b
        → lookupOrder() — search di 3 Google Sheets
            → FOUND → handleOrderFound() → kirim detail + minta foto
            → NOT_FOUND → handleOrderNotFound() → pending_order_service
                → retry setiap 5 menit, max 30 menit
            → CANCELLED → handleOrderCancelled() → informasikan customer
```

### 3. Upload ke Google Drive
```
Cron setiap 30 detik → driveService.processUploadQueue()
    → check WAITING_RESI items → update resi dari DB
    → healing pass: UPLOADING nyangkut >1 jam → reset ke PENDING
    → batch sync resi dari Sheets (max 1x per 5 menit)
    → ambil PENDING items (max 100 per batch)
    → worker pool (5 workers paralel):
        → download dari Object Storage / disk lokal
        → ensureFolderHierarchy() — ROOT/TOKO/PRODUK/RESI_SKU
        → uploadFile() ke Drive
        → mark DONE
```

---

## Database Schema

### Tabel Utama
- **customers** — Data pelanggan (phone, order_id, status, resi, store_name, dll)
- **messages** — Riwayat pesan WA
- **media** — Media yang diterima (foto, URL, storage info, klasifikasi)
- **pending_orders** — Order ID yang belum ada di spreadsheet (antrian retry)
- **ai_config** — Konfigurasi bot (on/off, system prompt, gambar contoh)
- **drive_upload_queue** — Antrian upload ke Google Drive
- **drive_folders** — Cache ID folder Google Drive
- **ai_usage_counters** — Rate limiter penggunaan API AI

---

## Environment Variables Kritis
```env
# WhatsApp
WA_API_URL= (URL publik backend, e.g., https://api.kirimfoto.com)

# Database
DATABASE_PATH= (opsional, default: ./database.sqlite)

# Google Sheets API
GOOGLE_SHEETS_API_KEY=
SPREADSHEET_VENTURA=
SPREADSHEET_GIFTYOURS=
SPREADSHEET_CUSTOMBASE=

# Google Drive
GOOGLE_DRIVE_FOLDER_ID=     (ID folder root di Drive)
GOOGLE_OAUTH2_CLIENT_ID=
GOOGLE_OAUTH2_CLIENT_SECRET=
GOOGLE_OAUTH2_REFRESH_TOKEN=
# OR (fallback untuk Shared Drive):
GOOGLE_SERVICE_ACCOUNT_KEY=

# Object Storage (S3-compatible)
STORAGE_ENDPOINT=
STORAGE_ACCESS_KEY=
STORAGE_SECRET_KEY=
STORAGE_BUCKET=
STORAGE_REGION=

# AI Bot
GROQ_API_KEY=          (Primary — Llama 3.3 70B, GRATIS)
OPENAI_API_KEY=        (Fallback — GPT-4o-mini, BERBAYAR)

# Media Workers
MEDIA_WORKERS=5        (Default: 5, max aman di VPS 8GB)
MEDIA_POLL_MS=1500
MEDIA_TIMEOUT_MS=90000
```
