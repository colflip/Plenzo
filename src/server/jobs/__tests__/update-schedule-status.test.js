const db = require('../../db/db');

// Mock db
jest.mock('../../db/db', () => ({
    query: jest.fn(),
    runInTransaction: jest.fn(),
    end: jest.fn()
}));

const updateScheduleStatus = require('../update-schedule-status');

describe('updateScheduleStatus Job（一场一行：整批压成一条语句）', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('没有到期 pair 时只发一次查询、不进事务', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        const result = await updateScheduleStatus();

        expect(result.success).toBe(true);
        expect(result.updatedCount).toBe(0);
        expect(db.query).toHaveBeenCalledTimes(1);
        // 候选筛选 + 原地重建 + 审计插入在同一个 CTE 里，不再需要外层事务
        expect(db.runInTransaction).not.toHaveBeenCalled();
    });

    it('一条语句完成「筛候选 + 改状态 + 写审计」，返回的行数即更新的 pair 数', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ session_id: 101, teacher_uid: 't1' }] })
            .mockResolvedValueOnce({ rows: [] });

        const result = await updateScheduleStatus();

        expect(result.success).toBe(true);
        expect(result.updatedCount).toBe(1);
        expect(db.runInTransaction).not.toHaveBeenCalled();
    });

    it('候选谓词枚举完整字面量（3 类别 × 2 生命周期），否则拿不到 GIN 索引', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await updateScheduleStatus();

        const sql = String(db.query.mock.calls[0][0]);
        ['normal.pending', 'normal.confirmed', 'adjusted.pending',
            'adjusted.confirmed', 'temp.pending', 'temp.confirmed']
            .forEach(code => expect(sql).toContain(`@.status == "${code}"`));
        // starts with / like_regex 拿不到索引，所以不该出现
        expect(sql).not.toMatch(/starts with|like_regex/);
    });

    it('只换生命周期后缀，类别前缀原样保留（临时加课到期变 temp.completed）', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await updateScheduleStatus();

        const sql = String(db.query.mock.calls[0][0]);
        expect(sql).toMatch(/split_part\(e->>'status', '\.', 1\) \|\| '\.completed'/);
        expect(sql).toMatch(/'\{auto_at\}'/);       // auto_at 顶替原 last_auto_update
        expect(sql).toMatch(/FOR UPDATE/);          // 并发下无需 version
        expect(sql).toMatch(/INSERT INTO session_status_logs/);
    });

    it('查询报错时返回 success:false 并带上 runId（withRetry 重试后仍失败）', async () => {
        // mockReset 清掉前面用例遗留的 once 队列（clearAllMocks 只清调用记录，不清实现）
        db.query.mockReset();
        db.query.mockRejectedValue(new Error('boom'));
        const result = await updateScheduleStatus();
        expect(result.success).toBe(false);
        expect(result.error).toBe('boom');
        expect(result.runId).toBeTruthy();
    }, 15000);
});
