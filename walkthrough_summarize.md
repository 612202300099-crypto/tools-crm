# 📋 WhatsApp CRM — Dokumentasi Lengkap Production Hardening
> Sesi: 6-9 Mei 2026 | Server: VPS Ubuntu (crm-ai) | Disk: 30GB | RAM: 2-8GB

---

## 🗂️ Daftar Isi
1. [Arsitektur Sistem](#arsitektur-sistem)
2. [File & Service yang Dimodifikasi](#file--service-yang-dimodifikasi)
3. [Kronologi Masalah & Solusi](#kronologi-masalah--solusi)
4. [Konfigurasi Environment (.env)](#konfigurasi-environment-env)
5. [PM2 Process Management](#pm2-process-management)
6. [Perintah Operasional VPS](#perintah-operasional-vps)
7. [Alur Sistem End-to-End](#alur-sistem-end-to-end)
8. [Monitoring & Troubleshooting](#monitoring--troubleshooting)
9. [Commit History](#commit-history)

---

## Arsitektur Sistem

```
Customer WhatsApp
       │
       ▼
WhatsApp Web.js (Puppeteer + Google Chrome stable)
       │
       ├─► processMessageCommand()
       │      ├─ [Shield] Filter: grup, status, unknown, e2e_notification
       │      ├─ [Shield] Disk Guard: tolak media jika disk > 96%
       │      ├─ [DB] Simpan pesan ke SQLite (anti-duplikat)
       │      ├─ [MEDIA] → MediaQueueService (async worker pool)
       │      └─ [TEXT] → AI Follow-up Service
       │
       ├─► MediaQueueService (15 concurrent workers)
       │      ├─ Download foto dari WA
       │      ├─ HEIC → JPG conversion (heic-convert)
       │      ├─ Kompres foto via Sharp (2-5MB → 300-500KB, hemat 80%)
       │      ├─ Simpan ke disk lokal → Object Storage (opsional)
       │      ├─ Upload ke Google Drive (hierarki folder)
       │      └─ Update status customer di DB
       │
       ├─► AI Follow-up Service (Groq Llama 3.3 70B)
       │      ├─ Rate Limit Guard (auto-cooldown jika 429)
       │      ├─ Tagih nomor pesanan (14-20 digit)
       │      ├─ Lookup spreadsheet 3 toko (Ventura/Giftyours/Custombase)
       │      ├─ Kirim detail pesanan + minta foto
       │      └─ Konfirmasi foto cukup → VALIDATED
       │
       ├─► Cleanup Service / The Janitor (cron 02:00 pagi)
       │      ├─ TIER-0: Hapus file lokal yang sudah di Object Storage
       │      ├─ TIER-1: VALIDATED/SUDAH_KIRIM_FOTO > 3 hari (crisis: > 1 hari)
       │      ├─ TIER-2: BELUM_KIRIM_FOTO abandoned > 7 hari (crisis: > 2 hari)
       │      └─ TIER-3: Hapus folder kosong
       │
       ├─► Stability Manager / Watchdog (cek tiap 5 menit)
       │      ├─ Health check via getState()
       │      ├─ setBusy() selama startup sync (no false restart)
       │      └─ Stale check hanya jam 06:00-23:00 WIB
       │
       └─► Disk Monitor (cron tiap jam)
              └─ Disk > 90% → trigger cleanup darurat otomatis
```

---

## File & Service yang Dimodifikasi

### `backend/index.js` — Entry Point Utama
| Perbaikan | Detail |
|:---|:---|
| **Chrome Path Detection** | Auto-detect path Chrome Linux: `/usr/bin/google-chrome-stable`, `/usr/bin/chromium-browser` dll. Fallback ke bundled Chromium |
| **Puppeteer Args VPS** | `--no-sandbox`, `--disable-gpu`, `--disable-dev-shm-usage`, `--max-old-space-size=512` |
| **Global Error Catcher** | Filter `Execution context was destroyed`, `Session closed`, `Target closed` — tidak crash server |
| **Disk Guard** | Cek disk sebelum terima media. Threshold 96%. Cooldown 5 menit agar tidak spam |
| **Filter `unknown` type** | `BLOCKED_TYPES = ['e2e_notification', 'call_log', 'protocol', 'broadcast_list', 'unknown']` |
| **Startup Sync** | 48 jam (dari 24 jam). Delay 500ms/chat (dari 1500ms). Timeout 45s (dari 30s). `setBusy()` mencegah false Watchdog restart |
| **Disconnect Handler** | LOGOUT → biarkan restart. Disconnect jaringan → auto-reinit setelah 10s (tidak perlu scan QR) |
| **Disk Monitor** | `cron.schedule('0 * * * *')` — tiap jam cek disk, cleanup darurat jika > 90% |
| **Chrome Semaphore** | Max 5 operasi Chrome serentak. Mencegah overload Puppeteer |
| **QR to Terminal** | Print QR di terminal SSH untuk scan langsung tanpa dashboard |
| **`/api/health` endpoint** | Health check endpoint untuk monitoring eksternal |

---

### `backend/services/media_queue_service.js` — Worker Pool Foto
| Perbaikan | Detail |
|:---|:---|
| **Bug Concurrency Fix** | `startProcessing()` diganti `spawnWorkers()` idempotent. Sebelumnya hanya 1 worker jalan, sekarang 15 paralel |
| **Sharp Compression** | Foto 2-5MB → 300-500KB (hemat 80%). Max 1920px, JPEG 82% quality, auto-rotate EXIF |
| **HEIC Conversion** | Deteksi & konversi HEIC → JPG sebelum kompres |
| **Configurable Workers** | `MEDIA_WORKERS` env var. VPS 2GB: 5 worker. VPS 8GB: 10-15 worker |
| **Chrome Semaphore** | Semua operasi Chrome di-throttle via semaphore |
| **Disk Guard per-job** | Cek disk sebelum simpan setiap file (bukan hanya saat masuk antrian) |
| **Timeout download** | 60s (dari 45s). Download foto besar dari WA bisa lambat |
| **Object Storage** | Upload ke S3-compatible storage setelah simpan lokal |
| **Google Drive** | Upload ke Drive dengan hierarki PESANAN/TOKO/PRODUK/RESI_SKU/ |
| **Queue persistence** | State antrian disimpan ke `media_queue_state.json`. Restart server tidak hilang antrian |
| **Healing mechanism** | Re-antri pesan yang punya media tapi belum ada record di DB |

---

### `backend/services/ai_followup_service.js` — Bot AI
| Perbaikan | Detail |
|:---|:---|
| **Groq Rate Limit Guard** | `_aiRateLimitUntil` timestamp. Parse retry-after dari error `Xm Y.Zs`. Auto-cooldown tanpa spam error |
| **Lazy OpenAI Init** | Client dibuat hanya saat pertama kali dipakai (mencegah crash saat startup jika key kosong) |
| **Pemisahan is_enabled** | Deteksi nomor pesanan (18 digit) **selalu** diproses ke spreadsheet lookup, terlepas dari status `is_enabled`. `is_enabled` hanya kontrol follow-up AI |
| **SKU Integration** | Setelah pesanan ditemukan, update nama customer di DB: `Nama Asli | SKU: KODE` |
| **Konfirmasi foto ketat** | Foto konfirmasi hanya diterima setelah customer kirim nomor pesanan |

---

### `backend/services/cleanup_service.js` — The Janitor v3
| Perbaikan | Detail |
|:---|:---|
| **Raw SQLite** | Ditulis ulang v1→v3 pakai `better-sqlite3` langsung (bukan supabase_shim yang tidak support `.in().lt()` chaining) |
| **Crisis Mode** | Disk ≥ 90% → threshold TIER-1 turun 3 hari → 1 hari, TIER-2 turun 7 hari → 2 hari |
| **TIER-0** | Hapus file lokal yang sudah aman di Object Storage (tidak kehilangan data) |
| **TIER-1** | Hapus foto VALIDATED/SUDAH_KIRIM_FOTO yang sudah melebihi threshold |
| **TIER-2** | Hapus foto customer abandoned BELUM_KIRIM_FOTO |
| **TIER-3** | Hapus folder uploads kosong |
| **Disk report** | Log disk sebelum & sesudah cleanup: `Disk: 98% → 94%` |

---

### `backend/services/stability_manager.js` — Watchdog v2
| Perbaikan | Detail |
|:---|:---|
| **`setBusy(durationMs)`** | Pause watchdog selama startup sync. Mencegah `TIMEOUT_GET_STATE` false restart |
| **`stop()`** | Cleanup `setInterval` saat disconnect (fix memory leak) |
| **Jam aktif** | STALE check hanya jam 06:00-23:00 WIB. Malam = tidak ada customer = bukan STALE |
| **Toleransi saat busy** | MAX_FAILURES 3 → 5 saat sistem dalam mode busy |

---

### `backend/services/spreadsheet_service.js` — Lookup Order
| Perbaikan | Detail |
|:---|:---|
| **Range A:N** | Fetch kolom hingga N untuk dapat kolom Variation/SKU |
| **Guard placeholder** | Skip jika SPREADSHEET_ID berisi placeholder `ISI_` |
| **Custombase offset** | Fix offset kolom Variation untuk format spreadsheet Custombase |

---

### `backend/services/pending_order_service.js` — Order Queue
| Perbaikan | Detail |
|:---|:---|
| **UNIQUE constraint** | `ON CONFLICT UPSERT` pada `order_id` — tidak duplikat |
| **5s delay** | Jeda 5 detik antar proses untuk tidak overload Chrome |

---

### `backend/services/google_drive_service.js` — Google Drive [NEW]
| Fitur | Detail |
|:---|:---|
| **OAuth2 Service Account** | Autentikasi via `service-account.json` (bukan API key) |
| **Hierarki folder otomatis** | `PESANAN BULAN/TOKO/PRODUK/RESI_SKU/foto.jpg` |
| **Shared Drive support** | Support Google Shared Drive dengan `supportsAllDrives: true` |
| **Resi extraction** | Ekstrak nomor resi dari order_id untuk penamaan folder |

---

### `backend/services/object_storage_service.js` — Cloud Storage [NEW]
| Fitur | Detail |
|:---|:---|
| **S3-compatible** | IDCloudHost, DigitalOcean Spaces, Niaga Cloud, dll |
| **Fallback ke lokal** | Jika env kosong, foto tetap simpan di disk lokal |
| **Public URL** | CDN URL dari provider untuk akses foto |

---

### `backend/services/chrome_semaphore.js` — Traffic Control [NEW]
| Fitur | Detail |
|:---|:---|
| **Semaphore pattern** | Max N operasi Chrome serentak (default 5) |
| **Queue dengan timeout** | Operasi menunggu slot, auto-timeout jika terlalu lama |
| **Mencegah crash** | Tanpa semaphore, 15 worker × buka tab Chrome = crash server |

---

## Kronologi Masalah & Solusi

### Masalah 1: Harus Scan QR Setiap Hari
**Root Cause:** Chrome Linux tidak ditemukan → Puppeteer pakai bundled Chromium → crash → PM2 restart → session rusak  
**Solusi:**
- Auto-detect path Chrome Linux di 5 lokasi berbeda
- Filter `Execution context was destroyed` di Global Error Catcher (tidak crash server)
- Disconnect handler: bedakan LOGOUT vs disconnect jaringan

---

### Masalah 2: `TIMEOUT_GET_STATE` False Restart
**Root Cause:** Watchdog health check jalan saat startup sync berat (587 pesan) → WA lambat → dianggap mati → restart → QR lagi  
**Solusi:** `stability.setBusy(15 * 60 * 1000)` sebelum startup sync dimulai

---

### Masalah 3: Hanya W-1 Worker yang Jalan
**Root Cause:** `startProcessing()` punya guard `if (this.isProcessing) return`. Item masuk satu per satu via startup sync → hanya 1 worker spawned → 587 item × 5 detik = 49 menit  
**Solusi:** Ganti ke `spawnWorkers()` idempotent dipanggil dari `addToQueue()` langsung

---

### Masalah 4: Disk Penuh 100% (30GB/30GB)
**Root Cause:** Cleanup hanya hapus status `VALIDATED` — `SUDAH_KIRIM_FOTO` tidak pernah dihapus → menumpuk berbulan-bulan  
**Solusi:**
1. Cleanup v3 dengan raw SQLite (supabase_shim tidak support chaining)
2. Tambah TIER-1 untuk `SUDAH_KIRIM_FOTO`
3. Crisis mode: disk > 90% → threshold 1 hari

---

### Masalah 5: Disk Guard Spam Loop
**Root Cause:** Cleanup dipanggil setiap foto masuk → log flooding CPU waste  
**Solusi:** `global._lastDiskCleanupTime` cooldown 5 menit

---

### Masalah 6: `unknown` Message Type Spam
**Root Cause:** LID network metadata dikirim sebagai tipe `unknown` → diproses penuh (DB, AI call, dll)  
**Solusi:** Tambah `'unknown'` ke `BLOCKED_TYPES` array

---

### Masalah 7: Groq API Rate Limit 429 Spam
**Root Cause:** Error 429 muncul setiap pesan masuk → log spam → token habis sia-sia  
**Solusi:** `_aiRateLimitUntil` timestamp + parse retry-after format `Xm Y.Zs`

---

### Masalah 8: Media Tidak Muncul (DEADLOCK)
**Root Cause:**
```
Disk 95% → Disk Guard 92% → DITOLAK
Cleanup → 0 file dihapus (foto < 1 hari)
= Deadlock permanen
```
**Solusi:**
1. Threshold Disk Guard: 92% → 96% (disk 95% = **diterima**)
2. Sharp compression: foto 2-5MB → 300-500KB (hemat 80%)

---

### Masalah 9: Chrome Crash dari Overload Media
**Root Cause:** 15 worker download serentak → 15 tab Chrome → RAM habis → crash  
**Solusi:** Chrome Semaphore — max 5 operasi Chrome serentak

---

### Masalah 10: WhatsApp Disconnect Harian
**Root Cause:** Kombinasi `webVersionCache` URL 404 + `dataPath` konflik  
**Solusi:** Hapus `webVersionCache` dan `dataPath` dari Puppeteer config

---

## Konfigurasi Environment (.env)

```env
# ── SERVER ──────────────────────────────────────────
PORT=3001
PUBLIC_API_URL=https://api-wa.parecustom.com

# ── AI BOT ──────────────────────────────────────────
GROQ_API_KEY=gsk_xxx...          # Groq API Key (100k token/hari gratis)
OPENAI_API_KEY=sk-xxx...         # OpenAI (opsional, fallback)

# ── GOOGLE SHEETS ───────────────────────────────────
GOOGLE_SHEETS_API_KEY=AIzaSy...  # Google Cloud Console → Enable Sheets API
SPREADSHEET_VENTURA=1boeBFow...  # ID dari URL spreadsheet
SPREADSHEET_GIFTYOURS=1xZyKPg...
SPREADSHEET_CUSTOMBASE=1etNKBp...

# ── GOOGLE DRIVE ────────────────────────────────────
GOOGLE_DRIVE_FOLDER_ID=19jxzRf... # Folder ID root di Google Drive
GOOGLE_SERVICE_ACCOUNT_KEY=./service-account.json

# ── OBJECT STORAGE (Opsional) ───────────────────────
OBJECT_STORAGE_ENDPOINT=https://is3.cloudhost.id
OBJECT_STORAGE_REGION=sgp1
OBJECT_STORAGE_BUCKET=crm-media
OBJECT_STORAGE_ACCESS_KEY=xxx
OBJECT_STORAGE_SECRET_KEY=xxx
OBJECT_STORAGE_PUBLIC_URL=https://crm-media.is3.cloudhost.id

# ── MEDIA QUEUE ─────────────────────────────────────
MEDIA_WORKERS=5                  # VPS 2GB RAM = 5, VPS 8GB = 10
MEDIA_MAX_QUEUE=300              # Max item di antrian (buang yang lebih lama)

# ── SECURITY (WAJIB diisi) ──────────────────────────
JWT_SECRET=random_string_panjang_minimal_32_karakter
ADMIN_EMAIL=admin@email.com
ADMIN_PASSWORD=password_kuat

# ── CHROME (Opsional) ───────────────────────────────
CHROME_PATH=/usr/bin/google-chrome-stable  # Override path Chrome manual
```

---

## PM2 Process Management

### Konfigurasi `ecosystem.config.js`
```javascript
{
  name: 'WA-Engine',
  script: './index.js',
  max_memory_restart: '1500M',   // Restart jika RAM > 1.5GB
  cron_restart: '0 3 * * *',    // Restart bersih jam 03:00 pagi
  autorestart: true,
  max_restarts: 10,
  min_uptime: '30s',
  restart_delay: 10000,          // Tunggu 10s sebelum restart
  NODE_OPTIONS: '--max-old-space-size=1024'  // V8 heap limit 1GB
}
```

### Penjadwalan Internal (Node.js cron)
| Waktu | Tugas |
|:---|:---|
| **Setiap jam** (`:00`) | Disk Monitor — cleanup darurat jika disk > 90% |
| **02:00 pagi** | The Janitor — cleanup rutin foto lama |
| **03:00 pagi** | PM2 restart bersih (dari ecosystem.config.js) |

---

## Perintah Operasional VPS

### Deploy Update Kode
```bash
cd ~/tools-crm
git pull origin main
cd backend && npm install && cd ..
pm2 reload WA-Engine-Bot --update-env
pm2 logs WA-Engine-Bot --lines 30
```

### Monitoring
```bash
pm2 status                        # Status semua proses
pm2 logs WA-Engine-Bot --lines 50 # Lihat log real-time
pm2 monit                         # Dashboard CPU/RAM real-time
df -h /                           # Cek penggunaan disk
du -sh ~/tools-crm/backend/uploads/* | sort -rh | head -20  # Folder terbesar
```

### Cleanup Darurat (Disk Penuh)
```bash
# 1. Bersihkan cache sistem
apt-get clean && apt-get autoremove -y
pm2 flush
rm -f ~/.pm2/logs/*.log

# 2. Jalankan The Janitor manual (crisis mode)
cd ~/tools-crm
node backend/services/cleanup_service.js

# 3. Cek disk
df -h /
```

### Scan QR WhatsApp (jika perlu)
```bash
pm2 stop WA-Engine-Bot
pm2 start WA-Engine-Bot --update-env
pm2 logs WA-Engine-Bot --lines 5
# QR muncul di terminal — scan dengan HP
```

---

## Alur Sistem End-to-End

### Flow 1: Customer Baru Kirim Pesan
```
1. Customer kirim "halo" ke WA bot
2. processMessageCommand() dipanggil
   → Shield check (bukan grup, bukan unknown, bukan status)
   → Buat record customer di SQLite (status: BELUM_KIRIM_FOTO)
   → Simpan pesan ke messages table
3. checkAndRespond() — AI Bot
   → Cek is_enabled dari ai_config
   → Jika aktif: generate reply via Groq Llama 3.3 70B
   → Kirim pesan tagih nomor pesanan
4. Customer balas dengan nomor pesanan (18 digit)
5. lookupOrder() — Cek ke 3 spreadsheet
   → DITEMUKAN: update DB + kirim detail pesanan + minta foto
   → TIDAK DITEMUKAN: beritahu customer
6. Customer kirim foto
7. MediaQueueService.addToQueue()
   → spawnWorkers() → 5-15 worker paralel
   → Download foto dari WA
   → Sharp compress (2-5MB → 300-500KB)
   → Simpan ke disk lokal
   → Upload ke Object Storage (jika aktif)
   → Upload ke Google Drive (hierarki folder)
   → Update status customer → SUDAH_KIRIM_FOTO
8. checkAndRespondMedia() — konfirmasi cukup/kurang
```

### Flow 2: Startup Recovery (Server Restart)
```
1. Chrome ditemukan → /usr/bin/google-chrome-stable
2. WhatsApp session loaded dari LocalAuth cache
3. stability.setBusy(15 menit) — pause Watchdog
4. getChats() → loop semua chat 48 jam terakhir
   → Delay 500ms/chat (tidak rate-limit WA)
   → fetchMessages() timeout 45s (graceful skip jika gagal)
   → Setiap pesan di-process via processMessageCommand()
5. MediaQueueService healing: re-antri media yang belum ada di DB
6. stability.setBusy habis → Watchdog aktif kembali
```

---

## Monitoring & Troubleshooting

### Log Normal yang Diharapkan
```
[PUPPETEER] ✅ Menggunakan browser: /usr/bin/google-chrome-stable
[MEDIA-QUEUE] 🗜️ Sharp image processor siap (kompresi aktif).
[WATCHDOG] 🛡️ Monitoring dimulai. Threshold: 45 menit.
[WATCHDOG] 🔄 Mode BUSY aktif selama 15 menit (health check di-pause).
[SYNC] 🕐 Menyinkronkan pesan sejak: X hari lalu | Total chat: 450
[SYNC] ✅ Selesai! Diproses: 1234 pesan | Dilewati: 398 chat lama | Error: 3 chat
[W-1] 🗜️ Kompres: 3200KB → 380KB (hemat 88%, -2820KB)
[DISK-MONITOR] ✅ Disk 72% — dalam batas aman.
🧹 The Janitor dijadwalkan: cleanup rutin jam 02:00 pagi.
💾 Disk Monitor aktif: cek tiap jam, cleanup darurat otomatis jika >90%.
```

### Log Peringatan (Perlu Perhatian)
| Log | Arti | Tindakan |
|:---|:---|:---|
| `[DISK-GUARD] 🚨 Disk 96%!` | Disk hampir penuh | Jalankan cleanup manual |
| `[AI-BOT] 🚫 Groq Rate Limit 429!` | Token harian habis | Tunggu auto-cooldown, atau upgrade ke Groq Dev |
| `[WATCHDOG] ⚠️ Engine STALE` | Tidak ada aktivitas 45 menit (jam aktif) | Cek apakah WA terputus |
| `[W-x] ⚠️ Kompres gagal, simpan asli` | File foto corrupt | Normal, foto tetap tersimpan |

### Log Kritis (Harus Ditangani)
| Log | Arti | Tindakan |
|:---|:---|:---|
| `[WATCHDOG] 🔥 Restart otomatis` | WA tidak responsif | Cek PM2 logs setelah restart |
| `[FATAL] Gagal inisialisasi WA` | Chrome crash total | `pm2 restart WA-Engine-Bot` |
| `Disk 100% (0B free)` | VPS penuh total | Segera cleanup atau upgrade disk |

---

## Commit History

| Commit | Perubahan |
|:---|:---|
| `28fc799` | feat: Integrasi 3-store spreadsheet lookup + photo tracking |
| `5de9eb3` | fix: 4 bug produksi kritis |
| `0771644` | fix(vps): QR scan loop + execution context crashes |
| `f9379e6` | fix(disk): Cleanup service v2 + disk monitor |
| `87289e7` | fix(cleanup): Tulis ulang v3 pakai raw SQLite |
| `4537e3f` | fix(queue): Concurrent worker pool bug (hanya W-1) |
| `570f1f8` | hardening: Bulletproof — setBusy, startup sync, disk guard |
| `b3cd25a` | fix: Spam log + rate limit + unknown filter |
| `cac84f9` | fix(urgent): Media tidak muncul — sharp compression + threshold 96% |
| `34b7d04` | fix: Chrome Semaphore — concurrency 15→3+semaphore |
| `d069a01` | hotfix: Hapus webVersionCache yang menyebabkan LOGOUT loop |
| `b7101c0` | fix: Eliminasi WhatsApp disconnect harian (7 perbaikan) |
| `4935ad0` | feat: Object Storage + PendingOrderQueue |
| `ca527bc` | feat: Google Drive integration + customer naming |
| `04bdb54` | feat: OAuth2 untuk Drive + queue v5 |
| `bb0be93` | feat: PM2 production config (ecosystem.config.js) |

---

## Catatan Penting

> [!IMPORTANT]
> **Jangan pernah hapus folder `~/.wwebjs_auth/`** — ini adalah session WhatsApp. Jika terhapus, harus scan QR ulang.

> [!WARNING]
> **Jika disk > 96%**: Media akan ditolak sementara. Jalankan `node backend/services/cleanup_service.js` manual untuk bebaskan ruang.

> [!TIP]
> **Groq Rate Limit**: Tier gratis = 100.000 token/hari. Jika bot sering 429, pertimbangkan upgrade ke Groq Dev (berbayar, limit lebih tinggi) atau tambah `OPENAI_API_KEY` sebagai fallback.

> [!NOTE]
> **Object Storage**: Sangat dianjurkan untuk volume foto tinggi. Foto di-upload ke cloud → lokal dihapus otomatis oleh TIER-0 cleanup → disk tidak pernah penuh.

---

*Dokumentasi dibuat otomatis dari analisis sesi 6-9 Mei 2026*
