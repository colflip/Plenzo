/**
 * 学生端控制器
 * @description 处理学生端的个人信息、时间安排、课程管理等操作
 */

const db = require('../db/db');
const { handleExportError } = require('../middleware/exportErrorHandler');
const ExportLogService = require('../utils/exportLogService');
const SchemaHelper = require('../utils/schemaHelper');

const studentController = {
    /**
     * 获取个人信息
     * @description 返回当前登录学生的基本信息
     */
    async getProfile(req, res) {
        try {
            // 动态选择是否返回 status 和 nickname 字段
            let selectCols = 'id, username, name, profession, contact, visit_location, home_address, last_login';
            try {
                const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='students' AND column_name IN ('status', 'nickname')`);
                const availableCols = new Set((cols.rows || []).map(r => r.column_name));
                if (availableCols.has('nickname')) {
                    selectCols += ', nickname';
                }
                if (availableCols.has('status')) {
                    selectCols += ', status';
                }
            } catch (_) { }
            const result = await db.query(
                `SELECT ${selectCols} FROM students WHERE id = $1`,
                [req.user.id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ message: '未找到学生信息' });
            }

            res.json(result.rows[0]);
        } catch (error) {
            console.error('获取学生信息错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 更新个人信息
     * @description 更新学生的姓名、专业、联系方式等基本信息
     */
    async updateProfile(req, res) {
        try {
            const { name, profession, contact, visit_location, home_address, status, nickname } = req.body;

            let sets = ['name = $1', 'profession = $2', 'contact = $3', 'visit_location = $4', 'home_address = $5'];
            let values = [name, profession, contact, visit_location, home_address];
            let vi = 6;
            if (typeof nickname !== 'undefined') {
                sets.push(`nickname = $${vi++}`);
                values.push(nickname || null);
            }
            if (typeof status !== 'undefined') {
                const s = Number(status);
                if (![-1, 0, 1].includes(s)) {
                    return res.status(400).json({ message: '非法状态值' });
                }
                sets.push(`status = $${vi++}`);
                values.push(s);
            }
            values.push(req.user.id);

            const result = await db.query(
                `UPDATE students
                SET ${sets.join(', ')}
                WHERE id = $${vi}
                RETURNING id, username, name, nickname, profession, contact, visit_location, home_address, status`,
                values
            );

            try { const { recordAudit } = require('../middleware/audit'); await recordAudit(req, { op: 'update_status', entityType: 'student', entityId: req.user.id, details: { status } }); } catch (_) { }

            res.json(result.rows[0]);
        } catch (error) {
            console.error('更新学生信息错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 获取时间安排
     * @description 获取指定日期范围内的日常时间安排
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     */
    async getAvailability(req, res) {
        try {
            const { startDate, endDate } = req.query;
            // 返回新的时段字段
            const result = await db.query(
                `SELECT id, date, morning_available, afternoon_available, evening_available
                FROM student_daily_availability
                WHERE student_id = $1
                  AND date BETWEEN $2 AND $3
                ORDER BY date`,
                [req.user.id, startDate, endDate]
            );

            res.json(result.rows.map(r => ({
                id: r.id,
                date: r.date,
                morning_available: r.morning_available,
                afternoon_available: r.afternoon_available,
                evening_available: r.evening_available
            })));
        } catch (error) {
            console.error('获取时间安排错误:', error);
            const code = error?.sourceError?.code;
            const msg = String(error?.message || '');
            const isNeonTimeout = code === 'UND_ERR_CONNECT_TIMEOUT' || msg.includes('fetch failed') || msg.includes('ETIMEDOUT');
            if (isNeonTimeout) {
                return res.json([]);
            }
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 高级导出（供直接获取多Sheet Excel文件）
     */
    async advancedExport(req, res) {
        let logId = null;
        const startTime = Date.now();
        const logService = new ExportLogService(db);

        try {
            const studentId = req.user.id;
            const { startDate, endDate } = req.query;
            const { standardResponse } = require('../middleware/validation');

            if (!startDate || !endDate) {
                return res.status(400).json(standardResponse(false, null, '缺少起止日期参数'));
            }

            // 验证日期格式
            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (!dateRegex.test(startDate) || !dateRegex.test(endDate) ||
                new Date(startDate).toString() === 'Invalid Date' ||
                new Date(endDate).toString() === 'Invalid Date') {
                return res.status(400).json(standardResponse(false, null, '日期格式无效，请使用 YYYY-MM-DD 格式'));
            }

            // 记录导出开始
            try {
                logId = await logService.logExportStart({
                    userId: studentId,
                    userType: 'student',
                    startDate,
                    endDate,
                    studentId: studentId,
                    exportType: 'student_schedule'
                });
            } catch (logError) {
                console.warn('记录导出开始日志失败:', logError.message);
            }

            // 1. 查询原始数据（只查询当前学生的数据）
            const AdvancedExportService = require('../services/advancedExportService');
            const exportService = new AdvancedExportService(db);
            const rawData = await exportService.queryStudentSchedule(startDate, endDate, {
                student_id: studentId
            });

            if (!rawData || rawData.length === 0) {
                return res.status(404).json(standardResponse(false, null, '该时间段内无数据'));
            }

            // 2. 使用统一服务生成完整的多Sheet数据
            const UnifiedExportService = require('../services/unifiedExportService');
            const unifiedService = new UnifiedExportService();
            const exportResult = await unifiedService.generateCompleteExport(rawData, {
                startDate,
                endDate,
                userType: 'student',
                userId: studentId,
                studentId: studentId,
                studentName: req.user.name || req.user.username
            });

            // 3. 使用 excelGeneratorService 生成 Excel 文件
            const excelGeneratorService = require('../services/excelGeneratorService');
            const excelResult = await excelGeneratorService.generateMultiSheetExcel(
                exportResult.sheets,
                exportResult.filename
            );

            // 记录导出成功
            if (logId) {
                try {
                    await logService.logExportSuccess(logId, {
                        recordCount: rawData.length,
                        fileSize: excelResult.buffer.length,
                        fileName: excelResult.filename,
                        duration: Date.now() - startTime
                    });
                } catch (logError) {
                    console.warn('记录导出成功日志失败:', logError.message);
                }
            }

            // 4. 直接发送文件流
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(excelResult.filename)}"`);
            res.setHeader('Content-Length', excelResult.buffer.length);
            return res.end(excelResult.buffer);

        } catch (error) {
            // 记录导出失败
            if (logId) {
                try {
                    await logService.logExportError(logId, error.message);
                } catch (logError) {
                    console.warn('记录导出错误日志失败:', logError.message);
                }
            }

            return handleExportError(error, req, res);
        }
    },

    // 设置时间安排
    /**
     * 批量设置或更新学生的每日时间安排
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    async setAvailability(req, res) {
        try {
            const { availabilityList } = req.body;
            const studentId = req.user.id;

            if (!Array.isArray(availabilityList)) {
                return res.status(400).json({ message: '无效的数据格式' });
            }

            let updateCount = 0;
            let insertCount = 0;

            await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);

                for (const item of availabilityList) {
                    const slotToCol = (slot) => {
                        switch (slot) {
                            case 'morning': return 'morning_available';
                            case 'afternoon': return 'afternoon_available';
                            case 'evening': return 'evening_available';
                            default: return null;
                        }
                    };
                    const col = slotToCol(item.timeSlot);
                    if (!col) continue;

                    const val = item.isAvailable === false ? 0 : 1;

                    const updateSql = `UPDATE student_daily_availability SET ${col} = $3, updated_at = CURRENT_TIMESTAMP WHERE student_id = $1 AND date = $2`;

                    const upd = await q(
                        updateSql,
                        [studentId, item.date, val]
                    );

                    if (!upd || upd.rowCount === 0) {
                        const morning = (col === 'morning_available') ? val : 0;
                        const afternoon = (col === 'afternoon_available') ? val : 0;
                        const evening = (col === 'evening_available') ? val : 0;

                        const insertSql = `INSERT INTO student_daily_availability (student_id, date, morning_available, afternoon_available, evening_available, created_at)
                             VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`;

                        await q(insertSql, [studentId, item.date, morning, afternoon, evening]);
                        insertCount++;
                    } else {
                        updateCount++;
                    }
                }
            });

            res.json({ message: '时间安排更新成功', updateCount, insertCount });
        } catch (error) {
            console.error('[setAvailability] 错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 删除/清除时间安排
     * @description 将指定时段的可用状态设置为不可用
     * @param {Object} req.body.startDate - 开始日期
     * @param {Object} req.body.endDate - 结束日期
     * @param {Array} req.body.timeSlots - 时段列表
     */
    async deleteAvailability(req, res) {
        try {
            const { startDate, endDate, timeSlots, ranges } = req.body;

            const slotToCol = (slot) => {
                switch (slot) {
                    case 'morning': return 'morning_available';
                    case 'afternoon': return 'afternoon_available';
                    case 'evening': return 'evening_available';
                    default: return null;
                }
            };

            if (Array.isArray(timeSlots) && timeSlots.length > 0) {
                for (const slot of timeSlots) {
                    const col = slotToCol(slot);
                    if (!col) continue;
                    await db.query(
                        `UPDATE student_daily_availability SET ${col} = 0, updated_at = CURRENT_TIMESTAMP WHERE student_id = $1 AND date BETWEEN $2 AND $3`,
                        [req.user.id, startDate, endDate]
                    );
                }
            }

            if (Array.isArray(ranges) && ranges.length > 0) {
                // ranges 仍然兼容，但作为回退：将对应时段设置为 0
                for (const r of ranges) {
                    // 根据传入的 start_time 来判断是哪个时段
                    const start = r.start_time;
                    let slot = null;
                    if (start === '08:00') slot = 'morning';
                    if (start === '13:00') slot = 'afternoon';
                    if (start === '18:00') slot = 'evening';
                    const col = slotToCol(slot);
                    if (!col) continue;
                    await db.query(
                        `UPDATE student_daily_availability SET ${col} = 0, updated_at = CURRENT_TIMESTAMP WHERE student_id = $1 AND date BETWEEN $2 AND $3`,
                        [req.user.id, startDate, endDate]
                    );
                }
            }

            res.json({ message: '时间安排删除成功' });
        } catch (error) {
            console.error('删除时间安排错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 获取课程安排
     * @description 获取学生在指定日期范围的课程安排
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     * @param {string} req.query.status - 课程状态过滤（可选）
     */
    async getSchedules(req, res) {
        try {
            const { startDate, endDate, status } = req.query;

            const dateExpr = await SchemaHelper.getDateExpr('ca');
            let query = `
                SELECT
                    ca.id,
                    (${dateExpr})::text AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.location,
                    ca.adjustment_type,
                    ca.adjustment_type AS is_temp,
                    ca.teacher_id, t.name as teacher_name,
                    sty.name as schedule_type,
                    sty.description as schedule_type_cn,
                    ca.course_id
                FROM course_arrangement ca
                JOIN teachers t ON ca.teacher_id = t.id
                JOIN schedule_types sty ON ca.course_id = sty.id
                JOIN students s ON ca.student_id = s.id
                WHERE ca.student_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
            `;

            if (await SchemaHelper.hasColumn('teachers', 'status')) query += ` AND t.status = 1`;
            if (await SchemaHelper.hasColumn('students', 'status')) query += ` AND s.status = 1`;

            const values = [req.user.id, startDate, endDate];

            if (status) {
                query += ` AND ca.status = $4`;
                values.push(status);
            }

            // 默认隐藏调走的原课程；“显示全部安排”时与管理员端一致展示
            if (req.query.show_plan !== 'true') {
                query += ` AND NOT (ca.status = 'modified_away' AND COALESCE(ca.adjustment_type, 0) = 0)`;
            }

            query += ` ORDER BY date, ca.start_time`;

            const result = await db.query(query, values);
            res.json(result.rows);
        } catch (error) {
            console.error('获取课程安排错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 获取统计数据 (优化版：直接返回聚合结果)
     * @description 获取学生的课程类型统计和月度课程统计
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     */
    async getStatistics(req, res) {
        try {
            const { startDate, endDate } = req.query;
            if (!startDate || !endDate) {
                return res.status(400).json({ message: '请提供日期范围' });
            }

            const dateExpr = await SchemaHelper.getDateExpr('ca');

            // 三个查询相互独立，使用 Promise.all 并行执行，
            // 减少 Neon serverless 多次往返带来的累计延迟
            const [typeStats, monthlyStats, schedules] = await Promise.all([
                // 1. 按类型的聚合统计 (排除已取消)
                db.query(`
                SELECT
                    COALESCE(sty.description, sty.name) as type,
                    COUNT(*)::int as count
                FROM course_arrangement ca
                JOIN schedule_types sty ON ca.course_id = sty.id
                WHERE ca.student_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', '0', 'modified_away')
                GROUP BY COALESCE(sty.description, sty.name)
                ORDER BY count DESC
            `, [req.user.id, startDate, endDate]),

                // 2. 每月课程数统计 (柱状图所需)
                db.query(`
                SELECT
                    TO_CHAR(${dateExpr}, 'YYYY-MM') as month,
                    COUNT(*)::int as count
                FROM course_arrangement ca
                WHERE ca.student_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', '0', 'modified_away')
                GROUP BY TO_CHAR(${dateExpr}, 'YYYY-MM')
                ORDER BY month
            `, [req.user.id, startDate, endDate]),

                // 3. 所有课程明细 (用于统计页下方的表格，已过滤日期)
                db.query(`
                SELECT
                    ca.id,
                    (${dateExpr})::text AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.location,
                    ca.adjustment_type AS is_temp,
                    t.name as teacher_name,
                    sty.name as schedule_type,
                    sty.description as schedule_type_cn
                FROM course_arrangement ca
                LEFT JOIN teachers t ON ca.teacher_id = t.id
                JOIN schedule_types sty ON ca.course_id = sty.id
                WHERE ca.student_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', '0', 'modified_away')
                ORDER BY date DESC, ca.start_time ASC
            `, [req.user.id, startDate, endDate])
            ]);

            res.json({
                typeStats: typeStats.rows,
                monthlyStats: monthlyStats.rows,
                schedules: schedules.rows
            });
        } catch (error) {
            console.error('获取统计数据错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 获取总览数据
     * @description 获取学生仪表盘总览数据，包括本月课程数、待上课数、已完成课数、今日课程
     */
    async getOverview(req, res) {
        try {
            // Date ranges calculation
            const today = new Date();

            // Week range (Monday to Sunday)
            const dayOfWeek = today.getDay() || 7; // Sunday is 0, make it 7 for calculation
            const activeWeekStart = new Date(today);
            activeWeekStart.setDate(today.getDate() - dayOfWeek + 1);
            const activeWeekEnd = new Date(activeWeekStart);
            activeWeekEnd.setDate(activeWeekStart.getDate() + 6);

            // Month range
            const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
            const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);

            // Year range
            const firstDayOfYear = new Date(today.getFullYear(), 0, 1);
            const lastDayOfYear = new Date(today.getFullYear(), 11, 31);

            // 修复时区偏差问题：确保返回纯数字的 YYYY-MM-DD 格式，避免 zh-CN 下出现“月”、“日”字符
            const formatDate = (d) => {
                const parts = new Intl.DateTimeFormat('en-US', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    timeZone: 'Asia/Shanghai'
                }).formatToParts(d);
                const year = parts.find(p => p.type === 'year').value;
                const month = parts.find(p => p.type === 'month').value;
                const day = parts.find(p => p.type === 'day').value;
                return `${year}-${month}-${day}`;
            };

            const todayStr = formatDate(today);
            const weekStartStr = formatDate(activeWeekStart);
            const weekEndStr = formatDate(activeWeekEnd);
            const monthStartStr = formatDate(firstDayOfMonth);
            const monthEndStr = formatDate(lastDayOfMonth);
            const yearStartStr = formatDate(firstDayOfYear);
            const yearEndStr = formatDate(lastDayOfYear);

            const dateExpr = await SchemaHelper.getDateExpr('ca');

            // Unified Query for all 6 metrics
            // Time-based: pending, confirmed, completed (exclude cancelled)
            // Status-based: all time
            const statsResult = await db.query(`
                SELECT 
                    -- Time-based (Weekly, Monthly, Yearly) - Valid courses only
                    SUM(CASE WHEN ${dateExpr} BETWEEN $2 AND $3 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as weekly_count,
                    SUM(CASE WHEN ${dateExpr} BETWEEN $4 AND $5 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as monthly_count,
                    SUM(CASE WHEN ${dateExpr} BETWEEN $6 AND $7 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as yearly_count,
                    
                    -- Status-based (All time)
                    SUM(CASE WHEN ca.status IN ('pending', 'confirmed') THEN 1 ELSE 0 END)::int as total_pending,
                    SUM(CASE WHEN ca.status = 'completed' THEN 1 ELSE 0 END)::int as total_completed,
                    SUM(CASE WHEN ca.status = 'cancelled' THEN 1 ELSE 0 END)::int as total_cancelled
                FROM course_arrangement ca
                WHERE ca.student_id = $1
                  AND NOT (ca.status = 'modified_away' AND COALESCE(ca.adjustment_type, 0) = 0)
            `, [
                req.user.id,
                weekStartStr, weekEndStr,
                monthStartStr, monthEndStr,
                yearStartStr, yearEndStr
            ]);

            // 获取今日课程
            const todaySchedules = await db.query(`
                SELECT 
                    ca.id,
                    (${dateExpr})::text AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.location,
                    ca.adjustment_type AS is_temp,
                    t.name as teacher_name,
                    sty.name as schedule_type,
                    sty.description as schedule_type_cn
                FROM course_arrangement ca
                JOIN teachers t ON ca.teacher_id = t.id
                JOIN schedule_types sty ON ca.course_id = sty.id
                WHERE ca.student_id = $1
                  AND ${dateExpr} = $2
                  AND NOT (ca.status = 'modified_away' AND COALESCE(ca.adjustment_type, 0) = 0)
                ORDER BY ca.start_time
            `, [req.user.id, todayStr]);

            res.json({
                weeklyCount: parseInt(statsResult.rows[0]?.weekly_count || 0),
                monthlyCount: parseInt(statsResult.rows[0]?.monthly_count || 0),
                yearlyCount: parseInt(statsResult.rows[0]?.yearly_count || 0),
                totalPending: parseInt(statsResult.rows[0]?.total_pending || 0), // Includes confirmed as 'active/pending' actions
                totalCompleted: parseInt(statsResult.rows[0]?.total_completed || 0),
                totalCancelled: parseInt(statsResult.rows[0]?.total_cancelled || 0),
                todaySchedules: todaySchedules.rows
            });
        } catch (error) {
            console.error('获取总览数据错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 获取数据汇总
     * @description 获取指定日期范围的详细排课记录
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     */
    /**
     * 确认课程
     * @description 学生确认指定课程，更新状态为已确认
     * @param {string} req.params.id - 课程ID
     */
    async confirmSchedule(req, res) {
        try {
            const scheduleId = req.params.id;

            // 验证课程是否属于该学生
            const checkResult = await db.query(
                'SELECT id FROM course_arrangement WHERE id = $1 AND student_id = $2',
                [scheduleId, req.user.id]
            );

            if (checkResult.rows.length === 0) {
                return res.status(404).json({ message: '未找到该课程或无权限' });
            }

            // 更新状态为已确认
            await db.query(
                'UPDATE course_arrangement SET status = $1 WHERE id = $2',
                ['confirmed', scheduleId]
            );

            res.json({ message: '课程确认成功' });
        } catch (error) {
            console.error('确认课程错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 修改密码
     * @description 学生修改登录密码
     * @param {string} req.body.currentPassword - 当前密码
     * @param {string} req.body.newPassword - 新密码
     */
    async changePassword(req, res) {
        try {
            const bcrypt = require('bcrypt');
            const { currentPassword, newPassword } = req.body;

            // 验证输入
            if (!currentPassword || !newPassword) {
                return res.status(400).json({ message: '请提供当前密码和新密码' });
            }

            if (newPassword.length < 6) {
                return res.status(400).json({ message: '新密码长度不能少于6位' });
            }

            // 获取当前密码哈希
            const result = await db.query(
                'SELECT password_hash FROM students WHERE id = $1',
                [req.user.id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ message: '未找到学生信息' });
            }

            const currentPasswordHash = result.rows[0].password_hash;

            // 验证当前密码
            let isValidPassword = false;
            try {
                isValidPassword = await bcrypt.compare(currentPassword, currentPasswordHash);
            } catch (error) {
                console.error('密码比较错误:', error);
                return res.status(500).json({ message: '密码验证失败' });
            }

            if (!isValidPassword) {
                return res.status(401).json({ message: '当前密码不正确' });
            }

            // 生成新密码哈希
            const salt = await bcrypt.genSalt(10);
            const newPasswordHash = await bcrypt.hash(newPassword, salt);

            // 更新密码
            await db.query(
                'UPDATE students SET password_hash = $1 WHERE id = $2',
                [newPasswordHash, req.user.id]
            );

            // 记录审计
            try {
                const { recordAudit } = require('../middleware/audit');
                await recordAudit(req, {
                    op: 'change_password',
                    entityType: 'student',
                    entityId: req.user.id,
                    details: { success: true }
                });
            } catch (_) {
                // 忽略审计错误
            }

            res.json({ message: '密码修改成功' });
        } catch (error) {
            console.error('修改密码错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

};

module.exports = studentController;
