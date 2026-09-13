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
const { handleExportError } = require('../middleware/export-error-handler');
const { standardResponse } = require('../middleware/validation');
const { validateDateFormat, getTimestamp, resolveUserName } = require('../utils/shared-utils');

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
                return next(new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '缺少起止日期参数' }));
            }
            if (!validateDateFormat(startDate) || !validateDateFormat(endDate)) {
                return next(new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '日期格式无效，请使用 YYYY-MM-DD 格式' }));
            }

            // ===== 3. 角色权限收敛 =====
            let teacherId = null;
            let studentId = null;
            let studentIds = null;   // 班主任导出：绑定学生 ID 范围
            let logUserType = userType;
            let exportType = reqExportType;

            switch (userType) {
                case 'admin':
                    teacherId = reqTeacherId ? parseInt(reqTeacherId) : null;
                    studentId = reqStudentId ? parseInt(reqStudentId) : null;
                    // admin 默认导出 teacher_schedule
                    if (!exportType) exportType = 'teacher_schedule';
                    break;

                case 'teacher':
                    if (exportType === 'teacher_homeroom') {
                        // 班主任导出：以其绑定的学生为范围，导出这些学生的全部排课（不限授课教师），
                        // 不能收敛为 teacherId = 本人，否则只会导出自己名下的排课。
                        const { found, studentIds: boundStudentIds } = await headTeacherService.getBoundStudentIds(userId);
                        if (!found) {
                            return next(new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到教师信息' }));
                        }
                        if (boundStudentIds.length === 0) {
                            return next(new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '您未绑定任何学生，无法导出数据' }));
                        }

                        if (reqStudentId) {
                            const sId = parseInt(reqStudentId);
                            if (!boundStudentIds.includes(sId)) {
                                return next(new AppError({ code: 'FORBIDDEN', statusCode: 403, message: '您无权导出该学生的数据' }));
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
                        if (!exportType) exportType = 'teacher_schedule';
                    }
                    break;

                case 'student':
                    studentId = userId;
                    if (!exportType) exportType = 'student_schedule';
                    break;

                default:
                    return next(new AppError({ code: 'FORBIDDEN', statusCode: 403, message: '无导出权限' }));
            }

            // ===== 4-6. 用户名 / 导出开始日志 / 原始数据 =====
            // 三条互不依赖（userName 第 7 步才用，logId 第 9 步才用），并发省两次往返（每条约 250ms）
            const rawDataPromise = exportType === 'student_schedule'
                ? scheduleQueries.queryStudentSchedule(startDate, endDate, {
                    student_id: studentId
                })
                : scheduleQueries.queryTeacherSchedule(startDate, endDate, {
                    teacher_id: teacherId,
                    student_id: studentId,
                    student_ids: studentIds
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
                return next(new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '该时间段内无数据' }));
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
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(excelResult.filename)}"`);
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
                return next(new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '缺少必要参数: type (teacher_info 或 student_info)' }));
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

            let exportData, filename;

            if (type === 'teacher_info') {
                exportData = await scheduleQueries.exportTeacherInfo();
                filename = `教师信息数据_${new Date().toISOString().split('T')[0]}.${format === 'excel' ? 'xlsx' : 'csv'}`;
            } else {
                exportData = await scheduleQueries.exportStudentInfo();
                filename = `学生信息数据_${new Date().toISOString().split('T')[0]}.${format === 'excel' ? 'xlsx' : 'csv'}`;
            }

            if (logId) {
                try {
                    await logService.logExportSuccess(logId, {
                        recordCount: exportData.length,
                        fileSize: 0,
                        fileName: filename,
                        duration: Date.now() - startTime
                    });
                } catch (e) {
                    logger.warn('记录导出完成日志失败:', e.message);
                }
            }

            return res.json(successResponse({
                success: true,
                data: exportData,
                filename,
                format,
                recordCount: exportData.length
            }));

        } catch (error) {
            if (logId) {
                try { await logService.logExportError(logId, error.message); } catch (e) { /* */ }
            }
            return handleExportError(error, req, res);
        }
    }
};

module.exports = exportController;
