// user-service transport migration tests: domain data, AppError failures, raw DB propagation
const db = require('../../db/db');
const bcrypt = require('bcrypt');
const { recordAudit } = require('../../middleware/audit');
const SchemaHelper = require('../../utils/schema-helper');
const aiUserModelStore = require('../../services/ai-user-model-store');
const UserService = require('../../services/user-service');

jest.mock('../../db/db', () => ({
    query: jest.fn(),
    runInTransaction: jest.fn(async (cb) => cb(null, true)),
    warmup: jest.fn(),
}));
jest.mock('bcrypt', () => ({
    genSalt: jest.fn().mockResolvedValue('salt'),
    hash: jest.fn().mockResolvedValue('hashed'),
}));
jest.mock('../../utils/schema-helper', () => ({ hasColumn: jest.fn().mockResolvedValue(true) }));
jest.mock('../../middleware/audit', () => ({ recordAudit: jest.fn().mockResolvedValue() }));
jest.mock('../../services/ai-user-model-store', () => ({ purgeUserModel: jest.fn().mockResolvedValue() }));

// L1 超级管理员身份（权限落地后所有账号写操作要求 permissionLevel === 1）
const adminReq = { user: { id: 1, userType: 'admin', permissionLevel: 1 } };

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
});

describe('user-service.listUsers', () => {
    test('合法类型 → 返回领域列表', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });
        const data = await UserService.listUsers('teacher', { page: 1, size: 10 });
        expect(data).toEqual([{ id: 1 }, { id: 2 }]);
    });
    test('非法类型 → 抛 BAD_REQUEST', async () => {
        await expect(UserService.listUsers('foo', {})).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            statusCode: 400,
            message: '无效的用户类型'
        });
    });
    test('数据库异常原样传播', async () => {
        const error = new Error('list users failed');
        db.query.mockRejectedValueOnce(error);
        await expect(UserService.listUsers('teacher', {})).rejects.toBe(error);
    });
});

describe('user-service.getUserById', () => {
    test('存在 → 返回领域数据', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 9, name: 'S' }] });
        await expect(UserService.getUserById('student', 9)).resolves.toMatchObject({ id: 9 });
    });
    test('不存在 → 抛 RESOURCE_NOT_FOUND', async () => {
        await expect(UserService.getUserById('teacher', 404)).rejects.toMatchObject({
            code: 'RESOURCE_NOT_FOUND',
            statusCode: 404,
            message: '用户不存在'
        });
    });
});

describe('user-service.createUser', () => {
    test.each([
        [{ userType: 'student' }, 'BAD_REQUEST', '缺少必要字段：username, password, name'],
        [{ userType: 'admin', username: 'a', password: 'p', name: 'n', permission_level: 9 }, 'BAD_REQUEST', '权限级别必须在1到3之间'],
        [{ userType: 'admin', username: 'a', password: 'p', name: 'n', permission_level: 2 }, 'BAD_REQUEST', '管理员必须提供 email']
    ])('预期失败抛 AppError', async (payload, code, message) => {
        await expect(UserService.createUser(payload, adminReq)).rejects.toMatchObject({ code, message });
    });
    test('用户名已存在 → 抛 CONFLICT', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
        await expect(UserService.createUser({ userType: 'student', username: 'dup', password: 'p', name: 'n' }, adminReq))
            .rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409, message: '用户名已存在' });
    });
    test('teacher student_ids 含不存在 ID → 抛 BAD_REQUEST', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await expect(UserService.createUser({ userType: 'teacher', username: 't', password: 'p', name: 'n', student_ids: '999,1000' }, adminReq))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/以下学生ID不存在/) });
    });
    test('成功创建 → 返回领域数据、剥离 password_hash 并审计', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        db.query.mockResolvedValue({ rows: [{ id: 7, password_hash: 'x' }] });
        const data = await UserService.createUser({ userType: 'student', username: 'new', password: 'p', name: 'n' }, adminReq);
        expect(data).toEqual({ id: 7 });
        expect(bcrypt.hash).toHaveBeenCalled();
        expect(recordAudit).toHaveBeenCalled();
    });
});

describe('user-service.updateUser', () => {
    test('用户不存在 → 抛 RESOURCE_NOT_FOUND', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await expect(UserService.updateUser('teacher', 5, { name: 'x' }, adminReq))
            .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '用户不存在' });
    });
    test('无更新字段 → 抛 BAD_REQUEST', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 5 }] });
        await expect(UserService.updateUser('teacher', 5, {}, adminReq))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', message: '无更新字段' });
    });
    test('数据库唯一约束错误原样传播', async () => {
        const error = { code: '23505' };
        db.query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
        db.query.mockRejectedValueOnce(error);
        await expect(UserService.updateUser('teacher', 5, { name: 'x' }, adminReq)).rejects.toBe(error);
    });
    test('成功更新 → 返回领域数据并剥离 password_hash', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
        db.query.mockResolvedValue({ rows: [{ id: 5, password_hash: 'y', name: 'x' }] });
        await expect(UserService.updateUser('teacher', 5, { name: 'x' }, adminReq))
            .resolves.toEqual({ id: 5, name: 'x' });
    });
});

describe('user-service.deleteUser', () => {
    test('非法类型 → 抛 BAD_REQUEST', async () => {
        await expect(UserService.deleteUser('foo', 1, {}, adminReq))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400, message: '无效的用户类型' });
    });
    test('teacher 有关联排课且非级联 → 抛含 referencedSchedules 的 CONFLICT', async () => {
        db.query.mockResolvedValue({ rows: [{ count: 3 }] });
        await expect(UserService.deleteUser('teacher', 9, { cascade: false }, adminReq))
            .rejects.toMatchObject({
                code: 'CONFLICT',
                statusCode: 409,
                details: [expect.objectContaining({ referencedSchedules: 3 })]
            });
    });
    test('teacher 级联删除 → 返回移除 pair / 整场删除的场次数', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ count: 3 }] });
        db.query.mockResolvedValueOnce({ rows: [{ total: 3, whole: 1 }] });
        db.query.mockResolvedValue({ rows: [] });
        const data = await UserService.deleteUser('teacher', 9, { cascade: true }, adminReq);
        expect(data.affectedSessions).toBe(3);
        expect(data.deletedSessions).toBe(1);
        expect(data.message).toMatch(/3 场课移除了该教师，其中 1 场/);
        expect(db.runInTransaction).toHaveBeenCalled();
    });
    test('admin 目标存在且非最后L1 → 返回成功消息并审计', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 3, username: 'op', permission_level: 3 }] });
        db.query.mockResolvedValue({ rows: [] });
        await expect(UserService.deleteUser('admin', 3, {}, adminReq))
            .resolves.toEqual({ message: '用户删除成功' });
        expect(recordAudit).toHaveBeenCalled();
    });
    test('普通删除走事务：删用户与清 AI 偏好同生共死，不留孤儿偏好行', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 3, username: 'op', permission_level: 3 }] });
        db.query.mockResolvedValue({ rows: [] });
        await UserService.deleteUser('admin', 3, {}, adminReq);

        expect(db.runInTransaction).toHaveBeenCalledTimes(1);
        // 必须与删用户共用同一个执行器：若偏好清理走默认 db.query，就落在大事务之外，
        // 删用户与清偏好之间中断仍会留下孤儿行
        expect(aiUserModelStore.purgeUserModel).toHaveBeenCalledWith('admin', 3, expect.any(Function));
    });
    test('数据库外键约束错误原样传播', async () => {
        const error = { code: '23503' };
        db.query.mockResolvedValueOnce({ rows: [{ id: 3, username: 'op', permission_level: 3 }] });
        db.query.mockRejectedValueOnce(error);
        await expect(UserService.deleteUser('admin', 3, {}, adminReq)).rejects.toBe(error);
    });
});
