const db = require('./src/server/db/db.js');
async function run() {
  try {
    await db.query('ALTER TABLE course_arrangement ADD COLUMN IF NOT EXISTS is_temp SMALLINT;');
    console.log('Migration OK');
  } catch (err) {
    console.error('Migration failed:', err.message);
  } finally {
    process.exit(0);
  }
}
run();
