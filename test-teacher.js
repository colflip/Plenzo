const tc = require('./src/server/controllers/teacherController');
const req = { query: { startDate: '2026-02-16', endDate: '2026-02-22' }, user: { id: 40 } };
const res = { json: console.log, status: (code) => ({ json: (data) => console.log(code, data) }) };
tc.getSchedules(req, res).catch(console.error);
