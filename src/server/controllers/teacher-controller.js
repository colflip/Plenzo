const logger = require('../utils/logger.js');
const db = require('../db/db');
const { pipeline, scheduleQueries } = require('../services/export');
const { handleExportError } = require('../middleware/export-error-handler');
const ExportUtils = require('../utils/export-utils');
const { resolveActor, resolveAutoFeeStatus } = require('../utils/fee-status');
const FeeService = require('../services/fee-service');
const SchemaHelper = require('../utils/schema-helper');
const scheduleService = require('../services/schedule-service');
const headTeacherService = require('../services/head-teacher-service');
const courseSessionService = require('../services/course-session-service');

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

const { successResponse } = require('../utils/response');
const { statusToErrorCode } = require('../utils/http-status');
const { AppError, asyncHandler } = require('../middleware/error');

// 空闲时段纯函数与读写事务逻辑已下沉至 services/availability-service.js（见 D1-4）

const teacherController = {
    // 获取个人信息
    async getProfile(req, res, next) {
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
                throw new AppError({ code: statusToErrorCode(404), statusCode: 404, message: '未找到教师信息' });
            }

            const profile = result.rows[0];
            if (profile.last_login instanceof Date) {
                profile.last_login_iso = profile.last_login.toISOString();
            }
            res.json(successResponse(profile, { requestId: req.requestId }));
        } catch (error) {
            logger.error('获取教师信息错误:', error);
            throw error;
        }
    },

    // 更新个人信息
    async updateProfile(req, res, next) {
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
                    throw new AppError({ code: statusToErrorCode(400), statusCode: 400, message: '非法状态值' });
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

            // UPDATE ... RETURNING 无行返回说明该 id 不存在，不能当作更新成功返回 undefined
            if (!result.rows.length) {
                throw new AppError({ code: statusToErrorCode(404), statusCode: 404, message: '未找到教师信息' });
            }

            // 记录审计（若存在）
            try { const { recordAudit } = require('../middleware/audit'); await recordAudit(req, { op: 'update_status', entityType: 'teacher', entityId: req.user.id, details: { status } }); } catch (_) { }

            res.json(successResponse(result.rows[0], { requestId: req.requestId }));
        } catch (error) {
            logger.error('更新教师信息错误:', error);
            throw error;
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
            const out = await pipeline.runRoleScheduleExport({
                startDate,
                endDate,
                userId: teacherId,
                userType: 'teacher',
                userName: teacherName,
                teacherId,
                exportType: 'teacher_schedule',
                studentName: '全部学生',
                queryRawData: () => scheduleQueries.queryTeacherSchedule(startDate, endDate, { teacher_id: teacherId })
            });
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', ExportUtils.buildDownloadDisposition(out.filename, 'schedule-export'));
            res.setHeader('Content-Length', out.buffer.length);
            return res.end(out.buffer);
        } catch (error) {
            return handleExportError(error, req, res);
        }
    },

    // 获取时间安排
    /**
     * 获取指定日期范围的时间安排
     */
    async getAvailability(req, res, next) {
        try {
            const { startDate, endDate } = req.query;
            // 该路由没有 Joi 校验（同组的 POST/DELETE/PUT 都有）。缺日期时
            // date BETWEEN NULL AND NULL 恒为 NULL，会静默返回空数组，让人误以为「这期间没安排」。
            if (!startDate || !endDate) {
                throw new AppError({ code: statusToErrorCode(400), statusCode: 400, message: '缺少开始/结束日期' });
            }
            const data = await getTeacherAvailability(db, req.user.id, startDate, endDate);
            res.json(successResponse(data, { requestId: req.requestId }));
        } catch (error) {
            logger.error('获取时间安排错误:', error);
            throw error; // 保留原始错误，交由全局 errorHandler 按 code 精确映射状态
        }
    },

    // 设置时间安排
    /**
     * 批量设置时间安排
     */
    async setAvailability(req, res, next) {
        try {
            const { availabilityList } = req.body || {};
            const updatesByDate = collectAvailabilityUpdates(availabilityList);

            if (!updatesByDate.size) {
                throw new AppError({ code: statusToErrorCode(400), statusCode: 400, message: '缺少有效的时间安排数据' });
            }

            const { insertCount, updateCount, unchangedCount } = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                return await setTeacherAvailability(q, req.user.id, availabilityList);
            }, { allowDegraded: true });   // 单条多值 UPSERT 幂等：降级只失去「整批同生共死」

            res.json(successResponse({
                insertCount,
                updateCount,
                unchangedCount
            }, { requestId: req.requestId }));
        } catch (error) {
            logger.error('设置时间安排错误:', error);
            throw error;
        }
    },

    // 删除时间安排
    /**
     * 批量删除时间安排
     */
    async deleteAvailability(req, res, next) {
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
                throw new AppError({ code: statusToErrorCode(400), statusCode: 400, message: '缺少需要删除的时间安排记录' });
            }

            const { updateCount, deleteCount } = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                return await deleteTeacherAvailability(q, req.user.id, operations);
            }, { allowDegraded: true });   // 批量置位/删除空闲位，无跨表联动

            res.json(successResponse({
                updateCount,
                deleteCount
            }, { requestId: req.requestId }));
        } catch (error) {
            logger.error('删除时间安排错误:', error);
            throw error;
        }
    },

    // R2（选项 B）：原子保存教师空闲时段。
    // 单个事务内 upsert 提及的 updates、DELETE 提及的 removals；
    // 范围内未提及的已有记录一律保留（与现有两段式行为一致，不误删管理员代设记录）。
    async replaceAvailability(req, res, next) {
        try {
            const body = req.body || {};
            const updates = Array.isArray(body.updates) ? body.updates : [];
            const removals = Array.isArray(body.removals) ? body.removals : [];

            if (!updates.length && !removals.length) {
                throw new AppError({ code: statusToErrorCode(400), statusCode: 400, message: '缺少需要保存的时间安排' });
            }

            const { insertCount, updateCount, deleteCount } = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                return await replaceTeacherAvailability(q, req.user.id, { updates, removals });
            }, { allowDegraded: true });   // 同上：只写 teacher_daily_availability 一张表

            res.json(successResponse({
                insertCount,
                updateCount,
                deleteCount
            }, { requestId: req.requestId }));
        } catch (error) {
            logger.error('原子保存时间安排错误:', error);
            throw error;
        }
    },

    // 获取课程安排
    async getSchedules(req, res) {
        const data = await scheduleService.teacherListSchedules(req);
        res.json(successResponse(data, { requestId: req.requestId }));
    },

    /**
     * 确认课程
     * @description 教师确认指定课程，更新课程状态为已确认
     * @param {Object} req.params.id - 课程ID
     * @param {Object} req.body.teacherConfirmed - 是否确认
     * @param {Object} req.body.notes - 备注信息
     */
    async confirmSchedule(req, res) {
        const data = await scheduleService.teacherConfirmSchedule(req);
        res.json(successResponse(data, { requestId: req.requestId }));
    },

    /**
     * 更新课程状态
     * @description 教师更新指定课程的状态（pending/confirmed/completed/cancelled）
     * @param {Object} req.params.id - 课程ID
     * @param {Object} req.body.status - 新状态
     * @param {Object} req.body.notes - 备注信息
     */
    async updateScheduleStatus(req, res) {
        const data = await scheduleService.teacherUpdateScheduleStatus(req);
        res.json(successResponse(data, { requestId: req.requestId }));
    },

    /**
     * 获取统计数据
     * @description 获取教师在指定日期范围的排课统计（按类型、按日、按月）
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     */
    async getStatistics(req, res) {
        const data = await scheduleService.teacherStatistics(req);
        res.json(successResponse(data, { requestId: req.requestId }));
    },

    // 获取教师总览数据
    async getOverview(req, res) {
        const data = await scheduleService.teacherOverview(req);
        res.json(successResponse(data, { requestId: req.requestId }));
    },

    /**
     * 获取授课总数
     * @description 获取教师在指定日期范围的授课总数
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     */
    async getTeachingCount(req, res, next) {
        try {
            const { startDate, endDate } = req.query;

            // 授课数按「教师 × 学生」授课对计数（一师带 N 生算 N 次），
            // 这正是 v_session_pairs 展开后的行数；'0' 状态随旧表消失。
            const result = await db.query(`
                SELECT COUNT(*) as count
                FROM v_session_pairs
                WHERE teacher_id = $1
                  AND class_date BETWEEN $2 AND $3
                  AND status NOT IN ('cancelled', 'modified_away')
            `, [req.user.id, startDate, endDate]);

            const count = parseInt(result.rows[0].count, 10);

            res.json(successResponse({
                count,
                startDate,
                endDate
            }, { requestId: req.requestId }));
        } catch (error) {
            logger.error('获取授课总数错误:', error);
            throw error;
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
        const data = await scheduleService.teacherGetDetailedSchedules(req);
        res.json(successResponse(data, { requestId: req.requestId }));
    },

    // 修改密码
    async changePassword(req, res, next) {
        try {
            const bcrypt = require('bcrypt');
            const { currentPassword, newPassword } = req.body;

            // 验证输入
            if (!currentPassword || !newPassword) {
                throw new AppError({ code: statusToErrorCode(400), statusCode: 400, message: '请提供当前密码和新密码' });
            }

            if (newPassword.length < 6) {
                throw new AppError({ code: statusToErrorCode(400), statusCode: 400, message: '新密码长度不能少于6位' });
            }

            // 获取当前密码哈希
            const result = await db.query(
                'SELECT password_hash FROM teachers WHERE id = $1',
                [req.user.id]
            );

            if (result.rows.length === 0) {
                throw new AppError({ code: statusToErrorCode(404), statusCode: 404, message: '未找到教师信息' });
            }

            const currentPasswordHash = result.rows[0].password_hash;

            // 验证当前密码
            // 验证当前密码
            let isValidPassword = false;
            try {
                isValidPassword = await bcrypt.compare(currentPassword, currentPasswordHash);
            } catch (_) {
                throw new AppError({ code: statusToErrorCode(500), statusCode: 500, message: '密码验证失败' });
            }

            if (!isValidPassword) {
                throw new AppError({ code: statusToErrorCode(401), statusCode: 401, message: '当前密码不正确' });
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

            res.json(successResponse(null, { requestId: req.requestId }));
        } catch (error) {
            logger.error('修改密码错误:', error.message);
            throw error;
        }
    },

    /**
     * 更新单个排课的费用
     * @param {string} req.params.id - 课程ID
     * @param {number} req.body.transport_fee - 交通费
     * @param {number} req.body.other_fee - 其他费用
     * @param {string} [req.body.student_uid] - 学生 pair uid；传了就只写这一位学生那份
     *
     * 性能契约：**不再开启事务**。「费用更新」现是一条 UPDATE（金额 + 状态一次成型，
     * 见 fee-service.updateScheduleFeesInTx），金额审计与状态审计是「失败只告警」的旁路。
     * 包进事务反而多付 BEGIN + COMMIT 两次远程往返（≈500ms），并发并发也无一致性诉求。
     */
    async updateScheduleFees(req, res, next) {
        try {
            const { id } = req.params;
            const { transport_fee, other_fee, student_uid: studentUid } = req.body;

            // 保留 null：空值/未传 = 未填写（NULL）；0 = 用户主动填 0；负数仍拒绝。
            const tFee = FeeService.parseFeeAmount(transport_fee);
            const oFee = FeeService.parseFeeAmount(other_fee);

            if ((tFee !== null && tFee < 0) || (oFee !== null && oFee < 0)) {
                throw new AppError({ code: statusToErrorCode(400), statusCode: 400, message: '费用不能为负数' });
            }
            // 已报销 / 退回报销 不因编辑金额而回退（resolveAutoFeeStatus 内部已含此规则）
            const requestedTarget = FeeService.hasFilledFee(tFee, oFee) ? 'teacher_submitted' : null;

            // 费用挂在教师 pair 上（一趟一笔），所以定位需要「场次 id + teacher_uid」
            // 场次查询与操作身份解析互不依赖，并发省一次往返（约 250ms）
            const [session, actor] = await Promise.all([
                courseSessionService.getSessionById(id),
                resolveActor(db, req.user.id)
            ]);
            if (!session) {
                throw new AppError({ code: statusToErrorCode(404), statusCode: 404, message: '课程不存在' });
            }
            const teacherUid = req.params.uid || req.body.teacher_uid
                || (session.teachers || []).filter(p => Number(p.teacher_id) === Number(req.user.id)).map(p => p.uid)[0];
            const pair = FeeService.locateTeacherPair(session, teacherUid);
            if (!pair) {
                throw new AppError({ code: statusToErrorCode(404), statusCode: 404, message: '课程不存在' });
            }
            const row = pair;
            // 审计里的「改之前」按本次那一格取：带 student_uid 就是该学生那份，否则是整趟一笔
            const { transport_fee: old_t_fee, other_fee: old_o_fee } = FeeService.effectiveFeeOf(pair, studentUid);

            // 操作身份：班主任（有绑定学生）限关联学生，普通教师限本人 pair
            const scopeMsg = FeeService.checkScheduleScope(actor, { session, teacher: pair }, id);
            if (scopeMsg) throw new AppError({ code: statusToErrorCode(403), statusCode: 403, message: scopeMsg });

            // 无事务单条更新：金额与「保存并提交」自动流转（教师端 → 待审核）在一条
            // UPDATE 里完成（fee-service.updateScheduleFeesInTx），审计旁路并行落地。
            // 仅本次填写了费用的记录改状态；留空 / 清除费用不动状态（只改金额）。
            const targetStatus = requestedTarget
                ? resolveAutoFeeStatus(actor.actorType, row.fee_status)
                : null;

            await FeeService.updateScheduleFeesInTx(db.query, { sessionId: id, teacherUid: pair.uid }, {
                tFee, oFee, studentUid, oldTFee: old_t_fee, oldOFee: old_o_fee,
                targetStatus, oldStatus: row.fee_status, operatorId: req.user.id, operatorRole: 'teacher'
            });
            const feeStatus = targetStatus || row.fee_status;

            res.json(successResponse({ message: '费用更新成功', transport_fee: tFee, other_fee: oFee, fee_status: feeStatus }, { requestId: req.requestId }));
        } catch (error) {
            logger.error('更新费用错误:', error);
            throw error;
        }
    },

    /**
     * 获取班主任关联学生的所有排课
     */
    async getHeadTeacherStudentSchedules(req, res) {
        const data = await scheduleService.teacherGetHeadTeacherStudentSchedules(req);
        res.json(successResponse(data, { requestId: req.requestId }));
    },

    /**
     * 批量更新排课费用
     * @param {Array} req.body.updates - [{ id, teacher_uid?, student_uid?, transport_fee, other_fee }]
     */
    async batchUpdateScheduleFees(req, res, next) {
        try {
            const { updates } = req.body;
            if (!updates || !Array.isArray(updates) || updates.length === 0) {
                throw new AppError({ code: statusToErrorCode(400), statusCode: 400, message: '无可更新内容' });
            }

            // 解析操作身份：班主任（有绑定学生）仅能操作关联学生；普通教师仅能操作本人课时
            const actor = await resolveActor(db, req.user.id);

            const result = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                // 「保存并提交」：教师端（普通教师 / 班主任）提交后自动进入待审核
                return await FeeService.batchUpdateScheduleFeesInTx(q, updates, {
                    actor, operatorId: req.user.id, autoSubmitActorType: actor.actorType
                });
            });   // 不降级：越权在事务内 throw 整批回滚，降级会留下「已改一半」的费用

            res.json(successResponse({
                message: '批量更新费用成功',
                changed: result.changed,
                submitted: result.submitted
            }, { requestId: req.requestId }));
        } catch (error) {
            logger.error('批量更新费用错误:', error);
            // 业务规则以中文消息抛出，这里补上机器码；未知错误原样交给全局 errorHandler
            throw FeeService.toCanonicalFeeError(error);
        }
    },

    /**
     * 教师/班主任更新单条排课的费用报销状态
     * 授权：班主任（student_ids 非空）可操作其关联学生、任意流转；普通教师仅能操作本人课时，
     *       且仅允许 待提交→待审核 / 已退回→待审核。越权或非法流转返回 403/400。
     */
    async updateScheduleFeeStatus(req, res, next) {
        try {
            const { id } = req.params;
            const { fee_status: target, note } = req.body;
            if (!target) throw new AppError({ code: statusToErrorCode(400), statusCode: 400, message: '缺少目标状态' });

            // 身份解析与场次查询互不依赖，并发省一次往返（约 250ms）
            const [actor, session] = await Promise.all([
                resolveActor(db, req.user.id),
                courseSessionService.getSessionById(id)
            ]);
            if (!session) throw new AppError({ code: statusToErrorCode(404), statusCode: 404, message: '排课不存在' });

            const teacherUid = req.params.uid || req.body.teacher_uid
                || (session.teachers || []).filter(p => Number(p.teacher_id) === Number(req.user.id)).map(p => p.uid)[0];
            const pair = FeeService.locateTeacherPair(session, teacherUid);
            if (!pair) throw new AppError({ code: statusToErrorCode(404), statusCode: 404, message: '排课不存在' });

            // 范围校验：班主任限关联学生，普通教师限本人 pair
            const scopeMsg = FeeService.checkScheduleScope(actor, { session, teacher: pair }, id);
            if (scopeMsg) throw new AppError({ code: statusToErrorCode(403), statusCode: 403, message: scopeMsg });

            const from = pair.fee_status;
            const result = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                return await FeeService.transitionFeeStatus(q, {
                    sessionId: id, teacherUid: pair.uid, from, target, note,
                    operatorId: req.user.id, actorType: actor.actorType
                });
            }, { allowDegraded: true });   // 单 pair 状态：一条 UPDATE + 审计（审计失败不阻断）
            if (!result.ok) throw new AppError({ code: statusToErrorCode(400), statusCode: 400, message: result.error });

            res.json(successResponse({ message: '费用状态已更新', fee_status: target }, { requestId: req.requestId }));
        } catch (error) {
            logger.error('教师更新费用状态错误:', error);
            throw error;
        }
    },

    /**
     * 教师/班主任批量更新费用报销状态
     * 授权同 updateScheduleFeeStatus；范围支持 ids 列表或 scope 日期范围（班主任限关联学生）。
     */
    async batchUpdateScheduleFeeStatus(req, res, next) {
        try {
            const { ids, scope, fee_status: target, note, skipStatus } = req.body;
            if (!target) throw new AppError({ code: statusToErrorCode(400), statusCode: 400, message: '缺少目标状态' });

            const actor = await resolveActor(db, req.user.id);

            // 目标一律归一成 { session_id, teacher_uid }：费用挂在教师 pair 上
            let targets = [];
            if (Array.isArray(ids) && ids.length) {
                targets = ids.map(x => (typeof x === 'object'
                    ? { session_id: Number(x.session_id ?? x.id), teacher_uid: x.teacher_uid || null }
                    : { session_id: Number(x), teacher_uid: null }))
                    .filter(x => Number.isFinite(x.session_id));
            } else if (scope && scope.startDate && scope.endDate) {
                let sql = `SELECT vp.session_id, vp.teacher_uid FROM v_session_pairs vp
                            WHERE vp.class_date BETWEEN $1 AND $2`;
                const params = [scope.startDate, scope.endDate];
                if (scope.fee_status) { sql += ` AND vp.fee_status = $3`; params.push(scope.fee_status); }
                if (actor.actorType === 'headteacher') {
                    sql += ` AND vp.student_id = ANY($${params.length + 1}::int[])`;
                    params.push(actor.studentIds);
                } else {
                    sql += ` AND vp.teacher_id = $${params.length + 1}`;
                    params.push(req.user.id);
                }
                const r = await db.query(sql, params);
                // 视图是交叉积：同一 (场次, 教师) 会随学生数重复，这里先去重
                const seen = new Set();
                targets = (r.rows || []).filter(x => {
                    const k = `${x.session_id}|${x.teacher_uid}`;
                    if (seen.has(k)) return false;
                    seen.add(k);
                    return true;
                }).map(x => ({ session_id: Number(x.session_id), teacher_uid: x.teacher_uid }));
            } else {
                throw new AppError({ code: statusToErrorCode(400), statusCode: 400, message: '请提供 ids 或 scope 范围' });
            }

            if (!targets.length) return res.json(successResponse({ message: '没有符合条件的排课', updated: 0 }, { requestId: req.requestId }));

            const updated = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                // 复用共享批量流转原语：逐条范围授权（越权跳过）+ 状态机校验 + 审计
                return await FeeService.batchTransitionFeeStatus(q, {
                    targets, target, note, operatorId: req.user.id,
                    actorType: actor.actorType, skipStatus, actor
                });
            }, { allowDegraded: true });   // 批量流转：状态本身单条语句提交，降级只可能丢审计

            res.json(successResponse({ message: `已更新 ${updated} 条排课的费用状态`, updated }, { requestId: req.requestId }));
        } catch (error) {
            logger.error('教师批量更新费用状态错误:', error);
            throw error;
        }
    },

    /**
     * 获取教师关联/有排课记录的学生列表
     * @description 当传入 startDate/endDate 时，查询该时间段内有排课记录的学生；
     *              否则返回班主任绑定的学生列表（向下兼容）
     */
    async getAssociatedStudents(req, res) {
        const data = await headTeacherService.getAssociatedStudents(req);
        res.json(successResponse(data, { requestId: req.requestId }));
    },

    /**
     * 获取关联学生详细信息列表
     */
    async getAssociatedStudentsDetail(req, res) {
        const data = await headTeacherService.getAssociatedStudentsDetail(req);
        res.json(successResponse(data, { requestId: req.requestId }));
    },

    /**
     * 更新关联学生信息
     */
    async updateAssociatedStudent(req, res) {
        const data = await headTeacherService.updateAssociatedStudent(req);
        res.json(successResponse(data, { requestId: req.requestId }));
    },

    /**
     * 获取所有教师列表 (用于班主任导出筛选)
     */
    async getAllTeachers(req, res) {
        const data = await headTeacherService.getAllTeachers(req);
        res.json(successResponse(data, { requestId: req.requestId }));
    }

};

// 处理器内部改为 throw 抛错（不再自己调 next），由这里统一包一层：
// Express 4 不会捕获 async 拒绝，不包的话抛出的 AppError 会让请求挂死。
// 包在导出处而不是逐条路由上，避免遗漏任何一条挂载路径。
for (const key of Object.keys(teacherController)) {
    if (typeof teacherController[key] === 'function') {
        teacherController[key] = asyncHandler(teacherController[key]);
    }
}

module.exports = teacherController;
