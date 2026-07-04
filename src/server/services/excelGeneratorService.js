/**
 * Excel 生成服务
 * 统一处理多Sheet Excel文件的生成
 * 基于 ExcelJS，支持 Rich Text 格式
 */

const enhancedExcel = require('./enhancedExcelService');

class ExcelGeneratorService {
    /**
     * 从多Sheet数据生成Excel Buffer
     * @param {Object} sheetsData - { 'Sheet1': [...data], 'Sheet2': [...data], _worksheetOptions: {...} }
     * @param {string} filename - 文件名
     * @returns {Object} { buffer, filename }
     */
    async generateMultiSheetExcel(sheetsData, filename) {
        const workbook = enhancedExcel.createWorkbook();

        // 提取工作表选项（如果存在）
        const worksheetOptions = sheetsData._worksheetOptions || {};

        // 定义固定的工作表顺序
        const sheetOrder = [
            '每日排课明细',
            '教师授课汇总',
            '学生上课汇总',
            '教师授课统计',
            '学生上课统计',
            '排课原始记录'
        ];

        // 按固定顺序添加工作表
        sheetOrder.forEach(sheetName => {
            const data = sheetsData[sheetName];
            // 跳过不存在或为空的工作表
            if (data && Array.isArray(data) && data.length > 0) {
                const options = worksheetOptions[sheetName] || {};
                enhancedExcel.addWorksheet(workbook, data, sheetName, options);
            }
        });

        // 添加任何不在固定顺序中的额外工作表（向后兼容）
        Object.entries(sheetsData).forEach(([sheetName, data]) => {
            if (sheetName === '_worksheetOptions') return;
            if (sheetOrder.includes(sheetName)) return; // 已经添加过

            if (Array.isArray(data) && data.length > 0) {
                const options = worksheetOptions[sheetName] || {};
                enhancedExcel.addWorksheet(workbook, data, sheetName, options);
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

}

module.exports = new ExcelGeneratorService();
