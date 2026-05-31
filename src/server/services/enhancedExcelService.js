/**
 * 增强的 Excel 服务
 * 基于 ExcelJS 库，提供 Rich Text 格式化功能
 * 支持：
 * 1. 按时间段分组显示课程
 * 2. 单元格内 Rich Text（多种颜色、加粗、斜体、删除线）
 * 3. 使用分号分隔同一时间段的多个课程
 */

const ExcelJS = require('exceljs');

class EnhancedExcelService {
    /**
     * 创建工作簿
     */
    createWorkbook() {
        return new ExcelJS.Workbook();
    }

    /**
     * 添加工作表到工作簿
     */
    addWorksheet(workbook, data, sheetName, options = {}) {
        const worksheet = workbook.addWorksheet(sheetName);

        if (!data || data.length === 0) {
            return worksheet;
        }

        // 获取列名
        const columns = Object.keys(data[0]).map(key => ({
            header: key,
            key: key,
            width: this.calculateColumnWidth(key, data)
        }));

        worksheet.columns = columns;

        // 添加数据行
        data.forEach((row, rowIndex) => {
            const excelRow = worksheet.addRow(row);

            // 检查是否需要应用 Rich Text 格式
            Object.keys(row).forEach((key, colIndex) => {
                const cell = excelRow.getCell(colIndex + 1);
                const value = row[key];

                // 如果是计划安排或实际安排列，应用 Rich Text
                if ((key === '计划安排' || key === '实际安排') && value) {
                    const richText = this.parseRichText(value, key === '计划安排');
                    if (richText.length > 0) {
                        cell.value = { richText };
                        cell.alignment = { wrapText: true, vertical: 'top' };
                    }
                }
            });
        });

        // 设置表头样式
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' }
        };

        return worksheet;
    }

    /**
     * 解析文本为 Rich Text 格式
     * @param {string} text - 原始文本
     * @param {boolean} isPlanned - 是否是计划安排列
     * @returns {Array} Rich Text 数组
     */
    parseRichText(text, isPlanned) {
        if (!text) return [];

        const richText = [];
        // 按分号分割课程
        const courses = text.split('；').filter(c => c.trim());

        courses.forEach((course, index) => {
            const trimmedCourse = course.trim();

            // 检查状态标记
            const isCancelled = trimmedCourse.startsWith('[已取消]');
            const isNew = trimmedCourse.startsWith('[新增]');
            const isAdjusted = trimmedCourse.startsWith('[调整]');

            if (isCancelled) {
                // 已取消：红色 + 斜体 + 删除线
                richText.push({
                    text: trimmedCourse,
                    font: {
                        color: { argb: 'FFFF0000' },
                        italic: true,
                        strike: true
                    }
                });
            } else if (isNew) {
                // 新增：绿色 + 加粗
                richText.push({
                    text: trimmedCourse,
                    font: {
                        color: { argb: 'FF008000' },
                        bold: true
                    }
                });
            } else if (isAdjusted) {
                // 调整：橙色 + 加粗
                richText.push({
                    text: trimmedCourse,
                    font: {
                        color: { argb: 'FFFF8C00' },
                        bold: true
                    }
                });
            } else {
                // 正常：黑色
                richText.push({
                    text: trimmedCourse,
                    font: {
                        color: { argb: 'FF000000' }
                    }
                });
            }

            // 添加分号分隔符（除了最后一个）
            if (index < courses.length - 1) {
                richText.push({
                    text: '；',
                    font: { color: { argb: 'FF000000' } }
                });
            }
        });

        return richText;
    }

    /**
     * 计算列宽
     */
    calculateColumnWidth(columnName, data) {
        let maxWidth = this.getStringWidth(columnName);

        data.forEach(row => {
            const value = row[columnName] ? String(row[columnName]) : '';
            // 移除标记符号后计算宽度
            const cleanValue = value.replace(/\[已取消\]|\[新增\]|\[调整\]/g, '');
            // 按分号分割，取最长的一个
            const parts = cleanValue.split('；');
            parts.forEach(part => {
                const width = this.getStringWidth(part.trim());
                if (width > maxWidth) maxWidth = width;
            });
        });

        return Math.min(maxWidth + 2, 80);
    }

    /**
     * 计算字符串宽度（中文字符算2个宽度）
     */
    getStringWidth(str) {
        if (!str) return 0;
        let width = 0;
        for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            width += (code > 255) ? 2 : 1;
        }
        return width;
    }

    /**
     * 自动计算列宽（兼容旧接口）
     */
    autoCalculateColumnWidths(data) {
        if (!data || data.length === 0) return [];

        const keys = Object.keys(data[0]);
        return keys.map(key => {
            const width = this.calculateColumnWidth(key, data);
            return { wch: width };
        });
    }

    /**
     * 格式化时间
     */
    formatTime(time) {
        if (!time) return '';
        if (typeof time === 'string') {
            return time.slice(0, 5);
        }
        if (time instanceof Date) {
            return time.toTimeString().slice(0, 5);
        }
        return String(time).slice(0, 5);
    }

    /**
     * 格式化日期
     */
    formatDate(date) {
        if (!date) return '';
        if (date instanceof Date) {
            return date.toISOString().slice(0, 10);
        }
        return String(date).slice(0, 10);
    }

    /**
     * 格式化日期时间
     */
    formatDateTime(datetime) {
        if (!datetime) return '';
        try {
            const d = new Date(datetime);
            return d.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
        } catch (e) {
            return String(datetime);
        }
    }

    /**
     * 格式化状态
     */
    formatStatus(status) {
        const statusMap = {
            'pending': '待确认',
            'confirmed': '已确认',
            'completed': '已完成',
            'cancelled': '已取消',
            'modified_away': '已调整',
            '0': '已取消',
            '1': '已确认',
            '2': '已取消'
        };
        return statusMap[String(status)] || status;
    }

    /**
     * 写入 Buffer
     */
    async writeToBuffer(workbook) {
        return await workbook.xlsx.writeBuffer();
    }

    /**
     * 生成时间戳
     */
    getTimestamp() {
        const now = new Date();
        const yyyyMMdd = now.toISOString().slice(0, 10).replace(/-/g, '');
        const hhmmss = now.toTimeString().slice(0, 8).replace(/:/g, '');
        return `${yyyyMMdd}${hhmmss}`;
    }
}

module.exports = new EnhancedExcelService();
