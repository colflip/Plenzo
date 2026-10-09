const logger = require('../utils/logger.js');
const { successResponse, errorResponse } = require('../utils/response');
const { statusToErrorCode } = require('../utils/http-status');
const { AppError } = require('../middleware/error');
/**
 * 统一导出控制器
 * @description 四端（管理员、教师、班主任、学生）共用的导出逻辑
 * @module controllers/exportController
 */

const db = require('../db/db');
const { pipeline, scheduleQueries } = require('../services/export');
const headTeacherService = require('../services/head-teacher-service');
const ExportLogService = require('../utils/export-log-service');
const { handleExportError, ExportError } = require('../middleware/export-error-handler');
const { standardResponse } = require('../middleware/validation');
const { validateDateFormat, getTimestamp, resolveUserName } = require('../utils/shared-utils');
const ExportUtils = require('../utils/export-utils');
const { EXPORT_LIMITS } = require('../services/export/export-constants');

const exportController = {
    /**
     * 统一排课数据导出 — 四端共用
     * POST /api/export/schedule
     *
     * Body: { startDate, endDate, exportType?, teacherId?, studentId? }
     * exportType: 'teacher_schedule' | 'teacher_homeroom' | 'student_schedule' (默认根据角色自动推断)
     *
     * 角色权限：
     * - admin: 可导出任意范围，可指定 teacherId/studentId
     * - teacher:
     *   - exportType='teacher_schedule'（默认）→ 自身授课记录，限定 teacherId = req.user.id
     *   - exportType='teacher_homeroom' → 班主任导出，范围为其绑定学生的全部排课（不限授课教师），
     *     可用 studentId 指定单个绑定学生、teacherId 按授课教师二次筛选
     * - student: 自动限定 studentId = req.user.id
     */
    async exportSchedule(req, res, next) {
        const startTime = Date.now();
        let logId = null;
        const logService = new ExportLogService(db);

        try {
            // ===== 1. 参数解析 =====
            const { startDate, endDate, exportType: reqExportType, teacherId: reqTeacherId, studentId: reqStudentId } = req.body || {};
            const userType = req.user.userType;
            const userId = req.user.id;

            // ===== 2. 统一日期验证 =====
            if (!startDate || !endDate) {
                throw new ExportError('缺少起止日期参数', 400, 'EXPORT_DATE_REQUIRED');
            }
            if (!validateDateFormat(startDate) || !validateDateFormat(endDate)) {
                throw new ExportError('日期格式无效，请使用 YYYY-MM-DD 格式', 400, 'EXPORT_INVALID_DATE');
            }
            /**
             * 跨度上限必须在查询之前判。sheet-builder 只限制**输入行数**（20000），
             * 不限制「按天铺开的日历行数」，而导出查询本身没有 LIMIT：
             * 一条数据 + 200 年跨度 ≈ 7.3 万个明细对象 + 全量缓冲的工作簿。
             * 这条规则原先写在 ExportUtils.validateDateRange 里，但那个包装没有调用者。
             */
            try {
                ExportUtils.validateDateRange(startDate, endDate, EXPORT_LIMITS.MAX_DATE_RANGE_DAYS);
            } catch (rangeErr) {
                throw new ExportError(rangeErr.message, 400, 'EXPORT_INVALID_DATE');
            }

            // ===== 3. 角色权限收敛 =====
            let teacherId = null;
            let studentId = null;
            let studentIds = null;   // 班主任导出：绑定学生 ID 范围
            let logUserType = userType;

            /**
             * exportType 决定走哪一条查询分支，因此它**不能由请求体决定「能看到谁的数据」**。
             * 原实现只在客户端「没给」时填默认值（`if (!exportType) …`），给了就原样采纳，
             * 于是教师传 exportType=student_schedule 且不传 studentId 时，会落到
             * queryStudentSchedule 的「student_id 为空 → 不加任何归属谓词」分支，
             * 而 applyOwnerScope 对非管理员是空操作 → 拿到全系统学生的课表与费用。
             * 允许集合与前端 export-dialog.js 的类型可见性过滤（:943-952）保持一致。
             */
            const EXPORT_TYPES_BY_ROLE = {
                admin: ['teacher_schedule', 'teacher_homeroom', 'student_schedule', 'schedule_data'],
                teacher: ['teacher_schedule', 'teacher_homeroom'],
                student: ['student_schedule']
            };
            const allowedExportTypes = EXPORT_TYPES_BY_ROLE[userType] || [];
            if (reqExportType && !allowedExportTypes.includes(reqExportType)) {
                throw new ExportError(
                    `当前角色无权导出 ${reqExportType} 类型的数据`,
                    403,
                    'EXPORT_TYPE_FORBIDDEN'
                );
            }
            // 缺省：学生只能拿自己的，其余按教师自身授课记录；管理员沿用原默认
            const DEFAULT_EXPORT_TYPE = {
                admin: 'teacher_schedule',
                teacher: 'teacher_schedule',
                student: 'student_schedule'
            };
            const exportType = reqExportType || DEFAULT_EXPORT_TYPE[userType] || 'teacher_schedule';

            switch (userType) {
                case 'admin':
                    teacherId = reqTeacherId ? parseInt(reqTeacherId) : null;
                    studentId = reqStudentId ? parseInt(reqStudentId) : null;
                    break;

                case 'teacher':
                    if (exportType === 'teacher_homeroom') {
                        // 班主任导出：以其绑定的学生为范围，导出这些学生的全部排课（不限授课教师），
                        // 不能收敛为 teacherId = 本人，否则只会导出自己名下的排课。
                        const { found, studentIds: boundStudentIds } = await headTeacherService.getBoundStudentIds(userId);
                        if (!found) {
                            throw new ExportError('未找到教师信息', 404, 'EXPORT_TEACHER_NOT_FOUND');
                        }
                        if (boundStudentIds.length === 0) {
                            throw new ExportError('您未绑定任何学生，无法导出数据', 400, 'EXPORT_NO_BOUND_STUDENTS');
                        }

                        if (reqStudentId) {
                            const sId = parseInt(reqStudentId);
                            if (!boundStudentIds.includes(sId)) {
                                throw new ExportError('您无权导出该学生的数据', 403, 'EXPORT_STUDENT_FORBIDDEN');
                            }
                            studentId = sId;
                        } else {
                            studentIds = boundStudentIds;
                        }

                        // 可选的授课教师二次筛选（不限于本人）
                        teacherId = reqTeacherId ? parseInt(reqTeacherId) : null;
                        logUserType = 'teacher_homeroom';
                    } else {
                        teacherId = userId;
                        if (reqStudentId) {
                            // 教师可导出与其有排课记录的任意学生（不限于绑定列表）
                            studentId = parseInt(reqStudentId);
                        }
                    }
                    break;

                case 'student':
                    studentId = userId;
                    break;

                default:
                    throw new ExportError('无导出权限', 403, 'EXPORT_FORBIDDEN');
            }

            // ===== 4-6. 用户名 / 导出开始日志 / 原始数据 =====
            // 三条互不依赖（userName 第 7 步才用，logId 第 9 步才用），并发省两次往返（每条约 250ms）
            const rawDataPromise = exportType === 'student_schedule'
                ? scheduleQueries.queryStudentSchedule(startDate, endDate, {
                    student_id: studentId,
                    actor: req.user
                })
                : scheduleQueries.queryTeacherSchedule(startDate, endDate, {
                    teacher_id: teacherId,
                    student_id: studentId,
                    student_ids: studentIds,
                    actor: req.user
                });
            const [userName, rawData] = await Promise.all([
                resolveUserName(db, userType, userId),
                rawDataPromise,
                // 开始日志失败不能影响导出，就地告警并吞掉，不参与解构
                logService.logExportStart({
                    userId,
                    userType: logUserType,
                    startDate,
                    endDate,
                    studentId,
                    teacherId,
                    exportType
                }).then(id => { logId = id; }).catch(e => {
                    logger.warn('记录导出开始日志失败:', e.message);
                })
            ]);

            if (!rawData || rawData.length === 0) {
                throw new ExportError('该时间段内无数据', 404, 'EXPORT_NO_DATA');
            }

            // ===== 7-8. 生成多 Sheet Excel（统一流水线） =====
            // 解析选择的学生/教师名称：仅在指定了具体筛选时才使用真实姓名，
            // 否则保持为 null（文件名回退为“全部学生”/“全部教师”）。
            const distinctStudentNames = [...new Set(rawData.map(r => r.student_name).filter(Boolean))];
            const isHomeroomExport = logUserType === 'teacher_homeroom';
            const selectedStudentName = studentId
                ? (distinctStudentNames.join('、') || null)
                : (isHomeroomExport ? '全部关联学生' : null);
            const selectedTeacherName = teacherId ? (rawData[0]?.teacher_name || null) : null;
            // 问询列的学生标签：指定学生时列出学生姓名，否则为“全体学生”
            const studentLabel = studentId ? (distinctStudentNames.join('，') || '全体学生') : '全体学生';

            const excelResult = await pipeline.generateExcelFromData(rawData, {
                startDate,
                endDate,
                userType: logUserType,
                userId,
                userName,
                teacherId,
                studentId,
                studentName: selectedStudentName,
                teacherName: selectedTeacherName,
                studentLabel
            });

            // ===== 9. 记录成功（审计不阻塞文件下发：发出即走，失败只告警） =====
            if (logId) {
                logService.logExportSuccess(logId, {
                    recordCount: rawData.length,
                    fileSize: excelResult.buffer.length,
                    fileName: excelResult.filename,
                    duration: Date.now() - startTime
                }).catch(e => {
                    logger.warn('记录导出成功日志失败:', e.message);
                });
            }

            // ===== 10. 发送文件 =====
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', ExportUtils.buildDownloadDisposition(excelResult.filename, 'schedule-export'));
            res.setHeader('Content-Length', excelResult.buffer.length);
            return res.end(excelResult.buffer);

        } catch (error) {
            if (logId) {
                try { await logService.logExportError(logId, error.message); } catch (e) { /* */ }
            }
            return handleExportError(error, req, res);
        }
    },

    /**
     * 信息类导出（仅管理员）— 返回 JSON
     * POST /api/export/info
     *
     * Body: { type: 'teacher_info' | 'student_info', format?: 'excel' | 'csv' }
     */
    async exportInfo(req, res, next) {
        const startTime = Date.now();
        let logId = null;
        const logService = new ExportLogService(db);

        try {
            const { type, format = 'excel' } = req.body || {};
            const adminId = req.user.id;

            if (!type || !['teacher_info', 'student_info'].includes(type)) {
                throw new ExportError('缺少必要参数: type (teacher_info 或 student_info)', 400, 'EXPORT_INVALID_TYPE');
            }
            // 目前只有 excel 一条产出路径（不再下发 JSON 让前端拼文件），其余格式一律拒绝
            if (format !== 'excel') {
                throw new ExportError('不支持的导出格式，请使用 excel', 400, 'EXPORT_INVALID_FORMAT');
            }

            const adminName = await resolveUserName(db, 'admin', adminId);

            try {
                logId = await logService.logExportStart({
                    userId: adminId,
                    userType: 'admin',
                    exportType: type
                });
            } catch (e) {
                logger.warn('记录导出日志失败:', e.message);
            }

            let exportData, sheetName;

            if (type === 'teacher_info') {
                exportData = await scheduleQueries.exportTeacherInfo();
                sheetName = '教师信息';
            } else {
                exportData = await scheduleQueries.exportStudentInfo();
                sheetName = '学生信息';
            }

            // 空集不生成空文件：既浪费一次 Excel 组装，也让用户拿到一个「打不开的表格」而不知原因
            if (!exportData || exportData.length === 0) {
                throw new ExportError('没有可导出的数据', 404, 'EXPORT_NO_DATA');
            }

            const suffix = format === 'excel' ? 'xlsx' : 'csv';
            const filename = `${type === 'teacher_info' ? '教师信息数据' : '学生信息数据'}_${new Date().toISOString().split('T')[0]}.${suffix}`;

            // 信息类导出同样走 Excel 流水线，不再把数据塞进 JSON 让前端自己拼文件
            const excelResult = await pipeline.generateInfoExcel(exportData, filename, sheetName);

            if (logId) {
                try {
                    await logService.logExportSuccess(logId, {
                        recordCount: exportData.length,
                        fileSize: excelResult.buffer.length,
                        fileName: excelResult.filename,
                        duration: Date.now() - startTime
                    });
                } catch (e) {
                    logger.warn('记录导出完成日志失败:', e.message);
                }
            }

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', ExportUtils.buildDownloadDisposition(excelResult.filename, 'info-export'));
            res.setHeader('Content-Length', excelResult.buffer.length);
            return res.end(excelResult.buffer);

        } catch (error) {
            if (logId) {
                try { await logService.logExportError(logId, error.message); } catch (e) { /* */ }
            }
            return handleExportError(error, req, res);
        }
    }
};

module.exports = exportController;
