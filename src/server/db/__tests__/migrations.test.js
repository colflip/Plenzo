/**
 * 迁移批次调度：确认「一个批次已应用 / 失败」不会让另一个批次被跳过。
 *
 * 守的是这样一类 bug：批次 guard 里的 `return` 退出的是整个 runDatabaseMigrations，
 * 而不是本批次 —— 一旦 v1 已应用的库提前 return，后加的 v2 建表就永远不会执行，
 * 且没有任何报错。ai_user_model_prefs 建表当初就是这么漏掉的。
 */
jest.mock('../db', () => ({
    query: jest.fn(async () => ({ rows: [] })),
    describeError: (e) => (e && e.message) || String(e),
    runInTransaction: jest.fn()
}));
jest.mock('../../utils/logger.js', () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../migrations-course-sessions', () => ({
    migrateCourseSessions: jest.fn(async () => {}),
    isApplied: jest.fn(async (key) => key === 'legacy_migrations@v1'),
    markApplied: jest.fn(async () => {})
}));

const db = require('../db');
const { isApplied, markApplied } = require('../migrations-course-sessions');
const runDatabaseMigrations = require('../migrations');

describe('迁移批次调度', () => {
    // 调用历史跨用例累积（jest.config 没开 clearMocks），每个用例前清一次
    beforeEach(() => jest.clearAllMocks());

    test('v1 已应用时，v2 批次仍然执行并写入自己的标记', async () => {
        await runDatabaseMigrations();

        const sql = db.query.mock.calls.map((c) => c[0]).join('\n');

        expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.ai_schedule_previews');
        expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.ai_pending_operations');
        expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.ai_user_model_prefs');

        // user_id 是多态的，没有单张表能当外键目标；任何 REFERENCES 都会让整批报 42P01
        expect(sql).not.toMatch(/REFERENCES/i);
        expect(sql).not.toContain('public.users');

        // v1 的语句不该被重跑（它已经标记过了）
        expect(sql).not.toContain('teacher_daily_availability');

        expect(isApplied).toHaveBeenCalledWith('legacy_migrations@v2');
        expect(markApplied).toHaveBeenCalledWith('legacy_migrations@v2');
        expect(markApplied).not.toHaveBeenCalledWith('legacy_migrations@v1');
    });

    test('全新库上两个批次都跑，各自写标记', async () => {
        isApplied.mockImplementation(async () => false);
        await runDatabaseMigrations();

        const sql = db.query.mock.calls.map((c) => c[0]).join('\n');
        expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.ai_user_model_prefs');
        expect(markApplied).toHaveBeenCalledWith('legacy_migrations@v1');
        expect(markApplied).toHaveBeenCalledWith('legacy_migrations@v2');
    });

    test('v1 批次中途报错也不阻断 v2 批次，且不写 v1 标记（下次启动重跑）', async () => {
        isApplied.mockImplementation(async () => false);
        db.query.mockImplementation(async (sql) => {
            if (/teacher_daily_availability/.test(sql)) throw new Error('boom');
            return { rows: [] };
        });

        await runDatabaseMigrations();

        const sql = db.query.mock.calls.map((c) => c[0]).join('\n');
        expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.ai_user_model_prefs');
        expect(markApplied).toHaveBeenCalledWith('legacy_migrations@v2');
        expect(markApplied).not.toHaveBeenCalledWith('legacy_migrations@v1');
    });
});
