const db = require('../db/db');
const ExportUtils = require('../utils/exportUtils');
const AdvancedExportService = require('../utils/advancedExportService');
const { standardResponse } = require('../middleware/validation');

const SLOT_COLUMNS = Object.freeze({
    morning: 'morning_available',
    afternoon: 'afternoon_available',
    evening: 'evening_available'
});

const LESSON_STATUS_SET = new Set(['pending', 'confirmed', 'completed', 'cancelled']);

function normalizeSlotKey(raw) {
    if (!raw && raw !== 0) return null;
    const key = String(raw).trim().toLowerCase();
    return SLOT_COLUMNS[key] ? key : null;
}

function isValidDateString(raw) {
    const str = String(raw == null ? '' : raw).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

function normalizeSlotValue(raw) {
    if (raw === null || typeof raw === 'undefined') return null;
    if (typeof raw === 'object' && raw !== null) {
        if (Object.prototype.hasOwnProperty.call(raw, 'available')) {
            return normalizeSlotValue(raw.available);
        }
        if (Object.prototype.hasOwnProperty.call(raw, 'status')) {
            return normalizeSlotValue(raw.status);
        }
    }
    if (typeof raw === 'number') {
        if (raw === 1) return 1;
        if (raw === 0) return 0;
        return null;
    }
    if (typeof raw === 'boolean') {
        return raw ? 1 : 0;
    }
    const text = String(raw).trim().toLowerCase();
    if (!text) return null;
    if (['available', 'true', 'yes', '1', 'enabled', 'enable', '开放'].includes(text)) return 1;
    if (['unavailable', 'false', 'no', '0', 'disabled', 'disable', 'not-set', '关闭'].includes(text)) return 0;
    return null;
}

function collectAvailabilityUpdates(list) {
    if (!Array.isArray(list)) {
        return new Map();
    }
    const byDate = new Map();
    for (const item of list) {
        if (!item || !item.date) {
            continue;
        }
        const date = String(item.date).trim();
        if (!date) continue;
        const ensureBucket = () => {
            if (!byDate.has(date)) {
                byDate.set(date, { morning: null, afternoon: null, evening: null });
            }
            return byDate.get(date);
        };

        if (item.slots && typeof item.slots === 'object') {
            const bucket = ensureBucket();
            for (const [rawSlot, rawValue] of Object.entries(item.slots)) {
                const slot = normalizeSlotKey(rawSlot);
                if (!slot) continue;
                const value = normalizeSlotValue(rawValue);
                if (value === null) continue;
                bucket[slot] = value;
            }
            continue;
        }

        const slot = normalizeSlotKey(item.timeSlot || item.slot || item.time_slot);
        if (!slot) continue;
        const value = normalizeSlotValue(item.isAvailable ?? item.available ?? item.status);
        if (value === null) continue;
        const bucket = ensureBucket();
        bucket[slot] = value;
    }
    return byDate;
}

function mapRowToAvailability(row) {
    return {
        id: row.id,
        date: row.date,
        morning_available: Number(row.morning_available) || 0,
        afternoon_available: Number(row.afternoon_available) || 0,
        evening_available: Number(row.evening_available) || 0,
        slots: {
            morning: Number(row.morning_available) === 1,
            afternoon: Number(row.afternoon_available) === 1,
            evening: Number(row.evening_available) === 1
        }
    };
}

// 性能优化：缓存列信息和日期表达式
const __dateExprCache = {};
const __schemaCache = { initialized: false, teacherHasStatus: false, studentHasStatus: false };

async function initSchemaCache() {
    if (__schemaCache.initialized) return;
    try {
        const tCols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='teachers' AND column_name='status'`);
        const sCols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='students' AND column_name='status'`);
        __schemaCache.teacherHasStatus = (tCols.rows || []).length > 0;
        __schemaCache.studentHasStatus = (sCols.rows || []).length > 0;
        __schemaCache.initialized = true;
    } catch (_) {
        __schemaCache.initialized = true;
    }
}

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

const teacherController = {
    // 获取个人信息
    async getProfile(req, res) {
        try {
            const columnResult = await db.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_schema = 'public' AND table_name = 'teachers'
                    AND column_name IN ('status','last_login','created_at')
            `);
            const availableCols = new Set(columnResult.rows.map(r => r.column_name));
            const selectCols = [
                'id',
                'username',
                'name',
                'profession',
                'contact',
                'work_location',
                'home_address'
            ];
            if (availableCols.has('status')) {
                selectCols.push('status');
            }
            if (availableCols.has('last_login')) {
                selectCols.push('last_login');
            }
            if (availableCols.has('created_at')) {
                selectCols.push('created_at');
            }

            const result = await db.query(
                `SELECT ${selectCols.join(', ')} FROM teachers WHERE id = $1`,
                [req.user.id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ message: '未找到教师信息' });
            }

            const profile = result.rows[0];
            if (profile.last_login instanceof Date) {
                profile.last_login_iso = profile.last_login.toISOString();
            }
            res.json(profile);
        } catch (error) {
            console.error('获取教师信息错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    // 更新个人信息
    async updateProfile(req, res) {
        try {
            const { name, profession, contact, work_location, home_address, status } = req.body;

            // 自助修改状态：仅允许设置为 -1/0/1
            let sets = ['name = $1', 'profession = $2', 'contact = $3', 'work_location = $4', 'home_address = $5'];
            let values = [name, profession, contact, work_location, home_address];
            let vi = 6;
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
                `UPDATE teachers
                SET ${sets.join(', ')}
                WHERE id = $${vi}
                RETURNING id, username, name, profession, contact, work_location, home_address, status`,
                values
            );

            // 记录审计（若存在）
            try { const { recordAudit } = require('../middleware/audit'); await recordAudit(req, { op: 'update_status', entityType: 'teacher', entityId: req.user.id, details: { status } }); } catch (_) { }

            res.json(result.rows[0]);
        } catch (error) {
            console.error('更新教师信息错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 导出排课数据为Excel
     * @param {Object} req 
     * @param {Object} res 
     */
    async exportMySchedules(req, res) {
        try {
            const teacherId = req.user.id;
            const { startDate, endDate } = req.query;

            // 1. 实例化独立导出服务
            const teacherExportService = require('../utils/teacherExportService');

            // 2. 生成文件
            const result = await teacherExportService.exportSchedule(teacherId, startDate, endDate);

            // 3. 发送文件
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

            const encodedFilename = encodeURIComponent(result.filename);
            res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"`);
            res.setHeader('Content-Length', result.buffer.length);

            res.end(result.buffer);

        } catch (error) {
            console.error('Export error:', error);
            res.status(error.status || 500).json({ error: error.message || '导出失败' });
        }
    },

    // 获取时间安排
    /**
     * 获取指定日期范围的时间安排
     */
    async getAvailability(req, res) {
        try {
            const { startDate, endDate } = req.query;
            const result = await db.query(
                `SELECT id, date, morning_available, afternoon_available, evening_available
                 FROM teacher_daily_availability
                 WHERE teacher_id = $1
                   AND date BETWEEN $2 AND $3
                 ORDER BY date`,
                [req.user.id, startDate, endDate]
            );

            res.json(result.rows.map(mapRowToAvailability));
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

    // 设置时间安排
    /**
     * 批量设置时间安排
     */
    async setAvailability(req, res) {
        try {
            const { availabilityList } = req.body || {};
            const updatesByDate = collectAvailabilityUpdates(availabilityList);

            if (!updatesByDate.size) {
                return res.status(400).json({ message: '缺少有效的时间安排数据' });
            }

            let insertCount = 0;
            let updateCount = 0;
            let unchangedCount = 0;

            await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                for (const [rawDate, slots] of updatesByDate.entries()) {
                    if (!isValidDateString(rawDate)) {
                        throw new Error(`无效的日期格式: ${rawDate}`);
                    }
                    const date = rawDate;
                    const hasExplicitUpdate = ['morning', 'afternoon', 'evening'].some(slot => typeof slots[slot] === 'number');
                    if (!hasExplicitUpdate) {
                        unchangedCount++;
                        continue;
                    }

                    const existing = await q(
                        `SELECT id, morning_available, afternoon_available, evening_available
                         FROM teacher_daily_availability
                         WHERE teacher_id = $1 AND date = $2
                         LIMIT 1`,
                        [req.user.id, date]
                    );

                    const currentRow = existing.rows[0] || null;
                    const nextValues = {
                        morning: typeof slots.morning === 'number'
                            ? slots.morning
                            : (currentRow ? Number(currentRow.morning_available) || 0 : 0),
                        afternoon: typeof slots.afternoon === 'number'
                            ? slots.afternoon
                            : (currentRow ? Number(currentRow.afternoon_available) || 0 : 0),
                        evening: typeof slots.evening === 'number'
                            ? slots.evening
                            : (currentRow ? Number(currentRow.evening_available) || 0 : 0)
                    };

                    const hasChange = !currentRow ||
                        Number(currentRow.morning_available) !== nextValues.morning ||
                        Number(currentRow.afternoon_available) !== nextValues.afternoon ||
                        Number(currentRow.evening_available) !== nextValues.evening;

                    if (!hasChange) {
                        unchangedCount++;
                        continue;
                    }

                    if (currentRow) {
                        await q(
                            `UPDATE teacher_daily_availability
                             SET morning_available = $3,
                                 afternoon_available = $4,
                                 evening_available = $5,
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE teacher_id = $1 AND date = $2`,
                            [req.user.id, date, nextValues.morning, nextValues.afternoon, nextValues.evening]
                        );
                        updateCount++;
                    } else {
                        await q(
                            `INSERT INTO teacher_daily_availability
                                 (teacher_id, date, morning_available, afternoon_available, evening_available, start_time, end_time, created_at, updated_at)
                             VALUES ($1, $2, $3, $4, $5, '00:00:00', '23:59:59', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                            [req.user.id, date, nextValues.morning, nextValues.afternoon, nextValues.evening]
                        );
                        insertCount++;
                    }
                }
            });

            res.json({
                message: '时间安排更新成功',
                insertCount,
                updateCount,
                unchangedCount
            });
        } catch (error) {
            console.error('设置时间安排错误:', error);
            return res.status(500).json({ message: '服务器错误' });
        }
    },

    // 删除时间安排
    /**
     * 批量删除时间安排
     */
    async deleteAvailability(req, res) {
        try {
            const { records = [], date, timeSlots = [] } = req.body || {};
            const operations = [];

            if (Array.isArray(records)) {
                for (const record of records) {
                    if (record && record.date) {
                        operations.push(record);
                    }
                }
            }

            if (date && Array.isArray(timeSlots) && timeSlots.length) {
                for (const slot of timeSlots) {
                    operations.push({ date, timeSlot: slot });
                }
            }

            if (!operations.length) {
                return res.status(400).json({ message: '缺少需要删除的时间安排记录' });
            }

            let updateCount = 0;
            let deleteCount = 0;

            await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);

                for (const op of operations) {
                    if (!isValidDateString(op.date)) {
                        throw new Error(`无效的日期格式: ${op.date}`);
                    }

                    if (op.removeAll) {
                        const del = await q(
                            `DELETE FROM teacher_daily_availability
                             WHERE teacher_id = $1 AND date = $2`,
                            [req.user.id, op.date]
                        );
                        deleteCount += del.rowCount || 0;
                        continue;
                    }

                    const slot = normalizeSlotKey(op.timeSlot || op.slot || op.time_slot);
                    if (!slot) {
                        continue;
                    }
                    const column = SLOT_COLUMNS[slot];
                    const updated = await q(
                        `UPDATE teacher_daily_availability
                         SET ${column} = 0,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE teacher_id = $1 AND date = $2
                         RETURNING morning_available, afternoon_available, evening_available`,
                        [req.user.id, op.date]
                    );

                    if (updated.rowCount === 0) {
                        continue;
                    }

                    const row = updated.rows[0];
                    const allZero = ['morning_available', 'afternoon_available', 'evening_available']
                        .every(key => Number(row[key]) === 0);

                    if (allZero) {
                        const del = await q(
                            `DELETE FROM teacher_daily_availability
                             WHERE teacher_id = $1 AND date = $2`,
                            [req.user.id, op.date]
                        );
                        if (del.rowCount) {
                            deleteCount += del.rowCount;
                        } else {
                            updateCount += 1;
                        }
                    } else {
                        updateCount += 1;
                    }
                }
            });

            res.json({
                message: '时间安排删除成功',
                updateCount,
                deleteCount
            });
        } catch (error) {
            console.error('删除时间安排错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    // 获取课程安排
    async getSchedules(req, res) {
        try {
            const { startDate, endDate, status } = req.query;

            const dateExpr = await getDateExpr('ca');
            await initSchemaCache();

            let query = `
                SELECT 
                    ca.id,
                    ${dateExpr} AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.teacher_id, ca.location,
                    ca.transport_fee, ca.other_fee,
                    st.name as student_name,
                    sty.name as schedule_type,
                    sty.description as schedule_type_cn
                FROM course_arrangement ca
                JOIN students st ON ca.student_id = st.id
                JOIN schedule_types sty ON ca.course_id = sty.id
                JOIN teachers t ON ca.teacher_id = t.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
            `;

            // 使用缓存的列信息而不是每次查询
            if (__schemaCache.teacherHasStatus) query += ` AND t.status = 1`;
            if (__schemaCache.studentHasStatus) query += ` AND st.status = 1`;

            const values = [req.user.id, startDate, endDate];

            if (status) {
                query += ` AND ca.status = $4`;
                values.push(status);
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
     * 确认课程
     * @description 教师确认指定课程，更新课程状态为已确认
     * @param {Object} req.params.id - 课程ID
     * @param {Object} req.body.teacherConfirmed - 是否确认
     * @param {Object} req.body.notes - 备注信息
     */
    async confirmSchedule(req, res) {
        try {
            const { id } = req.params;
            const { teacherConfirmed, notes } = req.body;

            // 查询课程信息，验证是否是该教师的课程
            const schedule = await db.query(
                'SELECT id, teacher_id FROM course_arrangement WHERE id = $1',
                [id]
            );

            if (schedule.rows.length === 0) {
                return res.status(404).json({ message: '未找到相关课程' });
            }

            if (Number(schedule.rows[0].teacher_id) !== Number(req.user.id) && req.user.userType !== 'admin') {
                return res.status(403).json({ message: '无权操作' });
            }

            // 更新课程状态与教师评价备注
            await db.query(
                `UPDATE course_arrangement 
                 SET status = CASE 
                        WHEN $2::boolean THEN 'confirmed'
                        ELSE COALESCE(status, 'pending')
                    END,
                     teacher_comment = COALESCE($3, teacher_comment),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [id, !!teacherConfirmed, notes || null]
            );

            res.json({ message: '课程确认状态更新成功' });
        } catch (error) {
            console.error('确认课程错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 更新课程状态
     * @description 教师更新指定课程的状态（pending/confirmed/completed/cancelled）
     * @param {Object} req.params.id - 课程ID
     * @param {Object} req.body.status - 新状态
     * @param {Object} req.body.notes - 备注信息
     */
    async updateScheduleStatus(req, res) {
        try {
            const { id } = req.params;
            const { status, notes } = req.body || {};

            if (!status) {
                return res.status(400).json({ message: '缺少课程状态' });
            }

            // 规范化并验证状态值
            const normalizedStatus = String(status).trim().toLowerCase();
            if (!LESSON_STATUS_SET.has(normalizedStatus)) {
                return res.status(400).json({ message: '非法的课程状态值' });
            }

            // 获取排课详细信息以进行权限检查
            const scheduleCheck = await db.query('SELECT teacher_id, student_id FROM course_arrangement WHERE id = $1', [id]);
            if (scheduleCheck.rows.length === 0) {
                return res.status(404).json({ message: '未找到相关课程' });
            }

            const { teacher_id, student_id } = scheduleCheck.rows[0];
            let hasPermission = false;

            if (teacher_id === req.user.id) {
                hasPermission = true; // 自己是任课教师
            } else {
                // 检查是否为该学生班主任
                const teacherResult = await db.query('SELECT student_ids FROM teachers WHERE id = $1', [req.user.id]);
                if (teacherResult.rows.length > 0 && teacherResult.rows[0].student_ids) {
                    const studentIdsStr = teacherResult.rows[0].student_ids;
                    const studentIds = studentIdsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
                    if (studentIds.includes(student_id)) {
                        hasPermission = true;
                    }
                }
            }

            if (!hasPermission) {
                return res.status(403).json({ message: '无权修改该课程状态（非本人任课且不属于所负责学生）' });
            }

            const result = await db.query(
                `UPDATE course_arrangement
                 SET status = $2,
                     teacher_comment = COALESCE($3, teacher_comment),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1
                 RETURNING id, status, start_time, end_time, location`,
                [id, normalizedStatus, notes || null]
            );

            res.json({
                message: '课程状态更新成功',
                schedule: result.rows[0]
            });
        } catch (error) {
            console.error('更新课程状态错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 获取统计数据
     * @description 获取教师在指定日期范围的排课统计（按类型、按日、按月）
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     */
    async getStatistics(req, res) {
        try {
            const { startDate, endDate } = req.query;

            // 获取日期表达式（带缓存）
            const dateExpr = await getDateExpr('ca');

            // 使用一个统一查询获取类型统计和每日统计，减少DB往返
            // 先获取类型统计
            const typeStatsResult = await db.query(`
                SELECT 
                    COALESCE(sty.description, sty.name) as type,
                    COUNT(*) as count
                FROM course_arrangement ca
                JOIN schedule_types sty ON ca.course_id = sty.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                GROUP BY COALESCE(sty.description, sty.name)
                ORDER BY count DESC
            `, [req.user.id, startDate, endDate]);

            // 然后获取每日统计（不需要额外的日期表达式调用）
            const dailyStatsResult = await db.query(`
                SELECT
                    to_char(DATE_TRUNC('day', ${dateExpr}), 'YYYY-MM-DD') as date,
                    COALESCE(sty.description, sty.name) as type,
                    COUNT(*) as count
                FROM course_arrangement ca
                JOIN schedule_types sty ON ca.course_id = sty.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                GROUP BY DATE_TRUNC('day', ${dateExpr}), COALESCE(sty.description, sty.name)
                ORDER BY date, count DESC
            `, [req.user.id, startDate, endDate]);

            // monthlyStats is optional - only compute if explicitly needed
            // For now we'll compute it efficiently
            const monthlyStatsResult = await db.query(`
                SELECT 
                    DATE_TRUNC('month', ${dateExpr}) as month,
                    COUNT(*) as count
                FROM course_arrangement ca
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                GROUP BY DATE_TRUNC('month', ${dateExpr})
                ORDER BY month
            `, [req.user.id, startDate, endDate]);

            res.json({
                typeStats: typeStatsResult.rows,
                monthlyStats: monthlyStatsResult.rows,
                dailyStats: dailyStatsResult.rows
            });
        } catch (error) {
            console.error('获取统计数据错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    // 获取教师总览数据
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

            const todayStr = today.toISOString().split('T')[0];
            const weekStartStr = activeWeekStart.toISOString().split('T')[0];
            const weekEndStr = activeWeekEnd.toISOString().split('T')[0];
            const monthStartStr = firstDayOfMonth.toISOString().split('T')[0];
            const monthEndStr = lastDayOfMonth.toISOString().split('T')[0];
            const yearStartStr = firstDayOfYear.toISOString().split('T')[0];
            const yearEndStr = lastDayOfYear.toISOString().split('T')[0];

            const dateExpr = await getDateExpr('ca');
            await initSchemaCache();

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
                    SUM(CASE WHEN ca.status = 'pending' THEN 1 ELSE 0 END)::int as total_pending,
                    SUM(CASE WHEN ca.status = 'completed' THEN 1 ELSE 0 END)::int as total_completed,
                    SUM(CASE WHEN ca.status = 'cancelled' THEN 1 ELSE 0 END)::int as total_cancelled
                FROM course_arrangement ca
                ${__schemaCache.teacherHasStatus ? 'JOIN teachers t ON ca.teacher_id = t.id' : ''}
                WHERE ca.teacher_id = $1
                  ${__schemaCache.teacherHasStatus ? 'AND t.status = 1' : ''}
            `, [
                req.user.id,
                weekStartStr, weekEndStr,
                monthStartStr, monthEndStr,
                yearStartStr, yearEndStr
            ]);

            // 获取今日课程
            let todayQuery = `
                SELECT 
                    ca.id,
                    ${dateExpr} AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.location,
                    s.name as student_name,
                    sty.name as schedule_type
                FROM course_arrangement ca
                JOIN students s ON ca.student_id = s.id
                LEFT JOIN schedule_types sty ON ca.course_id = sty.id
                JOIN teachers t ON ca.teacher_id = t.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} = $2
            `;

            if (__schemaCache.teacherHasStatus) todayQuery += ` AND t.status = 1`;
            if (__schemaCache.studentHasStatus) todayQuery += ` AND s.status = 1`;

            todayQuery += ` ORDER BY ca.start_time`;

            const todaySchedules = await db.query(todayQuery, [req.user.id, todayStr]);

            res.json({
                weeklyCount: parseInt(statsResult.rows[0]?.weekly_count || 0),
                monthlyCount: parseInt(statsResult.rows[0]?.monthly_count || 0),
                yearlyCount: parseInt(statsResult.rows[0]?.yearly_count || 0),
                totalPending: parseInt(statsResult.rows[0]?.total_pending || 0),
                totalCompleted: parseInt(statsResult.rows[0]?.total_completed || 0),
                totalCancelled: parseInt(statsResult.rows[0]?.total_cancelled || 0),
                todaySchedules: todaySchedules.rows
            });
        } catch (error) {
            console.error('获取教师总览数据错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 获取授课总数
     * @description 获取教师在指定日期范围的授课总数
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     */
    async getTeachingCount(req, res) {
        try {
            const { startDate, endDate } = req.query;

            const dateExpr = await getDateExpr('');
            const result = await db.query(`
                SELECT COUNT(*) as count
                FROM course_arrangement
                WHERE teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
            `, [req.user.id, startDate, endDate]);

            const count = parseInt(result.rows[0].count, 10);

            res.json({
                count,
                startDate,
                endDate
            });
        } catch (error) {
            console.error('获取授课总数错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 获取详细的排课数据
     * @description 获取详细排课列表，用于生成多系列折线图
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     * @param {number} req.query.limit - 最大返回条数（可选，最大1000）
     * @param {number} req.query.offset - 偏移量（可选）
     */
    async getDetailedSchedules(req, res) {
        try {
            const { startDate, endDate } = req.query;
            const limit = Math.min(1000, Number(req.query.limit) || 0) || null;
            const offset = Number(req.query.offset) || 0;

            // 离线开发模式：返回示例数据
            if (process.env.OFFLINE_DEV === 'true') {
                const today = new Date().toISOString().split('T')[0];
                const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
                return res.json([
                    {
                        id: 1,
                        date: today,
                        start_time: '09:00',
                        end_time: '10:00',
                        status: 'pending',
                        teacher_id: req.user.id,
                        location: '教室 A',
                        student_name: '学生甲',
                        schedule_type: '试听'
                    },
                    {
                        id: 2,
                        date: today,
                        start_time: '14:00',
                        end_time: '15:00',
                        status: 'confirmed',
                        teacher_id: req.user.id,
                        location: '教室 B',
                        student_name: '学生乙',
                        schedule_type: '正式课'
                    },
                    {
                        id: 3,
                        date: tomorrow,
                        start_time: '10:00',
                        end_time: '11:00',
                        status: 'completed',
                        teacher_id: req.user.id,
                        location: '教室 C',
                        student_name: '学生丙',
                        schedule_type: '试听'
                    }
                ]);
            }

            const dateExpr = await getDateExpr('ca');
            await initSchemaCache();

            let query = `
                SELECT 
                    ca.id,
                    ${dateExpr} AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.teacher_id, ca.location,
                    st.name as student_name,
                    sty.name as schedule_type,
                    sty.description as schedule_type_cn
                FROM course_arrangement ca
                JOIN students st ON ca.student_id = st.id
                JOIN schedule_types sty ON ca.course_id = sty.id
                JOIN teachers t ON ca.teacher_id = t.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
            `;

            // 使用缓存的列信息而不是每次查询
            if (__schemaCache.teacherHasStatus) query += ` AND t.status = 1`;
            if (__schemaCache.studentHasStatus) query += ` AND st.status = 1`;

            const values = [req.user.id, startDate, endDate];

            query += ` ORDER BY date, ca.start_time`;
            if (limit) {
                query += ` LIMIT ${limit} OFFSET ${offset}`;
            }

            const result = await db.query(query, values);
            res.json(result.rows);
        } catch (error) {
            console.error('获取详细排课数据错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    // 修改密码
    async changePassword(req, res) {
        try {
            const bcrypt = require('bcrypt');
            const { currentPassword, newPassword } = req.body;

            // 验证输入
            if (!currentPassword || !newPassword) {
                return res.status(400).json({ message: '请提供当前密码和新密码' });
            }

            if (newPassword.length < 1) {
                return res.status(400).json({ message: '新密码不能为空' });
            }

            // 获取当前密码哈希
            const result = await db.query(
                'SELECT password_hash FROM teachers WHERE id = $1',
                [req.user.id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ message: '未找到教师信息' });
            }

            const currentPasswordHash = result.rows[0].password_hash;

            // 验证当前密码
            // 验证当前密码
            let isValidPassword = false;
            try {
                isValidPassword = await bcrypt.compare(currentPassword, currentPasswordHash);
            } catch (_) {
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
                'UPDATE teachers SET password_hash = $1 WHERE id = $2',
                [newPasswordHash, req.user.id]
            );

            // 记录审计
            try {
                const { recordAudit } = require('../middleware/audit');
                await recordAudit(req, {
                    op: 'change_password',
                    entityType: 'teacher',
                    entityId: req.user.id,
                    details: { success: true }
                });
            } catch (_) {
                // 忽略审计错误
            }

            res.json({ message: '密码修改成功' });
        } catch (error) {
            console.error('修改密码错误:', error.message);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 更新单个排课的费用
     * @param {string} req.params.id - 课程ID
     * @param {number} req.body.transport_fee - 交通费
     * @param {number} req.body.other_fee - 其他费用
     */
    async updateScheduleFees(req, res) {
        try {
            const { id } = req.params;
            const { transport_fee, other_fee } = req.body;

            const tFee = parseFloat(transport_fee) || 0;
            const oFee = parseFloat(other_fee) || 0;

            if (tFee < 0 || oFee < 0) {
                return res.status(400).json({ message: '费用不能为负数' });
            }

            // 获取原费用
            const originalResult = await db.query(
                'SELECT transport_fee, other_fee FROM course_arrangement WHERE id = $1',
                [id]
            );

            if (originalResult.rows.length === 0) {
                return res.status(404).json({ message: '课程不存在' });
            }

            const { transport_fee: old_t_fee, other_fee: old_o_fee } = originalResult.rows[0];

            // 开启事务记录费用并审计
            await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);

                await q(
                    `UPDATE course_arrangement 
                     SET transport_fee = $1, other_fee = $2, updated_at = CURRENT_TIMESTAMP
                     WHERE id = $3`,
                    [tFee, oFee, id]
                );

                // 强制检查表是否存在
                const tableCheck = await q(`
                    SELECT table_name 
                    FROM information_schema.tables 
                    WHERE table_schema = 'public' 
                      AND table_name = 'fee_audit_logs'
                `);

                if (tableCheck.rows.length > 0) {
                    await q(
                        `INSERT INTO fee_audit_logs 
                        (schedule_id, operator_id, operator_role, old_transport_fee, new_transport_fee, old_other_fee, new_other_fee)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [id, req.user.id, 'teacher', old_t_fee, tFee, old_o_fee, oFee]
                    );
                }
            });

            res.json({ message: '费用更新成功', transport_fee: tFee, other_fee: oFee });
        } catch (error) {
            console.error('更新费用错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 获取班主任关联学生的所有排课
     */
    async getHeadTeacherStudentSchedules(req, res) {
        try {
            const { startDate, endDate } = req.query;

            // 获取教师信息和绑定的学生 ID
            const teacherResult = await db.query('SELECT student_ids FROM teachers WHERE id = $1', [req.user.id]);
            if (teacherResult.rows.length === 0) {
                return res.status(404).json({ message: '未找到教师信息' });
            }

            const studentIdsStr = teacherResult.rows[0].student_ids;
            if (!studentIdsStr) {
                return res.json({ students: [], schedules: [] }); // 没有绑定学生
            }

            // 解析绑定学生IDs
            const studentIds = studentIdsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
            if (studentIds.length === 0) {
                return res.json({ students: [], schedules: [] });
            }

            // 查询所有关联学生的基本信息（即使没有排课也要显示）
            const studentsResult = await db.query(
                `SELECT id, name FROM students WHERE id = ANY($1::int[]) ORDER BY id`,
                [studentIds]
            );
            const students = studentsResult.rows;

            const dateExpr = await getDateExpr('ca');

            // 查询关联学生的所有课程，过滤掉已取消的
            let query = `
                SELECT 
                    ca.id,
                    ${dateExpr} AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.location, ca.transport_fee, ca.other_fee,
                    t.name as teacher_name, t.id as teacher_id,
                    st.name as student_name, st.id as student_id,
                    sty.name as schedule_type, sty.description as schedule_type_cn
                FROM course_arrangement ca
                JOIN students st ON ca.student_id = st.id
                JOIN schedule_types sty ON ca.course_id = sty.id
                JOIN teachers t ON ca.teacher_id = t.id
                WHERE ca.student_id = ANY($1::int[])
                  AND ${dateExpr} BETWEEN $2 AND $3
                ORDER BY date, ca.start_time
            `;

            const result = await db.query(query, [studentIds, startDate, endDate]);
            res.json({ students, schedules: result.rows });
        } catch (error) {
            console.error('获取班主任学生排课错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 批量更新排课费用
     * @param {Array} req.body.updates - [{ id, transport_fee, other_fee }]
     */
    async batchUpdateScheduleFees(req, res) {
        try {
            const { updates } = req.body;
            if (!updates || !Array.isArray(updates) || updates.length === 0) {
                return res.status(400).json({ message: '无可更新内容' });
            }

            await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);

                // 检查表是否存在
                const tableCheck = await q(`
                    SELECT table_name 
                    FROM information_schema.tables 
                    WHERE table_schema = 'public' 
                      AND table_name = 'fee_audit_logs'
                `);
                const hasAuditTable = tableCheck.rows.length > 0;

                for (const item of updates) {
                    const id = item.id;
                    const tFee = parseFloat(item.transport_fee) || 0;
                    const oFee = parseFloat(item.other_fee) || 0;

                    if (tFee < 0 || oFee < 0) throw new Error(`排课 ID ${id} 包含负数费用`);

                    const originalResult = await q(
                        'SELECT transport_fee, other_fee FROM course_arrangement WHERE id = $1',
                        [id]
                    );

                    if (originalResult.rows.length === 0) continue;

                    const { transport_fee: old_t_fee, other_fee: old_o_fee } = originalResult.rows[0];

                    if (parseFloat(old_t_fee) === tFee && parseFloat(old_o_fee) === oFee) {
                        continue; // No changes
                    }

                    await q(
                        `UPDATE course_arrangement 
                         SET transport_fee = $1, other_fee = $2, updated_at = CURRENT_TIMESTAMP
                         WHERE id = $3`,
                        [tFee, oFee, id]
                    );

                    if (hasAuditTable) {
                        await q(
                            `INSERT INTO fee_audit_logs 
                            (schedule_id, operator_id, operator_role, old_transport_fee, new_transport_fee, old_other_fee, new_other_fee)
                            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                            [id, req.user.id, 'teacher_batch', old_t_fee, tFee, old_o_fee, oFee]
                        );
                    }
                }
            });

            res.json({ message: '批量更新费用成功' });
        } catch (error) {
            console.error('批量更新费用错误:', error);
            res.status(500).json({ message: error.message || '服务器错误' });
        }
    },

    /**
     * 获取班主任分配的学生列表
     */
    async getAssociatedStudents(req, res) {
        try {
            const teacherId = req.user.id;
            const teacherResult = await db.query('SELECT student_ids FROM teachers WHERE id = $1', [teacherId]);
            if (teacherResult.rows.length === 0) {
                return res.status(404).json(standardResponse(false, null, '未找到教师信息'));
            }

            const studentIdsStr = teacherResult.rows[0].student_ids || '';
            const studentIds = studentIdsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

            if (studentIds.length === 0) {
                return res.json(standardResponse(true, [], '未绑定学生'));
            }

            const studentsResult = await db.query(
                'SELECT id, name FROM students WHERE id = ANY($1::int[]) ORDER BY name',
                [studentIds]
            );
            res.json(standardResponse(true, studentsResult.rows, '获取学生列表成功'));
        } catch (error) {
            console.error('获取关联学生列表错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 获取所有教师列表 (用于班主任导出筛选)
     */
    async getAllTeachers(req, res) {
        try {
            const result = await db.query(
                `SELECT id, name FROM teachers WHERE status != -1 ORDER BY name`
            );
            res.json(standardResponse(true, result.rows, '获取教师列表成功'));
        } catch (error) {
            console.error('获取教师列表错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 班主任导出其关联的学生数据
     */
    async exportHeadTeacherStudentData(req, res) {
        try {
            const { startDate, endDate, student_id, teacher_id } = req.query;
            const myTeacherId = req.user.id;

            // 1. 获取并验证权限：这些学生是否真的归该班主任管
            const teacherResult = await db.query('SELECT student_ids FROM teachers WHERE id = $1', [myTeacherId]);
            if (teacherResult.rows.length === 0) {
                return res.status(404).json(standardResponse(false, null, '未找到教师信息'));
            }

            const allowedStudentIdsStr = teacherResult.rows[0].student_ids || '';
            const allowedStudentIds = allowedStudentIdsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

            if (allowedStudentIds.length === 0) {
                return res.status(400).json(standardResponse(false, null, '您未绑定任何学生，无法导出数据'));
            }

            // 2. 确定最终要查询的学生范围
            let studentIdsToQuery = allowedStudentIds;
            if (student_id) {
                const sId = parseInt(student_id);
                if (!allowedStudentIds.includes(sId)) {
                    return res.status(403).json(standardResponse(false, null, '您无权导出该学生的数据'));
                }
                studentIdsToQuery = [sId];
            }

            // 3. 构建过滤后的排课记录
            const exportService = new AdvancedExportService(db);

            // 验证日期范围
            try {
                if (!startDate || !endDate) throw new Error('开始日期和结束日期不能为空');
                exportService.validateDateRange(startDate, endDate);
            } catch (vError) {
                return res.status(400).json(standardResponse(false, null, vError.message));
            }

            const dateExpr = await getDateExpr('ca');
            let sql = `
                SELECT 
                    ca.id as schedule_id,
                    ca.teacher_id,
                    t.name as teacher_name,
                    ca.student_id,
                    s.name as student_name,
                    ${dateExpr}::date as date,
                    ca.start_time,
                    ca.end_time,
                    (TO_CHAR(ca.start_time, 'HH24:MI') || '-' || TO_CHAR(ca.end_time, 'HH24:MI')) as time_range,
                    ca.location,
                    st.id as course_id,
                    st.name as type_name,
                    COALESCE(st.description, st.name) as type_desc,
                    ca.status,
                    ca.teacher_comment as notes,
                    ca.created_at,
                    ca.updated_at,
                    ca.last_auto_update,
                    ca.created_by,
                    ca.transport_fee,
                    ca.other_fee,
                    ca.family_participants,
                    ca.teacher_rating,
                    ca.student_rating,
                    ca.student_comment
                FROM course_arrangement ca
                LEFT JOIN teachers t ON ca.teacher_id = t.id
                LEFT JOIN students s ON ca.student_id = s.id
                LEFT JOIN schedule_types st ON ca.course_id = st.id
                WHERE ${dateExpr}::date BETWEEN $1 AND $2
                AND ca.student_id = ANY($3::int[])
            `;

            const params = [startDate, endDate, studentIdsToQuery];

            if (teacher_id) {
                params.push(parseInt(teacher_id));
                sql += ` AND ca.teacher_id = $${params.length}`;
            }

            sql += ` ORDER BY ${dateExpr} DESC, ca.start_time ASC`;

            const result = await db.query(sql, params);
            const rawData = result.rows || [];

            if (rawData.length === 0) {
                return res.json(standardResponse(true, [], '没有找到匹配的记录'));
            }

            // 4. 格式化原始数据（与管理员端 exportTeacherSchedule 格式一致）
            const exportData = rawData.map(row => ({
                schedule_id: row.schedule_id,
                teacher_id: row.teacher_id,
                teacher_name: row.teacher_name || '',
                student_id: row.student_id,
                student_name: row.student_name || '',
                date: row.date,
                start_time: row.start_time,
                end_time: row.end_time,
                time_range: row.time_range,
                location: row.location || '',
                type: row.type_name || '',
                type_desc: row.type_desc || '',
                status: row.status,
                notes: row.notes || '',
                created_at: row.created_at,
                updated_at: row.updated_at || null,
                last_auto_update: row.last_auto_update || null,
                created_by: row.created_by || null,
                transport_fee: row.transport_fee,
                other_fee: row.other_fee,
                course_id: row.course_id,
                family_participants: row.family_participants,
                teacher_rating: row.teacher_rating,
                teacher_comment: row.notes || '',
                student_rating: row.student_rating,
                student_comment: row.student_comment || ''
            }));

            // 5. 生成文件名：[学生姓名]上课记录_[日期段]by[教师ID]_时间戳
            let studentNameForFilename = '全部学生';
            if (student_id) {
                const studentResult = await db.query('SELECT name FROM students WHERE id = $1', [parseInt(student_id)]);
                if (studentResult.rows.length > 0) {
                    studentNameForFilename = studentResult.rows[0].name;
                }
            }

            const dateRangeStr = `${startDate.replace(/-/g, '')}-${endDate.replace(/-/g, '')}`;
            const timestamp = exportService.getTimestamp();
            const filename = `[${studentNameForFilename}]上课记录_${dateRangeStr}by${myTeacherId}_${timestamp}.xlsx`;

            // 6. 记录审计日志
            try {
                const { recordAudit } = require('../middleware/audit');
                await recordAudit(req, {
                    op: 'export_headteacher_students_advanced',
                    entityType: 'teacher',
                    entityId: Number(myTeacherId),
                    details: {
                        startDate,
                        endDate,
                        studentId: student_id || 'all',
                        teacherId: teacher_id || 'all',
                        recordCount: rawData.length
                    }
                });
            } catch (auditError) {
                console.warn('记录班主任导出审计日志失败:', auditError.message);
            }

            res.json({
                success: true,
                data: exportData,
                filename: filename,
                format: 'excel',
                recordCount: exportData.length
            });

        } catch (error) {
            console.error('班主任导出学生数据错误:', error);
            res.status(500).json(standardResponse(false, null, '导出数据失败，请稍后重试'));
        }
    }

};

module.exports = teacherController;
