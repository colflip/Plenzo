const express = require('express');
const router = express.Router();
const db = require('../db/db');

// 数据库健康检查
router.get('/db', async (req, res) => {
  try {
    const result = await db.query('SELECT 1 as ok');
    if (result && result.rows && result.rows[0] && result.rows[0].ok === 1) {
      return res.json({ ok: true });
    }
    return res.status(500).json({ ok: false, message: '数据库查询异常' });
  } catch (error) {
    const code = error && error.code ? String(error.code) : undefined;
    return res.status(503).json({ ok: false, code, message: '数据库不可用', detail: error.message });
  }
});

module.exports = router;