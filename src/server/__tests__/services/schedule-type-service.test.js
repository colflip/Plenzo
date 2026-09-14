// D1-2：schedule-type-service 单测
const db = require('../../db/db');
const { recordAudit } = require('../../middleware/audit');
const ScheduleTypeService = require('../../services/schedule-type-service');

jest.mock('../../db/db', () => ({
    query: jest.fn(),
    runInTransaction: jest.fn(),
    getClient: jest.fn(),
    warmup: jest.fn()
}));
jest.mock('../../middleware/audit', () => ({
    recordAudit: jest.fn().mockResolvedValue(undefined)
}));

const req = { user: { id: 3 } };
beforeEach(() => { jest.clearAllMocks(); db.query.mockResolvedValue({ rows: [], rowCount: 0 }); });

describe('schedule-type-service.createScheduleType', () => {
    test('空名称 → 抛 BAD_REQUEST', async () => {
        await expect(ScheduleTypeService.createScheduleType({ name: '' }, req))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
        expect(db.query).not.toHaveBeenCalled();
    });
    test('重名 → 抛 CONFLICT', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
        await expect(ScheduleTypeService.createScheduleType({ name: '已存在' }, req))
            .rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    });
    test('正常 → 返回创建记录并执行 INSERT', async () => {
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // 查重无
        const created = { id: 2, name: '一对一', description: 'x' };
        db.query.mockResolvedValueOnce({ rows: [created], rowCount: 1 });
        const result = await ScheduleTypeService.createScheduleType({ name: '一对一', description: 'x' }, req);
        expect(result).toEqual(created);
        const insert = db.query.mock.calls.find((c) => /INSERT INTO schedule_types/.test(c[0]));
        expect(insert[1]).toEqual(['一对一', 'x']);
        expect(recordAudit).toHaveBeenCalled();
    });
});

describe('schedule-type-service.updateScheduleType', () => {
    test('不存在 → 抛 RESOURCE_NOT_FOUND', async () => {
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // 查重排除自身无
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE 无命中
        await expect(ScheduleTypeService.updateScheduleType('9', { name: 'x' }, req))
            .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404 });
    });
    test('正常 → 返回更新记录', async () => {
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const updated = { id: 9, name: 'x' };
        db.query.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });
        await expect(ScheduleTypeService.updateScheduleType('9', { name: 'x' }, req))
            .resolves.toEqual(updated);
    });
});

describe('schedule-type-service.deleteScheduleType', () => {
    test('被引用 → 抛 CONFLICT', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ count: '3' }], rowCount: 1 });
        await expect(ScheduleTypeService.deleteScheduleType('1', req))
            .rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409, message: expect.stringContaining('3') });
    });
    test('不存在 → 抛 RESOURCE_NOT_FOUND', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        await expect(ScheduleTypeService.deleteScheduleType('1', req))
            .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404 });
    });
    test('正常 → 返回 null', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
        db.query.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
        await expect(ScheduleTypeService.deleteScheduleType('1', req)).resolves.toBeNull();
        expect(recordAudit).toHaveBeenCalled();
    });
});
