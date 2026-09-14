// C1 (L4)：teacher/student getProfile 契约测试（mock-db + mock SchemaHelper）
const db = require('../../db/db');
const SchemaHelper = require('../../utils/schema-helper');
const teacherController = require('../../controllers/teacher-controller');
const studentController = require('../../controllers/student-controller');
const { mockRes, mockReq } = require('../helpers/httpMocks');
const bcrypt = require('bcrypt');

jest.mock('../../db/db', () => ({
    query: jest.fn(),
    runInTransaction: jest.fn(),
    getClient: jest.fn(),
    warmup: jest.fn()
}));

jest.mock('../../utils/schema-helper', () => ({
    getColumns: jest.fn().mockResolvedValue(new Set()),
    hasColumn: jest.fn().mockResolvedValue(true),
    hasTable: jest.fn().mockResolvedValue(true),
    getDateExpr: jest.fn().mockResolvedValue('class_date')
}));

jest.mock('bcrypt', () => ({
    compare: jest.fn(),
    genSalt: jest.fn(),
    hash: jest.fn()
}));

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    db.runInTransaction.mockImplementation(async callback => callback({ query: db.query }, true));
    bcrypt.compare.mockResolvedValue(true);
    bcrypt.genSalt.mockResolvedValue('salt');
    bcrypt.hash.mockResolvedValue('new-hash');
});

function expectCanonicalSuccess(res, data, requestId) {
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
        ok: true,
        data,
        error: null,
        meta: {
            requestId,
            timestamp: expect.any(String)
        }
    });
}

describe('teacherController.getProfile (契约: 动态列 SELECT teachers)', () => {
    test('存在记录 → 200 + 返回 profile 行', async () => {
        const profile = { id: 1, name: '张老师', username: 't1' };
        db.query.mockResolvedValueOnce({ rows: [profile], rowCount: 1 });

        const res = mockRes();
        await teacherController.getProfile(mockReq({ user: { id: 1 } }), res);

        expectCanonicalSuccess(res, profile, null);
        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/SELECT .* FROM teachers WHERE id = \$1/i);
        expect(params).toEqual([1]);
        // SchemaHelper.getColumns 被调用以决定动态列
        expect(SchemaHelper.getColumns).toHaveBeenCalledWith('teachers', expect.any(Array));
    });

    test('记录不存在 → 抛 RESOURCE_NOT_FOUND', async () => {
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        await expect(teacherController.getProfile(
            mockReq({ user: { id: 999 } }),
            mockRes()
        )).rejects.toMatchObject({
            code: 'RESOURCE_NOT_FOUND',
            statusCode: 404
        });
    });
});

describe('studentController.getProfile (契约: 动态列 SELECT students)', () => {
    test('存在记录 → 200 + 返回 profile 行；动态列由 SchemaHelper 决定', async () => {
        const profile = { id: 2, name: '李同学', username: 's2' };
        db.query.mockResolvedValueOnce({ rows: [profile], rowCount: 1 });

        const res = mockRes();
        await studentController.getProfile(mockReq({ user: { id: 2 } }), res);

        expectCanonicalSuccess(res, profile, null);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/FROM students WHERE id = \$1/i);
        expect(params).toEqual([2]);
        expect(SchemaHelper.getColumns).toHaveBeenCalledWith('students', expect.any(Array));
    });
    test('记录不存在 → 抛 RESOURCE_NOT_FOUND', async () => {
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        await expect(studentController.getProfile(
            mockReq({ user: { id: 999 } }),
            mockRes()
        )).rejects.toMatchObject({
            code: 'RESOURCE_NOT_FOUND',
            statusCode: 404
        });
    });
});

describe.each([
    ['teacher', teacherController, 'teachers'],
    ['student', studentController, 'students']
])('%s profile/password mutations', (role, controller, table) => {
    test('更新 profile 返回 canonical envelope', async () => {
        const profile = { id: 7, username: `${role}-7`, name: '更新姓名' };
        db.query.mockResolvedValueOnce({ rows: [profile], rowCount: 1 });
        const body = role === 'teacher'
            ? { name: '更新姓名', profession: '教师', contact: '', work_location: '', home_address: '' }
            : { name: '更新姓名', profession: '学生', contact: '', visit_location: '', home_address: '' };
        const res = mockRes();

        await controller.updateProfile(mockReq({
            user: { id: 7 },
            body,
            requestId: `req-${role}-profile`
        }), res);

        expectCanonicalSuccess(res, profile, `req-${role}-profile`);
        expect(db.query.mock.calls[0][0]).toMatch(new RegExp(`UPDATE ${table}`, 'i'));
    });

    test('更新不存在的 profile 抛 RESOURCE_NOT_FOUND', async () => {
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const body = role === 'teacher'
            ? { name: '更新姓名', profession: '教师', contact: '', work_location: '', home_address: '' }
            : { name: '更新姓名', profession: '学生', contact: '', visit_location: '', home_address: '' };

        await expect(controller.updateProfile(mockReq({ user: { id: 99 }, body }), mockRes()))
            .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404 });
    });

    test('修改密码成功返回 canonical envelope', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ password_hash: 'old-hash' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });
        const res = mockRes();

        await controller.changePassword(mockReq({
            user: { id: 7 },
            body: { currentPassword: 'old-password', newPassword: 'new-password' },
            requestId: `req-${role}-password`
        }), res);

        expectCanonicalSuccess(res, null, `req-${role}-password`);
        expect(bcrypt.compare).toHaveBeenCalledWith('old-password', 'old-hash');
        expect(db.query).toHaveBeenCalledWith(
            `UPDATE ${table} SET password_hash = $1 WHERE id = $2`,
            ['new-hash', 7]
        );
    });

    test('当前密码错误抛 AUTH_INVALID', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ password_hash: 'old-hash' }], rowCount: 1 });
        bcrypt.compare.mockResolvedValueOnce(false);

        await expect(controller.changePassword(mockReq({
            user: { id: 7 },
            body: { currentPassword: 'wrong', newPassword: 'new-password' }
        }), mockRes())).rejects.toMatchObject({
            code: 'AUTH_INVALID',
            statusCode: 401
        });
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    test('密码查询异常原样传播', async () => {
        const error = new Error(`${role} password db failed`);
        db.query.mockRejectedValueOnce(error);

        await expect(controller.changePassword(mockReq({
            user: { id: 7 },
            body: { currentPassword: 'old-password', newPassword: 'new-password' }
        }), mockRes())).rejects.toBe(error);
    });
});

describe('availability mutation contracts', () => {
    test('teacher set 返回 canonical 计数并在事务中执行', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });
        const res = mockRes();

        await teacherController.setAvailability(mockReq({
            user: { id: 7 },
            body: {
                availabilityList: [{ date: '2026-01-01', timeSlot: 'morning', isAvailable: true }]
            },
            requestId: 'req-teacher-set'
        }), res);

        expectCanonicalSuccess(res, {
            insertCount: 1,
            updateCount: 0,
            unchangedCount: 0
        }, 'req-teacher-set');
        expect(db.runInTransaction).toHaveBeenCalledTimes(1);
    });

    test('teacher delete 与 replace 返回 canonical 计数', async () => {
        db.query.mockResolvedValue({ rows: [], rowCount: 0 });
        const deleteRes = mockRes();
        await teacherController.deleteAvailability(mockReq({
            user: { id: 7 },
            body: { records: [{ date: '2026-01-01', removeAll: true }] },
            requestId: 'req-teacher-delete'
        }), deleteRes);
        expectCanonicalSuccess(deleteRes, { updateCount: 0, deleteCount: 0 }, 'req-teacher-delete');

        const replaceRes = mockRes();
        await teacherController.replaceAvailability(mockReq({
            user: { id: 7 },
            body: { removals: [{ date: '2026-01-01', removeAll: true }] },
            requestId: 'req-teacher-replace'
        }), replaceRes);
        expectCanonicalSuccess(replaceRes, {
            insertCount: 0,
            updateCount: 0,
            deleteCount: 0
        }, 'req-teacher-replace');
    });

    test('student set 与 delete 返回 canonical 计数', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });
        const setRes = mockRes();
        await studentController.setAvailability(mockReq({
            user: { id: 8 },
            body: {
                availabilityList: [{ date: '2026-01-01', timeSlot: 'morning', isAvailable: true }]
            },
            requestId: 'req-student-set'
        }), setRes);
        expectCanonicalSuccess(setRes, { updateCount: 0, insertCount: 1 }, 'req-student-set');

        const deleteRes = mockRes();
        await studentController.deleteAvailability(mockReq({
            user: { id: 8 },
            body: {
                startDate: '2026-01-01',
                endDate: '2026-01-31',
                timeSlots: ['morning']
            },
            requestId: 'req-student-delete'
        }), deleteRes);
        expectCanonicalSuccess(deleteRes, { clearedSlots: 1 }, 'req-student-delete');
    });

    test.each([
        ['teacher', teacherController],
        ['student', studentController]
    ])('%s availability 写入异常原样传播', async (role, controller) => {
        const error = new Error(`${role} availability db failed`);
        if (role === 'teacher') {
            db.runInTransaction.mockRejectedValueOnce(error);
        } else {
            db.query.mockRejectedValueOnce(error);
        }

        await expect(controller.setAvailability(mockReq({
            user: { id: 7 },
            body: {
                availabilityList: [{ date: '2026-01-01', timeSlot: 'morning', isAvailable: true }]
            }
        }), mockRes())).rejects.toBe(error);
    });
});

describe('teacherController.getTeachingCount', () => {
    test('返回 canonical 授课统计', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ count: '12' }], rowCount: 1 });
        const res = mockRes();

        await teacherController.getTeachingCount(mockReq({
            user: { id: 7 },
            query: { startDate: '2026-01-01', endDate: '2026-01-31' },
            requestId: 'req-teaching-count'
        }), res);

        expectCanonicalSuccess(res, {
            count: 12,
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        }, 'req-teaching-count');
    });

    test('数据库异常原样传播', async () => {
        const error = new Error('teaching count db failed');
        db.query.mockRejectedValueOnce(error);

        await expect(teacherController.getTeachingCount(mockReq({
            user: { id: 7 },
            query: { startDate: '2026-01-01', endDate: '2026-01-31' }
        }), mockRes())).rejects.toBe(error);
    });
});

describe('availability controller error propagation', () => {
    test.each([
        ['teacher', teacherController],
        ['student', studentController]
    ])('%s 成功读取返回 canonical envelope', async (role, controller) => {
        const rows = [{
            id: 1,
            date: '2026-01-01',
            morning_available: 1,
            afternoon_available: 0,
            evening_available: 1
        }];
        db.query.mockResolvedValueOnce({ rows });
        const req = mockReq({
            user: { id: 7 },
            query: { startDate: '2026-01-01', endDate: '2026-01-31' },
            requestId: `req-${role}`
        });
        const res = mockRes();

        await controller.getAvailability(req, res);

        const expectedRows = role === 'teacher'
            ? [{
                ...rows[0],
                slots: {
                    morning: true,
                    afternoon: false,
                    evening: true
                }
            }]
            : rows;
        expectCanonicalSuccess(res, expectedRows, `req-${role}`);
        expect(db.query.mock.calls[0][1]).toEqual([
            7,
            '2026-01-01',
            '2026-01-31'
        ]);
    });

    test.each([
        ['teacher', teacherController],
        ['student', studentController]
    ])('%s 缺少日期时抛 BAD_REQUEST', async (role, controller) => {
        await expect(controller.getAvailability(
            mockReq({ user: { id: 7 }, query: {} }),
            mockRes()
        )).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            statusCode: 400
        });
        expect(db.query).not.toHaveBeenCalled();
    });

    test.each([
        ['teacher', teacherController],
        ['student', studentController]
    ])('%s 数据库异常原样传播', async (role, controller) => {
        const error = new Error(`${role} db failed`);
        db.query.mockRejectedValueOnce(error);

        await expect(controller.getAvailability(
            mockReq({
                user: { id: 7 },
                query: { startDate: '2026-01-01', endDate: '2026-01-31' }
            }),
            mockRes()
        )).rejects.toBe(error);
    });
});
