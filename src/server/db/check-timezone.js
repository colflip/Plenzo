const db = require('../db');

async function checkTimeZone() {
  const result = await db.query('SHOW timezone');
  console.log('当前时区设置:', result.rows[0]);
  
  const time = await db.query('SELECT NOW()');
  console.log('当前数据库时间:', time.rows[0]);
}

checkTimeZone().catch(console.error);