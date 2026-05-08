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
        id           TEXT PRIMARY KEY,
        customer_id  TEXT NOT NULL,
        message_id   TEXT,
        file_url     TEXT NOT NULL,
        file_name    TEXT,
        storage_key  TEXT,  -- Key/path di object storage (sama dengan file_name)
        storage_type TEXT DEFAULT 'local',  -- 'object' atau 'local'
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
        FOREIGN KEY (message_id)  REFERENCES messages(id)  ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pending_orders (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id  TEXT    NOT NULL,
        order_id     TEXT    NOT NULL UNIQUE,  -- UNIQUE wajib agar ON CONFLICT(order_id) di UPSERT berfungsi
        phone_number TEXT    NOT NULL,
        retry_count  INTEGER DEFAULT 0,
        max_retries  INTEGER DEFAULT 6,
        last_retry_at TEXT,
        resolved_at   TEXT,
        created_at    TEXT DEFAULT (datetime('now'))
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

// ── [MIGRATION] Kolom storage_key & storage_type di tabel media ──────────────
const mediaColumns = db.prepare('PRAGMA table_info(media)').all().map(c => c.name);
if (!mediaColumns.includes('storage_key')) {
    db.exec(`ALTER TABLE media ADD COLUMN storage_key TEXT;`);
    console.log('[DB] ✅ Migration: Kolom storage_key ditambahkan ke tabel media.');
}
if (!mediaColumns.includes('storage_type')) {
    db.exec(`ALTER TABLE media ADD COLUMN storage_type TEXT DEFAULT 'local';`);
    console.log('[DB] ✅ Migration: Kolom storage_type ditambahkan ke tabel media.');
}

// ── [MIGRATION] Fix pending_orders: tambah UNIQUE constraint pada order_id ───
// SQLite tidak support ALTER TABLE ADD UNIQUE, jadi harus rebuild tabel.
// Tanpa UNIQUE: ON CONFLICT(order_id) di UPSERT akan ERROR.
try {
    const poColumns = db.prepare('PRAGMA index_list(pending_orders)').all();
    const hasUnique = poColumns.some(idx =>
        idx.unique === 1 && !idx.name.startsWith('idx_pending') && !idx.name.startsWith('sqlite_autoindex')
    );
    // Cek apakah sudah ada column-level UNIQUE (sqlite_autoindex_pending_orders_1)
    const hasAutoIndex = poColumns.some(idx => idx.name.includes('autoindex'));
    
    if (!hasAutoIndex) {
        console.log('[DB] 🔄 Migration: Rebuilding pending_orders dengan UNIQUE(order_id)...');
        db.exec(`
            ALTER TABLE pending_orders RENAME TO pending_orders_old;
            CREATE TABLE pending_orders (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id  TEXT    NOT NULL,
                order_id     TEXT    NOT NULL UNIQUE,
                phone_number TEXT    NOT NULL,
                retry_count  INTEGER DEFAULT 0,
                max_retries  INTEGER DEFAULT 6,
                last_retry_at TEXT,
                resolved_at   TEXT,
                created_at    TEXT DEFAULT (datetime('now'))
            );
            INSERT OR IGNORE INTO pending_orders 
                (id, customer_id, order_id, phone_number, retry_count, max_retries, last_retry_at, resolved_at, created_at)
                SELECT id, customer_id, order_id, phone_number, retry_count, max_retries, last_retry_at, resolved_at, created_at
                FROM pending_orders_old;
            DROP TABLE pending_orders_old;
        `);
        console.log('[DB] ✅ Migration: pending_orders rebuilt dengan UNIQUE(order_id).');
    }
} catch (e) {
    // Tabel mungkin sudah benar, atau belum ada — abaikan
    if (!e.message.includes('no such table')) {
        console.warn('[DB] ⚠️ Migration pending_orders:', e.message);
    }
}

module.exports = db;

