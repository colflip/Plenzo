require('dotenv').config();
const db = require('./src/server/db/db');
const tc = require('./src/server/controllers/teacherController');

async function run() {
  try {
    const req = {
      query: { startDate: '2026-02-16', endDate: '2026-02-22' },
      user: { id: 40 }
    };
    const res = {
      json: (data) => console.log('SUCCESS JSON length:', data.length),
      status: (code) => {
        console.log('STATUS:', code);
        return { json: (data) => console.log('ERROR JSON:', data) };
      }
    };
    await tc.getSchedules(req, res);
  } catch(e) { console.error('CRASH:', e); }
}

run().then(() => process.exit(0));
