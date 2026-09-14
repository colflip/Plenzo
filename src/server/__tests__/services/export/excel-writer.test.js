const ExcelJS = require('exceljs');
const excelWriter = require('../../../services/export/excel-writer');
const { RICH_TEXT_COLORS } = require('../../../services/export/export-constants');

describe('ExcelWriter', () => {
    test('generates a single-sheet workbook and preserves the filename', async () => {
        const result = await excelWriter.generateSingleSheetExcel([
            { '教师姓名': '教师A', '次数': 2 }
        ], 'teachers.xlsx', '教师信息');

        expect(result.filename).toBe('teachers.xlsx');
        expect(Buffer.from(result.buffer).subarray(0, 2).toString()).toBe('PK');
    });

    test('adds ordered and extra non-empty sheets only', async () => {
        const workbook = excelWriter.createWorkbook();
        jest.spyOn(excelWriter, 'createWorkbook').mockReturnValueOnce(workbook);
        jest.spyOn(excelWriter, 'writeToBuffer').mockResolvedValueOnce(Buffer.from('xlsx'));

        const result = await excelWriter.generateMultiSheetExcel({
            '学生上课汇总': [{ '学生姓名': '学生A' }],
            '每日排课明细': [{ '日期': '2026-01-01' }],
            '空表': [],
            '额外表': [{ '备注': 'x' }],
            _worksheetOptions: {
                '每日排课明细': { kind: 'detail' }
            }
        }, 'schedules.xlsx');

        expect(workbook.worksheets.map(sheet => sheet.name)).toEqual([
            '每日排课明细',
            '学生上课汇总',
            '额外表'
        ]);
        expect(result).toEqual({ buffer: Buffer.from('xlsx'), filename: 'schedules.xlsx' });
        excelWriter.createWorkbook.mockRestore();
        excelWriter.writeToBuffer.mockRestore();
    });

    test('adds rich text, safe numeric placeholders, merges, and detail styles', () => {
        const workbook = new ExcelJS.Workbook();
        const data = [
            {
                '日期': '2026-01-01',
                '星期': '周四',
                '计划安排': 'plain',
                '实际安排': 'plain',
                '费用': 100,
                '周汇总': '2次',
                '报销状态': '待报销',
                '汇总': '2次',
                '备注': Number.NaN,
                _weekNumber: 1,
                _isSunday: true,
                _planTextParts: [{ text: '评审', colorType: 'red' }],
                _actualTextParts: [{ text: '+', colorType: 'blue', isSuperscript: true }, { text: '教师A', colorType: 'blue' }]
            },
            {
                '日期': '2026-01-01',
                '星期': '周四',
                '计划安排': 'Good Luck！',
                '实际安排': '/',
                '费用': 100,
                '周汇总': '2次',
                '报销状态': '待报销',
                '汇总': '/',
                '备注': '这是超过十个字符的备注内容',
                _weekNumber: 1
            }
        ];

        const worksheet = excelWriter.addWorksheet(workbook, data, '明细', {
            kind: 'detail',
            applyRichText: true,
            applyRowColors: true,
            mergeDateColumns: true,
            mergeFeeColumn: true,
            mergeWeekSummaryColumn: true
        });

        expect(worksheet.getCell('A2').isMerged).toBe(true);
        expect(worksheet.getCell('E2').isMerged).toBe(true);
        expect(worksheet.getCell('F2').isMerged).toBe(true);
        expect(worksheet.getCell('C2').value.richText[0].font.color.argb).toBe(RICH_TEXT_COLORS.RED);
        expect(worksheet.getCell('D2').value.richText[0].font.vertAlign).toBe('superscript');
        expect(worksheet.getCell('I2').value).toBe('/');
        expect(worksheet.getCell('A2').fill.fgColor.argb).toBe('FFE2EFDA');
    });

    test('applies summary and raw record styles', () => {
        const summaryBook = new ExcelJS.Workbook();
        const summary = excelWriter.addWorksheet(summaryBook, [{
            '教师姓名': '教师A',
            '试教': 2,
            '备注': '备注',
            '核对': '是',
            '问询': '无'
        }], '汇总', { kind: 'summary' });

        expect(summary.getCell('A2').alignment.horizontal).toBe('center');
        expect(summary.getCell('B2').alignment.horizontal).toBe('right');
        expect(summary.getCell('B2').font.bold).toBe(true);
        expect(summary.getCell('C2').alignment.horizontal).toBe('left');
        expect(summary.getCell('D2').alignment.horizontal).toBe('center');

        const rawBook = new ExcelJS.Workbook();
        const raw = excelWriter.addWorksheet(rawBook, [{
            '教师': '教师B',
            '上课地点': '地点\n二楼',
            _type_name: '咨询（线上）',
            _status: 'cancelled',
            _isWeekend: true
        }], '原始', { kind: 'raw' });

        expect(raw.getCell('A2').font.color.argb).toBe(RICH_TEXT_COLORS.RED_LIGHT);
        expect(raw.getCell('A2').font.italic).toBe(true);
        expect(raw.getCell('A2').fill.fgColor.argb).toBe('FFDDEBF7');
        expect(raw.getCell('B2').alignment.wrapText).toBe(true);
    });

    test('formats rich text and common values', () => {
        const parts = excelWriter.applyRichTextFormat([
            null,
            { text: '  ' },
            { text: '评审', colorType: 'red', isCancelled: true },
            { text: '+', colorType: 'blue', isSuperscript: true, startsLine: true }
        ]);

        expect(parts).toHaveLength(3);
        expect(parts[0].font.color.argb).toBe(RICH_TEXT_COLORS.RED_LIGHT);
        expect(parts[1].text).toBe('\n');
        expect(parts[2].font.vertAlign).toBe('superscript');
        expect(excelWriter.calculateColumnWidth('列', [{ '列': '中文abc；short' }])).toBe(11);
        expect(excelWriter.getStringWidth('中a')).toBe(3);
        expect(excelWriter.formatTime('09:30:00')).toBe('09:30');
        expect(excelWriter.formatTime(new Date('2026-01-01T09:30:00Z'))).toMatch(/^\d{2}:\d{2}$/);
        expect(excelWriter.formatDate(new Date('2026-01-02T00:00:00Z'))).toBe('2026-01-02');
        expect(excelWriter.formatStatus('confirmed')).toBe('已确认');
        expect(excelWriter.getTimestamp()).toMatch(/^\d{14}$/);
    });
});
