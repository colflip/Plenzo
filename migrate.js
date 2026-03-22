const neon = require('@neondatabase/serverless').neon;

const connectionString = 'postgresql://neondb_owner:npg_pDu8R7LkAwiv@ep-patient-bird-a1hf50t1.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';

async function run() {
  try {
    const sql = neon(connectionString);
    await sql`ALTER TABLE course_arrangement ADD COLUMN IF NOT EXISTS is_temp SMALLINT;`;
    console.log('Migration OK');
  } catch (err) {
    console.error('Migration failed:', err.message);
  } finally {
    process.exit(0);
  }
}
run();
