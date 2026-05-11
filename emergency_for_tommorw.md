# Rencana Darurat: Sistem "Sapu Jagat" (Mass Recovery Sync)

Saya sepenuhnya memahami urgensi dan krisis yang terjadi. Karena ada 1000 pelanggan dari 2 hari terakhir yang fotonya berceceran akibat *timeout* dan *spreadsheet* yang terlambat update, melakukan "Gali Ulang" manual satu-per-satu sangatlah mustahil dalam 5 jam.

Kita membutuhkan sebuah **Sistem Sapu Jagat (Mass Recovery)** yang bekerja secara otomatis, akurat, dan sangat hati-hati agar tidak membuat server macet lagi.

## User Review Required
> [!IMPORTANT]
> Fitur ini adalah tombol darurat. Sekali ditekan, mesin akan otomatis:
> 1. Mencari **SEMUA** pelanggan dalam 2 hari terakhir.
> 2. **Menyambung ulang** (Re-validate) ke Google Sheets untuk mengambil Resi & Toko terbaru.
> 3. **Menggali riwayat WA** (Fetch) secara otomatis untuk menarik foto yang tertinggal.
> 4. **Mendorong ke antrean Google Drive**, dengan jaminan **100% Anti-Duplikat** (melewati foto yang sudah `DONE`).
> 
> Proses untuk 1000 pesanan akan memakan waktu sekitar **20 - 30 menit** di *background* karena saya akan memberinya jeda 1 detik per pesanan agar WhatsApp Web tidak *Crash*. Apakah Anda setuju?

## Proposed Changes

### Backend (`backend/index.js`)
#### [MODIFY] `backend/index.js`
- Menambahkan *endpoint* khusus `POST /api/local/emergency-mass-sync`.
- *Endpoint* ini akan menjalankan proses raksasa di *background* yang menyisir 2 hari terakhir.
- Proses menggunakan `chromeSemaphore` dan `sleep(1000)` agar CPU VPS tidak kewalahan.

### Frontend (`frontend/src/app/dashboard/page.tsx`)
#### [MODIFY] `frontend/src/app/dashboard/page.tsx`
- Menambahkan satu tombol merah **"🚨 Darurat: Sapu Jagat (Sinkronisasi Massal 2 Hari Terakhir)"** di halaman utama *Dashboard*.
- Tombol ini hanya bisa ditekan sekali, dan akan menampilkan notifikasi bahwa proses sedang berjalan di *background*.

## Verification Plan
1. Tekan tombol **"🚨 Darurat: Sapu Jagat"**.
2. Anda cukup memantau *Terminal PM2* (`pm2 logs WA-Engine`). Akan ada baris log seperti: `[EMERGENCY] Memproses: 081234... (Order: TK-123)`.
3. Setelah 20-30 menit, periksa Google Drive. Seluruh folder resi akan terbentuk rapi, dan tidak akan ada file duplikat.
