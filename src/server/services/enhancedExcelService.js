/**
 * 增强的 Excel 服务
 * 基于 ExcelJS 库，提供 Rich Text 格式化功能
 * 支持：
 * 1. 按时间段分组显示课程
 * 2. 单元格内 Rich Text（多种颜色、加粗、斜体、删除线）
 * 3. 使用分号分隔同一时间段的多个课程
 */

const ExcelJS = require('exceljs');
const { RICH_TEXT_COLORS } = require('./export/ExportConstants');
const RichTextFormatter = require('./export/RichTextFormatter');

// ============================================================
// 预定义样式常量 — 避免在循环中重复创建对象
// ============================================================
const STYLE_FONT = { name: '宋体', size: 11 };
const STYLE_BORDER = {
    top:    { style: 'thin', color: { argb: 'FFD4D4D4' } },
    bottom: { style: 'thin', color: { argb: 'FFD4D4D4' } },
    left:   { style: 'thin', color: { argb: 'FFD4D4D4' } },
    right:  { style: 'thin', color: { argb: 'FFD4D4D4' } }
};
const STYLE_ALIGN_RICHTEXT = { wrapText: true, vertical: 'top', horizontal: 'left' };
const STYLE_ALIGN_DEFAULT = { vertical: 'middle', wrapText: true, horizontal: 'center' };
const STYLE_FILL_SUNDAY = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };

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

        // 固定列宽配置（参考前端 export-manager-exceljs.js 第 86-109 行）
        // 汇总、核对、问询列使用自动列宽（按最宽内容计算）
        const fixedColumnWidths = {
            '日期': 12,
            '星期': 8,
            '计划安排': 60,
            '实际安排': 60,
            '费用': 20,
            '周汇总': 15,
            '时间段': 12,
            '教师': 10,
            '学生': 10,
            '类型': 16,
            '地点': 20,
            '教师姓名': 16,
            '学生姓名': 16
        };

        const columns = visibleKeys.map(key => ({
            header: key,
            key: key,
            width: fixedColumnWidths[key] || this.calculateColumnWidth(key, data)
        }));

        worksheet.columns = columns;

        // 添加数据行
        data.forEach((row, rowIndex) => {
            // 过滤掉以 _ 开头的内部字段，并预处理 Rich Text
            const cleanRow = {};
            visibleKeys.forEach(key => {
                let cellValue = row[key];

                // 预先生成 Rich Text 对象（在 addRow 时设置，确保被正确序列化）
                if (options.applyRichText && key === '计划安排' && row._planTextParts && row._planTextParts.length > 0) {
                    const richText = this.applyRichTextFormat(row._planTextParts);
                    if (richText.length > 0) {
                        cellValue = { richText };
                    }
                } else if (options.applyRichText && key === '实际安排' && row._actualTextParts && row._actualTextParts.length > 0) {
                    const richText = this.applyRichTextFormat(row._actualTextParts);
                    if (richText.length > 0) {
                        cellValue = { richText };
                    }
                }

                // 防御性处理：NaN/Infinity 写入数字单元格会损坏 Excel 文件
                // 将非有限数字降级为安全占位符 '/'
                if (typeof cellValue === 'number' && !Number.isFinite(cellValue)) {
                    cellValue = '/';
                }

                cleanRow[key] = cellValue;
            });

            const excelRow = worksheet.addRow(cleanRow);

            // 设置所有单元格的基础样式：字体、对齐、灰色边框
            visibleKeys.forEach((key, colIndex) => {
                const cell = excelRow.getCell(colIndex + 1);
                const value = cleanRow[key];

                // 基础字体（所有数据单元格）— 复用预定义样式
                cell.font = STYLE_FONT;
                cell.border = STYLE_BORDER;

                // Rich Text 单元格：换行 + 顶部对齐
                if (value && typeof value === 'object' && value.richText) {
                    cell.alignment = STYLE_ALIGN_RICHTEXT;
                } else {
                    // 普通单元格：基础居中
                    cell.alignment = STYLE_ALIGN_DEFAULT;
                }
            });

            // 应用条件样式（参考前端 export-manager-exceljs.js 第 237-339 行）
            if (options.kind === 'detail') {
                this.applyConditionalStyles(excelRow, visibleKeys, row, cleanRow, options);
            }

            // 应用行背景色
            if (options.applyRowColors) {
                this.applyRowBackgroundColor(excelRow, row);
            }

            // 原始记录表：复用第1工作表的颜色/斜体/周末背景
            if (options.kind === 'raw') {
                this.applyRawRecordStyles(excelRow, visibleKeys, row);
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
        const headerRow = worksheet.getRow(1);
        headerRow.font = { name: '宋体', size: 12, bold: true };
        headerRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' }
        };
        // 表头也添加灰色边框
        headerRow.eachCell({ includeEmpty: true }, (cell) => {
            cell.border = {
                top:    { style: 'thin', color: { argb: 'FFD4D4D4' } },
                bottom: { style: 'thin', color: { argb: 'FFD4D4D4' } },
                left:   { style: 'thin', color: { argb: 'FFD4D4D4' } },
                right:  { style: 'thin', color: { argb: 'FFD4D4D4' } }
            };
            cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        });

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

            // 检测到日期变化，执行合并
            if (currDate !== prevDate) {
                // i 的当前 Excel 行号 = i + 2（i=0对应第2行，i=1对应第3行）
                // 上一个区域的结束行 = i + 1（i-1 对应的行号）
                const mergeEndRow = i + 1;

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
                mergeStartRow = i + 2; // 当前行号
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

            if (curr['日期'] !== prev['日期']) {
                const mergeEndRow = i + 1;
                if (mergeEndRow > startRow) {
                    worksheet.mergeCells(startRow, feeColIdx + 1, mergeEndRow, feeColIdx + 1);
                    const cell = worksheet.getCell(startRow, feeColIdx + 1);
                    cell.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
                }
                startRow = i + 2; // 下一个区域从当前行开始
            }
        }

        // 处理最后一个日期区域
        const lastMergeEndRow = data.length + 1;
        if (lastMergeEndRow > startRow) {
            worksheet.mergeCells(startRow, feeColIdx + 1, lastMergeEndRow, feeColIdx + 1);
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

            // 添加存在性检查，防止 undefined 导致的合并错误
            if (curr._weekNumber && prev._weekNumber && curr._weekNumber !== prev._weekNumber) {
                const mergeEndRow = i + 1;
                if (mergeEndRow > startRow) {
                    worksheet.mergeCells(startRow, weekSumColIdx + 1, mergeEndRow, weekSumColIdx + 1);
                    const cell = worksheet.getCell(startRow, weekSumColIdx + 1);
                    cell.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
                }
                startRow = i + 2; // 下一个区域从当前行开始
            }
        }

        // 处理最后一个周区域
        const lastMergeEndRow = data.length + 1;
        if (lastMergeEndRow > startRow) {
            worksheet.mergeCells(startRow, weekSumColIdx + 1, lastMergeEndRow, weekSumColIdx + 1);
            const cell = worksheet.getCell(startRow, weekSumColIdx + 1);
            cell.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
        }
    }

    /**
     * 应用 Rich Text 格式（从 textParts 数组生成）
     */
    applyRichTextFormat(textParts) {
        const richText = [];

        const validParts = (textParts || []).filter(part =>
            part && typeof part.text === 'string' && part.text.trim() !== ''
        );

        if (validParts.length === 0) {
            return [];
        }

        validParts.forEach((part, index) => {
            const color = RichTextFormatter.getTextColor(part);
            const isDim = part.dim || part.isCancelled || part.isAdjusted;

            // 基础字体配置
            const font = {
                name: '宋体',
                size: part.isSuperscript ? 7 : 11,
                color: { argb: color },
                italic: isDim || false
            };

            // 上标
            if (part.isSuperscript) {
                font.vertAlign = 'superscript';
            }

            // 换行：由 startsLine 决定（第一 run 跳过前导换行）
            if (index > 0 && part.startsLine) {
                richText.push({
                    text: '\n',
                    font: { name: '宋体', size: 11, color: { argb: RICH_TEXT_COLORS.BLACK } }
                });
            }

            richText.push({
                text: String(part.text).trim(),
                font
            });
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
                cell.fill = STYLE_FILL_SUNDAY;
            });
        }

        // 红行（有咨询/评审课程）— 仅通过字体颜色标识，不使用背景色
        // 颜色由 RichTextFormatter 的 colorType 标记在 Rich Text 中单独控制
    }

    /**
     * 原始记录表：复用第1工作表的颜色/斜体/周末背景
     */
    applyRawRecordStyles(excelRow, visibleKeys, rowData) {
        const typeName = (rowData._type_name || '').replace(/（线上）/g, '');
        const isRedType = typeName.includes('评审') || typeName.includes('咨询');
        const isBlueType = typeName.includes('集体活动');
        const isCancelled = rowData._status === 'cancelled';
        const isModified = rowData._status === 'modified_away';
        const isWeekend = rowData._isWeekend;

        // 确定字体颜色
        let fontColor;
        if (isRedType) {
            fontColor = (isCancelled || isModified) ? RICH_TEXT_COLORS.RED_LIGHT : RICH_TEXT_COLORS.RED;
        } else if (isBlueType) {
            fontColor = (isCancelled || isModified) ? RICH_TEXT_COLORS.BLUE_LIGHT : RICH_TEXT_COLORS.BLUE;
        } else {
            fontColor = (isCancelled || isModified) ? RICH_TEXT_COLORS.BLACK_LIGHT : RICH_TEXT_COLORS.BLACK;
        }

        const isItalic = isCancelled || isModified;

        visibleKeys.forEach((key, colIndex) => {
            const cell = excelRow.getCell(colIndex + 1);

            // 字体颜色 + 斜体
            cell.font = {
                ...cell.font,
                color: { argb: fontColor },
                italic: isItalic || undefined
            };

            // 周末（周日）背景
            if (isWeekend) {
                cell.fill = STYLE_FILL_SUNDAY;
            }
        });
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

            // 汇总表/统计表：姓名居中、备注靠左、核对居中、其他靠右，所有数据单行显示
            if (kind === 'summary' || kind === 'stats') {
                const isNameCol = header.includes('姓名');
                const isNoteCol = header === '备注';
                const isCheckCol = header === '核对';
                const isInquiryCol = header === '问询';
                const isNumericCol = ['试教', '入户', '评审', '集体活动', '咨询'].includes(header);

                // 汇总表：第2-4列宽度增加1倍
                if (kind === 'summary' && colIndex >= 2 && colIndex <= 4) {
                    const col = worksheet.getColumn(colIndex);
                    col.width = (col.width || 10) * 2;
                }

                worksheet.getColumn(colIndex).eachCell({ includeEmpty: false }, (cell, rowNumber) => {
                    if (rowNumber > 1) {
                        if (isNameCol) {
                            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
                        } else if (isNoteCol) {
                            cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
                        } else if (isCheckCol) {
                            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
                        } else if (isInquiryCol) {
                            cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: false };
                        } else {
                            cell.alignment = { horizontal: 'right', vertical: 'bottom', wrapText: false };
                            // 数值列数字加粗（非 '/' 占位符）
                            if (isNumericCol && cell.value !== '/' && cell.value !== undefined && cell.value !== null) {
                                cell.font = { ...cell.font, bold: true };
                            }
                        }
                    }
                });
            }

            // 原始记录表：所有列单行显示，上课地点保留换行；复用第1工作表的颜色/斜体/周末背景
            if (kind === 'raw') {
                const isLocationCol = header === '上课地点';
                worksheet.getColumn(colIndex).eachCell({ includeEmpty: false }, (cell, rowNumber) => {
                    if (rowNumber > 1) {
                        cell.alignment = {
                            ...cell.alignment,
                            horizontal: 'center',
                            vertical: 'middle',
                            wrapText: isLocationCol
                        };
                    }
                });
            }
        });
    }

    /**
     * 应用条件样式（参考前端 export-manager-exceljs.js 第 237-339 行）
     */
    applyConditionalStyles(excelRow, visibleKeys, rowData, cleanRow, options) {
        visibleKeys.forEach((key, colIndex) => {
            const cell = excelRow.getCell(colIndex + 1);
            const value = cleanRow[key];
            const strValue = String(value || '');

            // 0. 日期列和星期列：水平和垂直居中
            if (key === '日期' || key === '星期') {
                cell.alignment = {
                    ...cell.alignment,
                    horizontal: 'center',
                    vertical: 'middle'
                };
            }

            // 1. 费用列和周汇总列：靠右靠下，保持一致的右边距和下边距
            if (key === '费用' || key === '周汇总') {
                cell.alignment = {
                    horizontal: 'right',
                    vertical: 'bottom',
                    wrapText: strValue.includes('\n') // 多行内容启用换行
                };
            }

            // 2. 祝福语样式（前端第 326-329 行）
            if (strValue.includes('Congratulations！') || strValue.includes('Good Luck！')) {
                cell.alignment = {
                    horizontal: 'center',
                    vertical: 'middle',
                    wrapText: false
                };
                cell.font = {
                    name: 'Apple Chancery',
                    size: 11,
                    bold: true,
                    color: { argb: 'FF000000' }
                };
            }

            // 3. 汇总行边框（前端第 291-299 行）
            const isSummaryRow = strValue.includes('次') || strValue.includes('Congratulations');
            if (isSummaryRow && key === '汇总') {
                cell.font = { ...cell.font, bold: true };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'FF000000' } },
                    bottom: { style: 'thin', color: { argb: 'FF000000' } },
                    left: { style: 'thin', color: { argb: 'FF000000' } },
                    right: { style: 'thin', color: { argb: 'FF000000' } }
                };
            }

            // 4. "/" 符号对齐（前端第 332-334 行）
            if (strValue === '/' && !key.includes('费用') && !key.includes('费')) {
                cell.alignment = {
                    ...cell.alignment,
                    horizontal: 'left'
                };
            }

            // 5. 长文本对齐（前端第 337-339 行）
            const needsRightBottom = key.includes('费用') || key.includes('费') ||
                                    key.includes('次数') || key.includes('统计') ||
                                    key === '周汇总' || key === '汇总';
            if (strValue.length > 10 && !needsRightBottom) {
                cell.alignment = {
                    ...cell.alignment,
                    horizontal: 'left'
                };
            }
        });
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

        return Math.min(maxWidth + 4, 120);
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
        // 统一使用 sharedUtils.STATUS_MAP 作为权威来源
        const { getStatusLabel } = require('../utils/sharedUtils');
        return getStatusLabel(status);
    }

    /**
     * 写入 Buffer
     */
    async writeToBuffer(workbook) {
        return await workbook.xlsx.writeBuffer();
    }

    /**
     * 生成时间戳（委托给 sharedUtils 消除重复）
     */
    getTimestamp() {
        const { getTimestamp } = require('../utils/sharedUtils');
        return getTimestamp();
    }
}

module.exports = new EnhancedExcelService();
