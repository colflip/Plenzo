const logger = require('../utils/logger.js');
const express = require('express');
const router = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/auth');
const db = require('../db/db');
const SchemaHelper = require('../utils/schema-helper');
const { successResponse } = require('../utils/response');
const { AppError } = require('../middleware/error');

// 获取所有用户或根据类型过滤用户（仅管理员）
router.get('/', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { type } = req.query;
        
        if (!type) {
            // 获取所有类型的用户
            // 若存在 status 列则排除删除账号，否则直接返回
            let teachersSql = "SELECT id, name, username, 'teacher' as type FROM teachers";
            let studentsSql = "SELECT id, name, username, 'student' as type FROM students";
            try {
                const [tHasStatus, sHasStatus] = await Promise.all([
                    SchemaHelper.hasColumn('teachers', 'status'),
                    SchemaHelper.hasColumn('students', 'status')
                ]);
                if (tHasStatus) teachersSql += ' WHERE status != -1';
                if (sHasStatus) studentsSql += ' WHERE status != -1';
            } catch(_) {}
            // 三条 SELECT 互不依赖，并发省两次往返（每条约 250ms）
            const [teachersResult, studentsResult, adminsResult] = await Promise.all([
                db.query(teachersSql),
                db.query(studentsSql),
                db.query('SELECT id, name, username, \'admin\' as type FROM administrators')
            ]);
            
            const allUsers = [...teachersResult.rows, ...studentsResult.rows, ...adminsResult.rows];

            res.json(successResponse({ users: allUsers }));
        } else if (type === 'teacher') {
            // 只获取教师用户
            const result = await db.query('SELECT id, name, username, email, phone, subject FROM teachers');

            res.json(successResponse({ users: result.rows }));
        } else if (type === 'student') {
            // 只获取学生用户
            const result = await db.query('SELECT id, name, username, email, phone, grade FROM students');

            res.json(successResponse({ users: result.rows }));
        } else {
            return next(new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '无效的用户类型' }));
        }
    } catch (error) {
        logger.error('获取用户列表错误:', error);
        return next(error);
    }
});

module.exports = router;
