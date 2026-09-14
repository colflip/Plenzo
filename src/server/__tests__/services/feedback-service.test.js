// D1-3：feedback-service 单测
const db = require('../../db/db');
const FeedbackService = require('../../services/feedback-service');

jest.mock('../../db/db', () => ({
    query: jest.fn(),
    runInTransaction: jest.fn(),
    getClient: jest.fn(),
    warmup: jest.fn()
}));

const adminReq = { user: { id: 1, userType: 'admin', name: 'A' } };
const ownerReq = { user: { id: 9, userType: 'student', name: 'S' } };
const otherReq = { user: { id: 2, userType: 'student', name: 'O' } };

beforeEach(() => { jest.clearAllMocks(); db.query.mockResolvedValue({ rows: [], rowCount: 0 }); });

describe('feedback-service.createFeedback', () => {
    test('非法类型 → 抛 BAD_REQUEST', async () => {
        await expect(FeedbackService.createFeedback({ type: 'x', description: 'd' }, adminReq))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    });
    test('缺描述 → 抛 BAD_REQUEST', async () => {
        await expect(FeedbackService.createFeedback({ type: 'bug' }, adminReq))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    });
    test('合法 → 返回记录并执行 INSERT（默认 priority=medium）', async () => {
        const created = { id: 1 };
        db.query.mockResolvedValueOnce({ rows: [created], rowCount: 1 });
        const result = await FeedbackService.createFeedback({ type: 'bug', description: '崩了' }, adminReq);
        expect(result).toEqual(created);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/INSERT INTO feedbacks/i);
        expect(params[0]).toBe('bug');
        expect(params[1]).toBe('medium');
    });
});

describe('feedback-service.updateFeedback', () => {
    test('不存在 → 抛 RESOURCE_NOT_FOUND', async () => {
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        await expect(FeedbackService.updateFeedback('5', { status: 'done' }, adminReq))
            .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404 });
    });
    test('非管理员且非本人 → 抛 FORBIDDEN', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 5, submitter_id: 9 }], rowCount: 1 });
        await expect(FeedbackService.updateFeedback('5', { status: 'done' }, otherReq))
            .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    });
    test('本人可改 → 返回更新记录', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 5, submitter_id: 9, type: 'bug', priority: 'low', title: 't', description: 'd', status: 'open' }], rowCount: 1 });
        const updated = { id: 5 };
        db.query.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });
        await expect(FeedbackService.updateFeedback('5', { status: 'done' }, ownerReq))
            .resolves.toEqual(updated);
        expect(db.query.mock.calls[1][1].slice(-2)).toEqual(['done', '5']);
    });
});

describe('feedback-service.deleteFeedback', () => {
    test('管理员可删 → 返回删除 ID', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ submitter_id: 9 }], rowCount: 1 });
        db.query.mockResolvedValueOnce({ rowCount: 1 });
        await expect(FeedbackService.deleteFeedback('5', adminReq)).resolves.toEqual({ id: '5' });
    });
    test('非本人且非管理员 → 抛 FORBIDDEN', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ submitter_id: 9 }], rowCount: 1 });
        await expect(FeedbackService.deleteFeedback('5', otherReq))
            .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    });
});
