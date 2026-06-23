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

        // 获取列名（过滤掉以 _ 开头的内部字段）
        const visibleKeys = Object.keys(data[0]).filter(key => !key.startsWith('_'));
        const columns = visibleKeys.map(key => ({
            header: key,
            key: key,
            width: this.calculateColumnWidth(key, data)
        }));

        worksheet.columns = columns;

        // 添加数据行
        data.forEach((row, rowIndex) => {
            // 过滤掉以 _ 开头的内部字段
            const cleanRow = {};
            visibleKeys.forEach(key => {
                cleanRow[key] = row[key];
            });

            const excelRow = worksheet.addRow(cleanRow);

            // 检查是否需要应用 Rich Text 格式
            visibleKeys.forEach((key, colIndex) => {
                const cell = excelRow.getCell(colIndex + 1);
                const value = cleanRow[key];

                // 如果是计划安排或实际安排列，应用 Rich Text
                if ((key === '计划安排' || key === '实际安排') && value) {
                    const richText = this.parseRichText(value, key === '计划安排');
                    if (richText.length > 0) {
                        cell.value = { richText };
                        cell.alignment = { wrapText: true, vertical: 'top' };
                    }
                }

                // 应用 Rich Text（从 textParts）
                if (options.applyRichText && row._planTextParts && key === '计划安排') {
                    const richText = this.applyRichTextFormat(row._planTextParts);
                    if (richText.length > 0) {
                        cell.value = { richText };
                        cell.alignment = { wrapText: true, vertical: 'top' };
                    }
                }
                if (options.applyRichText && row._actualTextParts && key === '实际安排') {
                    const richText = this.applyRichTextFormat(row._actualTextParts);
                    if (richText.length > 0) {
                        cell.value = { richText };
                        cell.alignment = { wrapText: true, vertical: 'top' };
                    }
                }
            });

            // 应用行背景色
            if (options.applyRowColors) {
                this.applyRowBackgroundColor(excelRow, row);
            }
        });

        // 在数据行添加完成后，应用日期列合并
        if (options.mergeDateColumns === true) {
            this.mergeDateAndWeekdayColumns(worksheet, data);
        }

        // 应用费用列合并
        if (options.mergeFeeColumn === true) {
            this.mergeFeeColumn(worksheet, data);
        }

        // 应用周汇总列合并
        if (options.mergeWeekSummaryColumn === true) {
            this.mergeWeekSummaryColumn(worksheet, data);
        }

        // 应用列样式（使用过滤后的可见列名）
        if (options.kind) {
            this.applyColumnStyles(worksheet, visibleKeys, options.kind);
        }

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
     * 合并日期和星期列中连续相同日期的单元格
     * @param {Worksheet} worksheet - ExcelJS worksheet对象
     * @param {Array} data - 原始数据数组
     */
    mergeDateAndWeekdayColumns(worksheet, data) {
        if (!data || data.length === 0) {
            return;
        }

        const dateColIdx = 1;  // 日期列（第1列）
        const weekdayColIdx = 2; // 星期列（第2列）

        let mergeStartRow = 2; // ExcelJS行号从1开始，第1行是表头，数据从第2行开始

        for (let i = 1; i < data.length; i++) {
            const prevDate = data[i - 1]['日期'];
            const currDate = data[i]['日期'];
            const currentRowIdx = i + 2; // ExcelJS行索引：i=0对应第2行，i=1对应第3行...

            // 检测到日期变化，执行合并
            if (currDate !== prevDate) {
                const mergeEndRow = i + 1; // 上一个区域的结束行

                // 只有当合并区域大于1行时才执行合并
                if (mergeEndRow > mergeStartRow) {
                    // 合并日期列
                    worksheet.mergeCells(mergeStartRow, dateColIdx, mergeEndRow, dateColIdx);

                    // 合并星期列
                    worksheet.mergeCells(mergeStartRow, weekdayColIdx, mergeEndRow, weekdayColIdx);

                    // 设置合并后的单元格样式
                    const dateCell = worksheet.getCell(mergeStartRow, dateColIdx);
                    const weekdayCell = worksheet.getCell(mergeStartRow, weekdayColIdx);

                    // 垂直居中对齐
                    dateCell.alignment = {
                        vertical: 'middle',
                        horizontal: 'center',
                        wrapText: false
                    };
                    weekdayCell.alignment = {
                        vertical: 'middle',
                        horizontal: 'center',
                        wrapText: false
                    };
                }

                // 更新下一个合并区域的起始行
                mergeStartRow = currentRowIdx;
            }
        }

        // 处理最后一个日期区域
        const lastMergeEndRow = data.length + 1;
        if (lastMergeEndRow > mergeStartRow) {
            // 合并日期列
            worksheet.mergeCells(mergeStartRow, dateColIdx, lastMergeEndRow, dateColIdx);

            // 合并星期列
            worksheet.mergeCells(mergeStartRow, weekdayColIdx, lastMergeEndRow, weekdayColIdx);

            // 设置样式
            const dateCell = worksheet.getCell(mergeStartRow, dateColIdx);
            const weekdayCell = worksheet.getCell(mergeStartRow, weekdayColIdx);

            dateCell.alignment = {
                vertical: 'middle',
                horizontal: 'center',
                wrapText: false
            };
            weekdayCell.alignment = {
                vertical: 'middle',
                horizontal: 'center',
                wrapText: false
            };
        }
    }

    /**
     * 合并费用列（按日期）
     */
    mergeFeeColumn(worksheet, data) {
        if (!data || data.length === 0) return;

        const headers = Object.keys(data[0]).filter(k => !k.startsWith('_'));
        const feeColIdx = headers.indexOf('费用');
        if (feeColIdx === -1) return;

        let startRow = 2;
        for (let i = 1; i < data.length; i++) {
            const prev = data[i - 1];
            const curr = data[i];
            const currentRowIdx = i + 2;

            if (curr['日期'] !== prev['日期']) {
                if (i + 1 - startRow > 1) {
                    worksheet.mergeCells(startRow, feeColIdx + 1, i + 1, feeColIdx + 1);
                    const cell = worksheet.getCell(startRow, feeColIdx + 1);
                    cell.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
                }
                startRow = currentRowIdx;
            }
        }

        // 处理最后一个日期区域
        if (data.length + 1 - startRow > 1) {
            worksheet.mergeCells(startRow, feeColIdx + 1, data.length + 1, feeColIdx + 1);
            const cell = worksheet.getCell(startRow, feeColIdx + 1);
            cell.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
        }
    }

    /**
     * 合并周汇总列（按 _weekNumber）
     */
    mergeWeekSummaryColumn(worksheet, data) {
        if (!data || data.length === 0) return;

        const headers = Object.keys(data[0]).filter(k => !k.startsWith('_'));
        const weekSumColIdx = headers.indexOf('周汇总');
        if (weekSumColIdx === -1) return;

        let startRow = 2;
        for (let i = 1; i < data.length; i++) {
            const prev = data[i - 1];
            const curr = data[i];
            const currentRowIdx = i + 2;

            if (curr._weekNumber !== prev._weekNumber) {
                if (i + 1 - startRow > 1) {
                    worksheet.mergeCells(startRow, weekSumColIdx + 1, i + 1, weekSumColIdx + 1);
                    const cell = worksheet.getCell(startRow, weekSumColIdx + 1);
                    cell.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
                }
                startRow = currentRowIdx;
            }
        }

        // 处理最后一个周区域
        if (data.length + 1 - startRow > 1) {
            worksheet.mergeCells(startRow, weekSumColIdx + 1, data.length + 1, weekSumColIdx + 1);
            const cell = worksheet.getCell(startRow, weekSumColIdx + 1);
            cell.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
        }
    }

    /**
     * 应用 Rich Text 格式（从 textParts 数组生成）
     */
    applyRichTextFormat(textParts) {
        const richText = [];

        textParts.forEach((part, index) => {
            const font = { color: { argb: 'FF000000' } };

            // 红色类型（咨询、评审）
            if (part.isRed) {
                font.color = { argb: 'FFFF0000' };
            }

            // 已取消：灰色 + 斜体
            if (part.isCancelled) {
                font.color = { argb: 'FF595959' };
                font.italic = true;
            }

            // 调走：茶色 + 斜体
            if (part.isModifiedAway) {
                font.color = { argb: 'FF8C6239' };
                font.italic = true;
            }

            richText.push({
                text: part.text,
                font: font
            });

            // 添加分号分隔符（除了最后一个）
            if (index < textParts.length - 1) {
                richText.push({
                    text: '；',
                    font: { color: { argb: 'FF000000' } }
                });
            }
        });

        return richText;
    }

    /**
     * 应用行背景色
     */
    applyRowBackgroundColor(excelRow, rowData) {
        // 周日行：浅蓝色
        if (rowData._isSunday) {
            excelRow.eachCell({ includeEmpty: true }, (cell) => {
                cell.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFDDEBF7' }
                };
            });
        }

        // 红行（有咨询/评审课程）
        if (rowData._isRedRow) {
            // 可以选择性地添加特殊标记
            // 暂时不做额外处理
        }
    }

    /**
     * 应用列样式（根据工作表类型）
     */
    applyColumnStyles(worksheet, headers, kind) {
        headers.forEach((header, index) => {
            const colIndex = index + 1;

            // 日期列：浅绿色背景
            if (kind === 'detail' && header === '日期') {
                worksheet.getColumn(colIndex).eachCell({ includeEmpty: false }, (cell, rowNumber) => {
                    if (rowNumber > 1) { // 跳过表头
                        cell.fill = {
                            type: 'pattern',
                            pattern: 'solid',
                            fgColor: { argb: 'FFE2EFDA' }
                        };
                    }
                });
            }

            // 费用、周汇总列：右对齐
            if ((header === '费用' || header === '周汇总') && kind === 'detail') {
                worksheet.getColumn(colIndex).eachCell({ includeEmpty: false }, (cell, rowNumber) => {
                    if (rowNumber > 1) {
                        cell.alignment = { ...cell.alignment, horizontal: 'right', vertical: 'bottom' };
                    }
                });
            }

            // 汇总表的数值列：右对齐
            if (kind === 'summary' && ['试教', '入户', '评审', '集体活动', '咨询'].includes(header)) {
                worksheet.getColumn(colIndex).eachCell({ includeEmpty: false }, (cell, rowNumber) => {
                    if (rowNumber > 1) {
                        cell.alignment = { horizontal: 'right', vertical: 'bottom', wrapText: true };
                    }
                });
            }
        });
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
