/**
 * 导出流水线编排服务（Export Pipeline）
 * @description 统一三端排课导出共用的流水线：
 *              日期校验 → 导出开始日志 → 数据查询（调用方注入）→ 统一多Sheet生成 → Excel 生成 → 导出成功日志。
 *              文件流由控制器发送（service 返回 { status, buffer, filename } 成功或 { status, body } 业务错误）。
 *              数据查询/Excel 生成异常：service 记录导出失败日志后 rethrow，由控制器 handleExportError 收口。
 * @module services/export/pipeline
 */

const db = require('../../db/db');
const logger = require('../../utils/logger');
const ExportLogService = require('../../utils/export-log-service');
const unifiedExportService = require('./sheet-builder');
const excelGeneratorService = require('./excel-writer');
const { standardResponse } = require('../../middleware/validation');

class ExportService {
    /**
     * 排课导出日期校验（与 teacher/student advancedExport 原内联逻辑逐字一致）
     * @returns {{ok: true}} 或 {{ok: false, status: number, body: object}}
     */
    validateScheduleDateRange(startDate, endDate) {
        if (!startDate || !endDate) {
            return { ok: false, status: 400, body: standardResponse(false, null, '缺少起止日期参数') };
        }
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(startDate) || !dateRegex.test(endDate) ||
            new Date(startDate).toString() === 'Invalid Date' ||
            new Date(endDate).toString() === 'Invalid Date') {
            return { ok: false, status: 400, body: standardResponse(false, null, '日期格式无效，请使用 YYYY-MM-DD 格式') };
        }
        return { ok: true };
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
     * @returns {Promise<{status: number, body?: object, buffer?: Buffer, filename?: string}>}
     * @throws {Error} 数据查询/Excel 生成失败（已记录导出失败日志，由控制器 handleExportError 收口）
     */
    async runRoleScheduleExport(opts) {
        const { startDate, endDate, userId, userType, userName, studentId, teacherId, studentName, teacherName, exportType, queryRawData } = opts;
        const logService = new ExportLogService(db);
        let logId = null;
        const startTime = Date.now();

        const v = this.validateScheduleDateRange(startDate, endDate);
        if (!v.ok) return v;

        try {
            const logStartPayload = { userId, userType, startDate, endDate, exportType };
            if (typeof studentId !== 'undefined') logStartPayload.studentId = studentId;
            if (typeof teacherId !== 'undefined') logStartPayload.teacherId = teacherId;
            logId = await logService.logExportStart(logStartPayload);
        } catch (logError) {
            logger.warn('记录导出开始日志失败:', logError.message);
        }

        try {
            const rawData = await queryRawData();

            if (!rawData || rawData.length === 0) {
                return { status: 404, body: standardResponse(false, null, '该时间段内无数据') };
            }

            const meta = { startDate, endDate, userType, userId, studentName };
            if (userName) meta.userName = userName;
            if (typeof studentId !== 'undefined') meta.studentId = studentId;
            if (typeof teacherId !== 'undefined') meta.teacherId = teacherId;
            if (teacherName) meta.teacherName = teacherName;

            const { buffer, filename } = await this.generateExcelFromData(rawData, meta);

            if (logId) {
                try {
                    await logService.logExportSuccess(logId, {
                        recordCount: rawData.length,
                        fileSize: buffer.length,
                        fileName: filename,
                        duration: Date.now() - startTime
                    });
                } catch (logError) {
                    logger.warn('记录导出完成日志失败:', logError.message);
                }
            }

            return { status: 200, buffer, filename };
        } catch (error) {
            if (logId) {
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
