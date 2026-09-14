/**
 * 权限落地（Phase 1.5）单测：AI 助手数据工具的 L3 范围过滤
 * - 读类工具（query_overview / query_schedules / query_schedule_stats）注入 created_by 范围
 * - 写类工具（preview update/delete）任一越权整批拒绝；创建打标 created_by
 * - 功能性例外：find_available_slots 保持全量（冲突检测必需）
 */
const db = require('../../db/db');
const { _test } = require('../../controllers/ai-controller');
const { executeDataTool } = _test;
const aiOperationStore = require('../../services/ai-operation-store');
const schedulePreviewStore = aiOperationStore._mem.memPreviews;

jest.mock('../../db/db', () => ({
    query: jest.fn(),
    runInTransaction: jest.fn(async (cb) => cb(null, true)),
    warmup: jest.fn(),
}));

const l1Req = { user: { id: 1, userType: 'admin', permissionLevel: 1 } };
const l3Req = { user: { id: 9, userType: 'admin', permissionLevel: 3 } };

beforeEach(() => {
    jest.clearAllMocks();
    schedulePreviewStore.clear();
    db.query.mockResolvedValue({ rows: [{ count: 0 }] });
});

describe('query_overview 范围化', () => {
    test('L3：排课计数注入 created_by 范围，教师/学生计数保持全局', async () => {
        await executeDataTool('query_overview', {}, l3Req);
        // 4 个计数压在同一条语句的 subselect 里（原来是 4 条并发查询，占 4 条连接）
        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        // 教师/学生计数保持全局：各自的 subselect 里不带范围条件
        expect(sql).toMatch(/\(SELECT COUNT\(\*\) FROM teachers WHERE status=1\) AS teacher_count/);
        expect(sql).toMatch(/\(SELECT COUNT\(\*\) FROM students WHERE status=1\) AS student_count/);
        // 两个排课计数各注入一次范围条件
        expect(sql.match(/created_by=\$1 OR created_by IS NULL/g)).toHaveLength(2);
        expect(params).toEqual([9]);
    });

    test('L1：不注入范围', async () => {
        await executeDataTool('query_overview', {}, l1Req);
        const sqls = db.query.mock.calls.map(c => c[0]);
        expect(sqls.every(s => !s.includes('created_by'))).toBe(true);
    });
});

describe('query_schedules 范围化', () => {
    test('L3：追加归属条件且参数正确', async () => {
        await executeDataTool('query_schedules', { startDate: '2026-08-01' }, l3Req);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/ca\.created_by=\$2 OR ca\.created_by IS NULL/); // startDate 占 $1
        expect(params).toEqual(['2026-08-01', 9]);
    });

    test('L1：不加归属条件', async () => {
        await executeDataTool('query_schedules', {}, l1Req);
        expect(db.query.mock.calls[0][0]).not.toContain('created_by');
    });
});

describe('query_schedule_stats 范围化', () => {
    test.each(['type', 'teacher', 'student'])('L3 维度=%s：注入归属条件', async (dimension) => {
        await executeDataTool('query_schedule_stats', { dimension }, l3Req);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/ca\.created_by=\$1 OR ca\.created_by IS NULL/);
        expect(params).toEqual([9]);
    });
});

describe('写路径归属校验（AI 工具）', () => {
    // 预览工具内部注册 5 分钟自动过期的 setTimeout，用假定时器避免挂起 jest 进程
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    test('preview_schedule_update：L3 含他人记录 → 403 整批拒绝', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                { id: 1, created_by: 9 },
                { id: 2, created_by: 8 }
            ]
        });
        await expect(executeDataTool('preview_schedule_update',
            { scheduleIds: [1, 2], fields: { status: 'confirmed' } }, l3Req))
            .rejects.toMatchObject({ statusCode: 403 });
    });

    test('preview_schedule_update：L3 全部为本人/无主 → 通过并生成预览', async () => {
        db.query.mockResolvedValueOnce({
            rows: [
                { id: 1, created_by: 9 },
                { id: 2, created_by: null }
            ]
        });
        const out = await executeDataTool('preview_schedule_update',
            { scheduleIds: [1, 2], fields: { status: 'confirmed' } }, l3Req);
        expect(out.type).toBe('schedule_operation_preview');
    });

    test('preview_schedule_deletion：L3 含他人记录 → 403', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 5, created_by: 8 }] });
        await expect(executeDataTool('preview_schedule_deletion',
            { scheduleIds: [5], reason: 'test' }, l3Req))
            .rejects.toMatchObject({ statusCode: 403 });
    });

    test('confirm_schedule_creation：INSERT 打标 created_by=actorId', async () => {
        schedulePreviewStore.set('pv_1', {
            previewId: 'pv_1',
            groups: [{
                teacherId: 3, studentId: 4, courseId: 2, location: 'A101',
                slots: [{ date: '2026-08-25', startTime: '09:00', endTime: '11:00', status: 'confirmed' }]
            }]
        });
        // 一场一行：创建改走 courseSessionService.createSessions（批量入口）——
        // 引用完整性并发校验一次（JSONB 拿不到外键），再一条多行 INSERT。
        // 批量版的参数布局是 $1 = actorId，其后每场 7 个（日期/起/止/地点/备注/teachers/students）。
        db.query.mockImplementation(async (sql, params) => {
            if (/SELECT id FROM (teachers|students|schedule_types) WHERE id = ANY/.test(String(sql))) {
                const ids = Array.isArray(params[0]) ? params[0] : [];
                return { rows: ids.map(id => ({ id })) };
            }
            return { rows: [{ id: 101, teachers: [], students: [] }] };
        });
        await executeDataTool('confirm_schedule_creation', { previewId: 'pv_1' }, l3Req);
        const insert = db.query.mock.calls.find(c => /INSERT INTO course_sessions/i.test(String(c[0])));
        expect(insert).toBeDefined();
        expect(String(insert[0])).toContain('created_by');
        expect(insert[1][0]).toBe(9);                                  // 头部 created_by / updated_by 共用 $1
        // pair 里的 created_by 也是 actor.id（服务端填，不接受请求传入）
        expect(JSON.parse(insert[1][6])[0].created_by).toBe(9);
    });
});

describe('功能性例外：find_available_slots 保持全量', () => {
    test('L3 查找空闲时段不加归属过滤（需见师生全部占用）', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 3, name: 'T' }] })   // teacher 校验
            .mockResolvedValueOnce({ rows: [{ id: 4, name: 'S' }] })   // student 校验
            .mockResolvedValueOnce({ rows: [] });                       // 已有排课
        await executeDataTool('find_available_slots', {
            teacherId: 3, studentId: 4,
            startDate: '2026-08-25', endDate: '2026-08-26'
        }, l3Req);
        const conflictSql = db.query.mock.calls[2][0];
        expect(conflictSql).not.toContain('created_by');
    });
});
