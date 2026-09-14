/**
 * admin-permissions 单测：能力码门禁中间件边界 + 字段敏感度分级 + L3 数据范围辅助
 */
const {
    CAPABILITIES,
    FIELD_SENSITIVITY,
    getActorLevel,
    requireCapability,
    canSeeField,
    visibleColumns,
    filterObjectByLevel,
    requiresOwnDataScope,
    buildScopeClause,
    canTouchRecord
} = require('../utils/admin-permissions');

const mockRes = () => {
    const res = { statusCode: null, body: null };
    res.status = jest.fn((code) => { res.statusCode = code; return res; });
    res.json = jest.fn((body) => { res.body = body; return res; });
    return res;
};

describe('能力码矩阵（v6 批准版）', () => {
    test('关键能力码的级别要求正确', () => {
        expect(CAPABILITIES['export:advanced']).toBe(2);
        expect(CAPABILITIES['users:write']).toBe(1);
        expect(CAPABILITIES['feedback:update']).toBe(1);
        expect(CAPABILITIES['settings:holidays:write']).toBe(1);
        expect(CAPABILITIES['settings:schedule-types:write']).toBe(1);
        expect(CAPABILITIES['schedules:read']).toBe(3);
        expect(CAPABILITIES['schedules:write']).toBe(3);
        expect(CAPABILITIES['finance:write']).toBe(3);
        expect(CAPABILITIES['users:read']).toBe(3);
        expect(CAPABILITIES['settings:holidays:read']).toBeUndefined();
    });

    test('未知能力码 → 抛错', () => {
        expect(() => requireCapability('nope:not-exist')).toThrow(/未知能力码/);
    });
});

describe('requireCapability 中间件', () => {
    const mw = requireCapability('export:advanced'); // 需要 L2+

    test('未认证 → AUTH_REQUIRED', () => {
        const res = mockRes();
        const next = jest.fn();
        mw({}, res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({
            code: 'AUTH_REQUIRED',
            statusCode: 401
        }));
        expect(res.status).not.toHaveBeenCalled();
    });

    test('非管理员角色 → FORBIDDEN', () => {
        const res = mockRes();
        const next = jest.fn();
        mw({ user: { id: 1, userType: 'teacher' } }, res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({
            code: 'FORBIDDEN',
            statusCode: 403
        }));
        expect(res.status).not.toHaveBeenCalled();
    });

    test('L3 访问导出 → FORBIDDEN 权限级别不足', () => {
        const res = mockRes();
        const next = jest.fn();
        mw({ user: { id: 9, userType: 'admin', permissionLevel: 3 } }, res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({
            code: 'FORBIDDEN',
            statusCode: 403,
            message: '权限级别不足'
        }));
        expect(res.status).not.toHaveBeenCalled();
    });

    test('L2/L1 访问导出 → 放行', () => {
        const next2 = jest.fn();
        mw({ user: { id: 8, userType: 'admin', permissionLevel: 2 } }, mockRes(), next2);
        expect(next2).toHaveBeenCalled();
        const next1 = jest.fn();
        mw({ user: { id: 7, userType: 'admin', permissionLevel: 1 } }, mockRes(), next1);
        expect(next1).toHaveBeenCalled();
    });

    test('缺失 permissionLevel 视为最低档 L3（安全取向）', () => {
        const res = mockRes();
        const next = jest.fn();
        mw({ user: { id: 6, userType: 'admin' } }, res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({
            code: 'FORBIDDEN',
            statusCode: 403
        }));
        expect(res.status).not.toHaveBeenCalled();
    });
});

describe('字段敏感度分级', () => {
    test('public 字段全员可见（含住址类，按 v4 划定）', () => {
        for (const f of ['home_address', 'work_location', 'visit_location', 'username', 'name', 'status']) {
            expect(canSeeField(f, 3)).toBe(true);
        }
    });

    test('internal 字段仅 L1/L2 可见（contact、email）', () => {
        expect(canSeeField('contact', 2)).toBe(true);
        expect(canSeeField('contact', 3)).toBe(false);
        expect(canSeeField('email', 1)).toBe(true);
        expect(canSeeField('email', 3)).toBe(false);
    });

    test('sensitive 字段仅 L1 可见', () => {
        for (const f of ['restriction', 'permission_level', 'last_login', 'created_at']) {
            expect(canSeeField(f, 1)).toBe(true);
            expect(canSeeField(f, 2)).toBe(false);
            expect(canSeeField(f, 3)).toBe(false);
        }
    });

    test('未登记字段默认 public', () => {
        expect(FIELD_SENSITIVITY['some_future_column']).toBeUndefined();
        expect(canSeeField('some_future_column', 3)).toBe(true);
    });

    test('visibleColumns 按级别裁剪 SELECT 列清单', () => {
        const cols = 'id, username, contact, email, restriction, last_login, home_address';
        expect(visibleColumns(cols, 1)).toBe(cols);
        expect(visibleColumns(cols, 2)).toBe('id, username, contact, email, home_address');
        expect(visibleColumns(cols, 3)).toBe('id, username, home_address');
        // 数组输入与带前缀列名
        expect(visibleColumns(['ca.id', 'ca.contact'], 3)).toBe('ca.id');
    });

    test('filterObjectByLevel 对已取出对象裁剪', () => {
        const row = { id: 1, name: 'x', contact: 'c', last_login: '2026-01-01' };
        expect(filterObjectByLevel(row, 1)).toEqual(row);
        expect(filterObjectByLevel(row, 3)).toEqual({ id: 1, name: 'x' });
    });
});

describe('L3 数据范围辅助', () => {
    test('requiresOwnDataScope 判定', () => {
        expect(requiresOwnDataScope(undefined)).toBe(false);
        expect(requiresOwnDataScope({ userType: 'teacher', id: 1 })).toBe(false);
        expect(requiresOwnDataScope({ userType: 'admin', permissionLevel: 1 })).toBe(false);
        expect(requiresOwnDataScope({ userType: 'admin', permissionLevel: 2 })).toBe(false);
        expect(requiresOwnDataScope({ userType: 'admin', permissionLevel: 3 })).toBe(true);
        expect(requiresOwnDataScope({ userType: 'admin' })).toBe(true); // 缺省视为 L3
    });

    test('buildScopeClause：非 L3 返回 null；L3 返回子句与 actorId', () => {
        expect(buildScopeClause({ userType: 'admin', permissionLevel: 1 })).toBeNull();
        const scope = buildScopeClause({ userType: 'admin', permissionLevel: 3, id: 42 }, 'ca');
        expect(scope.actorId).toBe(42);
        expect(scope.clause).toContain('ca.created_by');
        expect(scope.clause).toContain('$ACTOR_ID');
        expect(scope.clause).toContain('IS NULL');
    });

    test('canTouchRecord：L3 只能触碰自己创建或无主的记录', () => {
        const l3 = { userType: 'admin', permissionLevel: 3, id: 9 };
        expect(canTouchRecord(null, l3)).toBe(true);
        expect(canTouchRecord(undefined, l3)).toBe(true);
        expect(canTouchRecord(9, l3)).toBe(true);
        expect(canTouchRecord('9', l3)).toBe(true);
        expect(canTouchRecord(8, l3)).toBe(false);
        const l1 = { userType: 'admin', permissionLevel: 1, id: 1 };
        expect(canTouchRecord(999, l1)).toBe(true); // L1 不受限
    });

    test('getActorLevel 边界归一化', () => {
        expect(getActorLevel(null)).toBe(3);
        expect(getActorLevel({})).toBe(3);
        expect(getActorLevel({ permissionLevel: 0 })).toBe(3);
        expect(getActorLevel({ permissionLevel: 9 })).toBe(3);
        expect(getActorLevel({ permissionLevel: 1 })).toBe(1);
        expect(getActorLevel({ permissionLevel: '2' })).toBe(2);
    });
});
