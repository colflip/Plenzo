/**
 * 统一导出控制器
 * @description 四端（管理员、教师、班主任、学生）共用的导出逻辑
 * @module controllers/exportController
 */

const db = require('../db/db');
const AdvancedExportService = require('../services/advancedExportService');
const UnifiedExportService = require('../services/unifiedExportService');
const excelGeneratorService = require('../services/excelGeneratorService');
const ExportLogService = require('../utils/exportLogService');
const { handleExportError } = require('../middleware/exportErrorHandler');
const { standardResponse } = require('../middleware/validation');
const { validateDateFormat, getTimestamp, resolveUserName } = require('../utils/sharedUtils');

const exportController = {
    /**
     * 统一排课数据导出 — 四端共用
     * POST /api/export/schedule
     *
     * Body: { startDate, endDate, exportType?, teacherId?, studentId? }
     * exportType: 'teacher_schedule' | 'student_schedule' (默认根据角色自动推断)
     *
     * 角色权限：
     * - admin: 可导出任意范围，可指定 teacherId/studentId
     * - teacher: 自动限定 teacherId = req.user.id
     *   - 若指定 studentId 且在绑定列表内 → 班主任导出
     * - student: 自动限定 studentId = req.user.id
     */
    async exportSchedule(req, res) {
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
                return res.status(400).json(standardResponse(false, null, '缺少起止日期参数'));
            }
            if (!validateDateFormat(startDate) || !validateDateFormat(endDate)) {
                return res.status(400).json(standardResponse(false, null, '日期格式无效，请使用 YYYY-MM-DD 格式'));
            }

            // ===== 3. 角色权限收敛 =====
            let teacherId = null;
            let studentId = null;
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
                    teacherId = userId;
                    if (reqStudentId) {
                        // 教师可导出与其有排课记录的任意学生（不限于绑定列表）
                        studentId = parseInt(reqStudentId);
                    }
                    if (!exportType) exportType = 'teacher_schedule';
                    break;

                case 'student':
                    studentId = userId;
                    if (!exportType) exportType = 'student_schedule';
                    break;

                default:
                    return res.status(403).json(standardResponse(false, null, '无导出权限'));
            }

            // ===== 4. 获取用户名 =====
            const userName = await resolveUserName(db, userType, userId);

            // ===== 5. 记录导出开始 =====
            try {
                logId = await logService.logExportStart({
                    userId,
                    userType: logUserType,
                    startDate,
                    endDate,
                    studentId,
                    teacherId,
                    exportType
                });
            } catch (e) {
                console.warn('记录导出开始日志失败:', e.message);
            }

            // ===== 6. 查询原始数据 =====
            const exportService = new AdvancedExportService(db);
            let rawData;

            if (exportType === 'student_schedule') {
                rawData = await exportService.queryStudentSchedule(startDate, endDate, {
                    student_id: studentId
                });
            } else {
                rawData = await exportService.queryTeacherSchedule(startDate, endDate, {
                    teacher_id: teacherId,
                    student_id: studentId
                });
            }

            if (!rawData || rawData.length === 0) {
                return res.status(404).json(standardResponse(false, null, '该时间段内无数据'));
            }

            // ===== 7. 生成多 Sheet 数据 =====
            const unifiedService = new UnifiedExportService();
            const exportResult = await unifiedService.generateCompleteExport(rawData, {
                startDate,
                endDate,
                userType: logUserType,
                userId,
                userName,
                teacherId,
                studentId,
                studentName: rawData[0]?.student_name || '全部学生',
                teacherName: rawData[0]?.teacher_name || null
            });

            // ===== 8. 生成 Excel 二进制 =====
            const excelResult = await excelGeneratorService.generateMultiSheetExcel(
                exportResult.sheets,
                exportResult.filename
            );

            // ===== 9. 记录成功 =====
            if (logId) {
                try {
                    await logService.logExportSuccess(logId, {
                        recordCount: rawData.length,
                        fileSize: excelResult.buffer.length,
                        fileName: excelResult.filename,
                        duration: Date.now() - startTime
                    });
                } catch (e) {
                    console.warn('记录导出成功日志失败:', e.message);
                }
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
    async exportInfo(req, res) {
        const startTime = Date.now();
        let logId = null;
        const logService = new ExportLogService(db);

        try {
            const { type, format = 'excel' } = req.body || {};
            const adminId = req.user.id;

            if (!type || !['teacher_info', 'student_info'].includes(type)) {
                return res.status(400).json(standardResponse(false, null, '缺少必要参数: type (teacher_info 或 student_info)'));
            }

            const adminName = await resolveUserName(db, 'admin', adminId);

            try {
                logId = await logService.logExportStart({
                    userId: adminId,
                    userType: 'admin',
                    exportType: type
                });
            } catch (e) {
                console.warn('记录导出日志失败:', e.message);
            }

            const exportService = new AdvancedExportService(db);
            let exportData, filename;

            if (type === 'teacher_info') {
                exportData = await exportService.exportTeacherInfo();
                filename = `教师信息数据_${new Date().toISOString().split('T')[0]}.${format === 'excel' ? 'xlsx' : 'csv'}`;
            } else {
                exportData = await exportService.exportStudentInfo();
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
                    console.warn('记录导出完成日志失败:', e.message);
                }
            }

            return res.json({
                success: true,
                data: exportData,
                filename,
                format,
                recordCount: exportData.length
            });

        } catch (error) {
            if (logId) {
                try { await logService.logExportError(logId, error.message); } catch (e) { /* */ }
            }
            return handleExportError(error, req, res);
        }
    }
};

module.exports = exportController;
