require('dotenv').config();
const neon = require('@neondatabase/serverless').neon;

const connectionString = process.env.DATABASE_URL;

async function run() {
  if (!connectionString) {
    console.error('Migration failed: DATABASE_URL is not set in environment (.env)');
    process.exit(1);
  }
  try {
    const sql = neon(connectionString);
    await sql`ALTER TABLE course_arrangement ADD COLUMN IF NOT EXISTS is_temp SMALLINT;`;
    console.log('Migration OK');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}
run();
