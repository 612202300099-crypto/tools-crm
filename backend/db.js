const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

// Enable WAL mode for better concurrency and performance
db.pragma('journal_mode = WAL');

// Initialize schema — Tabel utama
db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        phone_number TEXT UNIQUE NOT NULL,
        name TEXT,
        order_id TEXT,
        status TEXT DEFAULT 'BELUM_KIRIM_FOTO',
        is_valid BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        wa_id TEXT,
        body TEXT,
        is_from_me BOOLEAN DEFAULT 0,
        message_hash TEXT UNIQUE,
        is_deleted BOOLEAN DEFAULT 0,
        deleted_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        message_id TEXT,
        file_url TEXT NOT NULL,
        file_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_config (
        id INTEGER PRIMARY KEY,
        is_enabled BOOLEAN DEFAULT 1,
        system_prompt TEXT,
        order_image_url TEXT,
        post_order_message TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO ai_config (id, is_enabled) VALUES (1, 1);
`);

// ── [MIGRATION] Tambah kolom baru untuk fitur Spreadsheet Integration ──────────
// Menggunakan ALTER TABLE yang aman (tidak error jika kolom sudah ada)
const existingColumns = db.prepare("PRAGMA table_info(customers)").all().map(c => c.name);

if (!existingColumns.includes('store_name')) {
    db.exec(`ALTER TABLE customers ADD COLUMN store_name TEXT;`);
    console.log('[DB] ✅ Migration: Kolom store_name ditambahkan ke tabel customers.');
}
if (!existingColumns.includes('order_detail')) {
    db.exec(`ALTER TABLE customers ADD COLUMN order_detail TEXT;`);
    console.log('[DB] ✅ Migration: Kolom order_detail ditambahkan ke tabel customers.');
}
if (!existingColumns.includes('required_photos')) {
    db.exec(`ALTER TABLE customers ADD COLUMN required_photos INTEGER DEFAULT 0;`);
    console.log('[DB] ✅ Migration: Kolom required_photos ditambahkan ke tabel customers.');
}
if (!existingColumns.includes('photo_confirmed')) {
    db.exec(`ALTER TABLE customers ADD COLUMN photo_confirmed BOOLEAN DEFAULT 0;`);
    console.log('[DB] ✅ Migration: Kolom photo_confirmed ditambahkan ke tabel customers.');
}
if (!existingColumns.includes('photo_followup_count')) {
    db.exec(`ALTER TABLE customers ADD COLUMN photo_followup_count INTEGER DEFAULT 0;`);
    console.log('[DB] ✅ Migration: Kolom photo_followup_count ditambahkan ke tabel customers.');
}

module.exports = db;
