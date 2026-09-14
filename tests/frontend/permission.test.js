/**
 * 权限落地（Phase 3）前端单测：permission.js
 * node 环境（无 jsdom），手工桩 window/localStorage/document。
 */

// ---- 浏览器全局桩（须在 require 目标模块前就位）----
const memStore = new Map();
global.localStorage = {
    getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
    setItem: (k, v) => memStore.set(k, String(v)),
    removeItem: (k) => memStore.delete(k)
};
global.window = { localStorage: global.localStorage };
const createdGates = [];
global.document = {
    querySelectorAll: () => createdGates,
    getElementById: () => null
};

const setLevel = (lvl) => {
    if (lvl === null) memStore.delete('userData');
    else memStore.set('userData', JSON.stringify(lvl === 'bad' ? '{oops' : { id: 1, userType: 'admin', permission_level: lvl }));
};

const pu = (() => {
    require('../../public/js/utils/permission.js');
    return global.window.permissionUtils;
})();

beforeEach(() => {
    createdGates.length = 0;
});

describe('getLevel：级别解析与缺省安全取向', () => {
    test.each([
        ['未设置 userData', null, 3],
        ['非法 JSON', 'bad', 3],
        ['越界 0', 0, 3],
        ['越界 9', 9, 3],
        ['L1', 1, 1],
        ['L2', 2, 2]
    ])('%s → %i', (_name, input, expected) => {
        setLevel(input);
        expect(pu.getLevel()).toBe(expected);
    });
});

describe('isSuperAdmin / atLeast', () => {
    test('仅 L1 是超管', () => {
        setLevel(1);
        expect(pu.isSuperAdmin()).toBe(true);
        setLevel(2);
        expect(pu.isSuperAdmin()).toBe(false);
        setLevel(null);
        expect(pu.isSuperAdmin()).toBe(false);
    });

    test('atLeast 边界（数字越小权限越高）', () => {
        setLevel(2);
        expect(pu.atLeast(2)).toBe(true);
        expect(pu.atLeast(1)).toBe(false);
        expect(pu.atLeast(3)).toBe(true);
    });
});

describe('canSeeSection：导航区块最低级别映射', () => {
    test.each([
        ['users 对 L3 隐藏', 'users', 3, false],
        ['users 对 L2 可见', 'users', 2, true],
        ['system-settings 对 L2 隐藏', 'system-settings', 2, false],
        ['system-settings 对 L1 可见', 'system-settings', 1, true],
        ['overview 全员可见', 'overview', 3, true],
        ['finance 对 L3 可见（数据范围由后端过滤）', 'finance', 3, true],
        ['未知区块默认可见', 'unknown-section', 3, true]
    ])('%s', (_name, section, lvl, expected) => {
        setLevel(lvl);
        expect(pu.canSeeSection(section)).toBe(expected);
    });
});

describe('visibleFields：字段敏感度裁剪（与后端 FIELD_SENSITIVITY 对齐）', () => {
    const cols = ['id', 'username', 'contact', 'email', 'restriction', 'last_login', 'home_address'];

    test('L1 全字段', () => {
        setLevel(1);
        expect(pu.visibleFields(cols)).toEqual(cols);
    });

    test('L2 剔除 sensitive，保留 internal/public', () => {
        setLevel(2);
        expect(pu.visibleFields(cols)).toEqual(['id', 'username', 'contact', 'email', 'home_address']);
    });

    test('L3 仅 public 字段', () => {
        setLevel(3);
        expect(pu.visibleFields(cols)).toEqual(['id', 'username', 'home_address']);
    });

    test('未登记字段默认 public', () => {
        setLevel(3);
        expect(pu.canSeeField('some_future_column')).toBe(true);
    });
});

describe('applyPermissionGating：data-min-level 批量显隐', () => {
    const makeEl = (min) => {
        const el = { dataset: { minLevel: String(min) }, style: {}, permissionHidden: undefined };
        createdGates.push(el);
        return el;
    };

    test('低于门槛的元素被隐藏并打标', () => {
        setLevel(3);
        const usersNav = makeEl(2);
        const settingsNav = makeEl(1);
        pu.applyPermissionGating();
        expect(usersNav.style.display).toBe('none');
        expect(usersNav.dataset.permissionHidden).toBe('1');
        expect(settingsNav.style.display).toBe('none');
    });

    test('达到门槛的元素不受影响', () => {
        setLevel(2);
        const usersNav = makeEl(2);
        const overviewNav = makeEl(3);
        pu.applyPermissionGating();
        expect(usersNav.style.display).toBeUndefined();
        expect(overviewNav.style.display).toBeUndefined();
    });
});
