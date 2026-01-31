/**
 * 统计数据控制器
 * @description 提供管理员、教师、学生的各类统计数据查询
 */

const db = require('../db/db');

/**
 * 动态构建 course_arrangement 日期表达式
 * @description 兼容 arr_date/class_date/date 缺失场景，带缓存
 * @param {string} alias - 表别名
 * @returns {Promise<string>} SQL日期表达式
 */
const __dateExprCache = {};
async function getDateExpr(alias) {
    const key = `expr_${alias || ''}`;
    if (__dateExprCache[key]) return __dateExprCache[key];
    const r = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='course_arrangement'
        AND column_name IN ('arr_date','class_date','date')
    `);
    const cols = new Set((r.rows || []).map(x => x.column_name));
    const mk = (c) => alias ? `${alias}.${c}` : c;
    const parts = [];
    if (cols.has('arr_date')) parts.push(mk('arr_date'));
    if (cols.has('class_date')) parts.push(mk('class_date'));
    if (cols.has('date')) parts.push(mk('date'));
    const expr = parts.length > 1 ? `COALESCE(${parts.join(', ')})` : (parts[0] || 'CURRENT_DATE');
    __dateExprCache[key] = expr;
    return expr;
}

const statisticsController = {
    /**
     * 获取管理员总览统计
     * @description 返回系统总览数据：教师/学生总数、已完成/待处理课程数、本月课程数
     */
    async getAdminOverview(req, res) {
        try {
            const dateExprNoAlias = await getDateExpr('');
            const result = await db.query(`
                SELECT
                    (SELECT COUNT(*) FROM teachers) as total_teachers,
                    (SELECT COUNT(*) FROM students) as total_students,
                    (SELECT COUNT(*) FROM course_arrangement WHERE status = 'completed') as total_completed_schedules,
                    (SELECT COUNT(*) FROM course_arrangement WHERE status = 'pending') as total_pending_schedules,
                    (SELECT COUNT(*) FROM course_arrangement 
                     WHERE ${dateExprNoAlias} >= DATE_TRUNC('month', CURRENT_DATE)
                       AND ${dateExprNoAlias} < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
                    ) as current_month_schedules
            `);

            res.json(result.rows[0]);
        } catch (error) {
            console.error('获取管理员总览统计错误:', error);
            const code = error?.sourceError?.code;
            const msg = String(error?.message || '');
            const isNeonTimeout = code === 'UND_ERR_CONNECT_TIMEOUT' || msg.includes('fetch failed') || msg.includes('ETIMEDOUT');
            if (isNeonTimeout) {
                return res.json({
                    total_teachers: 0,
                    total_students: 0,
                    total_completed_schedules: 0,
                    total_pending_schedules: 0,
                    current_month_schedules: 0
                });
            }
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 获取管理员排课统计
     * @description 返回排课统计：按课程类型、按月份、按状态
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     */
    async getAdminScheduleStats(req, res) {
        try {
            const { startDate, endDate } = req.query;

            // 按课程类型统计
            const dateExprCa = await getDateExpr('ca');
            const typeStats = await db.query(`
                SELECT 
                    st.name as type,
                    COUNT(*) as count
                FROM course_arrangement ca
                JOIN schedule_types st ON ca.course_id = st.id
                WHERE ${dateExprCa} BETWEEN $1 AND $2
                GROUP BY st.name
                ORDER BY count DESC
            `, [startDate, endDate]);

            // 按月份统计
            const dateExprNoAlias2 = await getDateExpr('');
            const monthlyStats = await db.query(`
                SELECT 
                    DATE_TRUNC('month', ${dateExprNoAlias2}) as month,
                    COUNT(*) as total_count,
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count
                FROM course_arrangement
                WHERE ${dateExprNoAlias2} BETWEEN $1 AND $2
                GROUP BY month
                ORDER BY month
            `, [startDate, endDate]);

            // 按状态统计
            const statusStats = await db.query(`
                SELECT 
                    status,
                    COUNT(*) as count
                FROM course_arrangement
                WHERE ${dateExprNoAlias2} BETWEEN $1 AND $2
                GROUP BY status
            `, [startDate, endDate]);

            res.json({
                typeStats: typeStats.rows,
                monthlyStats: monthlyStats.rows,
                statusStats: statusStats.rows
            });
        } catch (error) {
            console.error('获取管理员排课统计错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 获取管理员用户统计
     * @description 返回教师和学生的课程统计数据
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     */
    async getAdminUserStats(req, res) {
        try {
            const { startDate, endDate } = req.query;

            // 教师课程统计
            const dateExprCa2 = await getDateExpr('ca');
            const teacherStats = await db.query(`
                SELECT 
                    t.name as teacher_name,
                    COUNT(ca.id) as total_schedules,
                    SUM(CASE WHEN ca.status = 'completed' THEN 1 ELSE 0 END) as completed_schedules,
                    COUNT(DISTINCT ca.student_id) as student_count
                FROM teachers t
                LEFT JOIN course_arrangement ca ON t.id = ca.teacher_id AND ${dateExprCa2} BETWEEN $1 AND $2
                GROUP BY t.id, t.name
                ORDER BY total_schedules DESC
            `, [startDate, endDate]);

            // 学生课程统计
            const studentStats = await db.query(`
                SELECT 
                    st.name as student_name,
                    COUNT(ca.id) as total_schedules,
                    SUM(CASE WHEN ca.status = 'completed' THEN 1 ELSE 0 END) as completed_schedules,
                    COUNT(DISTINCT ca.teacher_id) as teacher_count
                FROM students st
                LEFT JOIN course_arrangement ca ON st.id = ca.student_id AND ${dateExprCa2} BETWEEN $1 AND $2
                GROUP BY st.id, st.name
                ORDER BY total_schedules DESC
            `, [startDate, endDate]);

            res.json({
                teacherStats: teacherStats.rows,
                studentStats: studentStats.rows
            });
        } catch (error) {
            console.error('获取管理员用户统计错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 获取教师统计
     * @description 返回指定教师的课程类型、月度、学生统计
     * @param {string} req.params.id - 教师ID
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     */
    async getTeacherStats(req, res) {
        try {
            const { id } = req.params;
            const { startDate, endDate } = req.query;

            // 验证权限
            if (req.user.userType === 'teacher' && req.user.id !== parseInt(id)) {
                return res.status(403).json({ message: '无权访问此数据' });
            }

            // 课程类型统计
            const dateExprCa3 = await getDateExpr('ca');
            const typeStats = await db.query(`
                SELECT 
                    st.name as type,
                    COUNT(*) as count
                FROM course_arrangement ca
                JOIN schedule_types st ON ca.course_id = st.id
                WHERE ca.teacher_id = $1
                  AND ${dateExprCa3} BETWEEN $2 AND $3
                GROUP BY st.name
                ORDER BY count DESC
            `, [id, startDate, endDate]);

            // 月度课程统计
            const dateExprNoAlias3 = await getDateExpr('');
            const monthlyStats = await db.query(`
                SELECT 
                    DATE_TRUNC('month', ${dateExprNoAlias3}) as month,
                    COUNT(*) as total_count,
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count
                FROM course_arrangement
                WHERE teacher_id = $1
                  AND ${dateExprNoAlias3} BETWEEN $2 AND $3
                GROUP BY month
                ORDER BY month
            `, [id, startDate, endDate]);

            // 学生统计
            const studentStats = await db.query(`
                SELECT 
                    st.name as student_name,
                    COUNT(*) as schedule_count
                FROM course_arrangement ca
                JOIN students st ON ca.student_id = st.id
                WHERE ca.teacher_id = $1
                  AND ${dateExprCa3} BETWEEN $2 AND $3
                GROUP BY st.id, st.name
                ORDER BY schedule_count DESC
                LIMIT 10
            `, [id, startDate, endDate]);

            res.json({
                typeStats: typeStats.rows,
                monthlyStats: monthlyStats.rows,
                studentStats: studentStats.rows
            });
        } catch (error) {
            console.error('获取教师统计错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 获取学生统计
     * @description 返回指定学生的课程类型、月度、教师统计
     * @param {string} req.params.id - 学生ID
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     */
    async getStudentStats(req, res) {
        try {
            const { id } = req.params;
            const { startDate, endDate } = req.query;

            // 验证权限
            if (req.user.userType === 'student' && req.user.id !== parseInt(id)) {
                return res.status(403).json({ message: '无权访问此数据' });
            }

            // 课程类型统计
            const dateExprCa4 = await getDateExpr('ca');
            const typeStats = await db.query(`
                SELECT 
                    st.name as type,
                    COUNT(*) as count
                FROM course_arrangement ca
                JOIN schedule_types st ON ca.course_id = st.id
                WHERE ca.student_id = $1
                  AND ${dateExprCa4} BETWEEN $2 AND $3
                GROUP BY st.name
                ORDER BY count DESC
            `, [id, startDate, endDate]);

            // 月度课程统计
            const dateExprNoAlias4 = await getDateExpr('');
            const monthlyStats = await db.query(`
                SELECT 
                    DATE_TRUNC('month', ${dateExprNoAlias4}) as month,
                    COUNT(*) as total_count,
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count
                FROM course_arrangement
                WHERE student_id = $1
                  AND ${dateExprNoAlias4} BETWEEN $2 AND $3
                GROUP BY month
                ORDER BY month
            `, [id, startDate, endDate]);

            // 教师统计
            const teacherStats = await db.query(`
                SELECT 
                    t.name as teacher_name,
                    COUNT(*) as schedule_count
                FROM course_arrangement ca
                JOIN teachers t ON ca.teacher_id = t.id
                WHERE ca.student_id = $1
                  AND ${dateExprCa4} BETWEEN $2 AND $3
                GROUP BY t.id, t.name
                ORDER BY schedule_count DESC
                LIMIT 10
            `, [id, startDate, endDate]);

            res.json({
                typeStats: typeStats.rows,
                monthlyStats: monthlyStats.rows,
                teacherStats: teacherStats.rows
            });
        } catch (error) {
            console.error('获取学生统计错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    }
};

module.exports = statisticsController;
