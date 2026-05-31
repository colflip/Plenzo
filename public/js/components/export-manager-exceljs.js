/**
 * ExcelJS 版本的 generateExcelFile 函数
 * 支持单元格内 rich text（多种颜色和样式）
 */

/**
 * 生成 Excel 文件（使用 ExcelJS）
 * @param {Object|Array} exportData - 导出数据 (支持 { sheetName: [], ... } 多 Sheet 结构)
 * @param {string} filename - 文件名
 * @param {string} userType - 用户类型
 */
async function generateExcelFileWithExcelJS(exportData, filename, userType) {
    // 确保 ExcelJS 库已加载
    if (typeof ExcelJS === 'undefined') {
        throw new Error('ExcelJS library not loaded');
    }

    const workbook = new ExcelJS.Workbook();

    // 统一处理成 { SheetName: DataArray } 格式
    let sheets = {};
    if (Array.isArray(exportData)) {
        sheets['数据'] = exportData;
    } else if (exportData && typeof exportData === 'object' && !exportData.data) {
        sheets = exportData;
    } else if (exportData && typeof exportData === 'object' && exportData.data) {
        const innerData = exportData.data;
        if (Array.isArray(innerData) && innerData.length > 0) {
            sheets['数据'] = innerData;
        } else if (Array.isArray(innerData) && innerData.length === 0) {
            sheets['数据'] = [];
        } else if (typeof innerData === 'object' && !Array.isArray(innerData)) {
            sheets = innerData;
        } else {
            sheets['数据'] = [];
        }
    } else {
        sheets['数据'] = [];
    }

    let hasData = false;
    const sheetNames = Object.keys(sheets);

    for (let sheetIndex = 0; sheetIndex < sheetNames.length; sheetIndex++) {
        const sheetName = sheetNames[sheetIndex];
        const rawDataList = sheets[sheetName];

        if (!Array.isArray(rawDataList) || rawDataList.length === 0) {
            continue;
        }

        // 清理内部标记
        const cleanData = rawDataList.map(row => {
            const newRow = { ...row };
            delete newRow._isRedRow;
            delete newRow._planIsRed;
            delete newRow._actualIsRed;
            delete newRow._planTextParts;
            delete newRow._actualTextParts;
            delete newRow._planIsCancelledGrey;
            delete newRow._planIsModifiedAwayGrey;
            delete newRow._actualIsCancelledGrey;
            delete newRow._actualIsModifiedAwayGrey;
            delete newRow._sTime;
            delete newRow._parsedDate;
            delete newRow._parsedTimeRange;
            delete newRow._typeName;
            delete newRow._groupType;
            delete newRow._isSunday;
            delete newRow._weekNumber;
            delete newRow._isSingleStudent;
            delete newRow._student_id;
            delete newRow._teacher_id;
            delete newRow._isSummaryRow;
            delete newRow._isModifiedDate;
            delete newRow._isSubRowOfMixed;
            return newRow;
        });

        const worksheet = workbook.addWorksheet(sheetName);
        const headers = Object.keys(cleanData[0]);

        // 设置列
        worksheet.columns = headers.map(header => {
            // 第一个工作表的列宽
            const firstSheetColumnWidths = {
                '日期': 12,
                '星期': 8,
                '计划安排': 60,
                '实际安排': 60,
                '费用': 20,
                '周汇总': 15
            };

            const minWidths = {
                '时间段': 15,
                '备注': 30,
                '创建时间': 20,
                '日期': 12,
                '类型': 15,
                '星期': 6
            };

            let width = 10;
            if (sheetIndex === 0 && firstSheetColumnWidths[header]) {
                width = firstSheetColumnWidths[header];
            } else if (minWidths[header]) {
                width = minWidths[header];
            }

            return {
                header: header,
                key: header,
                width: width
            };
        });

        // 添加数据行
        cleanData.forEach((rowData, rowIndex) => {
            const originalRow = rawDataList[rowIndex];
            const excelRow = worksheet.addRow(rowData);

            // 应用样式到每个单元格
            excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                const header = headers[colNumber - 1];
                const value = rowData[header];

                // 基础样式
                cell.font = { name: '宋体', size: 11 };
                cell.alignment = { vertical: 'middle', wrapText: true, horizontal: 'center' };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'FFD4D4D4' } },
                    bottom: { style: 'thin', color: { argb: 'FFD4D4D4' } },
                    left: { style: 'thin', color: { argb: 'FFD4D4D4' } },
                    right: { style: 'thin', color: { argb: 'FFD4D4D4' } }
                };

                // 处理 rich text（计划安排和实际安排列）
                if (sheetIndex === 0) {
                    if (header === '计划安排' && originalRow._planTextParts && originalRow._planTextParts.length > 0) {
                        cell.value = buildRichText(originalRow._planTextParts);
                    } else if (header === '实际安排' && originalRow._actualTextParts && originalRow._actualTextParts.length > 0) {
                        cell.value = buildRichText(originalRow._actualTextParts);
                    }
                }

                // 应用条件样式
                applyConditionalStyles(cell, header, originalRow, sheetIndex, userType, value);
            });
        });

        // 设置表头样式
        const headerRow = worksheet.getRow(1);
        headerRow.eachCell((cell) => {
            cell.font = { name: '宋体', size: 12, bold: true };
            cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFF2F2F2' }
            };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
            cell.border = {
                top: { style: 'thin', color: { argb: 'FFD4D4D4' } },
                bottom: { style: 'thin', color: { argb: 'FFD4D4D4' } },
                left: { style: 'thin', color: { argb: 'FFD4D4D4' } },
                right: { style: 'thin', color: { argb: 'FFD4D4D4' } }
            };
        });

        // 应用合并单元格（仅第一个工作表）
        if (sheetIndex === 0) {
            applyMerges(worksheet, rawDataList, headers);
        }

        hasData = true;
    }

    if (!hasData) {
        throw new Error('没有可导出的数据');
    }

    // 生成并下载文件
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `export_${Date.now()}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
}

/**
 * 构建 ExcelJS rich text 对象
 */
function buildRichText(textParts) {
    const richText = [];

    textParts.forEach((part, index) => {
        if (index > 0) {
            // 添加分隔符
            richText.push({
                text: '；',
                font: { name: '宋体', size: 11 }
            });
        }

        if (part.isCancelled) {
            // 已取消：灰色、斜体
            richText.push({
                text: part.text,
                font: { name: '宋体', size: 11, color: { argb: 'FF595959' }, italic: true }
            });
        } else if (part.isModifiedAway) {
            // 调走：茶色、斜体
            richText.push({
                text: part.text,
                font: { name: '宋体', size: 11, color: { argb: 'FF8C6239' }, italic: true }
            });
        } else {
            // 正常：黑色
            richText.push({
                text: part.text,
                font: { name: '宋体', size: 11, color: { argb: 'FF000000' } }
            });
        }
    });

    return { richText: richText };
}

/**
 * 应用条件样式
 */
function applyConditionalStyles(cell, header, dataRow, sheetIndex, userType, value) {
    const isSunday = dataRow['星期'] === '周日';
    const isSummaryRow = dataRow._isSummaryRow;
    const isCancelledRow = dataRow['实际安排'] && String(dataRow['实际安排']).includes('已取消');

    // 日期列 -> 浅绿色
    if (header.includes('日期')) {
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE2EFDA' }
        };
    }

    // 周日行 -> 浅蓝色
    if (isSunday) {
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFDDEBF7' }
        };
    }

    // 第一个工作表的特殊样式
    if (sheetIndex === 0) {
        const isCoreField = header.includes('计划安排') || header.includes('实际安排') || header.includes('类型');

        if (isCoreField) {
            let isCellRed = false;

            if (header.includes('计划安排')) {
                isCellRed = dataRow._planIsRed;
            } else if (header.includes('实际安排')) {
                isCellRed = dataRow._actualIsRed;
            }

            // 只有在没有 rich text 时才应用整体颜色
            if (isCellRed && !cell.value?.richText) {
                cell.font = { ...cell.font, color: { argb: 'FFFF0000' } };
            }
        }
    }

    // 已取消行的斜体（费用和周汇总列除外）
    if (isCancelledRow && header !== '费用' && header !== '周汇总') {
        cell.font = { ...cell.font, italic: true };
    }

    // 日期变动标记
    if (dataRow._isModifiedDate && (header === '日期' || header === '星期')) {
        cell.font = { ...cell.font, italic: true };
    }

    // 汇总行样式
    if (isSummaryRow && header === '汇总') {
        cell.font = { ...cell.font, bold: true };
        cell.border = {
            top: { style: 'thin', color: { argb: 'FF000000' } },
            bottom: { style: 'thin', color: { argb: 'FF000000' } },
            left: { style: 'thin', color: { argb: 'FF000000' } },
            right: { style: 'thin', color: { argb: 'FF000000' } }
        };
    }

    // 费用/汇总/统计列特殊对齐
    const s2RightBottom = ['试教', '入户', '评审', '集体活动', '咨询', '汇总'];
    const s4RightBottom = ['入户', '试教', '评审', '评审记录', '半次入户', '集体活动', '咨询', '(线上)评审', '(线上)入户', '(线上)咨询', '咨询记录', '汇总'];

    const isFinanceHeader = header === '费用' || header === '周汇总' || header === '汇总';
    const needsRightBottom = isFinanceHeader ||
        (sheetIndex === 1 && s2RightBottom.includes(header)) ||
        (sheetIndex === 3 && s4RightBottom.includes(header));

    if (needsRightBottom) {
        cell.alignment = { horizontal: 'right', vertical: 'bottom', wrapText: true };
        cell.font = { ...cell.font, bold: false, italic: false };

        // Sheet 1 费用列和周汇总列缩进
        if (sheetIndex === 0 && (header === '费用' || header === '周汇总')) {
            const cellValue = String(value || '');
            const hasMultipleEntries = cellValue.includes('\n');
            if (!hasMultipleEntries && cellValue !== '/') {
                cell.alignment = { ...cell.alignment, indent: 1 };
            }
        }
    }

    // 祝福语列样式
    const strValue = String(value || '');
    if (strValue.includes('Congratulations！') || strValue.includes('Good Luck！')) {
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
        cell.font = { name: 'Apple Chancery', size: 11, bold: true, color: { argb: 'FF000000' } };
    }

    // "/" 靠左显示（排除费用列）
    if (strValue === '/' && !header.includes('费用') && !header.includes('费')) {
        cell.alignment = { ...cell.alignment, horizontal: 'left' };
    }

    // 长文本靠左对齐（非第三个工作表）
    if (sheetIndex !== 2 && strValue.length > 10 && !needsRightBottom) {
        cell.alignment = { ...cell.alignment, horizontal: 'left' };
    }
}

/**
 * 应用合并单元格
 */
function applyMerges(worksheet, rawDataList, headers) {
    const feeColIdx = headers.indexOf('费用');
    const weekSumColIdx = headers.indexOf('周汇总');

    // 费用列按"日期"合并
    if (feeColIdx !== -1) {
        let feeStartRow = 2; // ExcelJS 行号从 1 开始，第 1 行是表头
        for (let i = 1; i < rawDataList.length; i++) {
            const prev = rawDataList[i - 1];
            const curr = rawDataList[i];
            const currentRowIdx = i + 2;

            if (curr['日期'] !== prev['日期']) {
                if (i + 1 - feeStartRow > 0) {
                    worksheet.mergeCells(feeStartRow, feeColIdx + 1, i + 1, feeColIdx + 1);
                }
                feeStartRow = currentRowIdx;
            }
        }
        if (rawDataList.length + 1 - feeStartRow > 0) {
            worksheet.mergeCells(feeStartRow, feeColIdx + 1, rawDataList.length + 1, feeColIdx + 1);
        }
    }

    // 周汇总列按"周次"合并
    if (weekSumColIdx !== -1) {
        let weekStartRow = 2;
        for (let i = 1; i < rawDataList.length; i++) {
            const prev = rawDataList[i - 1];
            const curr = rawDataList[i];
            const currentRowIdx = i + 2;

            if (curr._weekNumber !== prev._weekNumber) {
                if (i + 1 - weekStartRow > 0) {
                    worksheet.mergeCells(weekStartRow, weekSumColIdx + 1, i + 1, weekSumColIdx + 1);
                }
                weekStartRow = currentRowIdx;
            }
        }
        if (rawDataList.length + 1 - weekStartRow > 0) {
            worksheet.mergeCells(weekStartRow, weekSumColIdx + 1, rawDataList.length + 1, weekSumColIdx + 1);
        }
    }
}

// 导出函数
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { generateExcelFileWithExcelJS };
} else if (typeof window !== 'undefined') {
    window.generateExcelFileWithExcelJS = generateExcelFileWithExcelJS;
}
