const db = require('better-sqlite3')('./database.sqlite');
const info = db.prepare("UPDATE drive_upload_queue SET product_abbr = 'POLAROID' WHERE product_abbr = 'LAINNYA'").run();
console.log('Fixed ' + info.changes + ' rows');
