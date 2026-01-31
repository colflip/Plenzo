const express = require('express');
const router = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/auth');
const db = require('../db/db');

// 获取所有用户或根据类型过滤用户
router.get('/', authMiddleware, async (req, res) => {
    try {
        const { type } = req.query;
        
        if (!type) {
            // 获取所有类型的用户
            // 若存在 status 列则排除删除账号，否则直接返回
            let teachersSql = "SELECT id, name, username, 'teacher' as type FROM teachers";
            let studentsSql = "SELECT id, name, username, 'student' as type FROM students";
            try {
                const tCols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='teachers' AND column_name='status'`);
                const sCols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='students' AND column_name='status'`);
                if ((tCols.rows || []).length > 0) teachersSql += ' WHERE status != -1';
                if ((sCols.rows || []).length > 0) studentsSql += ' WHERE status != -1';
            } catch(_) {}
            const teachersResult = await db.query(teachersSql);
            const studentsResult = await db.query(studentsSql);
            const adminsResult = await db.query('SELECT id, name, username, \'admin\' as type FROM administrators');
            
            const allUsers = [...teachersResult.rows, ...studentsResult.rows, ...adminsResult.rows];
            
            res.json({
                success: true,
                users: allUsers
            });
        } else if (type === 'teacher') {
            // 只获取教师用户
            const result = await db.query('SELECT id, name, username, email, phone, subject FROM teachers');
            
            res.json({
                success: true,
                users: result.rows
            });
        } else if (type === 'student') {
            // 只获取学生用户
            const result = await db.query('SELECT id, name, username, email, phone, grade FROM students');
            
            res.json({
                success: true,
                users: result.rows
            });
        } else {
            return res.status(400).json({
                success: false,
                message: '无效的用户类型'
            });
        }
    } catch (error) {
        console.error('获取用户列表错误:', error);
        res.status(500).json({
            success: false,
            message: '服务器错误'
        });
    }
});

module.exports = router;
