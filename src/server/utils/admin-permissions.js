/**
 * admin-permissions.js —— 管理员权限级别矩阵（单一权威来源）
 *
 * 权限模型：
 * - 路由门禁决定「能不能用功能」（requireCapability）；
 * - 服务层范围过滤决定「能碰哪些数据」（requiresOwnDataScope / buildScopeClause / canTouchRecord）。
 *
 * 级别语义（与 middleware/role.js 一致，数字越小权限越高）：
 *   L1 SUPER_ADMIN 超级管理员 / L2 ADMIN 普通管理员 / L3 OPERATOR 操作员
 */

const { PERMISSION_LEVELS, requirePermissionLevel } = require('../middleware/role');

// 能力码 → 允许的最大 level 数字
const CAPABILITIES = {
    // 排课域：功能全级别可用；L3 的数据范围由服务层过滤（仅自己创建 + 无主存量）
    'schedules:read': PERMISSION_LEVELS.OPERATOR,
    'schedules:write': PERMISSION_LEVELS.OPERATOR,
    'availability:read': PERMISSION_LEVELS.OPERATOR,
    'availability:write': PERMISSION_LEVELS.OPERATOR,
    'statistics:read': PERMISSION_LEVELS.OPERATOR,
    'conflicts:read': PERMISSION_LEVELS.OPERATOR,
    // 费用域：路由放行到 L3，服务层对 L3 做行级归属校验（单条拒绝 / 批量 all-or-nothing）
    'finance:view': PERMISSION_LEVELS.OPERATOR,
    'finance:write': PERMISSION_LEVELS.OPERATOR,
    // 高级导出：L2+（L3 不可导出）
    'export:advanced': PERMISSION_LEVELS.ADMIN,
    // 用户域：读全级别（字段按敏感度裁剪）；所有账号写操作仅 L1
    'users:read': PERMISSION_LEVELS.OPERATOR,
    'users:write': PERMISSION_LEVELS.SUPER_ADMIN,
    // 系统设置域：课程类型读全员、写仅 L1；假期查询保持登录可读、写操作仅 L1
    'settings:schedule-types:read': PERMISSION_LEVELS.OPERATOR,
    'settings:schedule-types:write': PERMISSION_LEVELS.SUPER_ADMIN,
    'settings:holidays:write': PERMISSION_LEVELS.SUPER_ADMIN,
    // 反馈：提交不设门禁（任何登录用户）；修改/删除/状态变更仅 L1
    'feedback:update': PERMISSION_LEVELS.SUPER_ADMIN,
    // 手动触发定时任务
    'jobs:trigger': PERMISSION_LEVELS.ADMIN
};

// 用户信息字段敏感度分级：
//   public    —— 所有级别可见；
//   internal  —— L1/L2 可见；
//   sensitive —— 仅 L1 可见。
// 未登记字段默认 public（业务新增列不会误伤列表展示）。
const FIELD_SENSITIVITY = {
    id: 'public',
    username: 'public',
    name: 'public',
    nickname: 'public',
    profession: 'public',
    status: 'public',
    student_ids: 'public',
    home_address: 'public',
    work_location: 'public',
    visit_location: 'public',
    contact: 'internal',
    email: 'internal',
    restriction: 'sensitive',
    permission_level: 'sensitive',
    last_login: 'sensitive',
    created_at: 'sensitive'
};

const SENSITIVITY_MAX_LEVEL = {
    public: PERMISSION_LEVELS.OPERATOR,
    internal: PERMISSION_LEVELS.ADMIN,
    sensitive: PERMISSION_LEVELS.SUPER_ADMIN
};

/** 归一化操作者权限级别（缺省视为最低档 L3，安全取向） */
function getActorLevel(user) {
    const lvl = parseInt(user && user.permissionLevel, 10);
    return Number.isInteger(lvl) && lvl >= 1 && lvl <= 3 ? lvl : PERMISSION_LEVELS.OPERATOR;
}

/** 能力码门禁中间件工厂 */
function requireCapability(capability) {
    const maxLevel = CAPABILITIES[capability];
    if (typeof maxLevel !== 'number') {
        throw new Error(`未知能力码: ${capability}`);
    }
    return requirePermissionLevel(maxLevel);
}

/** 判断字段在指定级别下是否可见 */
function canSeeField(field, actorLevel) {
    const tier = FIELD_SENSITIVITY[field] || 'public';
    return actorLevel <= SENSITIVITY_MAX_LEVEL[tier];
}

/**
 * 按操作者级别裁剪列清单（用于动态拼 SELECT）
 * @param {string|string[]} columns - 逗号分隔的列名或数组
 * @returns {string} 过滤后的逗号分隔列名
 */
function visibleColumns(columns, actorLevel) {
    const list = Array.isArray(columns)
        ? columns
        : String(columns).split(',').map(s => s.trim()).filter(Boolean);
    return list.filter(col => canSeeField(String(col).split('.').pop().trim(), actorLevel)).join(', ');
}

/** 对已取出的对象做字段裁剪（纵深防御，配合 visibleColumns 使用） */
function filterObjectByLevel(obj, actorLevel) {
    if (!obj || typeof obj !== 'object') return obj;
    return Object.fromEntries(Object.entries(obj).filter(([key]) => canSeeField(key, actorLevel)));
}

/**
 * L3 数据范围判定：L3 操作员只能触达自己创建的数据（含无主 created_by IS NULL 存量）。
 * @returns {boolean} true 表示该操作者需要行级范围过滤
 */
function requiresOwnDataScope(user) {
    if (!user) return false;
    if (user.userType !== undefined && user.userType !== 'admin') return false;
    return getActorLevel(user) >= PERMISSION_LEVELS.OPERATOR;
}

/**
 * 构造 L3 范围 SQL 片段。非 L3 返回 null（不加过滤）；
 * L3 返回 { clause, param }：调用方把 param 追加进 values 后，将 clause 中 $ACTOR_ID 替换为实际占位序号。
 * @param {object} user - req.user
 * @param {string} alias - course_arrangement 的 SQL 别名，默认 'ca'
 */
function buildScopeClause(user, alias = 'ca') {
    if (!requiresOwnDataScope(user)) return null;
    return {
        clause: `(${alias}.created_by = $ACTOR_ID OR ${alias}.created_by IS NULL)`,
        actorId: user.id
    };
}

/**
 * 行级归属校验：L3 只能修改自己创建或无主的记录；其他级别不受限。
 * @param {*} rowCreatedBy - 目标记录当前 created_by 值
 */
function canTouchRecord(rowCreatedBy, user) {
    if (!requiresOwnDataScope(user)) return true;
    if (rowCreatedBy === null || rowCreatedBy === undefined) return true;
    return Number(rowCreatedBy) === Number(user.id);
}

module.exports = {
    CAPABILITIES,
    FIELD_SENSITIVITY,
    SENSITIVITY_MAX_LEVEL,
    getActorLevel,
    requireCapability,
    canSeeField,
    visibleColumns,
    filterObjectByLevel,
    requiresOwnDataScope,
    buildScopeClause,
    canTouchRecord
};
