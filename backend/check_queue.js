const db = require('better-sqlite3')('./database.sqlite');
const rows = db.prepare("SELECT status, COUNT(*) as c FROM drive_upload_queue GROUP BY status").all();
console.log('QUEUE STATUS:', rows);
const pending = db.prepare("SELECT c.status as c_status, c.photo_confirmed, duq.status as q_status, COUNT(*) as c FROM drive_upload_queue duq JOIN customers c ON duq.customer_id = c.id WHERE duq.status = 'PENDING' GROUP BY c.status, c.photo_confirmed").all();
console.log('PENDING DETAILS:', pending);
