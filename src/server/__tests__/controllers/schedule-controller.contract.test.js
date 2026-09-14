const scheduleService = require('../../services/schedule-service');
const scheduleController = require('../../controllers/schedule-controller');
const { mockReq, mockRes } = require('../helpers/httpMocks');

jest.mock('../../services/schedule-service', () => ({
    getAvailableTeachers: jest.fn(),
    getAvailableStudents: jest.fn(),
    checkConflicts: jest.fn(),
    createSchedule: jest.fn(),
    getScheduleTypes: jest.fn(),
    confirmSchedule: jest.fn()
}));

async function invoke(handler, req, res) {
    const next = jest.fn();
    handler(req, res, next);
    await new Promise(resolve => setImmediate(resolve));
    expect(next).not.toHaveBeenCalled();
}

function expectCanonicalSuccess(res, data, statusCode = 200) {
    expect(res.statusCode).toBe(statusCode);
    expect(res.body).toEqual({
        ok: true,
        data,
        error: null,
        meta: {
            requestId: 'req-schedule',
            timestamp: expect.any(String)
        }
    });
    expect(res.body).not.toHaveProperty('success');
    expect(res.body).not.toHaveProperty('message');
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('scheduleController canonical success responses', () => {
    test('可用教师列表放入 data', async () => {
        const teachers = [{ id: 1, name: '教师甲' }];
        scheduleService.getAvailableTeachers.mockResolvedValue(teachers);
        const req = mockReq({
            query: { date: '2026-01-01', startTime: '09:00', endTime: '10:00' },
            requestId: 'req-schedule'
        });
        const res = mockRes();

        await invoke(scheduleController.getAvailableTeachers, req, res);

        expect(scheduleService.getAvailableTeachers).toHaveBeenCalledWith(
            '2026-01-01', undefined, '09:00', '10:00'
        );
        expectCanonicalSuccess(res, teachers);
    });

    test('冲突检查结果放入 data', async () => {
        const result = { hasConflicts: false, conflicts: [] };
        scheduleService.checkConflicts.mockResolvedValue(result);
        const req = mockReq({
            body: {
                teacherId: 1,
                studentId: 2,
                date: '2026-01-01',
                timeSlot: 'morning',
                startTime: '09:00',
                endTime: '10:00'
            },
            requestId: 'req-schedule'
        });
        const res = mockRes();

        await invoke(scheduleController.checkScheduleConflicts, req, res);

        expectCanonicalSuccess(res, result);
    });

    test('创建排课返回 201 canonical envelope', async () => {
        const result = { id: 8 };
        scheduleService.createSchedule.mockResolvedValue(result);
        const req = mockReq({
            body: { date: '2026-01-01' },
            user: { id: 3 },
            requestId: 'req-schedule'
        });
        const res = mockRes();

        await invoke(scheduleController.createSchedule, req, res);

        expect(scheduleService.createSchedule).toHaveBeenCalledWith(req.body, 3);
        expectCanonicalSuccess(res, result, 201);
    });

    test.each([
        ['confirmTeacher', false],
        ['confirmAdmin', true]
    ])('%s 返回 data.message，不返回旧顶层 success/message', async (handlerName, isAdmin) => {
        scheduleService.confirmSchedule.mockResolvedValue({ status: 'normal.confirmed' });
        const req = mockReq({
            params: { id: '7' },
            body: { teacher_uid: 'teacher-pair-1' },
            user: { id: 3 },
            requestId: 'req-schedule'
        });
        const res = mockRes();

        await invoke(scheduleController[handlerName], req, res);

        expect(scheduleService.confirmSchedule).toHaveBeenCalledWith('7', 'teacher-pair-1', 3, isAdmin);
        expectCanonicalSuccess(res, { message: '课程已确认', status: 'normal.confirmed' });
    });
});
