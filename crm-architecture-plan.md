# Arsitektur & Perencanaan Proyek CRM WhatsApp Polaroid

Dokumen ini berisi perencanaan sistem untuk MVP (Minimum Viable Product) Web based CRM WhatsApp yang difokuskan pada pengelolaan order cetak foto polaroid.

---

## 1. Keterbatasan Integrasi WhatsApp di Vercel (SANGAT PENTING)
Sesuai aturan operasional, ada keterbatasan arsitektur yang **wajib dipahami** jika aplikasi frontend ingin menggunakan Vercel:
* **Vercel adalah Environment Serverless:** Artinya, API dan fungsi backend yang di-deploy ke Vercel hanya hidup maksimal sekitar 10-60 detik saat ada request masuk.
* **Cara Kerja WhatsApp Web Library (`whatsapp-web.js`):** Library ini butuh menjalankan instance browser headless (Puppeteer) secara **24/7 di background** (websocket) untuk mempertahankan sesi login dan menerima chat secara real-time.
* **Kesimpulan:** Engine bot WhatsApp **TIDAK BISA** dan **TIDAK BOLEH** disatukan dengan backend Vercel (Next.js API).

**Solusi Arsitektur Realistis (MVP):**
1. **Frontend UI & Dashboard Admin:** Gunakan **Next.js** dan deploy di **Vercel**.
2. **Database & Storage Media:** Gunakan **Supabase** (PostgreSQL).
3. **WhatsApp Engine (Micro-service kecil):** Buat satu server kecil **Node.js** khusus untuk `whatsapp-web.js` dan deploy ke Platform yang mendukung running 24/7 secara murah/gratis (misalnya **Railway**, **Render**, atau VPS lokal).

---

## 2. Rekomendasi Tech Stack
* **Frontend:** Next.js (App Router), TailwindCSS, TypeScript (Mudah, stabil, build otomatis di Vercel).
* **Database & File Storage:** Supabase (Gratis di tier awal, fitur Realtime DB sangat berguna untuk chat masuk, dan Storage untuk menyimpan foto base64 yang dikonversi dari WA).
* **WA Engine:** Node.js + Express + `whatsapp-web.js` + `qrcode-terminal` (Hanya fokus terima WA, download media WA, upload ke Supabase).
* **Zipping (Download Multiple):** Library `jszip` di sisi Frontend (Next.js) untuk menggabungkan banyak foto menjadi 1 file ZIP sebelum didownload admin.

---

## 3. Desain Database (Supabase PostgreSQL)

**Tabel `users` (Bawaan Supabase Auth)**
Admin login memakai sistem default login Supabase.

**Tabel `customers` (Data Pelanggan)**
* `id` (UUID, Primary Key)
* `phone_number` (String, Unique)
* `name` (String, nullable — diisi manual oleh admin)
* `order_id` (String, nullable — diisi manual oleh admin)
* `status` (Enum: `BELUM_KIRIM_FOTO`, `SUDAH_KIRIM_FOTO`, `VALIDATED`)
* `is_valid` (Boolean — ditandai jika admin memastikan data tidak ada masalah)
* `created_at` (Timestamp)

**Tabel `messages` (Riwayat Percakapan)**
* `id` (UUID, Primary Key)
* `customer_id` (UUID, Foreign Key)
* `body` (Text - teks chat)
* `is_from_me` (Boolean - chat dari customer atau admin)
* `created_at` (Timestamp)

**Tabel `media` (Galeri Foto Pesanan)**
* `id` (UUID, Primary Key)
* `customer_id` (UUID, Foreign Key)
* `message_id` (UUID, Foreign Key)
* `file_url` (Text - URL foto di Supabase Storage)
* `file_name` (Text)
* `created_at` (Timestamp)

---

## 4. Flow Sistem (Dari Awal s.d Akhir)

1. **Authentication (Login):**
   * Admin membuka web Next.js -> Login menggunakan email & password.
2. **Setup Koneksi WA:**
   * Di dashboard menu "Koneksi", UI Next.js meminta QR Code dari **WA Engine**.
   * WA Engine me-render Base64 QR UI, admin scan menggunakan HP operasional.
   * Status di Dashboard berubah menjadi "Connected".
3. **Handle Chat & Media Masuk:**
   * Customer chat "Halo mau kirim foto" -> *WA Engine* menangkap chat -> Insert phone number ke tabel `customers` (status: `BELUM_KIRIM_FOTO`).
   * (Opsional: WA Engine membalas text bot otomatis petunjuk kirim foto).
   * Customer kirim 25 foto -> *WA Engine* deteksi media -> Extract base64 -> **Upload File ke Supabase Storage** -> Simpan referensi ke tabel `media` dan tabel `messages`, kemudian ubah status customer menjadi `SUDAH_KIRIM_FOTO`.
4. **Validasi oleh Admin:**
   * Admin melihat chat tersebut secara realtime di list UI. Klik chat masuk ke **Chat Detail View**.
   * Admin membaca teks: "Nama: Budi, Order: #1234".
   * Admin memasukkan data tersebut ke Panel Data Customer di sebelah kanan dan klik tombol **Mark as Valid** -> (Status customer diupdate ke `VALIDATED`).
5. **Download Media:**
   * Admin mencentang foto di kolom Gallery (Select All).
   * Admin klik **"Download ZIP"**.
   * Sistem mendownload file gambar dari Supabase menggunakan URL secara batch di browser, melakukan kompres file dengan `jszip`, lalu output berupa file `.zip` siap simpan ke lokal PC admin.

---

## 5. Struktur Folder Project (Next.js)

```text
/
├── src/
│   ├── app/
│   │   ├── (auth)/login/page.tsx     # Halaman Login
│   │   ├── dashboard/
│   │   │   ├── page.tsx              # Inbox / List Chat
│   │   │   ├── [customerId]/page.tsx # Detail Chat + Media Gallery
│   │   │   └── settings/page.tsx     # Halaman Setup QR Code WA
│   │   ├── layout.tsx
│   ├── components/
│   │   ├── layout/Sidebar.tsx
│   │   ├── chat/ChatList.tsx
│   │   ├── chat/ChatBubble.tsx
│   │   ├── media/MediaGallery.tsx
│   │   ├── media/ZipDownloader.tsx
│   ├── lib/
│   │   ├── supabaseClient.ts         # Inisialisasi Auth/DB Supabase
│   │   └── utils.ts
├── .env.local
└── package.json
```

---

## 6. Contoh API Endpoint Penting

Karena data menggunakan integrasi klien langsung ke Supabase, API endpoints kebanyakan hanya diperlukan pada modul **WA Engine (Node.js)**:
* `GET /api/wa/qr` -> Render/ambil status instance WA dan QR Code string base64.
* `GET /api/wa/status` -> Mengecek apakah bot dalam keadaan `connected` atau `disconnected`.
* `POST /api/wa/send-message` -> Untuk Admin membalas pesan teks (atau *Template Balasan Cepat*) dari Next.js UI agar diarahkan menjadi pengiriman via bot WA Engine.

---

## 7. Cara Deploy ke Vercel (Next.js App)

1. Push seluruh kode Next.js (Frontend) ke repositori **GitHub**.
2. Login ke Dashboard Vercel dan buat project baru (**Add New Project**).
3. Hubungkan repositori GitHub, pilih direktori kode.
4. Pada proses konfigurasi, tambahkan **Environment Variables** berikut:
   * `NEXT_PUBLIC_SUPABASE_URL` = URL dari dashboard Supabase
   * `NEXT_PUBLIC_SUPABASE_ANON_KEY` = Kunci Anon dari Supabase
   * `NEXT_PUBLIC_WA_ENGINE_URL` = URL microservice Node.js yang sudah di-deploy di platform lain (seperti Railway/Render/VPS).
5. Klik **Deploy**. Aplikasi akan otomatis di-build dan berjalan stabil.

*Catatan: Sistem WA Nodejs (Microservice) tetap harus berjalan di hosting terpisah (seperti VPS Ubuntu murah $4/bulan) via proses manajer `pm2` untuk kestabilan pembacaan websocket hp secara konstan.*
