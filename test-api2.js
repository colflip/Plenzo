const fs = require('fs');
const path = require('path');
process.env.DATABASE_URL = "postgresql://neondb_owner:npg_1fR4mGohFHzb@ep-mute-bird-a18z9bap-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const tc = require('./src/server/controllers/teacherController.js');

async function run() {
  try {
    const req = {
      query: { startDate: '2026-02-16', endDate: '2026-02-22' },
      user: { id: 40 }
    };
    const res = {
      json: (data) => console.log('SUCCESS JSON', data.length),
      status: (code) => {
        console.log('STATUS:', code);
        return { json: (data) => console.log('ERROR JSON:', data) };
      }
    };
    
    // Patch console.error to see the actual error
    const oldErr = console.error;
    console.error = (...args) => {
        console.log("CAUGHT BY CONSOLE.ERROR:", ...args);
    };
    
    await tc.getSchedules(req, res);
  } catch(e) { console.log('CRASH:', e); }
}

run().then(() => process.exit(0));
