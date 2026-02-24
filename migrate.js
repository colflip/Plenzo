require('dotenv').config();
const db = require('./src/server/db/db.js');
const fs = require('fs');
const sql = fs.readFileSync('./src/server/db/migrations/20260221_add_fees_and_student_ids.sql', 'utf8');

db.query(sql).then(() => {
    console.log('Migration applied successfully');
    process.exit(0);
}).catch(e => {
    console.error('Migration failed:', e);
    process.exit(1);
});
