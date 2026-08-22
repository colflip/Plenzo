const logger = require('../utils/logger.js');
const db = require('../db/db');
const AdvancedExportService = require('../services/advanced-export-service');
const { standardResponse } = require('../middleware/validation');
const { handleExportError, ExportError } = require('../middleware/export-error-handler');
const ExportLogService = require('../utils/export-log-service');
const { resolveActor } = require('../utils/feeStatus');
const FeeService = require('../services/fee-service');
const SchemaHelper = require('../utils/schema-helper');
const scheduleService = require('../services/schedule-service');
const headTeacherService = require('../services/head-teacher-service');
const exportService = require('../services/export-service');
const {
    SLOT_COLUMNS,
    normalizeSlotKey,
    isValidDateString,
    normalizeSlotValue,
    collectAvailabilityUpdates,
    mapRowToAvailability,
    getTeacherAvailability,
    setTeacherAvailability,
    deleteTeacherAvailability,
    replaceTeacherAvailability
} = require('../services/availability-service');

// 空闲时段纯函数与读写事务逻辑已下沉至 services/availability-service.js（见 D1-4）

const teacherController = {
    // 获取个人信息
    async getProfile(req, res) {
        try {
            const availableCols = await SchemaHelper.getColumns('teachers', ['status', 'last_login', 'created_at', 'student_ids', 'nickname']);
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
            logger.error('获取教师信息错误:', error);
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
            logger.error('更新教师信息错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 高级导出（供直接获取多Sheet Excel文件）
     */
    async advancedExport(req, res) {
        try {
            const teacherId = req.user.id;
            const teacherName = req.user.name || req.user.username || '教师';
            const { startDate, endDate } = req.query;
            const out = await exportService.runRoleScheduleExport({
                startDate,
                endDate,
                userId: teacherId,
                userType: 'teacher',
                userName: teacherName,
                teacherId,
                exportType: 'teacher_schedule',
                studentName: '全部学生',
                queryRawData: () => new AdvancedExportService(db).queryTeacherSchedule(startDate, endDate, { teacher_id: teacherId })
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

    // 获取时间安排
    /**
     * 获取指定日期范围的时间安排
     */
    async getAvailability(req, res) {
        try {
            const { startDate, endDate } = req.query;
            const data = await getTeacherAvailability(db, req.user.id, startDate, endDate);
            res.json(data);
        } catch (error) {
            logger.error('获取时间安排错误:', error);
            res.status(503).json({ message: '数据库暂时不可用，请稍后重试' });
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

            const { insertCount, updateCount, unchangedCount } = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                return await setTeacherAvailability(q, req.user.id, availabilityList);
            });

            res.json({
                message: '时间安排更新成功',
                insertCount,
                updateCount,
                unchangedCount
            });
        } catch (error) {
            logger.error('设置时间安排错误:', error);
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

            const { updateCount, deleteCount } = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                return await deleteTeacherAvailability(q, req.user.id, operations);
            });

            res.json({
                message: '时间安排删除成功',
                updateCount,
                deleteCount
            });
        } catch (error) {
            logger.error('删除时间安排错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    // R2（选项 B）：原子保存教师空闲时段。
    // 单个事务内 upsert 提及的 updates、DELETE 提及的 removals；
    // 范围内未提及的已有记录一律保留（与现有两段式行为一致，不误删管理员代设记录）。
    async replaceAvailability(req, res) {
        try {
            const body = req.body || {};
            const updates = Array.isArray(body.updates) ? body.updates : [];
            const removals = Array.isArray(body.removals) ? body.removals : [];

            if (!updates.length && !removals.length) {
                return res.status(400).json({ message: '缺少需要保存的时间安排' });
            }

            const { insertCount, updateCount, deleteCount } = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                return await replaceTeacherAvailability(q, req.user.id, { updates, removals });
            });

            res.json({
                message: '时间安排已保存',
                insertCount,
                updateCount,
                deleteCount
            });
        } catch (error) {
            logger.error('原子保存时间安排错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    // 获取课程安排
    async getSchedules(req, res) {
        const out = await scheduleService.teacherListSchedules(req);
        return res.status(out.status).json(out.body);
    },

    /**
     * 确认课程
     * @description 教师确认指定课程，更新课程状态为已确认
     * @param {Object} req.params.id - 课程ID
     * @param {Object} req.body.teacherConfirmed - 是否确认
     * @param {Object} req.body.notes - 备注信息
     */
    async confirmSchedule(req, res) {
        const out = await scheduleService.teacherConfirmSchedule(req);
        return res.status(out.status).json(out.body);
    },

    /**
     * 更新课程状态
     * @description 教师更新指定课程的状态（pending/confirmed/completed/cancelled）
     * @param {Object} req.params.id - 课程ID
     * @param {Object} req.body.status - 新状态
     * @param {Object} req.body.notes - 备注信息
     */
    async updateScheduleStatus(req, res) {
        const out = await scheduleService.teacherUpdateScheduleStatus(req);
        return res.status(out.status).json(out.body);
    },

    /**
     * 获取统计数据
     * @description 获取教师在指定日期范围的排课统计（按类型、按日、按月）
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     */
    async getStatistics(req, res) {
        const out = await scheduleService.teacherStatistics(req);
        return res.status(out.status).json(out.body);
    },

    // 获取教师总览数据
    async getOverview(req, res) {
        const out = await scheduleService.teacherOverview(req);
        return res.status(out.status).json(out.body);
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
            logger.error('获取授课总数错误:', error);
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
        const out = await scheduleService.teacherGetDetailedSchedules(req);
        return res.status(out.status).json(out.body);
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
            logger.error('修改密码错误:', error.message);
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

            // 保留 null：空值/未传 = 未填写（NULL）；0 = 用户主动填 0；负数仍拒绝。
            const tFee = FeeService.parseFeeAmount(transport_fee);
            const oFee = FeeService.parseFeeAmount(other_fee);

            if ((tFee !== null && tFee < 0) || (oFee !== null && oFee < 0)) {
                return res.status(400).json({ message: '费用不能为负数' });
            }

            const originalResult = await db.query(
                'SELECT transport_fee, other_fee, student_id, teacher_id, fee_status FROM course_arrangement WHERE id = $1',
                [id]
            );
            if (originalResult.rows.length === 0) {
                return res.status(404).json({ message: '课程不存在' });
            }
            const row = originalResult.rows[0];
            const { transport_fee: old_t_fee, other_fee: old_o_fee } = row;

            // 操作身份：班主任（有绑定学生）限关联学生，普通教师限本人课时
            const actor = await resolveActor(db, req.user.id);
            const scopeMsg = FeeService.checkScheduleScope(actor, row, id);
            if (scopeMsg) return res.status(403).json({ message: scopeMsg });

            // 事务内更新费用 + 审计 + 「保存并提交」自动流转（教师端 → 待审核）
            // 仅本次填写了费用的记录改状态；留空 / 清除费用不动状态（只改金额）
            const feeStatus = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                await FeeService.updateScheduleFeesInTx(q, id, {
                    tFee, oFee, oldTFee: old_t_fee, oldOFee: old_o_fee,
                    operatorId: req.user.id, operatorRole: 'teacher'
                });
                if (!FeeService.hasFilledFee(tFee, oFee)) return row.fee_status;
                const auto = await FeeService.autoSubmitFeeStatus(q, {
                    id, from: row.fee_status, actorType: actor.actorType, operatorId: req.user.id
                });
                return auto.fee_status;
            });

            res.json({ message: '费用更新成功', transport_fee: tFee, other_fee: oFee, fee_status: feeStatus });
        } catch (error) {
            logger.error('更新费用错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 获取班主任关联学生的所有排课
     */
    async getHeadTeacherStudentSchedules(req, res) {
        const out = await scheduleService.teacherGetHeadTeacherStudentSchedules(req);
        return res.status(out.status).json(out.body);
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

            // 解析操作身份：班主任（有绑定学生）仅能操作关联学生；普通教师仅能操作本人课时
            const actor = await resolveActor(db, req.user.id);

            const result = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                // 「保存并提交」：教师端（普通教师 / 班主任）提交后自动进入待审核
                return await FeeService.batchUpdateScheduleFeesInTx(q, updates, {
                    actor, operatorId: req.user.id, autoSubmitActorType: actor.actorType
                });
            });

            res.json({
                message: '批量更新费用成功',
                changed: result.changed,
                submitted: result.submitted
            });
        } catch (error) {
            logger.error('批量更新费用错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 教师/班主任更新单条排课的费用报销状态
     * 授权：班主任（student_ids 非空）可操作其关联学生、任意流转；普通教师仅能操作本人课时，
     *       且仅允许 待提交→待审核 / 已退回→待审核。越权或非法流转返回 403/400。
     */
    async updateScheduleFeeStatus(req, res) {
        try {
            const { id } = req.params;
            const { fee_status: target, note } = req.body;
            if (!target) return res.status(400).json({ message: '缺少目标状态' });

            const actor = await resolveActor(db, req.user.id);
            const cur = await db.query(
                'SELECT fee_status, student_id, teacher_id FROM course_arrangement WHERE id = $1',
                [id]
            );
            if (cur.rows.length === 0) return res.status(404).json({ message: '排课不存在' });

            const row = cur.rows[0];
            // 范围校验：班主任限关联学生，普通教师限本人课时
            const scopeMsg = FeeService.checkScheduleScope(actor, row, id);
            if (scopeMsg) return res.status(403).json({ message: scopeMsg });

            const from = row.fee_status;
            const result = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                return await FeeService.transitionFeeStatus(q, {
                    id, from, target, note, operatorId: req.user.id, actorType: actor.actorType
                });
            });
            if (!result.ok) return res.status(400).json({ message: result.error });

            res.json({ message: '费用状态已更新', fee_status: target });
        } catch (error) {
            logger.error('教师更新费用状态错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 教师/班主任批量更新费用报销状态
     * 授权同 updateScheduleFeeStatus；范围支持 ids 列表或 scope 日期范围（班主任限关联学生）。
     */
    async batchUpdateScheduleFeeStatus(req, res) {
        try {
            const { ids, scope, fee_status: target, note, skipStatus } = req.body;
            if (!target) return res.status(400).json({ message: '缺少目标状态' });

            const actor = await resolveActor(db, req.user.id);

            let targetIds = [];
            if (Array.isArray(ids) && ids.length) {
                targetIds = ids.map(Number).filter(n => !Number.isNaN(n));
            } else if (scope && scope.startDate && scope.endDate) {
                const dateExpr = await SchemaHelper.getDateExpr('ca');
                let sql = `SELECT id, fee_status, student_id FROM course_arrangement ca WHERE ${dateExpr} BETWEEN $1 AND $2`;
                const params = [scope.startDate, scope.endDate];
                if (scope.fee_status) { sql += ` AND ca.fee_status = $3`; params.push(scope.fee_status); }
                if (actor.actorType === 'headteacher') {
                    sql += ` AND ca.student_id = ANY($${params.length + 1}::int[])`;
                    params.push(actor.studentIds);
                } else {
                    sql += ` AND ca.teacher_id = $${params.length + 1}`;
                    params.push(req.user.id);
                }
                const r = await db.query(sql, params);
                targetIds = r.rows.map(x => x.id);
            } else {
                return res.status(400).json({ message: '请提供 ids 或 scope 范围' });
            }

            if (!targetIds.length) return res.json({ message: '没有符合条件的排课', updated: 0 });

            const updated = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                // 复用共享批量流转原语：逐条范围授权（越权跳过）+ 状态机校验 + 审计
                return await FeeService.batchTransitionFeeStatus(q, {
                    targetIds, target, note, operatorId: req.user.id,
                    actorType: actor.actorType, skipStatus, actor
                });
            });

            res.json({ message: `已更新 ${updated} 条排课的费用状态`, updated });
        } catch (error) {
            logger.error('教师批量更新费用状态错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 获取教师关联/有排课记录的学生列表
     * @description 当传入 startDate/endDate 时，查询该时间段内有排课记录的学生；
     *              否则返回班主任绑定的学生列表（向下兼容）
     */
    async getAssociatedStudents(req, res) {
        const out = await headTeacherService.getAssociatedStudents(req);
        return res.status(out.status).json(out.body);
    },

    /**
     * 获取关联学生详细信息列表
     */
    async getAssociatedStudentsDetail(req, res) {
        const out = await headTeacherService.getAssociatedStudentsDetail(req);
        return res.status(out.status).json(out.body);
    },

    /**
     * 更新关联学生信息
     */
    async updateAssociatedStudent(req, res) {
        const out = await headTeacherService.updateAssociatedStudent(req);
        return res.status(out.status).json(out.body);
    },

    /**
     * 获取所有教师列表 (用于班主任导出筛选)
     */
    async getAllTeachers(req, res) {
        const out = await headTeacherService.getAllTeachers(req);
        return res.status(out.status).json(out.body);
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
                logger.warn('记录导出开始日志失败:', logError.message);
            }

            // 3. 构建过滤后的排课记录
            const advancedExporter = new AdvancedExportService(db);

            // 验证日期范围
            try {
                advancedExporter.validateDateRange(startDate, endDate);
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

            // 6-7. 使用统一导出服务生成完整的多Sheet Excel（unified + excel 合并）
            const excelResult = await exportService.generateExcelFromData(formattedData, {
                startDate,
                endDate,
                userType: 'teacher_homeroom',  // 班主任角色
                userId: myTeacherId,
                userName: teacherName,
                teacherId: teacher_id ? parseInt(teacher_id) : null,
                studentId: student_id ? parseInt(student_id) : null,
                studentName: studentNameForFilename
            });

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
                    logger.warn('记录导出成功日志失败:', logError.message);
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
                logger.warn('记录班主任导出审计日志失败:', auditError.message);
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
                    logger.warn('记录导出错误日志失败:', logError.message);
                }
            }

            return handleExportError(error, req, res);
        }
    }

};

module.exports = teacherController;
