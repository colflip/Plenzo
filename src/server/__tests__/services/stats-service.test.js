// D1-8：schedule-service 统计方法单测（admin/teacher/student stats 下沉）
// Service 返回领域数据并传播异常，HTTP 状态与 envelope 由 controller 和全局错误出口处理。
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
    db.query.mockResolvedValue({ rows: [{ id: 1 }] });
});

describe('adminOverviewStats', () => {
    test('有数据 → 返回 rows[0]', async () => {
        const data = { teacher_count: 3, student_count: 5, monthly_schedules: 2, pending_count: 1, total_schedules: 9 };
        db.query.mockResolvedValue({ rows: [data] });
        await expect(scheduleService.adminOverviewStats({})).resolves.toEqual(data);
    });

    test('空结果 → 返回全零对象（9 个指标都要有键，前端直接读不做兜底）', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await expect(scheduleService.adminOverviewStats({})).resolves.toEqual({
            teacher_count: 0, student_count: 0, monthly_schedules: 0, pending_count: 0,
            total_schedules: 0, weekly_schedules: 0, yearly_schedules: 0,
            completed_schedules: 0, cancelled_schedules: 0
        });
    });

    test('异常原样传播', async () => {
        const error = new Error('boom');
        db.query.mockRejectedValue(error);
        await expect(scheduleService.adminOverviewStats({})).rejects.toBe(error);
    });
});

describe('adminScheduleStats', () => {
    test('默认日期 → 返回 result.rows', async () => {
        const rows = [{ type: '语文', count: 4 }];
        db.query.mockResolvedValue({ rows });
        await expect(scheduleService.adminScheduleStats({ query: {} })).resolves.toEqual(rows);
    });

    test('异常原样传播', async () => {
        const error = new Error('boom');
        db.query.mockRejectedValue(error);
        await expect(scheduleService.adminScheduleStats({ query: { startDate: '2026-01-01', endDate: '2026-02-01' } }))
            .rejects.toBe(error);
    });
});

describe('adminUserStats', () => {
    test('正常 → 200 {teacherStats, studentStats}（按人聚合）', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ teacher_id: 1, teacher_name: 'T', schedule_type: '语文', type_count: 3 }] })
            .mockResolvedValueOnce({ rows: [{ student_id: 2, student_name: 'S', schedule_type: '数学', type_count: 2 }] });
        const r = await scheduleService.adminUserStats({ query: { startDate: '2026-01-01', endDate: '2026-02-01' } });
        expect(r.teacherStats).toEqual([{ id: 1, name: 'T', total: 3, types: { '语文': 3 } }]);
        expect(r.studentStats).toEqual([{ id: 2, name: 'S', total: 2, types: { '数学': 2 } }]);
    });

    test('异常原样传播', async () => {
        const error = new Error('boom');
        db.query.mockRejectedValue(error);
        await expect(scheduleService.adminUserStats({ query: {} })).rejects.toBe(error);
    });
});

describe('teacherStatistics', () => {
    test('正常 → 200 {typeStats, monthlyStats, dailyStats}', async () => {
        db.query.mockResolvedValue({ rows: [{ type: '评审', count: 2 }] });
        const r = await scheduleService.teacherStatistics({ user: { id: 7 }, query: { startDate: '2026-01-01', endDate: '2026-02-01' } });
        // typeStats/dailyStats 经过 大评审→评审 归一（此处无大评审，形态保持不变）
        expect(r.typeStats).toEqual([{ type: '评审', count: 2 }]);
        expect(r.monthlyStats).toEqual([{ type: '评审', count: 2 }]);
        expect(Array.isArray(r.dailyStats)).toBe(true);
    });

    test('异常原样传播', async () => {
        const error = new Error('boom');
        db.query.mockRejectedValue(error);
        await expect(scheduleService.teacherStatistics({ user: { id: 7 }, query: {} })).rejects.toBe(error);
    });
});

describe('teacherOverview', () => {
    test('正常 → 200 计数 + todaySchedules', async () => {
        db.query.mockResolvedValue({ rows: [{ weekly_count: 1, monthly_count: 2, yearly_count: 3, total_pending: 4, total_completed: 5, total_cancelled: 6 }] });
        const r = await scheduleService.teacherOverview({ user: { id: 7 } });
        expect(r).toEqual({
            weeklyCount: 1, monthlyCount: 2, yearlyCount: 3,
            totalPending: 4, totalCompleted: 5, totalCancelled: 6,
            todaySchedules: [{ weekly_count: 1, monthly_count: 2, yearly_count: 3, total_pending: 4, total_completed: 5, total_cancelled: 6 }]
        });
    });

    test('异常原样传播', async () => {
        const error = new Error('boom');
        db.query.mockRejectedValue(error);
        await expect(scheduleService.teacherOverview({ user: { id: 7 } })).rejects.toBe(error);
    });
});

describe('studentStatistics', () => {
    test('缺日期 → BAD_REQUEST', async () => {
        await expect(scheduleService.studentStatistics({ user: { id: 3 }, query: {} }))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400, message: '请提供日期范围' });
    });

    test('正常 → 返回 {typeStats, monthlyStats, schedules}', async () => {
        db.query.mockResolvedValue({ rows: [{ type: '评审', count: 2, schedule_type: 'review' }] });
        const r = await scheduleService.studentStatistics({ user: { id: 3 }, query: { startDate: '2026-01-01', endDate: '2026-02-01' } });
        // typeStats 经过 大评审→评审 归一；schedules.schedule_type 归一为规范英文 'review'
        expect(r.typeStats).toEqual([{ type: '评审', count: 2 }]);
        expect(r.monthlyStats).toEqual([{ type: '评审', count: 2, schedule_type: 'review' }]);
        expect(r.schedules).toEqual([{ type: '评审', count: 2, schedule_type: 'review' }]);
    });

    test('异常原样传播', async () => {
        const error = new Error('boom');
        db.query.mockRejectedValue(error);
        await expect(scheduleService.studentStatistics({ user: { id: 3 }, query: { startDate: '2026-01-01', endDate: '2026-02-01' } }))
            .rejects.toBe(error);
    });
});

describe('studentOverview', () => {
    test('正常 → 200 计数 + todaySchedules', async () => {
        db.query.mockResolvedValue({ rows: [{ weekly_count: 1, monthly_count: 2, yearly_count: 3, total_pending: 4, total_completed: 5, total_cancelled: 6 }] });
        const r = await scheduleService.studentOverview({ user: { id: 3 } });
        expect(r.weeklyCount).toBe(1);
        expect(r.todaySchedules).toEqual([{ weekly_count: 1, monthly_count: 2, yearly_count: 3, total_pending: 4, total_completed: 5, total_cancelled: 6 }]);
    });

    test('异常原样传播', async () => {
        const error = new Error('boom');
        db.query.mockRejectedValue(error);
        await expect(scheduleService.studentOverview({ user: { id: 3 } })).rejects.toBe(error);
    });
});
