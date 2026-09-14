// 班主任（teacher_homeroom）排课导出的范围收敛契约
// 关注点：班主任在“学生排课管理”页导出时，范围必须是其绑定学生的全部排课（不限授课教师），
//        而不是收敛到登录教师自己名下的排课。
const { mockReq, mockRes } = require('../helpers/httpMocks');

jest.mock('../../db/db', () => ({ query: jest.fn().mockResolvedValue({ rows: [{ name: '班主任张' }] }) }));
jest.mock('../../services/export', () => ({
    pipeline: {
        generateExcelFromData: jest.fn(),
        generateInfoExcel: jest.fn()
    },
    scheduleQueries: {
        queryTeacherSchedule: jest.fn(),
        queryStudentSchedule: jest.fn(),
        exportTeacherInfo: jest.fn(),
        exportStudentInfo: jest.fn()
    }
}));
jest.mock('../../services/head-teacher-service', () => ({ getBoundStudentIds: jest.fn() }));
jest.mock('../../utils/export-log-service', () => jest.fn().mockImplementation(() => ({
    logExportStart: jest.fn().mockResolvedValue(1),
    logExportSuccess: jest.fn().mockResolvedValue(undefined),
    logExportError: jest.fn().mockResolvedValue(undefined)
})));
jest.mock('../../utils/logger', () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { pipeline, scheduleQueries } = require('../../services/export');
const headTeacherService = require('../../services/head-teacher-service');
const exportController = require('../../controllers/export-controller');

const RAW_ROWS = [
    { schedule_id: 1, teacher_id: 88, teacher_name: '李老师', student_id: 11, student_name: '学生甲' },
    { schedule_id: 2, teacher_id: 99, teacher_name: '班主任张', student_id: 12, student_name: '学生乙' }
];

function homeroomReq(body = {}) {
    return mockReq({
        user: { id: 99, userType: 'teacher' },
        body: {
            startDate: '2026-01-01',
            endDate: '2026-01-31',
            exportType: 'teacher_homeroom',
            ...body
        }
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    headTeacherService.getBoundStudentIds.mockResolvedValue({ found: true, studentIds: [11, 12] });
    scheduleQueries.queryTeacherSchedule.mockResolvedValue(RAW_ROWS);
    scheduleQueries.exportTeacherInfo.mockResolvedValue([{ id: 1, name: '教师甲' }]);
    scheduleQueries.exportStudentInfo.mockResolvedValue([{ id: 2, name: '学生甲' }]);
    pipeline.generateExcelFromData.mockResolvedValue({ buffer: Buffer.from('xlsx'), filename: 'f.xlsx' });
    pipeline.generateInfoExcel.mockResolvedValue({ buffer: Buffer.from('info-xlsx'), filename: 'info.xlsx' });
});

describe('exportSchedule - 班主任导出', () => {
    test('未选学生 → 按绑定学生范围查询，不限定 teacher_id', async () => {
        const res = mockRes();
        await exportController.exportSchedule(homeroomReq(), res);

        expect(scheduleQueries.queryTeacherSchedule).toHaveBeenCalledWith('2026-01-01', '2026-01-31', {
            teacher_id: null,
            student_id: null,
            student_ids: [11, 12]
        });
        expect(res.end).toHaveBeenCalled();
    });

    test('选定绑定学生 → 只按该学生查询，仍不限定 teacher_id', async () => {
        const res = mockRes();
        await exportController.exportSchedule(homeroomReq({ studentId: '11' }), res);

        expect(scheduleQueries.queryTeacherSchedule).toHaveBeenCalledWith('2026-01-01', '2026-01-31', {
            teacher_id: null,
            student_id: 11,
            student_ids: null
        });
    });

    test('选定授课教师 → 作为二次筛选传入（可为他人）', async () => {
        const res = mockRes();
        await exportController.exportSchedule(homeroomReq({ teacherId: '88' }), res);

        expect(scheduleQueries.queryTeacherSchedule).toHaveBeenCalledWith('2026-01-01', '2026-01-31', {
            teacher_id: 88,
            student_id: null,
            student_ids: [11, 12]
        });
    });

    test('非绑定学生 → 403', async () => {
        const res = mockRes();
        await exportController.exportSchedule(homeroomReq({ studentId: '77' }), res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(scheduleQueries.queryTeacherSchedule).not.toHaveBeenCalled();
    });

    test('未绑定任何学生 → 400', async () => {
        headTeacherService.getBoundStudentIds.mockResolvedValue({ found: true, studentIds: [] });
        const res = mockRes();
        await exportController.exportSchedule(homeroomReq(), res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(scheduleQueries.queryTeacherSchedule).not.toHaveBeenCalled();
    });

    test('教师记录不存在 → 404', async () => {
        headTeacherService.getBoundStudentIds.mockResolvedValue({ found: false, studentIds: [] });
        const res = mockRes();
        await exportController.exportSchedule(homeroomReq(), res);

        expect(res.status).toHaveBeenCalledWith(404);
    });

    test('缺少日期 → canonical 400', async () => {
        const res = mockRes();
        await exportController.exportSchedule(homeroomReq({ startDate: '' }), res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject({
            ok: false,
            error: { code: 'BAD_REQUEST', details: [{ exportCode: 'EXPORT_DATE_REQUIRED' }] }
        });
        expect(scheduleQueries.queryTeacherSchedule).not.toHaveBeenCalled();
    });

    test('日期格式非法 → canonical 400', async () => {
        const res = mockRes();
        await exportController.exportSchedule(homeroomReq({ startDate: '2026/01/01' }), res);

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatchObject({
            code: 'BAD_REQUEST',
            details: [{ exportCode: 'EXPORT_INVALID_DATE' }]
        });
    });

    test('无数据 → canonical 404', async () => {
        scheduleQueries.queryTeacherSchedule.mockResolvedValue([]);
        const res = mockRes();
        await exportController.exportSchedule(homeroomReq(), res);

        expect(res.statusCode).toBe(404);
        expect(res.body.error).toMatchObject({
            code: 'RESOURCE_NOT_FOUND',
            details: [{ exportCode: 'EXPORT_NO_DATA' }]
        });
        expect(pipeline.generateExcelFromData).not.toHaveBeenCalled();
    });

    test('文件名按 teacher_homeroom 语义生成（全部关联学生）', async () => {
        const res = mockRes();
        await exportController.exportSchedule(homeroomReq(), res);

        expect(pipeline.generateExcelFromData).toHaveBeenCalledWith(RAW_ROWS, expect.objectContaining({
            userType: 'teacher_homeroom',
            studentName: '全部关联学生'
        }));
    });
});

describe('exportInfo - 管理员用户信息导出', () => {
    test('生成 Excel 二进制，不返回 JSON 数据', async () => {
        const res = mockRes();
        await exportController.exportInfo(mockReq({
            user: { id: 1, userType: 'admin' },
            body: { type: 'teacher_info', format: 'excel' }
        }), res);

        expect(pipeline.generateInfoExcel).toHaveBeenCalledWith(
            [{ id: 1, name: '教师甲' }],
            expect.stringMatching(/^教师信息数据_\d{4}-\d{2}-\d{2}\.xlsx$/),
            '教师信息'
        );
        expect(res.setHeader).toHaveBeenCalledWith(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        expect(res.end).toHaveBeenCalledWith(Buffer.from('info-xlsx'));
        expect(res.json).not.toHaveBeenCalled();
    });

    test('不支持的格式返回 canonical JSON 错误', async () => {
        const res = mockRes();
        await exportController.exportInfo(mockReq({
            user: { id: 1, userType: 'admin' },
            body: { type: 'student_info', format: 'csv' },
            requestId: 'req-export-info'
        }), res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject({
            ok: false,
            data: null,
            error: {
                code: 'BAD_REQUEST',
                details: [{ exportCode: 'EXPORT_INVALID_FORMAT' }]
            },
            meta: { requestId: 'req-export-info' }
        });
        expect(scheduleQueries.exportStudentInfo).not.toHaveBeenCalled();
    });

    test('合法空数据返回 404，不生成空文件', async () => {
        scheduleQueries.exportStudentInfo.mockResolvedValue([]);
        const res = mockRes();
        await exportController.exportInfo(mockReq({
            user: { id: 1, userType: 'admin' },
            body: { type: 'student_info', format: 'excel' }
        }), res);

        expect(res.statusCode).toBe(404);
        expect(res.body.error).toMatchObject({
            code: 'RESOURCE_NOT_FOUND',
            details: [{ exportCode: 'EXPORT_NO_DATA' }]
        });
        expect(pipeline.generateInfoExcel).not.toHaveBeenCalled();
    });
});


describe('exportSchedule - 教师自身授课记录不受影响', () => {
    test('默认 teacher_schedule → 仍收敛到本人 teacher_id', async () => {
        const res = mockRes();
        await exportController.exportSchedule(mockReq({
            user: { id: 99, userType: 'teacher' },
            body: { startDate: '2026-01-01', endDate: '2026-01-31' }
        }), res);

        expect(headTeacherService.getBoundStudentIds).not.toHaveBeenCalled();
        expect(scheduleQueries.queryTeacherSchedule).toHaveBeenCalledWith('2026-01-01', '2026-01-31', {
            teacher_id: 99,
            student_id: null,
            student_ids: null
        });
        expect(pipeline.generateExcelFromData).toHaveBeenCalledWith(RAW_ROWS, expect.objectContaining({
            userType: 'teacher'
        }));
    });
});
