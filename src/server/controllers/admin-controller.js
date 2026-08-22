const logger = require('../utils/logger.js');
/**
 * 管理员控制器
 * @description 处理管理员端的用户管理、排课管理、统计和数据导出等操作
 */

const db = require('../db/db');
const { standardResponse } = require('../middleware/validation');
const { handleExportError } = require('../middleware/export-error-handler');
const SchemaHelper = require('../utils/schema-helper');
const { upsertAvailabilityByAdmin } = require('../services/availability-service');
const HolidayService = require('../services/holiday-service');
const ScheduleTypeService = require('../services/schedule-type-service');
const FeedbackService = require('../services/feedback-service');
const FeeService = require('../services/fee-service');
const UserService = require('../services/user-service');
const scheduleService = require('../services/schedule-service');
const { getTimestamp } = require('../utils/shared-utils');
const AdvancedExportService = require('../services/advanced-export-service');
const ExportLogService = require('../utils/export-log-service');
const exportService = require('../services/export-service');
const { buildScopeClause, canTouchRecord, requiresOwnDataScope } = require('../utils/admin-permissions');

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
            let teacherSql = `SELECT id, name FROM teachers WHERE 1=1`;
            if (await SchemaHelper.hasColumn('teachers', 'status')) {
                teacherSql += ` AND status <> -1`;
            }
            teacherSql += ` ORDER BY id ASC`;
            const teachersResult = await db.query(teacherSql);
            const teachers = teachersResult.rows || [];

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
            const availabilityResult = await db.query(availabilitySql, availabilityParams);
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
            let studentSql = `SELECT id, name FROM students WHERE 1=1`;
            if (await SchemaHelper.hasColumn('students', 'status')) {
                studentSql += ` AND status <> -1`;
            }
            studentSql += ` ORDER BY id ASC`;
            const studentsResult = await db.query(studentSql);
            const students = studentsResult.rows || [];

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
            const availabilityResult = await db.query(availabilitySql, availabilityParams);
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

    // ============ 高级导出功能 ============
    /**
     * 高级数据导出接口
     * 支持4种导出类型 + 2种文件格式
     * 
     * 查询参数：
     * - type: 导出类型 (teacher_info, student_info, teacher_schedule, student_schedule)
     * - format: 文件格式 (excel, csv)
     * - startDate: 开始日期 (仅对schedule类型有效)
     * - endDate: 结束日期 (仅对schedule类型有效)
     */
    async advancedExport(req, res) {
        let logId = null;
        let startTime = Date.now();
        const logService = new ExportLogService(db);

        try {
            const { type, format, startDate, endDate, student_id, ...filters } = req.query;
            const adminId = req.user?.id;

            // 从数据库获取管理员名称
            let adminName = '管理员';
            if (adminId) {
                try {
                    const result = await db.query(
                        'SELECT username, name FROM administrators WHERE id = $1',
                        [adminId]
                    );
                    if (result && result.rows && result.rows[0]) {
                        adminName = result.rows[0].name || result.rows[0].username || '管理员';
                    }
                } catch (err) {
                    logger.warn('获取管理员名称失败:', err.message);
                }
            }

            // ===== 参数验证 =====
            if (!type || !format) {
                return res.status(400).json(
                    standardResponse(false, null, '缺少必要参数: type 和 format')
                );
            }

            // ===== 初始化服务 =====
            const exportService = new AdvancedExportService(db);

            try {
                // 记录导出开始
                logId = await logService.logExportStart({
                    userId: adminId,
                    userType: 'admin',
                    startDate,
                    endDate,
                    studentId: student_id,
                    teacherId: req.query.teacher_id,
                    exportType: type
                });
            } catch (logError) {
                logger.warn('记录导出日志失败:', logError.message);
                // 继续执行导出，不中断流程
            }

            // ===== 执行导出 =====
            let exportData = [];
            let filename = '';

            // 根据导出类型获取数据
            switch (type) {
                case 'teacher_info':
                    exportData = await exportService.exportTeacherInfo();
                    filename = `教师信息数据_${new Date().toISOString().split('T')[0]}.${format === 'excel' ? 'xlsx' : 'csv'}`;
                    break;

                case 'student_info':
                    exportData = await exportService.exportStudentInfo();
                    filename = `学生信息数据_${new Date().toISOString().split('T')[0]}.${format === 'excel' ? 'xlsx' : 'csv'}`;
                    break;

                case 'teacher_schedule':
                case 'student_schedule':
                    // 排课记录导出：使用新的统一服务（后端生成Excel）
                    if (!startDate || !endDate) {
                        return res.status(400).json(
                            standardResponse(false, null, '导出排课记录需要指定日期范围')
                        );
                    }

                    // 1. 查询原始数据
                    let rawData;
                    const teacherId = req.query.teacher_id;
                    let teacherName = null;

                    if (type === 'teacher_schedule') {
                        rawData = await exportService.queryTeacherSchedule(startDate, endDate, {
                            student_id,
                            teacher_id: teacherId
                        });

                        // 如果指定了教师，获取教师名称
                        if (teacherId && rawData.length > 0) {
                            teacherName = rawData[0]?.teacher_name || null;
                        }
                    } else {
                        rawData = await exportService.queryStudentSchedule(startDate, endDate, {
                            student_id
                        });
                    }

                    if (!rawData || rawData.length === 0) {
                        return res.status(404).json(
                            standardResponse(false, null, '该时间段内无数据')
                        );
                    }

                    // 2. 使用统一导出服务生成完整的多Sheet Excel（unified + excel 合并）
                    const excelResult = await exportService.generateExcelFromData(rawData, {
                        startDate,
                        endDate,
                        userType: 'admin',
                        userId: adminId,
                        userName: adminName,
                        studentId: student_id,
                        teacherId: teacherId,
                        studentName: rawData[0]?.student_name || '全部学生',
                        teacherName: teacherName
                    });

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
                            logger.warn('记录导出完成日志失败:', logError.message);
                        }
                    }

                    // 4. 直接发送文件
                    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(excelResult.filename)}"`);
                    res.setHeader('Content-Length', excelResult.buffer.length);
                    return res.end(excelResult.buffer);

                case 'schedule_data':
                    if (!startDate || !endDate) {
                        return res.status(400).json(
                            standardResponse(false, null, '导出排课数据需要指定日期范围')
                        );
                    }

                    // 使用统一服务生成多Sheet Excel（与 teacher_schedule 相同的处理）
                    const scheduleRawData = await exportService.queryTeacherSchedule(startDate, endDate, {
                        student_id,
                        teacher_id: req.query.teacher_id
                    });

                    if (!scheduleRawData || scheduleRawData.length === 0) {
                        return res.status(404).json(
                            standardResponse(false, null, '该时间段内无数据')
                        );
                    }

                    // 获取教师名称
                    let scheduleTeacherName = null;
                    if (req.query.teacher_id && scheduleRawData.length > 0) {
                        scheduleTeacherName = scheduleRawData[0]?.teacher_name || null;
                    }

                    // 使用统一导出服务生成完整的多Sheet Excel（unified + excel 合并）
                    const scheduleExcelResult = await exportService.generateExcelFromData(scheduleRawData, {
                        startDate,
                        endDate,
                        userType: 'admin',
                        userId: adminId,
                        userName: adminName,
                        studentId: student_id,
                        teacherId: req.query.teacher_id,
                        studentName: scheduleRawData[0]?.student_name || '全部学生',
                        teacherName: scheduleTeacherName
                    });

                    // 记录导出成功
                    if (logId) {
                        try {
                            await logService.logExportSuccess(logId, {
                                recordCount: scheduleRawData.length,
                                fileSize: scheduleExcelResult.buffer.length,
                                fileName: scheduleExcelResult.filename,
                                duration: Date.now() - startTime
                            });
                        } catch (logError) {
                            logger.warn('记录导出完成日志失败:', logError.message);
                        }
                    }

                    // 直接发送文件
                    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(scheduleExcelResult.filename)}"`);
                    res.setHeader('Content-Length', scheduleExcelResult.buffer.length);
                    return res.end(scheduleExcelResult.buffer);

                default:
                    return res.status(400).json(
                        standardResponse(false, null, `不支持的导出类型: ${type}`)
                    );
            }

            // 记录导出成功
            const duration = Date.now() - startTime;
            try {
                if (logId) {
                    await logService.logExportSuccess(logId, {
                        recordCount: exportData.length,
                        fileSize: 0,  // 旧版导出无法获取文件大小
                        fileName: filename,
                        duration: duration
                    });
                }
            } catch (logError) {
                logger.warn('记录导出完成日志失败:', logError.message);
            }

            // 返回原始数据，由前端 ExportManager 统一生成 Excel
            res.json({
                success: true,
                data: exportData,
                filename: filename,
                format: format,
                recordCount: exportData.length
            });

        } catch (error) {
            // 记录导出失败
            if (logId) {
                try {
                    await logService.logExportError(logId, error.message);
                } catch (logError) {
                    logger.warn('记录导出错误日志失败:', logError.message);
                }
            }

            // 使用统一错误处理
            return handleExportError(error, req, res);
        }
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
                'SELECT transport_fee, other_fee, fee_status, created_by FROM course_arrangement WHERE id = $1',
                [id]
            );

            if (originalResult.rows.length === 0) {
                return res.status(404).json({ message: '课程不存在' });
            }
            // 权限落地：L3 只能操作自己创建或无主的排课；越权视为不存在
            if (!canTouchRecord(originalResult.rows[0].created_by, req.user)) {
                return res.status(404).json({ message: '课程不存在' });
            }

            const { transport_fee: old_t_fee, other_fee: old_o_fee, fee_status: old_status } = originalResult.rows[0];

            // 事务内更新费用 + 审计 + 「保存并提交」自动流转（管理员端 → 已审核）
            // 仅本次填写了费用的记录改状态；留空 / 清除费用不动状态（只改金额）
            const feeStatus = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                await FeeService.updateScheduleFeesInTx(q, id, {
                    tFee, oFee, oldTFee: old_t_fee, oldOFee: old_o_fee,
                    operatorId: req.user.id, operatorRole: 'admin'
                });
                if (!FeeService.hasFilledFee(tFee, oFee)) return old_status;
                const auto = await FeeService.autoSubmitFeeStatus(q, {
                    id, from: old_status, actorType: 'admin', operatorId: req.user.id
                });
                return auto.fee_status;
            });

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

            const cur = await db.query('SELECT fee_status, student_id, teacher_id, created_by FROM course_arrangement WHERE id = $1', [id]);
            if (cur.rows.length === 0) return res.status(404).json({ message: '排课不存在' });
            // 权限落地：L3 只能操作自己创建或无主的排课；越权视为不存在
            if (!canTouchRecord(cur.rows[0].created_by, req.user)) {
                return res.status(404).json({ message: '排课不存在' });
            }

            const from = cur.rows[0].fee_status;
            const result = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                return await FeeService.transitionFeeStatus(q, {
                    id, from, target, note, operatorId: req.user.id, actorType: 'admin'
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

            let targetIds = [];
            if (Array.isArray(ids) && ids.length) {
                targetIds = ids.map(Number).filter(n => !Number.isNaN(n));
                // 权限落地：L3 批量操作 all-or-nothing —— 任一目标越权则整批拒绝
                if (requiresOwnDataScope(req.user)) {
                    const ownedRes = await db.query(
                        'SELECT id FROM course_arrangement WHERE id = ANY($1) AND (created_by = $2 OR created_by IS NULL)',
                        [targetIds, req.user.id]
                    );
                    if ((ownedRes.rows || []).length !== targetIds.length) {
                        return res.status(403).json({ message: '批量操作中包含您无权修改的排课，已整批拒绝' });
                    }
                }
            } else if (scope && scope.startDate && scope.endDate) {
                const dateExpr = await SchemaHelper.getDateExpr('ca');
                let sql = `SELECT id, fee_status FROM course_arrangement ca WHERE ${dateExpr} BETWEEN $1 AND $2`;
                const params = [scope.startDate, scope.endDate];
                if (scope.fee_status) { sql += ` AND ca.fee_status = $3`; params.push(scope.fee_status); }
                // 权限落地：L3 按范围选择时仅命中自己创建 + 无主存量的排课
                const batchScope = buildScopeClause(req.user, 'ca');
                if (batchScope) {
                    params.push(batchScope.actorId);
                    sql += ` AND ${batchScope.clause.replace('$ACTOR_ID', `$${params.length}`)}`;
                }
                const r = await db.query(sql, params);
                targetIds = r.rows.map(x => x.id);
            } else {
                return res.status(400).json({ message: '请提供 ids 或 scope 范围' });
            }

            if (!targetIds.length) return res.json({ message: '没有符合条件的排课', updated: 0 });

            const updated = await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                return await FeeService.batchTransitionFeeStatus(q, {
                    targetIds, target, note, operatorId: req.user.id, actorType: 'admin', skipStatus
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
            // 使用 SchemaHelper 获取实际日期列名，避免硬编码 class_date
            const dateExpr = await SchemaHelper.getDateExpr('ca');
            let sql = `SELECT ca.teacher_id FROM course_arrangement ca WHERE ${dateExpr} = $1 AND ca.status != 'cancelled' AND (ca.start_time < $3 AND ca.end_time > $2)`;
            const ps = [date, startTime, endTime];
            if (excludeScheduleId) { sql += ` AND ca.id != $4`; ps.push(excludeScheduleId); }
            const cR = await db.query(sql, ps);
            // teacher_daily_availability 按具体日期存储（date 列），仅统计可用记录
            const aR = await db.query(
                `SELECT teacher_id, start_time, end_time FROM teacher_daily_availability WHERE date = $1 AND status = 'available'`,
                [date]
            );
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
