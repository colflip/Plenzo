/**
 * 导出流水线编排服务（Export Pipeline）
 * @description 统一三端排课导出共用的流水线：
 *              日期校验 → 导出开始日志 → 数据查询（调用方注入）→ 统一多Sheet生成 → Excel 生成 → 导出成功日志。
 *              返回契约（D1）：成功返回领域数据 { status, buffer, filename }；日期非法 / 无数据抛 ExportError，
 *              由控制器 handleExportError 收口成 { ok, data, error, meta } 信封（导出子码落在 error.details[0].exportCode）。
 *              数据查询/Excel 生成异常：service 记录导出失败日志后 rethrow，同样由 handleExportError 收口。
 * @module services/export/pipeline
 */

const db = require('../../db/db');
const logger = require('../../utils/logger');
const ExportLogService = require('../../utils/export-log-service');
const unifiedExportService = require('./sheet-builder');
const excelGeneratorService = require('./excel-writer');
const { ExportError } = require('../../middleware/export-error-handler');

class ExportService {
    /**
     * 排课导出日期校验（与 teacher/student advancedExport 原内联逻辑逐字一致）
     * @throws {ExportError} 400 EXPORT_DATE_REQUIRED / EXPORT_INVALID_DATE
     */
    validateScheduleDateRange(startDate, endDate) {
        if (!startDate || !endDate) {
            throw new ExportError('缺少起止日期参数', 400, 'EXPORT_DATE_REQUIRED');
        }
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(startDate) || !dateRegex.test(endDate) ||
            new Date(startDate).toString() === 'Invalid Date' ||
            new Date(endDate).toString() === 'Invalid Date') {
            throw new ExportError('日期格式无效，请使用 YYYY-MM-DD 格式', 400, 'EXPORT_INVALID_DATE');
        }
    }

    /**
     * 统一生成多Sheet Excel（原三端重复的 unified + excel 两步合并）
     * @param {Array} rawData 排课原始数据
     * @param {Object} meta 生成元数据（startDate/endDate/userType/userId/userName/studentId/teacherId/studentName/teacherName）
     * @returns {Promise<{buffer: Buffer, filename: string}>}
     */
    async generateExcelFromData(rawData, meta) {
        const exportResult = await unifiedExportService.generateCompleteExport(rawData, meta);
        const excelResult = await excelGeneratorService.generateMultiSheetExcel(
            exportResult.sheets,
            exportResult.filename
        );
        return { buffer: excelResult.buffer, filename: excelResult.filename };
    }

    /**
     * 生成单工作表 Excel（信息类导出：教师信息 / 学生信息）
     * @param {Array} data 行数据
     * @param {string} filename 文件名
     * @param {string} sheetName 工作表名
     * @returns {Promise<{buffer: Buffer, filename: string}>}
     */
    async generateInfoExcel(data, filename, sheetName) {
        return excelGeneratorService.generateSingleSheetExcel(data, filename, sheetName);
    }

    /**
     * 角色排课导出完整流水线（teacher/student advancedExport 原同构逻辑合一）
     * @param {Object} opts
     * @param {string} opts.startDate
     * @param {string} opts.endDate
     * @param {number} opts.userId
     * @param {string} opts.userType
     * @param {string} [opts.userName]
     * @param {number|string} [opts.studentId]
     * @param {number|string} [opts.teacherId]
     * @param {string} [opts.studentName]
     * @param {string} [opts.teacherName]
     * @param {string} opts.exportType
     * @param {Function} opts.queryRawData - () => Promise<rows>
     * @returns {Promise<{status: number, buffer: Buffer, filename: string}>}
     * @throws {ExportError} 400 日期非法 / 404 该时间段内无数据
     * @throws {Error} 数据查询/Excel 生成失败（已记录导出失败日志，由控制器 handleExportError 收口）
     */
    async runRoleScheduleExport(opts) {
        const { startDate, endDate, userId, userType, userName, studentId, teacherId, studentName, teacherName, exportType, queryRawData } = opts;
        const logService = new ExportLogService(db);
        let logId = null;
        const startTime = Date.now();

        this.validateScheduleDateRange(startDate, endDate);

        try {
            const logStartPayload = { userId, userType, startDate, endDate, exportType };
            if (typeof studentId !== 'undefined') logStartPayload.studentId = studentId;
            if (typeof teacherId !== 'undefined') logStartPayload.teacherId = teacherId;

            // 开始日志与数据查询互不依赖（logId 直到成功日志才用），并发省一次往返（约 250ms）
            const [rawData] = await Promise.all([
                queryRawData(),
                // 日志失败不能影响导出，就地告警并吞掉
                logService.logExportStart(logStartPayload)
                    .then(id => { logId = id; })
                    .catch(logError => { logger.warn('记录导出开始日志失败:', logError.message); })
            ]);

            if (!rawData || rawData.length === 0) {
                throw new ExportError('该时间段内无数据', 404, 'EXPORT_NO_DATA');
            }

            const meta = { startDate, endDate, userType, userId, studentName };
            if (userName) meta.userName = userName;
            if (typeof studentId !== 'undefined') meta.studentId = studentId;
            if (typeof teacherId !== 'undefined') meta.teacherId = teacherId;
            if (teacherName) meta.teacherName = teacherName;

            const { buffer, filename } = await this.generateExcelFromData(rawData, meta);

            // 成功日志不阻塞返回：发出即走，失败只告警
            if (logId) {
                logService.logExportSuccess(logId, {
                    recordCount: rawData.length,
                    fileSize: buffer.length,
                    fileName: filename,
                    duration: Date.now() - startTime
                }).catch(logError => {
                    logger.warn('记录导出完成日志失败:', logError.message);
                });
            }

            return { status: 200, buffer, filename };
        } catch (error) {
            // 4xx 是业务分支（日期非法 / 该时间段内无数据），不是导出故障，不写失败日志
            const statusCode = error && error.statusCode;
            const isBusinessBranch = statusCode >= 400 && statusCode < 500;
            if (logId && !isBusinessBranch) {
                try {
                    await logService.logExportError(logId, error.message);
                } catch (logError) {
                    logger.warn('记录导出错误日志失败:', logError.message);
                }
            }
            throw error;
        }
    }
}

module.exports = new ExportService();
