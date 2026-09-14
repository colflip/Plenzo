// C1 (L4)：核心控制器 mock-db 契约测试
// 目标：在零真实 DB 依赖下，验证 admin-controller 关键写端点的「输入 → db 调用契约 → 响应形状」，
// 为后续 D1（上帝控制器拆分 / service 下沉）提供重构护栏。
const db = require('../../db/db');
const SchemaHelper = require('../../utils/schema-helper');
const { recordAudit } = require('../../middleware/audit');
const adminController = require('../../controllers/admin-controller');
const UserService = require('../../services/user-service');
const { mockRes, mockReq } = require('../helpers/httpMocks');

jest.mock('../../services/schedule-service', () => ({}));

jest.mock('../../db/db', () => ({
    query: jest.fn(),
    runInTransaction: jest.fn(),
    getClient: jest.fn(),
    warmup: jest.fn()
}));

jest.mock('../../middleware/audit', () => ({
    recordAudit: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../../services/user-service');

jest.mock('../../utils/schema-helper', () => ({
    hasColumn: jest.fn().mockResolvedValue(true)
}));

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('admin user transport contracts', () => {
    test.each([
        ['getUsers', 'listUsers', { params: { userType: 'teacher' }, query: { page: '2', size: '10' } }],
        ['getUserById', 'getUserById', { params: { userType: 'student', id: '9' } }],
        ['getNextUserId', 'getNextUserId', { params: { userType: 'student' } }],
        ['updateUser', 'updateUser', { params: { userType: 'teacher', id: '7' }, body: { name: 'N' } }],
        ['deleteUser', 'deleteUser', { params: { userType: 'teacher', id: '7' }, query: { cascade: '1' } }]
    ])('%s 用 canonical success envelope 返回 service data', async (handler, serviceMethod, request) => {
        const data = { marker: handler };
        // service 层（D1）只返回领域数据，控制器负责包成对外信封；mock 直接给领域数据。
        UserService[serviceMethod].mockResolvedValueOnce(data);
        const req = mockReq({ ...request, requestId: `req-${handler}` });
        const res = mockRes();

        await adminController[handler](req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ ok: true, data, error: null, meta: { requestId: `req-${handler}` } });
    });

    test('createUser 保持 HTTP 201', async () => {
        UserService.createUser.mockResolvedValueOnce({ id: 7 });
        const res = mockRes();
        await adminController.createUser(mockReq({ body: { userType: 'student' }, requestId: 'req-create' }), res);
        expect(res.statusCode).toBe(201);
        expect(res.body).toMatchObject({ ok: true, data: { id: 7 }, meta: { requestId: 'req-create' } });
    });

    test('service rejection 原样传播', async () => {
        const error = new Error('user service failed');
        UserService.listUsers.mockRejectedValueOnce(error);
        await expect(adminController.getUsers(mockReq({ params: { userType: 'teacher' } }), mockRes()))
            .rejects.toBe(error);
    });
});

describe('admin availability grids', () => {
    test.each([
        ['getTeacherAvailabilityGrid', 'teacher', 'teacher_id'],
        ['getStudentAvailabilityGrid', 'student', 'student_id']
    ])('%s 返回 canonical 网格数据', async (handlerName, role, idColumn) => {
        SchemaHelper.hasColumn.mockResolvedValueOnce(true);
        db.query.mockImplementation((sql) => {
            if (sql.includes(`FROM ${role}s`)) {
                return Promise.resolve({ rows: [{ id: 2, name: 'A' }] });
            }
            return Promise.resolve({ rows: [{
                [idColumn]: 2,
                date: '2026-01-02T00:00:00.000Z',
                morning_available: 1,
                afternoon_available: 0,
                evening_available: 1
            }] });
        });
        const req = mockReq({
            user: { id: 1, permission_level: 1 },
            query: { startDate: '2026-01-01', endDate: '2026-01-31' },
            requestId: `req-${role}`
        });
        const res = mockRes();

        await adminController[handlerName](req, res);

        expect(res.body.ok).toBe(true);
        expect(res.body.data).toEqual([{
            id: 2,
            name: 'A',
            availability: {
                '2026-01-02': {
                    morning: true,
                    afternoon: false,
                    evening: true
                }
            }
        }]);
        expect(res.body.meta.requestId).toBe(`req-${role}`);
    });

    test.each([
        'getTeacherAvailabilityGrid',
        'getStudentAvailabilityGrid'
    ])('%s 缺少日期时抛 BAD_REQUEST', async (handlerName) => {
        await expect(adminController[handlerName](
            mockReq({ query: {} }),
            mockRes()
        )).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            statusCode: 400
        });
        expect(db.query).not.toHaveBeenCalled();
    });

    test('数据库异常不再改写成裸 500', async () => {
        const error = new Error('db failed');
        SchemaHelper.hasColumn.mockRejectedValueOnce(error);

        await expect(adminController.getTeacherAvailabilityGrid(
            mockReq({
                query: { startDate: '2026-01-01', endDate: '2026-01-31' }
            }),
            mockRes()
        )).rejects.toBe(error);
    });
});

describe('adminController.getTeacherConflicts', () => {
    test('返回 canonical conflicts map 并保留业务标记', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ teacher_id: 2 }] })
            .mockResolvedValueOnce({
                rows: [
                    { teacher_id: 2, start_time: '08:00:00', end_time: '12:00:00' },
                    { teacher_id: 3, start_time: '14:00:00', end_time: '15:00:00' }
                ]
            });
        const req = mockReq({
            query: {
                date: '2026-09-12',
                startTime: '09:00:00',
                endTime: '10:00:00',
                excludeScheduleId: '11'
            },
            requestId: 'req-conflicts'
        });
        const res = mockRes();

        await adminController.getTeacherConflicts(req, res);

        expect(res.body).toMatchObject({
            ok: true,
            data: {
                2: { hasClass: true },
                3: { isUnavailable: true }
            },
            error: null,
            meta: { requestId: 'req-conflicts' }
        });
        expect(res.body).not.toHaveProperty('message');
        expect(db.query).toHaveBeenCalledTimes(2);
        expect(db.query.mock.calls[0][1]).toEqual([
            '2026-09-12', '09:00:00', '10:00:00', '11'
        ]);
    });

    test('缺参数抛 BAD_REQUEST，数据库错误原样传播', async () => {
        await expect(adminController.getTeacherConflicts(
            mockReq({ query: { date: '2026-09-12' } }),
            mockRes()
        )).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
        expect(db.query).not.toHaveBeenCalled();

        const error = new Error('conflicts db failed');
        db.query.mockRejectedValueOnce(error);
        await expect(adminController.getTeacherConflicts(
            mockReq({
                query: { date: '2026-09-12', startTime: '09:00:00', endTime: '10:00:00' }
            }),
            mockRes()
        )).rejects.toBe(error);
    });
});

describe('adminController.createHoliday (契约: INSERT holidays)', () => {
    test('合法负载 → 201 + 调用 INSERT 且参数完整', async () => {
        const inserted = { id: 1, year: 2026, type: 'public', label: '元旦', start_date: '2026-01-01', end_date: '2026-01-01' };
        db.query.mockResolvedValueOnce({ rows: [inserted], rowCount: 1 });

        const req = mockReq({
            body: { year: 2026, type: 'public', label: '元旦', start_date: '2026-01-01', end_date: '2026-01-01' }
        });
        const res = mockRes();

        await adminController.createHoliday(req, res);

        expect(res.statusCode).toBe(201);
        expect(res.body.ok).toBe(true);
        expect(res.body.data).toEqual(inserted);
        expect(res.body.error).toBeNull();
        expect(res.body).not.toHaveProperty('success');
        expect(res.body).not.toHaveProperty('message');
        // 契约：db.query 被调用一次，SQL 为 INSERT INTO holidays，5 个参数齐全
        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/INSERT INTO holidays/i);
        expect(params).toEqual([2026, 'public', '元旦', '2026-01-01', '2026-01-01']);
        expect(recordAudit).toHaveBeenCalled();
    });

    test('缺字段 → 抛 BAD_REQUEST 且未触碰 db', async () => {
        const req = mockReq({ body: { year: 2026, type: 'public', label: '元旦', start_date: '2026-01-01' } });

        await expect(adminController.createHoliday(req, mockRes()))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('adminController.updateHoliday (契约: UPDATE holidays)', () => {
    test('存在记录 → 200 + UPDATE 带 6 参数(id 在末)', async () => {
        const updated = { id: 5, year: 2026, type: 'public', label: '元旦', start_date: '2026-01-01', end_date: '2026-01-01' };
        db.query.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

        const req = mockReq({
            params: { id: '5' },
            body: { year: 2026, type: 'public', label: '元旦', start_date: '2026-01-01', end_date: '2026-01-01' }
        });
        const res = mockRes();

        await adminController.updateHoliday(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data).toEqual(updated);
        expect(res.body.error).toBeNull();
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/UPDATE holidays SET/i);
        expect(params[params.length - 1]).toBe('5');
    });

    test('记录不存在 → 抛 RESOURCE_NOT_FOUND', async () => {
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const req = mockReq({
            params: { id: '9' },
            body: { year: 2026, type: 'public', label: '元旦', start_date: '2026-01-01', end_date: '2026-01-01' }
        });

        await expect(adminController.updateHoliday(req, mockRes()))
            .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404 });
    });
});

describe('adminController.batchUpsertHolidays (契约: DELETE 年份 + 一条多值 INSERT)', () => {
    test('多年份 items → 先按年份 DELETE，再用一条多值 INSERT 写入', async () => {
        db.query.mockResolvedValue({ rows: [], rowCount: 0 });
        const req = mockReq({
            body: {
                items: [
                    { year: 2026, type: 'public', label: '元旦', start_date: '2026-01-01', end_date: '2026-01-01' },
                    { year: 2027, type: 'public', label: '春节', start_date: '2027-02-01', end_date: '2027-02-07' }
                ]
            }
        });
        const res = mockRes();

        await adminController.batchUpsertHolidays(req, res);

        expect(res.statusCode).toBe(200);
        // DELETE 一次 + INSERT 一次（两行合成一条多值语句；远程库每条约 250ms，不能逐条发）
        const sqls = db.query.mock.calls.map((c) => c[0]);
        const deleteCall = db.query.mock.calls.find((c) => /DELETE FROM holidays/.test(c[0]));
        expect(deleteCall).toBeTruthy();
        expect(deleteCall[1]).toEqual([[2026, 2027]]); // ANY($1::int[])
        const inserts = db.query.mock.calls.filter((c) => /INSERT INTO holidays/.test(c[0]));
        expect(inserts.length).toBe(1);
        expect(inserts[0][0].match(/\(\$/g)).toHaveLength(2);
        expect(inserts[0][1]).toHaveLength(10);
        expect(sqls.filter((s) => /INSERT INTO holidays/.test(s)).length).toBe(1);
    });

    test('空 items → 抛 BAD_REQUEST', async () => {
        const req = mockReq({ body: { items: [] } });
        await expect(adminController.batchUpsertHolidays(req, mockRes()))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('adminController.createScheduleType (契约: 查重 SELECT + INSERT)', () => {
    test('名称不重复 → 201 + INSERT', async () => {
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // 查重：无重复
        db.query.mockResolvedValueOnce({ rows: [{ id: 2, name: '一对一', description: 'x' }], rowCount: 1 });

        const req = mockReq({ body: { name: '一对一', description: 'x' } });
        const res = mockRes();

        await adminController.createScheduleType(req, res);

        expect(res.statusCode).toBe(201);
        const insertCall = db.query.mock.calls.find((c) => /INSERT INTO schedule_types/.test(c[0]));
        expect(insertCall).toBeTruthy();
        expect(insertCall[1]).toEqual(['一对一', 'x']);
    });

    test('名称已存在 → 抛 CONFLICT', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // 查重命中
        const req = mockReq({ body: { name: '已存在' } });
        await expect(adminController.createScheduleType(req, mockRes()))
            .rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    });
});
