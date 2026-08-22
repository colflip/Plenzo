const logger = require('../utils/logger.js');
/**
 * 学生端控制器
 * @description 处理学生端的个人信息、时间安排、课程管理等操作
 */

const db = require('../db/db');
const { slotToColumn, mapRowToStudentAvailability } = require('../services/availability-service');
const { handleExportError } = require('../middleware/export-error-handler');
const SchemaHelper = require('../utils/schema-helper');
const scheduleService = require('../services/schedule-service');
const AdvancedExportService = require('../services/advanced-export-service');
const exportService = require('../services/export-service');

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
                const availableCols = await SchemaHelper.getColumns('students', ['status', 'nickname']);
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
            logger.error('获取学生信息错误:', error);
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
            logger.error('更新学生信息错误:', error);
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

            res.json(result.rows.map(mapRowToStudentAvailability));
        } catch (error) {
            logger.error('获取时间安排错误:', error);
            res.status(503).json({ message: '数据库暂时不可用，请稍后重试' });
        }
    },

    /**
     * 高级导出（供直接获取多Sheet Excel文件）
     */
    async advancedExport(req, res) {
        try {
            const studentId = req.user.id;
            const { startDate, endDate } = req.query;
            const out = await exportService.runRoleScheduleExport({
                startDate,
                endDate,
                userId: studentId,
                userType: 'student',
                studentId,
                exportType: 'student_schedule',
                studentName: req.user.name || req.user.username,
                queryRawData: () => new AdvancedExportService(db).queryStudentSchedule(startDate, endDate, { student_id: studentId })
            });
            if (out.buffer) {
                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(out.filename)}"`);
                res.setHeader('Content-Length', out.buffer.length);
                return res.end(out.buffer);
            }
            return res.status(out.status).json(out.body);
        } catch (error) {
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
                    const col = slotToColumn(item.timeSlot);
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
            logger.error('[setAvailability] 错误:', error);
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

            if (Array.isArray(timeSlots) && timeSlots.length > 0) {
                for (const slot of timeSlots) {
                    const col = slotToColumn(slot);
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
                    const col = slotToColumn(slot);
                    if (!col) continue;
                    await db.query(
                        `UPDATE student_daily_availability SET ${col} = 0, updated_at = CURRENT_TIMESTAMP WHERE student_id = $1 AND date BETWEEN $2 AND $3`,
                        [req.user.id, startDate, endDate]
                    );
                }
            }

            res.json({ message: '时间安排删除成功' });
        } catch (error) {
            logger.error('删除时间安排错误:', error);
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
        const out = await scheduleService.studentListSchedules(req);
        return res.status(out.status).json(out.body);
    },

    /**
     * 获取统计数据 (优化版：直接返回聚合结果)
     * @description 获取学生的课程类型统计和月度课程统计
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     */
    async getStatistics(req, res) {
        const out = await scheduleService.studentStatistics(req);
        return res.status(out.status).json(out.body);
    },

    /**
     * 获取总览数据
     * @description 获取学生仪表盘总览数据，包括本月课程数、待上课数、已完成课数、今日课程
     */
    async getOverview(req, res) {
        const out = await scheduleService.studentOverview(req);
        return res.status(out.status).json(out.body);
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
        const out = await scheduleService.studentConfirmSchedule(req);
        return res.status(out.status).json(out.body);
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
                logger.error('密码比较错误:', error);
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
            logger.error('修改密码错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

};

module.exports = studentController;
