require('dotenv').config();
const db = require('./src/server/db/db');
async function test() {
  try {
    const res = await db.query('SELECT transport_fee, other_fee FROM course_arrangement LIMIT 1');
    console.log("DB query Success:", res.rowCount);
  } catch(e) { console.log("DB query Error:", e.message); }
}
test();
