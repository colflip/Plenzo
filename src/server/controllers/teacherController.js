const db = require('../db/db');
const AdvancedExportService = require('../services/advancedExportService');
const excelGenerator = require('../services/excelGeneratorService');
const { standardResponse } = require('../middleware/validation');
const { handleExportError, ExportError } = require('../middleware/exportErrorHandler');
const ExportLogService = require('../utils/exportLogService');

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

const SchemaHelper = require('../utils/schemaHelper');

const teacherController = {
    // 获取个人信息
    async getProfile(req, res) {
        try {
            const columnResult = await db.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'teachers'
                    AND column_name IN ('status','last_login','created_at','student_ids','nickname')
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
            if (availableCols.has('nickname')) {
                selectCols.push('nickname');
            }
            if (availableCols.has('status')) {
                selectCols.push('status');
            }
            if (availableCols.has('last_login')) {
                selectCols.push('last_login');
            }
            if (availableCols.has('created_at')) {
                selectCols.push('created_at');
            }
            if (availableCols.has('student_ids')) {
                selectCols.push('student_ids');
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
            const { name, profession, contact, work_location, home_address, status, nickname } = req.body;

            // 自助修改状态：仅允许设置为 -1/0/1
            let sets = ['name = $1', 'profession = $2', 'contact = $3', 'work_location = $4', 'home_address = $5'];
            let values = [name, profession, contact, work_location, home_address];
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
                `UPDATE teachers
                SET ${sets.join(', ')}
                WHERE id = $${vi}
                RETURNING id, username, name, nickname, profession, contact, work_location, home_address, status`,
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
     * 高级导出（供直接获取多Sheet Excel文件）
     */
    async advancedExport(req, res) {
        let logId = null;
        const startTime = Date.now();
        const logService = new ExportLogService(db);

        try {
            const teacherId = req.user.id;
            const teacherName = req.user.name || req.user.username || '教师';
            const { startDate, endDate } = req.query;

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
                    userId: teacherId,
                    userType: 'teacher',
                    startDate,
                    endDate,
                    teacherId: teacherId,
                    exportType: 'teacher_schedule'
                });
            } catch (logError) {
                console.warn('记录导出开始日志失败:', logError.message);
            }

            // 1. 查询原始数据（只查询当前教师的数据）
            const exportService = new AdvancedExportService(db);
            const rawData = await exportService.queryTeacherSchedule(startDate, endDate, {
                teacher_id: teacherId
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
                userType: 'teacher',
                userId: teacherId,
                userName: teacherName,
                teacherId: teacherId,
                studentName: '全部学生'
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

            const dateExpr = await SchemaHelper.getDateExpr('ca');

            let query = `
                SELECT
                    ca.id,
                    ${dateExpr} AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.teacher_id, ca.location,
                    ca.transport_fee, ca.other_fee,
                    ca.adjustment_type,
                    ca.adjustment_type AS is_temp,
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

            if (await SchemaHelper.hasColumn('teachers', 'status')) query += ` AND t.status = 1`;
            if (await SchemaHelper.hasColumn('students', 'status')) query += ` AND st.status = 1`;

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
                    if (studentIds.includes(Number(student_id))) {
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
            const dateExpr = await SchemaHelper.getDateExpr('ca');

            // 三个查询相互独立，使用 Promise.all 并行执行，
            // 减少 Neon serverless 多次往返带来的累计延迟
            const [typeStatsResult, dailyStatsResult, monthlyStatsResult] = await Promise.all([
                db.query(`
                SELECT
                    COALESCE(sty.description, sty.name) as type,
                    COUNT(*) as count
                FROM course_arrangement ca
                JOIN schedule_types sty ON ca.course_id = sty.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', '0', 'modified_away')
                GROUP BY COALESCE(sty.description, sty.name)
                ORDER BY count DESC
            `, [req.user.id, startDate, endDate]),

                db.query(`
                SELECT
                    to_char(DATE_TRUNC('day', ${dateExpr}), 'YYYY-MM-DD') as date,
                    COALESCE(sty.description, sty.name) as type,
                    COUNT(*) as count
                FROM course_arrangement ca
                JOIN schedule_types sty ON ca.course_id = sty.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', '0', 'modified_away')
                GROUP BY DATE_TRUNC('day', ${dateExpr}), COALESCE(sty.description, sty.name)
                ORDER BY date, count DESC
            `, [req.user.id, startDate, endDate]),

                db.query(`
                SELECT
                    DATE_TRUNC('month', ${dateExpr}) as month,
                    COUNT(*) as count
                FROM course_arrangement ca
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', '0', 'modified_away')
                GROUP BY DATE_TRUNC('month', ${dateExpr})
                ORDER BY month
            `, [req.user.id, startDate, endDate])
            ]);

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
            const teacherHasStatus = await SchemaHelper.hasColumn('teachers', 'status');
            const studentHasStatus = await SchemaHelper.hasColumn('students', 'status');

            // Unified Query for all 6 metrics
            const statsResult = await db.query(`
                SELECT
                    SUM(CASE WHEN ${dateExpr} BETWEEN $2 AND $3 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as weekly_count,
                    SUM(CASE WHEN ${dateExpr} BETWEEN $4 AND $5 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as monthly_count,
                    SUM(CASE WHEN ${dateExpr} BETWEEN $6 AND $7 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as yearly_count,
                    SUM(CASE WHEN ca.status = 'pending' THEN 1 ELSE 0 END)::int as total_pending,
                    SUM(CASE WHEN ca.status = 'completed' THEN 1 ELSE 0 END)::int as total_completed,
                    SUM(CASE WHEN ca.status = 'cancelled' THEN 1 ELSE 0 END)::int as total_cancelled
                FROM course_arrangement ca
                ${teacherHasStatus ? 'JOIN teachers t ON ca.teacher_id = t.id' : ''}
                WHERE ca.teacher_id = $1
                  ${teacherHasStatus ? 'AND t.status = 1' : ''}
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
                    ca.adjustment_type AS is_temp,
                    s.name as student_name,
                    sty.name as schedule_type
                FROM course_arrangement ca
                JOIN students s ON ca.student_id = s.id
                LEFT JOIN schedule_types sty ON ca.course_id = sty.id
                JOIN teachers t ON ca.teacher_id = t.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} = $2
            `;

            if (teacherHasStatus) todayQuery += ` AND t.status = 1`;
            if (studentHasStatus) todayQuery += ` AND s.status = 1`;

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

            const dateExpr = await SchemaHelper.getDateExpr('');
            const result = await db.query(`
                SELECT COUNT(*) as count
                FROM course_arrangement
                WHERE teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND status NOT IN ('cancelled', '0', 'modified_away')
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

            const dateExpr = await SchemaHelper.getDateExpr('ca');

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

            if (await SchemaHelper.hasColumn('teachers', 'status')) query += ` AND t.status = 1`;
            if (await SchemaHelper.hasColumn('students', 'status')) query += ` AND st.status = 1`;

            const values = [req.user.id, startDate, endDate];

            query += ` ORDER BY date, ca.start_time`;
            if (limit) {
                query += ` LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
                values.push(limit, offset);
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

            if (newPassword.length < 6) {
                return res.status(400).json({ message: '新密码长度不能少于6位' });
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

            const dateExpr = await SchemaHelper.getDateExpr('ca');

            // 查询关联学生的所有课程，过滤掉已取消的
            let query = `
                SELECT 
                    ca.id,
                    ${dateExpr} AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.location, ca.transport_fee, ca.other_fee,
                    ca.adjustment_type,
                    ca.adjustment_type AS is_temp,
                    t.name as teacher_name, t.id as teacher_id,
                    st.name as student_name, st.id as student_id,
                    sty.name as schedule_type, sty.description as schedule_type_cn
                FROM course_arrangement ca
                JOIN students st ON ca.student_id = st.id
                JOIN schedule_types sty ON ca.course_id = sty.id
                JOIN teachers t ON ca.teacher_id = t.id
                WHERE ca.student_id = ANY($1::int[])
                  AND ${dateExpr} BETWEEN $2 AND $3
            `;

            if (req.query.show_plan !== 'true') {
                query += ` AND NOT (ca.status = 'modified_away' AND COALESCE(ca.adjustment_type, 0) = 0)`;
            }

            query += ` ORDER BY date, ca.start_time`;

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
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 获取教师关联/有排课记录的学生列表
     * @description 当传入 startDate/endDate 时，查询该时间段内有排课记录的学生；
     *              否则返回班主任绑定的学生列表（向下兼容）
     */
    async getAssociatedStudents(req, res) {
        try {
            const teacherId = req.user.id;
            const { startDate, endDate } = req.query;

            // 有日期参数：查询该时间段内有排课记录的学生
            if (startDate && endDate) {
                const dateExpr = await SchemaHelper.getDateExpr('ca');
                const studentsResult = await db.query(`
                    SELECT DISTINCT s.id, s.name
                    FROM course_arrangement ca
                    JOIN students s ON ca.student_id = s.id
                    WHERE ca.teacher_id = $1
                      AND ${dateExpr}::date BETWEEN $2 AND $3
                    ORDER BY s.name
                `, [teacherId, startDate, endDate]);
                return res.json(standardResponse(true, studentsResult.rows, '获取学生列表成功'));
            }

            // 无日期参数：返回绑定的学生列表（向下兼容）
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
            console.error('获取学生列表错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 获取关联学生详细信息列表
     */
    async getAssociatedStudentsDetail(req, res) {
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
                `SELECT id, username, name, profession, contact, visit_location, home_address, status, last_login 
                 FROM students WHERE id = ANY($1::int[]) ORDER BY name`,
                [studentIds]
            );
            res.json(standardResponse(true, studentsResult.rows, '获取学生详细信息成功'));
        } catch (error) {
            console.error('获取关联学生详细信息错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 更新关联学生信息
     */
    async updateAssociatedStudent(req, res) {
        try {
            const teacherId = req.user.id;
            const studentId = req.params.id;
            const { name, profession, contact, visit_location, home_address, status } = req.body;

            if (!studentId) {
                return res.status(400).json(standardResponse(false, null, '缺少学生ID'));
            }

            const teacherResult = await db.query('SELECT student_ids FROM teachers WHERE id = $1', [teacherId]);
            if (teacherResult.rows.length === 0) {
                return res.status(404).json(standardResponse(false, null, '未找到教师信息'));
            }

            const studentIdsStr = teacherResult.rows[0].student_ids || '';
            const studentIds = studentIdsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

            if (!studentIds.includes(parseInt(studentId))) {
                return res.status(403).json(standardResponse(false, null, '无权修改该学生信息'));
            }

            let sets = ['name = $1', 'profession = $2', 'contact = $3', 'visit_location = $4', 'home_address = $5'];
            let values = [name, profession, contact, visit_location, home_address];
            let vi = 6;
            if (typeof status !== 'undefined') {
                const s = Number(status);
                if (![-1, 0, 1].includes(s)) {
                    return res.status(400).json(standardResponse(false, null, '非法状态值'));
                }
                sets.push(`status = $${vi++}`);
                values.push(s);
            }
            values.push(parseInt(studentId));

            const result = await db.query(
                `UPDATE students
                SET ${sets.join(', ')}
                WHERE id = $${vi}
                RETURNING id, username, name, profession, contact, visit_location, home_address, status`,
                values
            );

            if (result.rows.length === 0) {
                return res.status(404).json(standardResponse(false, null, '未找到学生信息'));
            }

            res.json(standardResponse(true, result.rows[0], '学生信息更新成功'));
        } catch (error) {
            console.error('更新关联学生信息错误:', error);
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
        let logId = null;
        const startTime = Date.now();
        const logService = new ExportLogService(db);

        try {
            const { startDate, endDate, student_id, teacher_id } = req.query;
            const myTeacherId = req.user.id;

            if (!startDate || !endDate) {
                return res.status(400).json(standardResponse(false, null, '缺少起止日期参数'));
            }

            // 1. 获取并验证权限：这些学生是否真的归该班主任管
            const teacherResult = await db.query('SELECT student_ids, name FROM teachers WHERE id = $1', [myTeacherId]);
            if (teacherResult.rows.length === 0) {
                return res.status(404).json(standardResponse(false, null, '未找到教师信息'));
            }

            const allowedStudentIdsStr = teacherResult.rows[0].student_ids || '';
            const teacherName = teacherResult.rows[0].name || '教师';
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

            // 记录导出开始
            try {
                logId = await logService.logExportStart({
                    userId: myTeacherId,
                    userType: 'teacher_homeroom',
                    startDate,
                    endDate,
                    studentId: student_id ? parseInt(student_id) : null,
                    teacherId: teacher_id ? parseInt(teacher_id) : null,
                    exportType: 'homeroom_students'
                });
            } catch (logError) {
                console.warn('记录导出开始日志失败:', logError.message);
            }

            // 3. 构建过滤后的排课记录
            const exportService = new AdvancedExportService(db);

            // 验证日期范围
            try {
                exportService.validateDateRange(startDate, endDate);
            } catch (vError) {
                return res.status(400).json(standardResponse(false, null, vError.message));
            }

            const dateExpr = await SchemaHelper.getDateExpr('ca');
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
                    ca.student_comment,
                    ca.adjustment_type AS is_temp
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

            sql += ` ORDER BY ${dateExpr}::date ASC, ca.start_time ASC`;

            const result = await db.query(sql, params);
            const rawData = result.rows || [];

            if (rawData.length === 0) {
                return res.status(404).json(standardResponse(false, null, '该时间段内无数据'));
            }

            // 4. 格式化原始数据（与管理员端格式一致）
            const formattedData = rawData.map(row => ({
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
                student_comment: row.student_comment || '',
                is_temp: row.is_temp
            }));

            // 5. 确定学生名称
            let studentNameForFilename = '全部关联学生';
            if (student_id) {
                const studentResult = await db.query('SELECT name FROM students WHERE id = $1', [parseInt(student_id)]);
                if (studentResult.rows.length > 0) {
                    studentNameForFilename = studentResult.rows[0].name;
                }
            }

            // 6. 使用统一服务生成完整的多Sheet数据
            const UnifiedExportService = require('../services/unifiedExportService');
            const unifiedService = new UnifiedExportService();
            const exportResult = await unifiedService.generateCompleteExport(formattedData, {
                startDate,
                endDate,
                userType: 'teacher_homeroom',  // 班主任角色
                userId: myTeacherId,
                userName: teacherName,
                teacherId: teacher_id ? parseInt(teacher_id) : null,
                studentId: student_id ? parseInt(student_id) : null,
                studentName: studentNameForFilename
            });

            // 7. 生成 Excel 文件
            const excelGeneratorService = require('../services/excelGeneratorService');
            const excelResult = await excelGeneratorService.generateMultiSheetExcel(
                exportResult.sheets,
                exportResult.filename
            );

            // 记录导出成功
            if (logId) {
                try {
                    await logService.logExportSuccess(logId, {
                        recordCount: formattedData.length,
                        fileSize: excelResult.buffer.length,
                        fileName: excelResult.filename,
                        duration: Date.now() - startTime
                    });
                } catch (logError) {
                    console.warn('记录导出成功日志失败:', logError.message);
                }
            }

            // 8. 记录审计日志
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

            // 9. 发送文件流
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
    }

};

module.exports = teacherController;
