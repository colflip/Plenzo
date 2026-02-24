const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_1fR4mGohFHzb@ep-mute-bird-a18z9bap-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require');
async function test() {
  try {
    const r = await sql`SELECT 1 as num`;
    console.log('DB SUCCESS:', r);
  } catch (e) {
    console.error('DB ERROR:', e);
  }
}
test();
