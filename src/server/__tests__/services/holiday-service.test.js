// D1-1：holiday-service 单测（契约测试迁移到 service 层）
// 直接 mock 数据访问与审计依赖，验证业务规则与 db 调用契约。
const db = require('../../db/db');
const { recordAudit } = require('../../middleware/audit');
const HolidayService = require('../../services/holiday-service');

jest.mock('../../db/db', () => ({
    query: jest.fn(),
    runInTransaction: jest.fn(),
    getClient: jest.fn(),
    warmup: jest.fn()
}));

jest.mock('../../middleware/audit', () => ({
    recordAudit: jest.fn().mockResolvedValue(undefined)
}));

const req = { user: { id: 7 } };

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('holiday-service.validateHolidayFields', () => {
    test('缺字段返回错误文案', () => {
        expect(HolidayService.validateHolidayFields({ year: 2026, type: 'public' })).toBeTruthy();
        expect(HolidayService.validateHolidayFields(null)).toBeTruthy();
    });
    test('全字段齐全返回 null', () => {
        expect(HolidayService.validateHolidayFields({ year: 2026, type: 'public', label: '元旦', start_date: '2026-01-01', end_date: '2026-01-01' })).toBeNull();
    });
});

describe('holiday-service.createHoliday', () => {
    test('合法 → 返回记录并执行 INSERT + recordAudit', async () => {
        const inserted = { id: 1, year: 2026, type: 'public', label: '元旦', start_date: '2026-01-01', end_date: '2026-01-01' };
        db.query.mockResolvedValueOnce({ rows: [inserted], rowCount: 1 });
        const result = await HolidayService.createHoliday(inserted, req);
        expect(result).toEqual(inserted);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/INSERT INTO holidays/i);
        expect(params).toEqual([2026, 'public', '元旦', '2026-01-01', '2026-01-01']);
        expect(recordAudit).toHaveBeenCalledWith(req, expect.objectContaining({ op: 'create_holiday' }));
    });
    test('缺字段 → 抛 BAD_REQUEST 且不触碰 db', async () => {
        await expect(HolidayService.createHoliday({ year: 2026 }, req))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('holiday-service.updateHoliday', () => {
    test('不存在 → 抛 RESOURCE_NOT_FOUND', async () => {
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        await expect(HolidayService.updateHoliday('9', { year: 2026, type: 'public', label: '元旦', start_date: '2026-01-01', end_date: '2026-01-01' }, req))
            .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404 });
    });
    test('存在 → 返回更新记录且 UPDATE 末参数为 id', async () => {
        const updated = { id: 5 };
        db.query.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });
        await expect(HolidayService.updateHoliday('5', { year: 2026, type: 'public', label: '元旦', start_date: '2026-01-01', end_date: '2026-01-01' }, req))
            .resolves.toEqual(updated);
        expect(db.query.mock.calls[0][1].slice(-1)[0]).toBe('5');
    });
});

describe('holiday-service.batchUpsertHolidays', () => {
    test('空数组 → 抛 BAD_REQUEST', async () => {
        await expect(HolidayService.batchUpsertHolidays([], req))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    });
    test('多年份 → 返回计数，先 DELETE，再用一条多值 INSERT 写入（每条语句约 250ms，不能逐条发）', async () => {
        db.query.mockResolvedValue({ rows: [], rowCount: 0 });
        const result = await HolidayService.batchUpsertHolidays([
            { year: 2026, type: 'public', label: '元旦', start_date: '2026-01-01', end_date: '2026-01-01' },
            { year: 2027, type: 'public', label: '春节', start_date: '2027-02-01', end_date: '2027-02-07' }
        ], req);
        expect(result).toEqual({ count: 2, years: [2026, 2027] });
        const deleteCall = db.query.mock.calls.find((c) => /DELETE FROM holidays/.test(c[0]));
        expect(deleteCall[1]).toEqual([[2026, 2027]]);
        const inserts = db.query.mock.calls.filter((c) => /INSERT INTO holidays/.test(c[0]));
        expect(inserts.length).toBe(1);
        // 一条语句里两组 VALUES 元组、10 个占位参数
        expect(inserts[0][0].match(/\(\$/g)).toHaveLength(2);
        expect(inserts[0][1]).toHaveLength(10);
    });
});

describe('holiday-service.syncHolidaysFromAPI (fetcher 注入)', () => {
    test('无数据 → 空数组', async () => {
        const fetcher = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ holiday: {} }) });
        const result = await HolidayService.syncHolidaysFromAPI([2026], req, { fetcher });
        expect(result).toEqual([]);
        expect(db.query).not.toHaveBeenCalled();
    });
    test('全部上游请求失败 → 503，不伪装成空数据', async () => {
        const fetcher = jest.fn().mockResolvedValue({ ok: false });

        await expect(HolidayService.syncHolidaysFromAPI([2026, 2027], req, { fetcher }))
            .rejects.toMatchObject({
                code: 'SERVICE_UNAVAILABLE',
                statusCode: 503,
                retryable: true,
                details: [{ year: 2026 }, { year: 2027 }]
            });
        expect(db.query).not.toHaveBeenCalled();
    });
    test('部分年份失败时仍同步成功年份并报告失败年份', async () => {
        db.query.mockResolvedValue({ rows: [], rowCount: 0 });
        const fetcher = jest.fn()
            .mockResolvedValueOnce({ ok: false })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ holiday: { '1-1': { name: '元旦', holiday: true } } })
            });

        const result = await HolidayService.syncHolidaysFromAPI([2025, 2026], req, { fetcher });

        expect(result).toEqual([]);
        const deleteCall = db.query.mock.calls.find((c) => /DELETE FROM holidays/.test(c[0]));
        expect(deleteCall[1]).toEqual([[2026]]);
    });
    test('解析并写入', async () => {
        db.query.mockResolvedValue({ rows: [], rowCount: 0 });
        const fetcher = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ holiday: { '1-1': { name: '元旦', holiday: true } } })
        });
        const result = await HolidayService.syncHolidaysFromAPI([2026], req, { fetcher });
        expect(result).toEqual([]);
        const insertCall = db.query.mock.calls.find((c) => /INSERT INTO holidays/.test(c[0]));
        expect(insertCall[1]).toEqual([2026, 'holiday', '元旦', '2026-01-01', '2026-01-01']);
    });
});
