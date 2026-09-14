// D1-7：schedule-service 角色方法单测（admin/teacher/student 排课方法下沉）
// Service 只返回领域数据；业务错误抛 AppError，由 controller 统一封装 HTTP 响应。
const db = require('../../db/db');
const SchemaHelper = require('../../utils/schema-helper');
const logger = require('../../utils/logger');
const scheduleService = require('../../services/schedule-service');

jest.mock('../../db/db', () => ({
    query: jest.fn(),
    runInTransaction: jest.fn(async (cb) => cb(null, true)),
    warmup: jest.fn(),
}));
jest.mock('../../utils/schema-helper', () => ({
    getDateExpr: jest.fn().mockResolvedValue('date'),
    hasColumn: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../utils/logger', () => ({ error: jest.fn(), warn: jest.fn() }));

beforeEach(() => {
    jest.clearAllMocks();
    // 默认 SELECT 返回一行，便于 list 类用例直接命中 200 分支
    db.query.mockResolvedValue({ rows: [{ id: 1 }] });
});

describe('adminDeleteSchedule', () => {
    test('不存在 → RESOURCE_NOT_FOUND', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await expect(scheduleService.adminDeleteSchedule({ params: { id: '999' } }))
            .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到该排课记录' });
    });
    test('存在 → 返回领域结果', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 1 }] });
        await expect(scheduleService.adminDeleteSchedule({ params: { id: '1' } }))
            .resolves.toEqual({ message: '排课删除成功' });
        // 先查存在性 → DELETE ... RETURNING → 一条 session_change_logs 审计。
        // 不开事务：单条 DELETE 本身原子，审计是「失败只告警」的旁路，
        // 省掉 BEGIN + COMMIT 两次往返（远程库每条约 250ms）。
        expect(db.query).toHaveBeenCalledTimes(3);
        expect(db.runInTransaction).not.toHaveBeenCalled();
    });
});


describe('teacherUpdateScheduleStatus', () => {
    const teacherReq = (over = {}) => ({
        params: { id: '7' },
        user: { id: 7, userType: 'teacher' },
        body: over
    });

    test('缺状态 → BAD_REQUEST', async () => {
        await expect(scheduleService.teacherUpdateScheduleStatus(teacherReq()))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400, message: '缺少课程状态' });
    });

    test('非法状态 → BAD_REQUEST', async () => {
        await expect(scheduleService.teacherUpdateScheduleStatus(teacherReq({ status: 'bogus' })))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400, message: '非法的课程状态值' });
    });

    test('排课不存在 → RESOURCE_NOT_FOUND', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await expect(scheduleService.teacherUpdateScheduleStatus(teacherReq({ status: 'confirmed' })))
            .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到相关课程' });
    });

    test('本人任课 → 返回领域结果（定位到自己那个 pair）', async () => {
        const session = {
            id: 7, start_time: '10:00', end_time: '11:00', location: 'L', version: 1,
            teachers: [{ uid: 't1', teacher_id: 7, type_id: 2, status: 'normal.pending', fee_status: 'draft' }],
            students: [{ uid: 's1', student_id: 5 }]
        };
        db.query
            .mockResolvedValueOnce({ rows: [session] })                                    // 写前读（服务层定位 pair）
            .mockResolvedValueOnce({ rows: [session] })                                    // setTeacherStatus 内部写前读
            .mockResolvedValueOnce({ rows: [{ ...session, teachers: [{ ...session.teachers[0], status: 'normal.confirmed' }] }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [] });                                          // 审计
        const r = await scheduleService.teacherUpdateScheduleStatus(teacherReq({ status: 'confirmed', notes: 'ok' }));
        expect(r.message).toBe('课程状态更新成功');
        expect(r.schedule).toMatchObject({
            session_id: 7, teacher_uid: 't1', status: 'confirmed', status_code: 'normal.confirmed',
            start_time: '10:00', end_time: '11:00', location: 'L'
        });
    });
});

describe('teacherConfirmSchedule', () => {
    test('非本人任课且非其名下学生 → FORBIDDEN', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{
                id: 1, version: 1,
                teachers: [{ uid: 't1', teacher_id: 99, type_id: 2, status: 'normal.pending', fee_status: 'draft' }],
                students: [{ uid: 's1', student_id: 5 }]
            }] })
            .mockResolvedValueOnce({ rows: [{ student_ids: '' }] });   // 班主任绑定学生为空
        await expect(scheduleService.teacherConfirmSchedule({
            params: { id: '1' },
            user: { id: 7, userType: 'teacher' },
            body: { teacherConfirmed: true, teacher_uid: 't1' }
        })).rejects.toMatchObject({
            code: 'FORBIDDEN',
            statusCode: 403,
            message: expect.stringMatching(/无权修改该课程状态/)
        });
    });

    test('本人任课 → 200 课程状态更新成功（收敛到 setTeacherStatus）', async () => {
        const session = {
            id: 1, start_time: '10:00', end_time: '11:00', location: 'L', version: 1,
            teachers: [{ uid: 't1', teacher_id: 7, type_id: 2, status: 'normal.pending', fee_status: 'draft' }],
            students: [{ uid: 's1', student_id: 5 }]
        };
        db.query
            .mockResolvedValueOnce({ rows: [session] })
            .mockResolvedValueOnce({ rows: [session] })
            .mockResolvedValueOnce({ rows: [{ ...session, teachers: [{ ...session.teachers[0], status: 'normal.confirmed' }] }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [] });
        const r = await scheduleService.teacherConfirmSchedule({
            params: { id: '1' },
            user: { id: 7, userType: 'teacher' },
            body: { teacherConfirmed: true }
        });
        expect(r.message).toBe('课程状态更新成功');
    });

    test('teacherConfirmed 为假 → 不发任何写请求', async () => {
        await expect(scheduleService.teacherConfirmSchedule({
            params: { id: '1' }, user: { id: 7, userType: 'teacher' }, body: { teacherConfirmed: false }
        })).resolves.toEqual({ message: '课程确认状态更新成功' });
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('list methods return rows', () => {
    test('adminListSchedules returns result.rows', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });
        await expect(scheduleService.adminListSchedules({ query: { startDate: '2026-01-01', endDate: '2026-02-01' } }))
            .resolves.toEqual([{ id: 1 }, { id: 2 }]);
    });

    test('teacherListSchedules returns result.rows', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 3 }] });
        await expect(scheduleService.teacherListSchedules({ user: { id: 7 }, query: { startDate: '2026-01-01', endDate: '2026-02-01' } }))
            .resolves.toEqual([{ id: 3 }]);
    });

    test('studentListSchedules returns result.rows', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 4 }] });
        await expect(scheduleService.studentListSchedules({ user: { id: 3 }, query: { startDate: '2026-01-01', endDate: '2026-02-01' } }))
            .resolves.toEqual([{ id: 4 }]);
    });
});
