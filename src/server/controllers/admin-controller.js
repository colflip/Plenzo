const logger = require('../utils/logger.js');
/**
 * 管理员控制器
 * @description 处理管理员端的用户管理、排课管理、统计和数据导出等操作
 */

const db = require('../db/db');
const { standardResponse } = require('../middleware/validation');
const SchemaHelper = require('../utils/schema-helper');
const { upsertAvailabilityByAdmin } = require('../services/availability-service');
const HolidayService = require('../services/holiday-service');
const ScheduleTypeService = require('../services/schedule-type-service');
const FeedbackService = require('../services/feedback-service');
const FeeService = require('../services/fee-service');
const UserService = require('../services/user-service');
const scheduleService = require('../services/schedule-service');
const { getTimestamp } = require('../utils/shared-utils');
const { buildScopeClause, canTouchRecord, requiresOwnDataScope } = require('../utils/admin-permissions');
const courseSessionService = require('../services/course-session-service');
const { resolveAutoFeeStatus } = require('../utils/fee-status');

const adminController = {
    /**
     * 获取用户列表
     * @description 根据用户类型返回对应的用户列表（管理员/教师/学生）
     * @param {string} req.params.userType - 用户类型
     */
    /**
     * 获取用户列表（逻辑见 user-service.listUsers）
     */
    async getUsers(req, res) {
        try {
            const result = await UserService.listUsers(req.params.userType, { page: req.query.page, size: req.query.size }, req);
            return res.status(result.status).json(result.body);
        } catch (error) {
            logger.error('获取用户列表错误:', error);
            res.status(500).json(standardResponse(false, null, '获取用户列表失败'));
        }
    },

    /**
     * 获取单个用户详情
     * @description 根据用户类型和ID返回用户详情
     * @param {string} req.params.userType - 用户类型
     * @param {string} req.params.id - 用户ID
     */
    /**
     * 获取单个用户详情（逻辑见 user-service.getUserById）
     */
    async getUserById(req, res) {
        try {
            const result = await UserService.getUserById(req.params.userType, req.params.id, req);
            return res.status(result.status).json(result.body);
        } catch (error) {
            logger.error('获取用户详情错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 创建用户（逻辑见 user-service.createUser）
     */
    async createUser(req, res) {
        try {
            const result = await UserService.createUser(req.body, req);
            return res.status(result.status).json(result.body);
        } catch (error) {
            logger.error('创建用户错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 更新用户（逻辑见 user-service.updateUser）
     */
    async updateUser(req, res) {
        try {
            const result = await UserService.updateUser(req.params.userType, req.params.id, req.body, req);
            return res.status(result.status).json(result.body);
        } catch (error) {
            logger.error('更新用户错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 删除用户（逻辑见 user-service.deleteUser）
     */
    async deleteUser(req, res) {
        try {
            const cascade = (req.query && (req.query.cascade === 'true' || req.query.cascade === '1'));
            const result = await UserService.deleteUser(req.params.userType, req.params.id, { cascade }, req);
            return res.status(result.status).json(result.body);
        } catch (error) {
            logger.error('删除用户错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 获取排课列表
     * @description 根据日期范围和过滤条件返回排课列表
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     * @param {string} req.query.status - 状态过滤（可选）
     * @param {string} req.query.type - 类型过滤（可选）
     */
    async getSchedules(req, res) {
        const out = await scheduleService.adminListSchedules(req);
        return res.status(out.status).json(out.body);
    },

    async getScheduleById(req, res) {
        const out = await scheduleService.adminGetScheduleById(req);
        return res.status(out.status).json(out.body);
    },

    /** 往一场课里加一位教师或学生（POST /admin/sessions/:id/:kind） */
    async addSchedulePair(req, res) {
        const out = await scheduleService.adminAddPair(req);
        return res.status(out.status).json(out.body);
    },

    /** 从一场课里移除一位教师或学生（DELETE /admin/sessions/:id/:kind/:uid；移空则整场删） */
    async removeSchedulePair(req, res) {
        const out = await scheduleService.adminRemovePair(req);
        return res.status(out.status).json(out.body);
    },

    // 网格视图：返回逐条排课记录，供前端按学生×日期进行精准渲染
    async getSchedulesGrid(req, res) {
        const out = await scheduleService.adminGetSchedulesGrid(req);
        return res.status(out.status).json(out.body);
    },

    /**
     * 获取教师空闲时段网格数据
     * @description 根据日期范围返回所有教师的空闲状态
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     */
    async getTeacherAvailabilityGrid(req, res) {
        try {
            const { startDate, endDate } = req.query;
            if (!startDate || !endDate) {
                return res.status(400).json({ message: '缺少开始/结束日期' });
            }

            // 1. 获取所有教师（状态非删除）
            //    status 列探针只决定教师 SQL 怎么拼，把教师查询挂在探针后面，
            //    与下面的 availability 查询并发（互不依赖），省一次往返（约 250ms）
            const teachersPromise = SchemaHelper.hasColumn('teachers', 'status').then(hasStatus => {
                let teacherSql = `SELECT id, name FROM teachers WHERE 1=1`;
                if (hasStatus) {
                    teacherSql += ` AND status <> -1`;
                }
                teacherSql += ` ORDER BY id ASC`;
                return db.query(teacherSql);
            });

            // 2. 获取日期范围内的availability数据（权限落地：L3 仅见自己创建 + 无主存量）
            let availabilitySql = `
                SELECT teacher_id, date, morning_available, afternoon_available, evening_available
                FROM teacher_daily_availability
                WHERE date BETWEEN $1 AND $2
            `;
            const availabilityParams = [startDate, endDate];
            const teacherScope = buildScopeClause(req.user, 'teacher_daily_availability');
            if (teacherScope) {
                availabilityParams.push(teacherScope.actorId);
                availabilitySql += ` AND ${teacherScope.clause.replace('$ACTOR_ID', `$${availabilityParams.length}`)}`;
            }
            const [teachersResult, availabilityResult] = await Promise.all([
                teachersPromise,
                db.query(availabilitySql, availabilityParams)
            ]);
            const teachers = teachersResult.rows || [];
            const availabilityRecords = availabilityResult.rows || [];

            // 3. 组织数据结构：Map<TeacherId, Map<DateStr, SlotData>>
            const availabilityMap = new Map();
            availabilityRecords.forEach(record => {
                const tId = record.teacher_id;
                if (!availabilityMap.has(tId)) {
                    availabilityMap.set(tId, {});
                }
                // 格式化日期 key (YYYY-MM-DD)
                let dStr = record.date;
                // 如果是 Date 对象，使用本地时间构建字符串，避免 toISOString() 带来的时区偏差
                if (dStr instanceof Date) {
                    const y = dStr.getFullYear();
                    const m = String(dStr.getMonth() + 1).padStart(2, '0');
                    const d = String(dStr.getDate()).padStart(2, '0');
                    dStr = `${y}-${m}-${d}`;
                } else if (typeof dStr === 'string') {
                    dStr = dStr.substring(0, 10);
                }

                availabilityMap.get(tId)[dStr] = {
                    morning: record.morning_available === 1,
                    afternoon: record.afternoon_available === 1,
                    evening: record.evening_available === 1
                };
            });

            // 4. 构建最终返回列表
            const result = teachers.map(t => ({
                id: t.id,
                name: t.name,
                availability: availabilityMap.get(t.id) || {}
            }));

            res.json(result);
        } catch (error) {
            logger.error('获取教师空闲网格错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 更新教师空闲时段
     * @param {object[]} req.body.updates - [{ teacher_id, date, morning, afternoon, evening }]
     */
    async updateTeacherAvailability(req, res) {
        try {
            const { updates } = req.body;
            if (!Array.isArray(updates) || updates.length === 0) {
                return res.status(400).json({ message: '缺少更新数据' });
            }

            // 使用事务进行批量更新（逻辑见 availability-service.upsertAvailabilityByAdmin）
            await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                await upsertAvailabilityByAdmin(q, 'teacher_daily_availability', 'teacher_id', updates, req.user);
            });

            res.json({ message: '更新成功' });
        } catch (error) {
            logger.error('更新教师空闲时段错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 获取学生空闲时段网格数据
     * @description 根据日期范围返回所有学生的空闲状态
     * @param {string} req.query.startDate - 开始日期
     * @param {string} req.query.endDate - 结束日期
     */
    async getStudentAvailabilityGrid(req, res) {
        try {
            const { startDate, endDate } = req.query;
            if (!startDate || !endDate) {
                return res.status(400).json({ message: '缺少开始/结束日期' });
            }

            // 1. 获取所有学生（状态非删除）
            //    status 列探针只决定学生 SQL 怎么拼，把学生查询挂在探针后面，
            //    与下面的 availability 查询并发（互不依赖），省一次往返（约 250ms）
            const studentsPromise = SchemaHelper.hasColumn('students', 'status').then(hasStatus => {
                let studentSql = `SELECT id, name FROM students WHERE 1=1`;
                if (hasStatus) {
                    studentSql += ` AND status <> -1`;
                }
                studentSql += ` ORDER BY id ASC`;
                return db.query(studentSql);
            });

            // 2. 获取日期范围内的availability数据（权限落地：L3 仅见自己创建 + 无主存量）
            let availabilitySql = `
                SELECT student_id, date, morning_available, afternoon_available, evening_available
                FROM student_daily_availability
                WHERE date BETWEEN $1 AND $2
            `;
            const availabilityParams = [startDate, endDate];
            const studentScope = buildScopeClause(req.user, 'student_daily_availability');
            if (studentScope) {
                availabilityParams.push(studentScope.actorId);
                availabilitySql += ` AND ${studentScope.clause.replace('$ACTOR_ID', `$${availabilityParams.length}`)}`;
            }
            const [studentsResult, availabilityResult] = await Promise.all([
                studentsPromise,
                db.query(availabilitySql, availabilityParams)
            ]);
            const students = studentsResult.rows || [];
            const availabilityRecords = availabilityResult.rows || [];

            // 3. 组织数据结构：Map<StudentId, Map<DateStr, SlotData>>
            const availabilityMap = new Map();
            availabilityRecords.forEach(record => {
                const sId = record.student_id;
                if (!availabilityMap.has(sId)) {
                    availabilityMap.set(sId, {});
                }
                // 格式化日期 key (YYYY-MM-DD)
                let dStr = record.date;
                if (dStr instanceof Date) {
                    const y = dStr.getFullYear();
                    const m = String(dStr.getMonth() + 1).padStart(2, '0');
                    const d = String(dStr.getDate()).padStart(2, '0');
                    dStr = `${y}-${m}-${d}`;
                } else if (typeof dStr === 'string') {
                    dStr = dStr.substring(0, 10);
                }

                availabilityMap.get(sId)[dStr] = {
                    morning: record.morning_available === 1,
                    afternoon: record.afternoon_available === 1,
                    evening: record.evening_available === 1
                };
            });

            // 4. 构建最终返回列表
            const result = students.map(s => ({
                id: s.id,
                name: s.name,
                availability: availabilityMap.get(s.id) || {}
            }));

            res.json(result);
        } catch (error) {
            logger.error('获取学生空闲网格错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 更新学生空闲时段
     * @param {object[]} req.body.updates - [{ student_id, date, morning, afternoon, evening }]
     */
    async updateStudentAvailability(req, res) {
        try {
            const { updates } = req.body;
            if (!Array.isArray(updates) || updates.length === 0) {
                return res.status(400).json({ message: '缺少更新数据' });
            }

            // 使用事务进行批量更新（逻辑见 availability-service.upsertAvailabilityByAdmin）
            await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                await upsertAvailabilityByAdmin(q, 'student_daily_availability', 'student_id', updates, req.user);
            });

            res.json({ message: '更新成功' });
        } catch (error) {
            logger.error('更新学生空闲时段错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    async createSchedule(req, res) {
        const out = await scheduleService.adminCreateSchedule(req);
        return res.status(out.status).json(out.body);
    },

    async updateSchedule(req, res) {
        const out = await scheduleService.adminUpdateSchedule(req);
        return res.status(out.status).json(out.body);
    },

    async deleteSchedule(req, res) {
        const out = await scheduleService.adminDeleteSchedule(req);
        return res.status(out.status).json(out.body);
    },

    async confirmSchedule(req, res) {
        const out = await scheduleService.adminConfirmSchedule(req);
        return res.status(out.status).json(out.body);
    },

    /**
     * 获取总览统计
     * @description 返回系统总览数据：教师/学生数量、排课统计等
     */
    async getOverviewStats(req, res) {
        const out = await scheduleService.adminOverviewStats(req);
        return res.status(out.status).json(out.body);
    },

    async getScheduleStats(req, res) {
        const out = await scheduleService.adminScheduleStats(req);
        return res.status(out.status).json(out.body);
    },

    async getUserStats(req, res) {
        const out = await scheduleService.adminUserStats(req);
        return res.status(out.status).json(out.body);
    },

    /**
     * 获取所有课程类型（逻辑见 schedule-type-service.listScheduleTypes）
     */
    async getScheduleTypes(req, res) {
        try {
            const data = await ScheduleTypeService.listScheduleTypes();
            res.json(standardResponse(true, data, '获取课程类型成功'));
        } catch (error) {
            logger.error('获取课程类型错误:', error);
            res.status(503).json(standardResponse(false, null, '数据库暂时不可用，请稍后重试'));
        }
    },

    /**
     * 创建课程类型（逻辑见 schedule-type-service.createScheduleType）
     */
    async createScheduleType(req, res) {
        try {
            const result = await ScheduleTypeService.createScheduleType(req.body, req);
            if (result.error) {
                return res.status(result.status).json({ message: result.error });
            }
            res.status(result.status).json(standardResponse(true, result.data, '创建课程类型成功'));
        } catch (error) {
            logger.error('创建课程类型错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 更新课程类型（逻辑见 schedule-type-service.updateScheduleType）
     */
    async updateScheduleType(req, res) {
        try {
            const result = await ScheduleTypeService.updateScheduleType(req.params.id, req.body, req);
            if (result.error) {
                return res.status(result.status).json({ message: result.error });
            }
            res.status(result.status).json(standardResponse(true, result.data, '更新课程类型成功'));
        } catch (error) {
            logger.error('更新课程类型错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 删除课程类型（逻辑见 schedule-type-service.deleteScheduleType）
     */
    async deleteScheduleType(req, res) {
        try {
            const result = await ScheduleTypeService.deleteScheduleType(req.params.id, req);
            if (result.error) {
                return res.status(result.status).json({ message: result.error });
            }
            res.json(standardResponse(true, null, '删除课程类型成功'));
        } catch (error) {
            logger.error('删除课程类型错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 获取节假日列表（逻辑见 holiday-service.listHolidays）
     */
    async getHolidays(req, res) {
        try {
            const data = await HolidayService.listHolidays();
            res.json(standardResponse(true, data, '获取节假日成功'));
        } catch (error) {
            logger.error('获取节假日错误:', error);
            res.status(503).json(standardResponse(false, null, '数据库暂时不可用，请稍后重试'));
        }
    },

    /**
     * 创建节假日（逻辑见 holiday-service.createHoliday）
     */
    async createHoliday(req, res) {
        try {
            const result = await HolidayService.createHoliday(req.body, req);
            if (result.error) {
                return res.status(result.status).json({ message: result.error });
            }
            res.status(result.status).json(standardResponse(true, result.data, '创建节假日成功'));
        } catch (error) {
            logger.error('创建节假日错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 更新节假日（逻辑见 holiday-service.updateHoliday）
     */
    async updateHoliday(req, res) {
        try {
            const result = await HolidayService.updateHoliday(req.params.id, req.body, req);
            if (result.error) {
                return res.status(result.status).json({ message: result.error });
            }
            res.status(result.status).json(standardResponse(true, result.data, '更新节假日成功'));
        } catch (error) {
            logger.error('更新节假日错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 删除节假日（逻辑见 holiday-service.deleteHoliday）
     */
    async deleteHoliday(req, res) {
        try {
            const result = await HolidayService.deleteHoliday(req.params.id, req);
            if (result.error) {
                return res.status(result.status).json({ message: result.error });
            }
            res.json(standardResponse(true, null, '删除节假日成功'));
        } catch (error) {
            logger.error('删除节假日错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 批量同步节假日（按涉及年份先清空再写入；逻辑见 holiday-service.batchUpsertHolidays）
     */
    async batchUpsertHolidays(req, res) {
        try {
            const result = await HolidayService.batchUpsertHolidays(req.body.items, req);
            if (result.error) {
                return res.status(result.status).json({ message: result.error });
            }
            res.json(standardResponse(true, result.data, `成功同步 ${result.data.count} 条节假日数据`));
        } catch (error) {
            logger.error('批量同步节假日错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 从第三方 API 同步节假日（后端代理，规避浏览器 CSP/CORS）
     * 逻辑见 holiday-service.syncHolidaysFromAPI
     */
    async syncHolidaysFromAPI(req, res) {
        try {
            const years = Array.isArray(req.body && req.body.years) ? req.body.years : undefined;
            const result = await HolidayService.syncHolidaysFromAPI(years, req);
            if (result.error) {
                return res.status(result.status).json({ message: result.error });
            }
            if (result.data.length === 0) {
                return res.json(standardResponse(true, [], '未获取到节假日数据（该年份可能尚未发布）'));
            }
            res.json(standardResponse(true, result.data, `成功同步 ${result.count} 条节假日数据`));
        } catch (error) {
            logger.error('同步节假日错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 管理员更新排课费用
     * @param {string} req.params.id - 课程ID
     * @param {number} req.body.transport_fee - 交通费
     * @param {number} req.body.other_fee - 其他费用
     *
     * 性能契约：**单条更新不开事务**。金额与「保存并提交」流转（管理员端 → 已审核）
     * 由 fee-service.updateScheduleFeesInTx 一条 UPDATE 完成，两项审计并行落地且失败
     * 只告警；包事务只多付 BEGIN + COMMIT 两次往返（≈500ms）。
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

            // 费用挂在教师 pair 上（一趟一笔），定位需要「场次 id + teacher_uid」
            const session = await courseSessionService.getSessionById(id);
            if (!session) {
                return res.status(404).json({ message: '课程不存在' });
            }
            // 权限落地：L3 只能操作自己创建或无主的排课；越权视为不存在
            if (!canTouchRecord(session.created_by, req.user)) {
                return res.status(404).json({ message: '课程不存在' });
            }
            const pair = FeeService.locateTeacherPair(session, req.params.uid || req.body.teacher_uid);
            if (!pair) {
                return res.status(404).json({ message: '课程不存在' });
            }

            const { transport_fee: old_t_fee, other_fee: old_o_fee, fee_status: old_status } = pair;

            // 无事务单条更新：金额 + 「保存并提交」自动流转（管理员端 → 已审核）一次成型。
            // 仅本次填写了费用的记录改状态；留空 / 清除费用不动状态（只改金额）。
            const targetStatus = FeeService.hasFilledFee(tFee, oFee)
                ? resolveAutoFeeStatus('admin', old_status)
                : null;
            await FeeService.updateScheduleFeesInTx(db.query, { sessionId: id, teacherUid: pair.uid }, {
                tFee, oFee, oldTFee: old_t_fee, oldOFee: old_o_fee,
                targetStatus, oldStatus: old_status, operatorId: req.user.id, operatorRole: 'admin'
            });
            const feeStatus = targetStatus || old_status;

            res.json({ message: '费用更新成功', transport_fee: tFee, other_fee: oFee, fee_status: feeStatus });
        } catch (error) {
            logger.error('管理员更新费用错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 管理员更新单条排课的费用报销状态
     * @param {number} req.params.id - 排课ID
     * @param {string} req.body.fee_status - 目标状态
     * @param {string} [req.body.note] - 备注
     */
    async updateScheduleFeeStatus(req, res) {
        try {
            const { id } = req.params;
            const { fee_status: target, note } = req.body;
            if (!target) return res.status(400).json({ message: '缺少目标状态' });

            const session = await courseSessionService.getSessionById(id);
            if (!session) return res.status(404).json({ message: '排课不存在' });
            // 权限落地：L3 只能操作自己创建或无主的排课；越权视为不存在
            if (!canTouchRecord(session.created_by, req.user)) {
                return res.status(404).json({ message: '排课不存在' });
            }
            const pair = FeeService.locateTeacherPair(session, req.params.uid || req.body.teacher_uid);
            if (!pair) return res.status(404).json({ message: '排课不存在' });

            const from = pair.fee_status;
            const result = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                return await FeeService.transitionFeeStatus(q, {
                    sessionId: id, teacherUid: pair.uid, from, target, note,
                    operatorId: req.user.id, actorType: 'admin'
                });
            });
            if (!result.ok) return res.status(400).json({ message: result.error });

            res.json({ message: '费用状态已更新', fee_status: target });
        } catch (error) {
            logger.error('管理员更新费用状态错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    /**
     * 管理员批量更新费用报销状态
     * @param {Array}  [req.body.ids] - 指定排课ID列表
     * @param {Object} [req.body.scope] - 或按范围选择：{ startDate, endDate, fee_status? }
     * @param {string} req.body.fee_status - 目标状态
     * @param {string} [req.body.note] - 备注
     * @param {string} [req.body.skipStatus] - 跳过已是该状态的记录（用于「完成报销」避免重复审计）
     */
    async batchUpdateScheduleFeeStatus(req, res) {
        try {
            const { ids, scope, fee_status: target, note, skipStatus } = req.body;
            if (!target) return res.status(400).json({ message: '缺少目标状态' });

            // 目标一律归一成 { session_id, teacher_uid }：费用挂在教师 pair 上
            let targets = [];
            if (Array.isArray(ids) && ids.length) {
                targets = ids.map(x => (typeof x === 'object'
                    ? { session_id: Number(x.session_id ?? x.id), teacher_uid: x.teacher_uid || null }
                    : { session_id: Number(x), teacher_uid: null }))
                    .filter(x => Number.isFinite(x.session_id));
                // 权限落地：L3 批量操作 all-or-nothing —— 任一目标越权则整批拒绝
                if (requiresOwnDataScope(req.user)) {
                    const sessionIds = [...new Set(targets.map(x => x.session_id))];
                    const ownedRes = await db.query(
                        'SELECT id FROM course_sessions WHERE id = ANY($1) AND (created_by = $2 OR created_by IS NULL)',
                        [sessionIds, req.user.id]
                    );
                    if ((ownedRes.rows || []).length !== sessionIds.length) {
                        return res.status(403).json({ message: '批量操作中包含您无权修改的排课，已整批拒绝' });
                    }
                }
            } else if (scope && scope.startDate && scope.endDate) {
                let sql = `SELECT vp.session_id, vp.teacher_uid FROM v_session_pairs vp
                            WHERE vp.class_date BETWEEN $1 AND $2`;
                const params = [scope.startDate, scope.endDate];
                if (scope.fee_status) { sql += ` AND vp.fee_status = $3`; params.push(scope.fee_status); }
                // 权限落地：L3 按范围选择时仅命中自己创建 + 无主存量的排课
                const batchScope = buildScopeClause(req.user, 'vp');
                if (batchScope) {
                    params.push(batchScope.actorId);
                    sql += ` AND ${batchScope.clause.replace('$ACTOR_ID', `$${params.length}`)}`;
                }
                const r = await db.query(sql, params);
                // 视图是交叉积：同一 (场次, 教师) 会随学生数重复，先去重
                const seen = new Set();
                targets = (r.rows || []).filter(x => {
                    const k = `${x.session_id}|${x.teacher_uid}`;
                    if (seen.has(k)) return false;
                    seen.add(k);
                    return true;
                }).map(x => ({ session_id: Number(x.session_id), teacher_uid: x.teacher_uid }));
            } else {
                return res.status(400).json({ message: '请提供 ids 或 scope 范围' });
            }

            if (!targets.length) return res.json({ message: '没有符合条件的排课', updated: 0 });

            const updated = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                return await FeeService.batchTransitionFeeStatus(q, {
                    targets, target, note, operatorId: req.user.id, actorType: 'admin', skipStatus
                });
            });

            res.json({ message: `已更新 ${updated} 条排课的费用状态`, updated });
        } catch (error) {
            logger.error('管理员批量更新费用状态错误:', error);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    async getTeacherConflicts(req, res) {
        try {
            const { date, startTime, endTime, excludeScheduleId } = req.query;
            if (!date || !startTime || !endTime) return res.status(400).json({ message: '缺少参数' });
            // 两段式：派生列 teacher_ids 拿 GIN 索引粗筛，再展开 JSONB 判活跃 pair。
            // 行为变更（有意）：旧实现只排除 cancelled，被调走的 modified_away 仍算教师占用；
            // 现在统一按生命周期位排除 cancelled + modified_away，46 条已调整原课不再制造假冲突。
            // 时段重叠改用 OVERLAPS —— 与旧的 `start < $end AND end > $start` 语义完全相同（左闭右开）。
            let sql = `SELECT DISTINCT (e->>'teacher_id')::int AS teacher_id
                         FROM course_sessions cs, jsonb_array_elements(cs.teachers) e
                        WHERE cs.class_date = $1
                          AND (cs.start_time, cs.end_time) OVERLAPS ($2::time, $3::time)
                          AND split_part(e->>'status', '.', 2) NOT IN ('cancelled', 'modified_away')`;
            const ps = [date, startTime, endTime];
            if (excludeScheduleId) { sql += ` AND cs.id != $4`; ps.push(excludeScheduleId); }
            // 冲突查询与可用时段查询互不依赖，并发省一次往返（约 250ms）
            // teacher_daily_availability 按具体日期存储（date 列），仅统计可用记录
            const [cR, aR] = await Promise.all([
                db.query(sql, ps),
                db.query(
                    `SELECT teacher_id, start_time, end_time FROM teacher_daily_availability WHERE date = $1 AND status = 'available'`,
                    [date]
                )
            ]);
            const resMap = {};
            (cR.rows || []).forEach(c => { resMap[c.teacher_id] = { hasClass: true }; });
            // 检查教师可用性：收集每个教师的所有可用时段
            const teacherSlots = {};
            (aR.rows || []).forEach(a => {
                if (!teacherSlots[a.teacher_id]) teacherSlots[a.teacher_id] = [];
                teacherSlots[a.teacher_id].push({ start: a.start_time, end: a.end_time });
            });
            // 如果教师没有任何可用时段覆盖请求时段，标记为不可用
            Object.entries(teacherSlots).forEach(([tid, slots]) => {
                const hasOverlap = slots.some(s => startTime < s.end && endTime > s.start);
                if (!hasOverlap) {
                    if (!resMap[tid]) resMap[tid] = {};
                    resMap[tid].isUnavailable = true;
                }
            });
            res.json(resMap);
        } catch (e) {
            logger.error('获取教师冲突状态失败:', e);
            res.status(500).json({ message: '服务器错误' });
        }
    },

    // ============================================
    // 反馈管理（功能反馈 / Bug / 新功能需求）
    // ============================================

    /**
     * 列表（逻辑见 feedback-service.listFeedbacks）
     */
    async listFeedbacks(req, res) {
        try {
            const data = await FeedbackService.listFeedbacks();
            res.json(standardResponse(true, data, '获取反馈成功'));
        } catch (error) {
            logger.error('获取反馈错误:', error);
            res.status(503).json(standardResponse(false, null, '数据库暂时不可用，请稍后重试'));
        }
    },

    /**
     * 创建反馈（逻辑见 feedback-service.createFeedback）
     */
    async createFeedback(req, res) {
        try {
            const result = await FeedbackService.createFeedback(req.body, req);
            if (result.error) {
                return res.status(result.status).json(standardResponse(false, null, result.error));
            }
            res.status(result.status).json(standardResponse(true, result.data, '反馈已提交'));
        } catch (error) {
            logger.error('创建反馈错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 更新反馈（逻辑见 feedback-service.updateFeedback）
     */
    async updateFeedback(req, res) {
        try {
            const result = await FeedbackService.updateFeedback(req.params.id, req.body, req);
            if (result.error) {
                return res.status(result.status).json(standardResponse(false, null, result.error));
            }
            res.status(result.status).json(standardResponse(true, result.data, '反馈已更新'));
        } catch (error) {
            logger.error('更新反馈错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    },

    /**
     * 删除反馈（逻辑见 feedback-service.deleteFeedback）
     */
    async deleteFeedback(req, res) {
        try {
            const result = await FeedbackService.deleteFeedback(req.params.id, req);
            if (result.error) {
                return res.status(result.status).json(standardResponse(false, null, result.error));
            }
            res.status(result.status).json(standardResponse(true, result.data, '反馈已删除'));
        } catch (error) {
            logger.error('删除反馈错误:', error);
            res.status(500).json(standardResponse(false, null, '服务器错误'));
        }
    }
};

module.exports = adminController;
