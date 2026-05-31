/**
 * Excel 生成服务
 * 统一处理多Sheet Excel文件的生成
 * 基于 ExcelJS，支持 Rich Text 格式
 */

const enhancedExcel = require('./enhancedExcelService');

class ExcelGeneratorService {
    /**
     * 从多Sheet数据生成Excel Buffer
     * @param {Object} sheetsData - { 'Sheet1': [...data], 'Sheet2': [...data] }
     * @param {string} filename - 文件名
     * @returns {Object} { buffer, filename }
     */
    async generateMultiSheetExcel(sheetsData, filename) {
        const workbook = enhancedExcel.createWorkbook();

        // 遍历每个Sheet并添加到工作簿
        Object.entries(sheetsData).forEach(([sheetName, data]) => {
            if (Array.isArray(data) && data.length > 0) {
                enhancedExcel.addWorksheet(workbook, data, sheetName);
            }
        });

        const buffer = await enhancedExcel.writeToBuffer(workbook);

        return {
            buffer,
            filename
        };
    }

    /**
     * 从单Sheet数据生成Excel Buffer
     * @param {Array} data - 数据数组
     * @param {string} filename - 文件名
     * @param {string} sheetName - Sheet名称
     * @returns {Object} { buffer, filename }
     */
    async generateSingleSheetExcel(data, filename, sheetName = 'Sheet1') {
        const workbook = enhancedExcel.createWorkbook();
        enhancedExcel.addWorksheet(workbook, data, sheetName);
        const buffer = await enhancedExcel.writeToBuffer(workbook);

        return {
            buffer,
            filename
        };
    }

    /**
     * 将导出数据转换为Excel格式并发送响应
     * @param {Object} res - Express响应对象
     * @param {Object|Array} data - 数据（可以是多Sheet对象或单个数组）
     * @param {string} filename - 文件名
     */
    async sendExcelResponse(res, data, filename) {
        let result;

        // 判断是多Sheet还是单Sheet
        if (typeof data === 'object' && !Array.isArray(data)) {
            // 多Sheet数据
            result = await this.generateMultiSheetExcel(data, filename);
        } else if (Array.isArray(data)) {
            // 单Sheet数据
            result = await this.generateSingleSheetExcel(data, filename);
        } else {
            throw new Error('无效的数据格式');
        }

        // 设置响应头
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

        const encodedFilename = encodeURIComponent(result.filename);
        res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"`);
        res.setHeader('Content-Length', result.buffer.length);

        res.end(result.buffer);
    }
}

module.exports = new ExcelGeneratorService();
