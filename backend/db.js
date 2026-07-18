const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

// Enable WAL mode for better concurrency and performance
db.pragma('journal_mode = WAL');
db.pragma('wal_autocheckpoint = 1000'); // Checkpoint otomatis tiap 1000 halaman

// [OPTIMASI] Interval Checkpoint Pasif setiap 15 menit
// Mencegah file WAL membengkak puluhan MB jika load sangat berat dan auto-checkpoint tertunda.
setInterval(() => {
    try {
        db.pragma('wal_checkpoint(PASSIVE)');
    } catch (err) {
        console.error('[DB] Gagal passive checkpoint:', err.message);
    }
}, 15 * 60 * 1000);


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
        excluded_from_production BOOLEAN DEFAULT 0,
        media_kind TEXT DEFAULT 'customer_photo',
        detected_order_id TEXT,
        classification_status TEXT,
        classification_reason TEXT,
        classified_at TEXT,
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

    -- [OPTIMASI PERFORMA]
    -- Index super cepat untuk mencegah Error 500 (Internal Server Error) saat data membesar
    CREATE INDEX IF NOT EXISTS idx_media_customer_id ON media(customer_id);
    CREATE INDEX IF NOT EXISTS idx_messages_customer_id ON messages(customer_id);
    CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
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
if (!mediaColumns.includes('excluded_from_production')) {
    db.exec(`ALTER TABLE media ADD COLUMN excluded_from_production BOOLEAN DEFAULT 0;`);
    console.log('[DB] Migration: Kolom excluded_from_production ditambahkan ke tabel media.');
}
if (!mediaColumns.includes('media_kind')) {
    db.exec(`ALTER TABLE media ADD COLUMN media_kind TEXT DEFAULT 'customer_photo';`);
    console.log('[DB] Migration: Kolom media_kind ditambahkan ke tabel media.');
}
if (!mediaColumns.includes('detected_order_id')) {
    db.exec(`ALTER TABLE media ADD COLUMN detected_order_id TEXT;`);
    console.log('[DB] Migration: Kolom detected_order_id ditambahkan ke tabel media.');
}
if (!mediaColumns.includes('classification_status')) {
    db.exec(`ALTER TABLE media ADD COLUMN classification_status TEXT;`);
    console.log('[DB] Migration: Kolom classification_status ditambahkan ke tabel media.');
}
if (!mediaColumns.includes('classification_reason')) {
    db.exec(`ALTER TABLE media ADD COLUMN classification_reason TEXT;`);
    console.log('[DB] Migration: Kolom classification_reason ditambahkan ke tabel media.');
}
if (!mediaColumns.includes('classified_at')) {
    db.exec(`ALTER TABLE media ADD COLUMN classified_at TEXT;`);
    console.log('[DB] Migration: Kolom classified_at ditambahkan ke tabel media.');
}

db.exec(`
    CREATE INDEX IF NOT EXISTS idx_media_customer_production
        ON media(customer_id, excluded_from_production);

    CREATE TABLE IF NOT EXISTS ai_usage_counters (
        provider   TEXT NOT NULL,
        purpose    TEXT NOT NULL,
        window_key TEXT NOT NULL,
        count      INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (provider, purpose, window_key)
    );
`);
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

// ── [MIGRATION] Kolom resi di tabel customers ───────────────────────────────
// Resi (nomor resi pengiriman) diambil dari spreadsheet kolom AP/AN
if (!existingColumns.includes('resi')) {
    db.exec(`ALTER TABLE customers ADD COLUMN resi TEXT;`);
    console.log('[DB] ✅ Migration: Kolom resi ditambahkan ke tabel customers.');
}

// ── [MIGRATION] Tabel drive_folders — Cache Google Drive folder ID ───────────
// Mencegah pembuatan folder duplikat + mempercepat lookup
db.exec(`
    CREATE TABLE IF NOT EXISTS drive_folders (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        folder_path  TEXT UNIQUE NOT NULL,   -- "VENTURA/POLAROID/JKT123_Polaroid50"
        drive_id     TEXT NOT NULL,          -- Google Drive folder ID
        parent_id    TEXT,                   -- Parent Drive folder ID
        created_at   TEXT DEFAULT (datetime('now'))
    );
`);

// ── [MIGRATION] Tabel drive_upload_queue — Antrian upload foto ke Drive ─────
// Decoupled dari media queue: jika Drive down, media queue tetap jalan
db.exec(`
    CREATE TABLE IF NOT EXISTS drive_upload_queue (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id   TEXT NOT NULL,
        media_id      TEXT,
        file_url      TEXT NOT NULL,
        storage_key   TEXT,
        storage_type  TEXT DEFAULT 'local',
        order_id      TEXT,
        store_name    TEXT,
        resi          TEXT,
        product_abbr  TEXT,
        sku           TEXT,
        photo_index   INTEGER DEFAULT 1,
        customer_phone TEXT,
        status        TEXT DEFAULT 'PENDING',
        retry_count   INTEGER DEFAULT 0,
        max_retries   INTEGER DEFAULT 5,
        error_msg     TEXT,
        drive_file_id TEXT,
        created_at    TEXT DEFAULT (datetime('now'))
    );
`);

// [MIGRATION] Tambah kolom baru ke tabel lama yang sudah ada di VPS
// Kolom photo_index dan customer_phone ditambahkan di v2 — safe migration
// updated_at ditambahkan di v3 untuk healing pass yang lebih akurat
//
// CATATAN KOMPATIBILITAS: SQLite < 3.38 tidak support DEFAULT (expr) di ALTER TABLE.
// Hanya DEFAULT dengan nilai konstan (angka/string literal) yang didukung.
// Solusi: ALTER TABLE tanpa DEFAULT, lalu UPDATE untuk isi nilai awal.
const driveQueueMigrations = [
    { col: 'photo_index',    sql: `ALTER TABLE drive_upload_queue ADD COLUMN photo_index INTEGER DEFAULT 1` },
    { col: 'customer_phone', sql: `ALTER TABLE drive_upload_queue ADD COLUMN customer_phone TEXT` },
    {
        col: 'updated_at',
        // [FIX] Tanpa DEFAULT expr — kompatibel semua versi SQLite
        sql: `ALTER TABLE drive_upload_queue ADD COLUMN updated_at TEXT`,
        // Setelah kolom ditambah, isi dengan nilai created_at untuk row lama
        postSql: `UPDATE drive_upload_queue SET updated_at = created_at WHERE updated_at IS NULL`,
    },
];
for (const m of driveQueueMigrations) {
    try {
        const cols = db.prepare(`PRAGMA table_info(drive_upload_queue)`).all();
        const exists = cols.some(c => c.name === m.col);
        if (!exists) {
            db.prepare(m.sql).run();
            if (m.postSql) db.prepare(m.postSql).run();
            console.log(`[DB] ✅ Migration: kolom '${m.col}' ditambahkan ke drive_upload_queue`);
        }
    } catch (e) {
        console.warn(`[DB] ⚠️ Migration '${m.col}' skip:`, e.message);
    }
}


// [INDEX] Tambah index untuk updated_at agar healing query cepat
try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_drive_queue_status_updated ON drive_upload_queue(status, updated_at)`);
} catch (e) { /* index mungkin sudah ada */ }

module.exports = db;
