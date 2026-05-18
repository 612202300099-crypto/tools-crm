# 🐛 BUG REPORT — Kirimfoto CRM

**Last Updated:** 2026-05-18  
**Status:** ✅ Semua bug kritis sudah diperbaiki

---

## Bug #1 — Drive Upload Berhenti Saat WA Disconnect ✅ FIXED

**File:** `backend/index.js` (cron Drive upload)  
**Root Cause:** Guard `if (!isConnected) return` menyebabkan cron Drive berhenti saat WA disconnect/restart. Padahal Drive upload menggunakan Google API (OAuth2/Service Account) — TIDAK membutuhkan WA connected.  
**Fix:** Hapus guard. Drive cron sekarang berjalan setiap 30 detik tanpa syarat koneksi WA.

---

## Bug #2 — Regex Nomor Pesanan Inkonsisten ✅ FIXED

**File:** `backend/index.js` (Emergency Mass Sync, line ~237), `ai_followup_service.js`  
**Root Cause:** Emergency sync pakai `\b\d{10,20}\b` (bisa tangkap nomor HP 12 digit), sedangkan deteksi realtime pakai `\b(\d{14,20})\b`.  
**Fix:** Dibuat utility terpusat `backend/utils/orderIdUtils.js` dengan regex baku `\b(\d{14,20})\b`. Semua tempat kini import dari sana.

---

## Bug #3 — UPLOADING Stuck Terlalu Lama ✅ FIXED

**File:** `backend/services/google_drive_service.js` (healing pass)  
**Root Cause:** Healing menggunakan `created_at < datetime('now', '-1 hours')`. Item yang baru mulai `UPLOADING` bisa terheal setelah 1 jam meski masih diproses. Juga, `updated_at` tidak pernah diupdate saat status berubah.  
**Fix:**
- Tambah kolom `updated_at` ke `drive_upload_queue` via migration di `db.js`
- Semua perubahan status (`UPLOADING`, `DONE`, `FAILED`, `PENDING`) kini update `updated_at`
- Healing pakai `COALESCE(updated_at, created_at) < datetime('now', '-30 minutes')` (30 menit, bukan 1 jam)

---

## Bug #4 — Nomor Pesanan di Pesan Lama Tidak Terdeteksi ✅ FIXED

**File:** `backend/index.js` (endpoint `/api/wa/resync`)  
**Root Cause:** Saat "Gali Ulang", semua pesan diproses dengan `skipCustomerUpdate=true`, sehingga AI bot tidak mendeteksi nomor pesanan dari pesan lama.  
**Fix:** Setelah loop resync selesai, ada **Post-Resync Order Detection Pass** yang scan semua pesan text tersimpan untuk customer tersebut. Jika ditemukan order ID → langsung lookup spreadsheet → update customer → release foto WAITING_RESI ke PENDING.

---

## Bug #5 — Race Condition Duplikat Customer

**Status:** 🔄 Mitigated by `INSERT OR IGNORE` pattern (sudah ada).

---

## Bug #6 — Gali Ulang Hanya 1500 Pesan

**File:** `backend/index.js` (endpoint `/api/wa/resync`)  
**Status:** ✅ FIXED di sesi sebelumnya — deep pagination sudah diimplementasikan.

---

## Bug #7 — Komentar Menyesatkan `photo_confirmed` ✅ FIXED

**File:** `backend/services/google_drive_service.js`  
**Fix:** Komentar yang menyebut `photo_confirmed` diganti dengan penjelasan yang benar tentang perilaku sistem.

---

## 🆕 Fitur Baru yang Ditambahkan

### Auto-Sweep Cron (setiap 4 jam)
- **File:** `backend/index.js` (cron baru `0 */4 * * *`)
- Setiap 4 jam, sweep semua chat aktif dalam 24 jam terakhir
- Anti-spam: `skipCustomerUpdate=true`, priority rendah (3)
- Hanya jalan jika WA connected dan tidak BUSY

### Auto Spreadsheet Lookup saat Admin Update Order ID
- **File:** `backend/api.js` (PUT `/customers/:id`)
- Ketika admin isi order_id manual → otomatis cari di spreadsheet
- Jika ditemukan: update resi + store_name + lepas foto WAITING_RESI ke Drive

### Drive Stats Endpoint
- **File:** `backend/api.js` (`GET /api/local/drive-stats`)
- Return jumlah PENDING, WAITING_RESI, UPLOADING, DONE, FAILED

### Session Reset Endpoint (untuk ganti nomor WA)
- **File:** `backend/api.js` (`POST /api/local/wa/reset-session`)
- Hapus folder `.wwebjs_auth/` lama, trigger restart, minta QR baru
- Tersedia di dashboard sebagai tombol "Reset WA"

### Dashboard: Drive Stats Widget
- **File:** `frontend/src/app/dashboard/page.tsx`
- Widget real-time yang polling setiap 30 detik
- Tampilkan PENDING, WAITING_RESI, UPLOADING, DONE, FAILED dengan warna

### Dashboard: Tombol Reset WA Session
- **File:** `frontend/src/app/dashboard/page.tsx`
- Tombol "Reset WA" di header dashboard
- Untuk ganti nomor WA tanpa perlu akses SSH manual

---

## Files yang Dimodifikasi

| File | Perubahan |
|------|-----------|
| `backend/utils/orderIdUtils.js` | **[NEW]** Unified regex utility |
| `backend/db.js` | Migration kolom `updated_at` + index |
| `backend/services/google_drive_service.js` | Healing fix, updated_at tracking |
| `backend/services/ai_followup_service.js` | Import orderIdUtils |
| `backend/index.js` | Bug1, Bug2, Bug4, Auto-sweep |
| `backend/api.js` | Auto-lookup, drive-stats, session reset |
| `frontend/.../dashboard/page.tsx` | Drive stats widget, reset WA button |
