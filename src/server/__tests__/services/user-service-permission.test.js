/**
 * 权限落地（Phase 1）单测：user-service 防提权四规则 + 字段三级裁剪
 */
const db = require('../../db/db');
const { recordAudit } = require('../../middleware/audit');
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

const l1 = { user: { id: 1, userType: 'admin', permissionLevel: 1 } };
const l2 = { user: { id: 2, userType: 'admin', permissionLevel: 2 } };
const l3 = { user: { id: 3, userType: 'admin', permissionLevel: 3 } };

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
});

describe('防提权①：所有账号写操作仅 L1（服务层纵深防御）', () => {
    test.each([
        ['createUser', () => UserService.createUser({ userType: 'student', username: 'a', password: 'p', name: 'n' }, l2)],
        ['updateUser', () => UserService.updateUser('teacher', 5, { name: 'x' }, l2)],
        ['deleteUser', () => UserService.deleteUser('teacher', 5, {}, l2)],
        ['getNextUserId', () => UserService.getNextUserId('student', l2)]
    ])('L2 调用 %s → 抛 403 仅限超级管理员', async (_name, fn) => {
        await expect(fn()).rejects.toMatchObject({
            code: 'FORBIDDEN',
            statusCode: 403,
            message: expect.stringMatching(/仅限超级管理员/)
        });
    });

    test.each([
        ['createUser', () => UserService.createUser({ userType: 'student' }, l3)],
        ['updateUser', () => UserService.updateUser('teacher', 5, {}, l3)],
        ['deleteUser', () => UserService.deleteUser('teacher', 5, {}, l3)],
        ['getNextUserId', () => UserService.getNextUserId('student', l3)]
    ])('L3 调用 %s → 抛 403', async (_name, fn) => {
        await expect(fn()).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    });

    test('L1 正常创建学生 → 返回领域数据', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // 用户名查重
        db.query.mockResolvedValue({ rows: [{ id: 7 }] }); // INSERT
        await expect(UserService.createUser({ userType: 'student', username: 'n', password: 'p', name: 'n' }, l1))
            .resolves.toEqual({ id: 7 });
    });

    test('L1 获取 next-id → 返回号段内 MAX(id)+1', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ next_id: 3042 }] });
        await expect(UserService.getNextUserId('student', l1)).resolves.toEqual({ nextId: 3042 });
    });

    test('号段内空表时 next-id 兜底为号段起点 3000', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ next_id: 3000 }] });
        await expect(UserService.getNextUserId('student', l1)).resolves.toEqual({ nextId: 3000 });
    });
});

describe('防提权③：不可自我改级 / 改敏感字段；本人可改 name/nickname/email', () => {
    test('L1 修改自己的 permission_level → 抛 403', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, username: 'boss', permission_level: 1 }] });
        await expect(UserService.updateUser('admin', 1, { permission_level: 2 }, l1))
            .rejects.toMatchObject({ code: 'FORBIDDEN', message: '不能修改自己的权限级别' });
    });

    test('L1 修改自己的 username → 抛 403', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, username: 'boss', permission_level: 1 }] });
        await expect(UserService.updateUser('admin', 1, { username: 'hacked' }, l1))
            .rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/username/) });
    });

    test('L1 修改自己的密码 → 抛 403', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, username: 'boss', permission_level: 1 }] });
        await expect(UserService.updateUser('admin', 1, { password: 'newpwd' }, l1))
            .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    });

    test('L1 编辑自己：表单回显同值 username/permission_level 不应误伤，仅更新 name', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 1, username: 'boss', permission_level: 1 }] })
            .mockResolvedValueOnce({ rows: [{ id: 1, name: '新名' }] });
        const data = await UserService.updateUser('admin', 1,
            { username: 'boss', permission_level: 1, name: '新名' }, l1);
        expect(data.name).toBe('新名');
    });

    test('L1 修改自己的 name/nickname/email → 200 且审计记录', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 1, username: 'boss', permission_level: 1 }] }) // fetchAdminTarget
            .mockResolvedValueOnce({ rows: [{ id: 1, name: '新名' }] }); // UPDATE RETURNING
        const data = await UserService.updateUser('admin', 1, { name: '新名', nickname: '超管', email: 'a@b.co' }, l1);
        expect(data.name).toBe('新名');
        expect(recordAudit).toHaveBeenCalled();
    });

    test('L1 删除自己 → 抛 403', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 1, username: 'boss', permission_level: 1 }] });
        await expect(UserService.deleteUser('admin', 1, {}, l1))
            .rejects.toMatchObject({ code: 'FORBIDDEN', message: '不能删除自己的账号' });
    });
});

describe('防提权②④：授予边界与最后超管保护', () => {
    test('降级最后一个 L1 → 403 系统必须保留至少一个超级管理员', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 2, username: 'other', permission_level: 1 }] }) // fetchAdminTarget
            .mockResolvedValueOnce({ rows: [{ count: 1 }] }); // COUNT(permission_level=1)
        await expect(UserService.updateUser('admin', 2, { permission_level: 2 }, l1))
            .rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/至少一个超级管理员/) });
    });

    test('存在多个 L1 时可降级 → 200 + 审计含 old/new', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 2, username: 'other', permission_level: 1 }] })
            .mockResolvedValueOnce({ rows: [{ count: 2 }] })
            .mockResolvedValueOnce({ rows: [{ id: 2, permission_level: 2 }] }); // UPDATE RETURNING
        const data = await UserService.updateUser('admin', 2, { permission_level: 2 }, l1);
        expect(data.permission_level).toBe(2);
        const auditCall = recordAudit.mock.calls.find(([reqArg, payload]) => payload.details && payload.details.permission_change);
        expect(auditCall[1].details.permission_change).toEqual({ from: 1, to: 2 });
    });

    test('删除最后一个 L1 → 403', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 2, username: 'other', permission_level: 1 }] })
            .mockResolvedValueOnce({ rows: [{ count: 1 }] });
        await expect(UserService.deleteUser('admin', 2, {}, l1))
            .rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/无法删除/) });
    });

    test('删除普通 L3 操作员 → 200', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 5, username: 'op', permission_level: 3 }] })
            .mockResolvedValue({ rows: [] }); // DELETE
        await expect(UserService.deleteUser('admin', 5, {}, l1))
            .resolves.toEqual({ message: '用户删除成功' });
    });
});

describe('用户信息字段三级裁剪（SELECT 列在服务端下发前过滤）', () => {
    const teacherCols = 'id, username, name, nickname, profession, contact, work_location, home_address, restriction, student_ids, status, last_login, created_at';

    function selectSqlOf() {
        return db.query.mock.calls[0][0];
    }

    test('L1 可见全字段（含 restriction/last_login/created_at）', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 1 }] });
        await UserService.listUsers('teacher', {}, l1);
        const sql = selectSqlOf();
        for (const col of ['restriction', 'last_login', 'created_at', 'contact', 'home_address']) {
            expect(sql).toContain(col);
        }
    });

    test('L2 剔除 sensitive（restriction/last_login/created_at），保留 internal/public', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 1 }] });
        await UserService.listUsers('teacher', {}, l2);
        const sql = selectSqlOf();
        expect(sql).not.toContain('restriction');
        expect(sql).not.toContain('last_login');
        expect(sql).not.toContain('created_at');
        expect(sql).toContain('contact');
        expect(sql).toContain('home_address');
    });

    test('L3 仅 public 字段', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 1 }] });
        await UserService.listUsers('teacher', {}, l3);
        const sql = selectSqlOf();
        expect(sql).toContain('username');
        expect(sql).toContain('home_address');
        expect(sql).not.toContain('contact');
        expect(sql).not.toContain('restriction');
    });

    test('详情接口同样裁剪（getUserById）', async () => {
        db.query.mockResolvedValue({ rows: [{ id: 9, contact: 'x', last_login: 'y' }] });
        const data = await UserService.getUserById('teacher', 9, l3);
        expect(data.contact).toBeUndefined();
        expect(data.last_login).toBeUndefined();
        expect(data.id).toBe(9);
    });
});
