/**
 * 权限落地（Phase 1）单测：schedule-service L3 数据范围过滤
 * （仅自己创建 + 无主存量；越权详情/删除/确认视为不存在 404）
 */
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
jest.mock('../../utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), log: jest.fn() }));

const l1Req = (over = {}) => ({ params: {}, query: {}, body: {}, user: { id: 1, userType: 'admin', permissionLevel: 1 }, ...over });
const l3Req = (over = {}) => ({ params: {}, query: {}, body: {}, user: { id: 9, userType: 'admin', permissionLevel: 3 }, ...over });

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
});

describe('排课列表 adminListSchedules 范围注入', () => {
    test('L3：SQL 追加 created_by 范围条件（$3），params 含 actorId', async () => {
        await scheduleService.adminListSchedules(l3Req({ query: {} }));
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/\(ca\.created_by = \$3 OR ca\.created_by IS NULL\)/);
        expect(params).toContain(9);
    });

    test('L1：不加范围条件', async () => {
        await scheduleService.adminListSchedules(l1Req({ query: {} }));
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).not.toContain('created_by');
        expect(params).toEqual(['1970-01-01', '2099-12-31']);
    });

    test('网格视图 adminGetSchedulesGrid 同样注入', async () => {
        await scheduleService.adminGetSchedulesGrid(l3Req({ query: { start_date: '2026-01-01', end_date: '2026-12-31' } }));
        const [sql, params] = db.query.mock.calls[0];
        // 网格视图数据源换成 v_session_pairs（别名 vp），视图透出场次头部的 created_by，
        // buildScopeClause 逻辑不变，只是别名从 ca 换成 vp。
        expect(sql).toMatch(/vp\.created_by = \$3 OR vp\.created_by IS NULL/);
        expect(params).toContain(9);
    });
});

describe('排课详情 adminGetScheduleById 越权视为不存在', () => {
    test('L3：SQL 含归属条件；无命中 → RESOURCE_NOT_FOUND', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await expect(scheduleService.adminGetScheduleById(l3Req({ params: { id: '77' } })))
            .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404 });
        const [sql, params] = db.query.mock.calls[0];
        // 详情读换成场次形状（FROM course_sessions cs），归属条件的别名随之从 ca 变 cs
        expect(sql).toMatch(/cs\.created_by = \$2 OR cs\.created_by IS NULL/);
        expect(params).toEqual([77, 9]);
    });

    test('L1：SQL 不含归属条件，正常返回', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 77 }] });
        await expect(scheduleService.adminGetScheduleById(l1Req({ params: { id: '77' } })))
            .resolves.toMatchObject({ id: 77 });
        // 场次形状会把 created_by 作为列选出来，所以这里只断言「没有范围谓词」
        expect(db.query.mock.calls[0][0]).not.toMatch(/cs\.created_by = \$/);
    });
});

describe('写路径归属校验', () => {
    test('adminDeleteSchedule：L3 删除他人创建 → RESOURCE_NOT_FOUND 且不进入事务', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, created_by: 8 }] }); // 他人创建
        await expect(scheduleService.adminDeleteSchedule(l3Req({ params: { id: '1' } })))
            .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404 });
        expect(db.runInTransaction).not.toHaveBeenCalled();
    });

    test('adminDeleteSchedule：L3 删除自己创建 → 返回领域结果', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, created_by: 9 }] });
        await expect(scheduleService.adminDeleteSchedule(l3Req({ params: { id: '1' } })))
            .resolves.toEqual({ message: '排课删除成功' });
        // 删除不再开事务（省 BEGIN + COMMIT 两次往返）；归属校验通过才会走到 DELETE
        expect(db.query.mock.calls.some(c => /DELETE FROM course_sessions/.test(String(c[0])))).toBe(true);
    });

    test('adminDeleteSchedule：L3 删除无主存量（created_by NULL）→ 返回领域结果', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, created_by: null }] });
        await expect(scheduleService.adminDeleteSchedule(l3Req({ params: { id: '1' } })))
            .resolves.toEqual({ message: '排课删除成功' });
    });

    test('adminConfirmSchedule：L3 确认他人创建 → RESOURCE_NOT_FOUND', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 3, created_by: 8 }] });
        await expect(scheduleService.adminConfirmSchedule(l3Req({ params: { id: '3' }, body: { adminConfirmed: true } })))
            .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404 });
    });

    test('adminConfirmSchedule：L1 全量可确认 → 返回领域结果（逐 pair 走 setTeacherStatus）', async () => {
        const session = {
            id: 3, created_by: 8, version: 1, start_time: '10:00', end_time: '11:00', location: 'L',
            teachers: [{ uid: 't1', teacher_id: 7, type_id: 2, status: 'normal.pending', fee_status: 'draft' }],
            students: [{ uid: 's1', student_id: 5 }]
        };
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 3, created_by: 8 }] })   // 存在性 + 归属
            .mockResolvedValueOnce({ rows: [session] })                    // 取 pair 列表
            .mockResolvedValueOnce({ rows: [session] })                    // setTeacherStatus 写前读
            .mockResolvedValueOnce({ rows: [session], rowCount: 1 })       // 原地重建
            .mockResolvedValue({ rows: [] });                              // 审计
        await expect(scheduleService.adminConfirmSchedule(l1Req({ params: { id: '3' }, body: { adminConfirmed: true } })))
            .resolves.toEqual({ message: '课程确认状态更新成功' });
    });
});

describe('统计聚合范围化', () => {
    test('adminOverviewStats：L3 排课衍生指标注入范围（教师/学生数保持全局）', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ teacher_count: 11, student_count: 5, monthly_schedules: 0, pending_count: 0, total_schedules: 0 }] });
        await scheduleService.adminOverviewStats(l3Req({}));
        const [sql, params] = db.query.mock.calls[0];
        // 7 个排课衍生子查询各注入一次范围条件（月/待确认/总计/本周/本年/已完成/已取消）
        // —— 它们都换到了 v_session_pairs（视图透出场次头部的 created_by）
        expect(sql.match(/v_session_pairs\.created_by = \$1 OR v_session_pairs\.created_by IS NULL/g)).toHaveLength(7);
        // teacher_count 子查询不受影响（紧邻的 COUNT(*) FROM teachers 段内无 created_by）
        expect(sql).toMatch(/\(SELECT COUNT\(\*\) FROM teachers\) as teacher_count/);
        expect(params).toEqual([9]);
    });

    test('adminOverviewStats：L1 无范围参数', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ teacher_count: 0 }] });
        await scheduleService.adminOverviewStats(l1Req({}));
        expect(db.query.mock.calls[0][0]).not.toContain('created_by');
        expect(db.query.mock.calls[0][1]).toEqual([]);
    });

    test('adminScheduleStats：L3 注入范围', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await scheduleService.adminScheduleStats(l3Req({ query: { startDate: '2026-08-01', endDate: '2026-08-31' } }));
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/ca\.created_by = \$3 OR ca\.created_by IS NULL/);
        expect(params).toEqual(['2026-08-01', '2026-08-31', 9]);
    });
});
