// D1-10：export-service 单测（三端 advancedExport 共用流水线 + 共享 Excel 生成步骤）
// 验证：日期校验、runRoleScheduleExport 业务分支（400/404/200/rethrow）、generateExcelFromData 返回值形态。
const db = require('../../../db/db');
const logger = require('../../../utils/logger');
const pipeline = require('../../../services/export/pipeline');

jest.mock('../../../db/db', () => ({ query: jest.fn() }));
jest.mock('../../../utils/logger', () => ({ error: jest.fn(), warn: jest.fn() }));
jest.mock('../../../services/export/sheet-builder', () => ({
    generateCompleteExport: jest.fn().mockResolvedValue({ sheets: [{ name: 's' }], filename: 'export.xlsx' })
}));
jest.mock('../../../services/export/excel-writer', () => ({
    generateMultiSheetExcel: jest.fn().mockResolvedValue({ buffer: Buffer.from('xlsx'), filename: 'export.xlsx' }),
    generateSingleSheetExcel: jest.fn().mockResolvedValue({ buffer: Buffer.from('info-xlsx'), filename: 'info.xlsx' })
}));

const mockLogServiceInstance = {
    logExportStart: jest.fn().mockResolvedValue(1),
    logExportSuccess: jest.fn().mockResolvedValue(undefined),
    logExportError: jest.fn().mockResolvedValue(undefined)
};
jest.mock('../../../utils/export-log-service', () => jest.fn(() => mockLogServiceInstance));

beforeEach(() => {
    jest.clearAllMocks();
    mockLogServiceInstance.logExportStart.mockResolvedValue(1);
    mockLogServiceInstance.logExportSuccess.mockResolvedValue(undefined);
    mockLogServiceInstance.logExportError.mockResolvedValue(undefined);
});

describe('validateScheduleDateRange', () => {
    test('缺日期 → 抛 400 EXPORT_DATE_REQUIRED', () => {
        expect(() => pipeline.validateScheduleDateRange(undefined, '')).toThrow(expect.objectContaining({
            statusCode: 400,
            details: [{ exportCode: 'EXPORT_DATE_REQUIRED' }]
        }));
    });

    test('格式非法 → 抛 400 EXPORT_INVALID_DATE', () => {
        expect(() => pipeline.validateScheduleDateRange('2026/01/01', '2026-02-01')).toThrow(expect.objectContaining({
            statusCode: 400,
            details: [{ exportCode: 'EXPORT_INVALID_DATE' }]
        }));
    });

    test('合法日期 → 不抛异常', () => {
        expect(() => pipeline.validateScheduleDateRange('2026-01-01', '2026-02-01')).not.toThrow();
    });
});

describe('generateExcelFromData', () => {
    test('返回 { buffer, filename }（unified + excel 两步合一）', async () => {
        const out = await pipeline.generateExcelFromData([{ id: 1 }], { startDate: '2026-01-01', endDate: '2026-02-01' });
        expect(out).toEqual({ buffer: Buffer.from('xlsx'), filename: 'export.xlsx' });
    });

    test('用户信息导出生成单工作表 Excel', async () => {
        const writer = require('../../../services/export/excel-writer');
        const data = [{ id: 1, name: '教师甲' }];
        const out = await pipeline.generateInfoExcel(data, 'teachers.xlsx', '教师信息');

        expect(writer.generateSingleSheetExcel).toHaveBeenCalledWith(data, 'teachers.xlsx', '教师信息');
        expect(out).toEqual({ buffer: Buffer.from('info-xlsx'), filename: 'info.xlsx' });
    });
});

describe('runRoleScheduleExport', () => {
    test('缺日期 → 抛 400（不查数据、不记日志）', async () => {
        const queryRawData = jest.fn();
        await expect(pipeline.runRoleScheduleExport({ queryRawData })).rejects.toMatchObject({
            statusCode: 400,
            details: [{ exportCode: 'EXPORT_DATE_REQUIRED' }]
        });
        expect(queryRawData).not.toHaveBeenCalled();
        expect(mockLogServiceInstance.logExportStart).not.toHaveBeenCalled();
    });

    test('无数据 → 抛 404 EXPORT_NO_DATA（已记录开始日志）', async () => {
        const queryRawData = jest.fn().mockResolvedValue([]);
        await expect(pipeline.runRoleScheduleExport({
            startDate: '2026-01-01', endDate: '2026-02-01', userId: 7, userType: 'teacher', exportType: 'teacher_schedule', queryRawData
        })).rejects.toMatchObject({
            statusCode: 404,
            details: [{ exportCode: 'EXPORT_NO_DATA' }]
        });
        expect(mockLogServiceInstance.logExportStart).toHaveBeenCalledTimes(1);
        expect(mockLogServiceInstance.logExportSuccess).not.toHaveBeenCalled();
    });

    test('成功 → 200 带 buffer/filename，记录开始+成功（teacher 日志负载无 studentId）', async () => {
        const queryRawData = jest.fn().mockResolvedValue([{ id: 1 }]);
        const r = await pipeline.runRoleScheduleExport({
            startDate: '2026-01-01', endDate: '2026-02-01', userId: 7, userType: 'teacher',
            userName: 'T', teacherId: 7, exportType: 'teacher_schedule', studentName: '全部学生', queryRawData
        });
        expect(r.status).toBe(200);
        expect(r.buffer).toEqual(Buffer.from('xlsx'));
        expect(r.filename).toBe('export.xlsx');
        expect(mockLogServiceInstance.logExportStart).toHaveBeenCalledWith(expect.objectContaining({
            userId: 7, userType: 'teacher', exportType: 'teacher_schedule', teacherId: 7
        }));
        expect(mockLogServiceInstance.logExportStart.mock.calls[0][0]).not.toHaveProperty('studentId');
        expect(mockLogServiceInstance.logExportSuccess).toHaveBeenCalledTimes(1);
        expect(mockLogServiceInstance.logExportError).not.toHaveBeenCalled();
    });

    test('查询异常 → rethrow 且记录导出失败', async () => {
        const queryRawData = jest.fn().mockRejectedValue(new Error('boom'));
        await expect(pipeline.runRoleScheduleExport({
            startDate: '2026-01-01', endDate: '2026-02-01', userId: 3, userType: 'student', exportType: 'student_schedule', queryRawData
        })).rejects.toThrow('boom');
        expect(mockLogServiceInstance.logExportError).toHaveBeenCalledTimes(1);
        expect(mockLogServiceInstance.logExportError).toHaveBeenCalledWith(1, 'boom');
    });
});
