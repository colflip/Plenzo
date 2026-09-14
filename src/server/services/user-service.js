/**
 * user-service.js —— 用户子域业务逻辑层（D1-6）
 *
 * 从 admin-controller 下沉的「用户管理」纯业务逻辑：列表 / 详情 / 创建 / 更新 / 删除
 * （含密码哈希、字段白名单过滤、student_ids 归属校验、可选主键变更、级联删除）。
 *
 * 设计约定（与 holiday-service / fee-service 一致）：
 * - 直接 require 单例 `db` / `bcrypt` / `SchemaHelper` / `recordAudit`（jest 全局 mock 仍生效）；
 * - 返回契约（D1）：只返回领域数据；业务错误抛 AppError，由 controller 统一封装 HTTP 响应；
 * - 未识别的异常（含唯一约束 23505、外键约束 23503）原样上抛，交给全局 errorHandler 统一归类，
 *   服务层不再各自把 SQLSTATE 翻译成状态码（两处翻译曾给出不一致的状态码）。
 */

const db = require('../db/db');
const bcrypt = require('bcrypt');
const { recordAudit } = require('../middleware/audit');
const SchemaHelper = require('../utils/schema-helper');
const { AppError } = require('../middleware/error');
const { PERMISSION_LEVELS } = require('../middleware/role');
const courseSessionService = require('./course-session-service');
const aiUserModelStore = require('./ai-user-model-store');
const { getActorLevel, visibleColumns, filterObjectByLevel } = require('../utils/admin-permissions');

const TABLES = { admin: 'administrators', teacher: 'teachers', student: 'students' };
const ROLE_LABELS = { admin: '管理员', teacher: '教师', student: '学生' };

const BASE_COLUMNS = {
    admin: 'id, username, name, nickname, email, permission_level, last_login, created_at',
    teacher: 'id, username, name, nickname, profession, contact, work_location, home_address, restriction, student_ids, last_login, created_at',
    student: 'id, username, name, nickname, profession, contact, visit_location, home_address, last_login, created_at'
};

const ALLOWED_ADDITIONAL = {
    admin: ['permission_level', 'nickname'],
    teacher: ['profession', 'contact', 'work_location', 'home_address', 'status', 'restriction', 'student_ids', 'nickname'],
    student: ['profession', 'contact', 'visit_location', 'home_address', 'status', 'nickname']
};

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/i;

// 各角色的 ID 号段（新用户生成与手工指定 ID 都限制在号段内；历史 ID 不迁移，允许号段外存量存在）
// 号段彼此互不重叠，配合下方 assertIdFreeAcrossRoles 保证同一数值 ID 不会同时属于两个角色
const ID_RANGES = { admin: [100, 999], teacher: [2000, 2999], student: [3000, 3999] };

function idRangeHint(userType) {
    const [lo, hi] = ID_RANGES[userType] || [0, 0];
    return `${lo}-${hi}`;
}

function inIdRange(userType, id) {
    const [lo, hi] = ID_RANGES[userType] || [0, 0];
    return Number.isInteger(id) && id >= lo && id <= hi;
}

const DEFAULT_PAGE_SIZE = 50;
// 上限从 200 放宽到 1000：前端下拉/复选列表需要「一次取全量」
// （user-manager 的 `/admin/users/student?limit=1000` 就是这种用法），
// 旧的 200 上限会在条数超过 200 时静默截断，用户看不到任何提示。
const MAX_PAGE_SIZE = 1000;

/**
 * 主键守卫：三个角色的主键列都是整型，非数字 ID（如 `t1`）会让 PG 抛 22P02
 * invalid_text_representation，被控制器 catch 后报成 500「获取用户详情失败」。
 * 参数问题不该表现为服务端故障，这里提前拦成 400。
 */
function assertValidId(id) {
    const raw = (id === undefined || id === null) ? '' : String(id);
    if (!/^\d+$/.test(raw)) {
        throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '无效的用户 ID' });
    }
}

/**
 * 跨角色 ID 占用检查：目标 ID 不得已被其他角色占用。
 * 三个号段本不重叠，此检查兜住两类历史遗留：号段外存量 ID（如教师旧 1xxx 段）与
 * 手工指定的越界 ID —— 若不加它，教师取 2000 而学生恰好也有 2000 时，
 * 多态列（operator_id/submitter_id）只靠 role 列消歧，极易在排查时看错人。
 * 返回命中的角色名，无冲突返回 null。
 */
async function findCrossRoleConflict(userType, id, client = null) {
    const q = client ? client.query.bind(client) : db.query.bind(db);
    const others = Object.keys(TABLES).filter(t => t !== userType);
    for (const role of others) {
        const res = await q(`SELECT username FROM ${TABLES[role]} WHERE id = $1 LIMIT 1`, [Number(id)]);
        if (normalizeRows(res).length > 0) return role;
    }
    return null;
}

function resolveTable(userType) {
    return TABLES[userType] || null;
}

function filterAdditional(additionalInfo, userType) {
    const allowed = ALLOWED_ADDITIONAL[userType] || [];
    return Object.fromEntries(Object.entries(additionalInfo || {}).filter(([k]) => allowed.includes(k)));
}

function normalizeRows(result) {
    if (!result) return [];
    if (Array.isArray(result)) return result;
    return (result.rows && Array.isArray(result.rows)) ? result.rows : [];
}

/** 权限落地（Phase 1）：所有账号写操作仅 L1，级别不足即抛 403 */
function assertSuperAdmin(req) {
    const actorLevel = getActorLevel(req && req.user);
    if (actorLevel !== PERMISSION_LEVELS.SUPER_ADMIN) {
        throw new AppError({ code: 'FORBIDDEN', statusCode: 403, message: '权限级别不足：账号管理操作仅限超级管理员(L1)' });
    }
}

/** 查询管理员目标行（含 permission_level，供自我保护与最后超管保护判定） */
async function fetchAdminTarget(id) {
    const res = await db.query('SELECT id, username, permission_level FROM administrators WHERE id = $1', [id]);
    return normalizeRows(res)[0] || null;
}

/** 列出某类型用户（分页 + 动态列 status/nickname 探测 + 按操作者级别裁剪敏感字段） */
async function listUsers(userType, { page, size, limit } = {}, req) {
    const table = resolveTable(userType);
    if (!table) throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '无效的用户类型' });

    let selectColumns = BASE_COLUMNS[userType];
    const pageNum = Math.max(1, parseInt(page) || 1);
    // size 是规范名，limit 是历史别名：前端仍有 `?limit=1000` 的调用，
    // 只认 size 会让它悄悄退回默认 50 条。两者同时接受。
    const rawSize = (size === undefined || size === '') ? limit : size;
    const sizeNum = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(rawSize) || DEFAULT_PAGE_SIZE));
    const offset = (pageNum - 1) * sizeNum;

    if (await SchemaHelper.hasColumn(table, 'status')) {
        selectColumns = selectColumns.replace('last_login, created_at', 'status, last_login, created_at');
    }
    if (!(await SchemaHelper.hasColumn(table, 'nickname'))) {
        selectColumns = selectColumns.replace(', nickname', '');
    }

    // 权限落地：按操作者级别裁剪 internal/sensitive 字段（数据在服务端不下发）
    const actorLevel = getActorLevel(req && req.user);
    selectColumns = visibleColumns(selectColumns, actorLevel);

    const result = await db.query(
        `SELECT ${selectColumns} FROM ${table} ORDER BY id ASC LIMIT $1 OFFSET $2`,
        [sizeNum, offset]
    );
    const rows = normalizeRows(result).map(row => filterObjectByLevel(row, actorLevel));
    return rows;
}

/** 获取单个用户详情（teacher/student 才探测 status 列，与原逻辑一致；按操作者级别裁剪字段） */
async function getUserById(userType, id, req) {
    const table = resolveTable(userType);
    if (!table) throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '无效的用户类型' });
    assertValidId(id);

    let selectColumns = BASE_COLUMNS[userType];
    try {
        if (table === 'teachers' || table === 'students') {
            if (await SchemaHelper.hasColumn(table, 'status')) {
                selectColumns = selectColumns.replace('last_login, created_at', 'status, last_login, created_at');
            }
        }
        if (!(await SchemaHelper.hasColumn(table, 'nickname'))) {
            selectColumns = selectColumns.replace(', nickname', '');
        }
    } catch (_) { /* 探测失败静默回退 */ }

    const actorLevel = getActorLevel(req && req.user);
    selectColumns = visibleColumns(selectColumns, actorLevel);

    const result = await db.query(`SELECT ${selectColumns} FROM ${table} WHERE id = $1`, [id]);
    const rows = normalizeRows(result);
    if (!rows[0]) throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '用户不存在' });
    return filterObjectByLevel(rows[0], actorLevel);
}

/**
 * 取该类型下一个可用主键（MAX(id)+1），供新增表单预填默认 ID。
 * 走数据库而不是前端分页缓存：缓存只有一页，超过一页后 max 会偏小并撞上已存在的 ID。
 */
async function getNextUserId(userType, req) {
    // 仅 L1 会新增账号，因此与写操作同一道门禁，不额外扩大信息面
    assertSuperAdmin(req);

    const table = resolveTable(userType);
    if (!table) throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '无效的用户类型' });

    // 号段内取 max：号段外的历史 ID（如教师旧 1xxx 段）不参与计算
    const [lo, hi] = ID_RANGES[userType];
    const result = await db.query(
        `SELECT COALESCE(MAX(id), $1 - 1) + 1 AS next_id FROM ${table} WHERE id BETWEEN $1 AND $2`,
        [lo, hi]
    );
    const row = normalizeRows(result)[0];
    const nextId = Math.max(lo, Number(row && row.next_id) || lo);
    return { nextId };
}

/** 创建用户（含密码哈希、字段白名单、student_ids 归属校验、用户名/ID 占用检查、审计） */
async function createUser(payload, req) {
    // 权限落地：所有账号写操作仅 L1
    assertSuperAdmin(req);

    const { userType, username, password, name, email, id, ...additionalInfo } = payload || {};
    const table = resolveTable(userType);
    if (!table) throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '无效的用户类型' });

    if (!username || !password || !name) {
        throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '缺少必要字段：username, password, name' });
    }

    if (userType === 'admin') {
        const lvl = parseInt(additionalInfo.permission_level, 10);
        if (!Number.isInteger(lvl) || lvl < 1 || lvl > 3) {
            throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '权限级别必须在1到3之间' });
        }
        // 防提权②：不能创建比自己权限级别更高的账号（数字更小即权力更大）
        const actorLevel = getActorLevel(req && req.user);
        if (lvl < actorLevel) {
            throw new AppError({ code: 'FORBIDDEN', statusCode: 403, message: '不能创建比自己权限级别更高的账号' });
        }
        additionalInfo.permission_level = lvl;
        if (!email) throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '管理员必须提供 email' });
        if (!EMAIL_RE.test(email)) throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '邮箱格式不合法' });
    }

    const filteredAdditional = filterAdditional(additionalInfo, userType);

    // 验证 student_ids 并规范化为逗号分隔字符串
    if (userType === 'teacher' && filteredAdditional.student_ids) {
        const idsArr = String(filteredAdditional.student_ids).split(',').map(sId => parseInt(sId.trim(), 10)).filter(sId => !isNaN(sId));
        if (idsArr.length > 0) {
            const checkRes = await db.query(`SELECT id FROM students WHERE id = ANY($1)`, [idsArr]);
            const existingIds = normalizeRows(checkRes).map(r => Number(r.id));
            const missingIds = idsArr.filter(sId => !existingIds.includes(Number(sId)));
            if (missingIds.length > 0) {
                throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: `以下学生ID不存在: ${missingIds.join(', ')}` });
            }
            filteredAdditional.student_ids = existingIds.join(',');
        } else {
            filteredAdditional.student_ids = null;
        }
    } else if (userType === 'teacher') {
        filteredAdditional.student_ids = null;
    }

    // 若表不存在某些列则忽略，防止 SQL 错误
    // （列存在性经 SchemaHelper 探测并缓存，一次请求内同键不重复打 information_schema）
    try {
        for (const f of ['status', 'student_ids', 'nickname']) {
            if (Object.prototype.hasOwnProperty.call(filteredAdditional, f) && !(await SchemaHelper.hasColumn(table, f))) {
                delete filteredAdditional[f];
            }
        }
    } catch (_) { /* 静默处理探测错误 */ }

    // 用户名查重（与 ID 占用检查、student_ids 归属、写入互不依赖，并发省 2 次往返）
    const [existingUser, existingIdRow] = await Promise.all([
        db.query(`SELECT id FROM ${table} WHERE username = $1`, [username]),
        id ? db.query(`SELECT id FROM ${table} WHERE id = $1`, [id]) : Promise.resolve({ rows: [] })
    ]);
    if (normalizeRows(existingUser).length > 0) {
        // 用户名冲突与 ID 冲突同属唯一性冲突：原先这里给 400、改主键路径给 409，前端要按两套状态码分支
        throw new AppError({ code: 'CONFLICT', statusCode: 409, message: '用户名已存在' });
    }
    // 自定义 ID：必须落在该角色号段内
    if (id && !inIdRange(userType, Number(id))) {
        throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: `ID 必须在 ${idRangeHint(userType)} 之间` });
    }
    // 自定义 ID 占用检查
    if (normalizeRows(existingIdRow).length > 0) {
        throw new AppError({ code: 'CONFLICT', statusCode: 409, message: '该用户 ID 已被占用' });
    }
    // 自定义 ID 不得与其他角色的现存 ID 重号（跨角色同号会让多态列只靠 role 消歧）
    if (id) {
        const clashRole = await findCrossRoleConflict(userType, id);
        if (clashRole) {
            throw new AppError({ code: 'CONFLICT', statusCode: 409, message: `该 ID 已被${ROLE_LABELS[clashRole]}占用（${idRangeHint(clashRole)} 号段），请换一个` });
        }
    }

    let createdUser = null;
    // allowDegraded：事务体只有一条 INSERT，再加一条失败不阻断的审计；
    // 降级后最坏情况是「用户建好了但审计缺失」，不会留下半截数据。
    await db.runInTransaction(async (client, usePool) => {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        const columns = ['username', 'password_hash', 'name'];
        const values = [username, passwordHash, name];
        const placeholders = ['$1', '$2', '$3'];
        let idx = 4;

        if (id) { columns.push('id'); values.push(id); placeholders.push(`$${idx++}`); }
        if (userType === 'admin') { columns.push('email'); values.push(email); placeholders.push(`$${idx++}`); }
        for (const [key, value] of Object.entries(filteredAdditional)) {
            columns.push(key); values.push(value); placeholders.push(`$${idx++}`);
        }

        const insertSql = `
            INSERT INTO ${table} (${columns.join(', ')})
            VALUES (${placeholders.join(', ')})
            RETURNING *
        `;
        const q = usePool ? db.query : client.query.bind(client);
        const result = await q(insertSql, values);
        const rows = normalizeRows(result);
        if (rows[0]) {
            delete rows[0].password_hash;
            delete rows[0].password;
        }
        createdUser = rows[0];
        try {
            await recordAudit(req, { op: 'create', entityType: userType, entityId: rows[0] && rows[0].id, details: { username, name, email, custom_id: id } });
        } catch (_) { /* 审计失败不阻断 */ }
    }, { allowDegraded: true });

    return createdUser;
}

/** 更新用户（含密码重置、字段白名单、可选主键变更、唯一约束冲突映射为 409） */
async function updateUser(userType, id, payload, req) {
    // 权限落地：所有账号写操作仅 L1
    assertSuperAdmin(req);

    const { username, name, email, new_id, password, ...additionalInfo } = payload || {};
    const table = resolveTable(userType);
    if (!table) throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '无效的用户类型' });
    assertValidId(id);

    const actorLevel = getActorLevel(req && req.user);
    const actorId = req.user ? req.user.id : null;
    const isSelf = target => target && actorId !== null && Number(target.id) === Number(actorId);

    // 管理员目标：预取当前行，用于自我保护与最后超管保护判定
    let targetAdmin = null;
    let oldPermissionLevel = null;
    if (userType === 'admin') {
        targetAdmin = await fetchAdminTarget(id);
        if (!targetAdmin) throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '用户不存在' });
        oldPermissionLevel = Number(targetAdmin.permission_level);
    } else {
        const existingUser = await db.query(`SELECT id FROM ${table} WHERE id = $1`, [id]);
        if (normalizeRows(existingUser).length === 0) {
            throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '用户不存在' });
        }
    }

    let newPermissionLevel = null;
    if (userType === 'admin' && Object.prototype.hasOwnProperty.call(additionalInfo, 'permission_level')) {
        const lvl = parseInt(additionalInfo.permission_level, 10);
        if (!Number.isInteger(lvl) || lvl < 1 || lvl > 3) {
            throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '权限级别必须在1到3之间' });
        }
        // 防提权③：不可修改自己的权限级别；与现值相同的无操作回显直接忽略
        if (isSelf(targetAdmin)) {
            if (lvl !== oldPermissionLevel) {
                throw new AppError({ code: 'FORBIDDEN', statusCode: 403, message: '不能修改自己的权限级别' });
            }
            delete additionalInfo.permission_level;
        } else {
            // 防提权②：不能授予比自己级别更高的权力（数字更小即权力更大）
            if (lvl < actorLevel) {
                throw new AppError({ code: 'FORBIDDEN', statusCode: 403, message: '不能授予比自己权限级别更高的权限' });
            }
            // 防提权④：最后一个超级管理员不可被降级
            if (oldPermissionLevel === PERMISSION_LEVELS.SUPER_ADMIN && lvl !== PERMISSION_LEVELS.SUPER_ADMIN) {
                const l1Res = normalizeRows(await db.query(
                    'SELECT COUNT(*)::int AS count FROM administrators WHERE permission_level = $1',
                    [PERMISSION_LEVELS.SUPER_ADMIN]
                ))[0];
                if ((l1Res ? Number(l1Res.count) : 0) <= 1) {
                    throw new AppError({ code: 'FORBIDDEN', statusCode: 403, message: '系统必须保留至少一个超级管理员(L1)，无法降级' });
                }
            }
            newPermissionLevel = lvl;
            additionalInfo.permission_level = lvl;
        }
    }

    // 防提权③：本人仅可修改自己的 name/nickname/email；
    // username/new_id 仅在值实际变化时拒绝（表单回显同值不算），密码一律禁止自改
    if (isSelf(targetAdmin)) {
        const forbidden = [];
        if (typeof username !== 'undefined' && String(username) !== String(targetAdmin.username)) forbidden.push('username');
        if (typeof new_id !== 'undefined' && String(new_id) !== String(id)) forbidden.push('new_id');
        if (typeof password !== 'undefined' && password !== null && password !== '') forbidden.push('password');
        if (forbidden.length > 0) {
            throw new AppError({ code: 'FORBIDDEN', statusCode: 403, message: `不能修改自己的${forbidden.join('/')}，请联系其他超级管理员操作` });
        }
        // 回显的同值 username 允许通过（等值更新无害），实际变化已在上方拦截
    }

    const filteredAdditional = filterAdditional(additionalInfo, userType);

    // 验证 student_ids 并规范化（保留 teacher 清空分支）
    if (userType === 'teacher' && filteredAdditional.student_ids) {
        const idsArr = String(filteredAdditional.student_ids).split(',').map(s => parseInt(s.trim(), 10)).filter(s => !isNaN(s));
        if (idsArr.length > 0) {
            const checkRes = await db.query(`SELECT id FROM students WHERE id = ANY($1)`, [idsArr]);
            const existingIds = normalizeRows(checkRes).map(r => Number(r.id));
            const missingIds = idsArr.filter(s => !existingIds.includes(Number(s)));
            if (missingIds.length > 0) {
                throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: `以下学生ID不存在: ${missingIds.join(', ')}` });
            }
            filteredAdditional.student_ids = existingIds.join(',');
        } else {
            filteredAdditional.student_ids = null;
        }
    } else if (userType === 'teacher' && Object.prototype.hasOwnProperty.call(additionalInfo, 'student_ids')) {
        filteredAdditional.student_ids = null;
    }

    // 列存在性探测（teacher 的 student_ids 豁免，确保存入）
    try {
        for (const f of ['status', 'student_ids', 'nickname']) {
            if (userType === 'teacher' && f === 'student_ids') continue;
            if (Object.prototype.hasOwnProperty.call(filteredAdditional, f) && !(await SchemaHelper.hasColumn(table, f))) {
                delete filteredAdditional[f];
            }
        }
    } catch (_) { /* 静默处理探测错误 */ }

    const updates = [];
    const values = [];
    let idx = 1;

    if (typeof password !== 'undefined' && password !== null && password !== '') {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        updates.push(`password_hash = $${idx}`); values.push(passwordHash); idx++;
    }
    if (typeof username !== 'undefined') { updates.push(`username = $${idx}`); values.push(username); idx++; }
    if (typeof name !== 'undefined') { updates.push(`name = $${idx}`); values.push(name); idx++; }

    let needIdChange = false;
    let newIdInt = null;
    if (typeof new_id !== 'undefined' && String(new_id) !== String(id)) {
        needIdChange = true; newIdInt = parseInt(new_id, 10);
        if (!inIdRange(userType, newIdInt)) {
            throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: `新 ID 必须在 ${idRangeHint(userType)} 之间` });
        }
    }

    if (userType === 'admin' && typeof email !== 'undefined') {
        if (!EMAIL_RE.test(email)) throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '邮箱格式不合法' });
        updates.push(`email = $${idx}`); values.push(email); idx++;
    }

    for (const [key, value] of Object.entries(filteredAdditional)) {
        updates.push(`${key} = $${idx}`); values.push(value); idx++;
    }

    if (updates.length === 0 && !needIdChange) {
        throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '无更新字段' });
    }

    // 改主键必须在同一事务里同步无外键引用（排课 JSONB pair、班主任 student_ids CSV、
    // feedbacks.submitter_id），否则 UPDATE id 后引用静默变孤儿。
    const idSyncTasks = needIdChange ? buildIdSyncTasks(userType, Number(id), newIdInt) : [];

    if (needIdChange) {
        const checkNewId = await db.query(`SELECT id FROM ${table} WHERE id = $1`, [newIdInt]);
        if (normalizeRows(checkNewId).length > 0) {
            throw new AppError({ code: 'CONFLICT', statusCode: 409, message: '修改失败：用户名或新ID已被占用' });
        }
        // 新 ID 不得与其他角色的现存 ID 重号（改主键最容易把两个角色搅在一起的地方）
        const clashRole = await findCrossRoleConflict(userType, newIdInt);
        if (clashRole) {
            throw new AppError({ code: 'CONFLICT', statusCode: 409, message: `新 ID 已被${ROLE_LABELS[clashRole]}占用（${idRangeHint(clashRole)} 号段），请换一个` });
        }
    }

    let query = '';
    if (updates.length > 0) {
        if (needIdChange) { updates.push(`id = $${idx}`); values.push(newIdInt); idx++; }
        values.push(id);
        query = `UPDATE ${table} SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`;
    } else if (needIdChange) {
        values.push(newIdInt); values.push(id);
        query = `UPDATE ${table} SET id = $1 WHERE id = $2 RETURNING *`;
    }

    const execUpdate = (q) => q(query, values);

    let rows;
    // 唯一约束冲突（23505）不在此处捕获：原样上抛，由 errorHandler 统一映射成 409 CONFLICT
    if (needIdChange) {
        await db.runInTransaction(async (client, usePool) => {
            const q = usePool ? db.query : client.query.bind(client);
            const result = await execUpdate(q);
            rows = normalizeRows(result);
            for (const task of idSyncTasks) {
                await task(q);
            }
        });   // 不降级：改 ID 要同步改写关联表，半途中止会留下指向旧 ID 的孤儿引用
    } else {
        const result = await execUpdate(db.query.bind(db));
        rows = normalizeRows(result);
    }

    // 目标行刚被校验存在却更新不到，只可能是并发删除；按非预期错误上报
    if (!rows[0]) throw new Error('更新用户失败：目标行在更新前被并发删除');
    delete rows[0].password_hash;
    delete rows[0].password;
    try {
        // 权限落地：权限级别变更记录 old/new（审计失败不阻断）
        const details = { username, name, email, ...filteredAdditional };
        if (needIdChange) details.id_change = { from: Number(id), to: newIdInt };
        if (newPermissionLevel !== null) {
            details.permission_change = { from: oldPermissionLevel, to: newPermissionLevel };
        }
        await recordAudit(req, {
            op: 'update', entityType: userType, entityId: needIdChange ? newIdInt : Number(id),
            details
        });
    } catch (_) { /* 审计失败不阻断 */ }

    return rows[0];
}

/**
 * 改 ID 时同步无外键引用的任务列表（在调用方事务内逐个执行）。
 * - 排课 JSONB pair：course-session-service.renameUserInAllSessions（teacher/student 改 pair 主键，
 *   admin 改 pair.created_by）
 * - 班主任 student_ids CSV：学生 ID 变化时替换所有教师 CSV 里的旧 ID
 * - feedbacks.submitter_id：无外键直接 UPDATE
 * export_logs 与各审计日志保留旧 ID 不改 —— 历史记录应反映当时事实，追溯经审计 details.id_change。
 */
function buildIdSyncTasks(userType, oldId, newId) {
    const tasks = [];
    tasks.push((q) => courseSessionService.renameUserInAllSessions(oldId, newId, userType, q));
    if (userType === 'student') {
        tasks.push(async (q) => {
            const res = await q('SELECT id, student_ids FROM teachers WHERE student_ids IS NOT NULL');
            for (const row of res.rows || []) {
                const ids = String(row.student_ids).split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
                if (!ids.includes(oldId)) continue;
                const next = ids.map(n => (n === oldId ? newId : n)).join(',');
                await q('UPDATE teachers SET student_ids = $1 WHERE id = $2', [next, row.id]);
            }
        });
    }
    tasks.push((q) => q(
        'UPDATE feedbacks SET submitter_id = $1 WHERE submitter_id = $2 AND submitter_role = $3',
        [newId, oldId, userType]
    ));
    return tasks;
}

/**
 * 删除用户（teacher/student 删除前外键检查，必要时级联删关联排课）。
 * cascade 删除 / 默认删除的唯一约束冲突（23503）映射为 409。
 */
async function deleteUser(userType, id, { cascade = false } = {}, req) {
    // 权限落地：所有账号写操作仅 L1
    assertSuperAdmin(req);

    const table = resolveTable(userType);
    if (!table) throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '无效的用户类型' });
    assertValidId(id);

    if (userType === 'admin') {
        const target = await fetchAdminTarget(id);
        if (!target) throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '用户不存在' });
        // 防提权③：不可删除自己
        if (req.user && Number(target.id) === Number(req.user.id)) {
            throw new AppError({ code: 'FORBIDDEN', statusCode: 403, message: '不能删除自己的账号' });
        }
        // 防提权④：最后一个超级管理员不可被删除
        if (Number(target.permission_level) === PERMISSION_LEVELS.SUPER_ADMIN) {
            const l1Res = normalizeRows(await db.query(
                'SELECT COUNT(*)::int AS count FROM administrators WHERE permission_level = $1',
                [PERMISSION_LEVELS.SUPER_ADMIN]
            ))[0];
            if ((l1Res ? Number(l1Res.count) : 0) <= 1) {
                throw new AppError({ code: 'FORBIDDEN', statusCode: 403, message: '系统必须保留至少一个超级管理员(L1)，无法删除' });
            }
        }
    }

    if (userType === 'teacher' || userType === 'student') {
        // 引用计数改按「这个人参与了几场课」算（派生列 GIN 索引），不再按平铺行数。
        const idsCol = userType === 'teacher' ? 'teacher_ids' : 'student_ids';
        const refCountRes = await db.query(
            `SELECT COUNT(*)::int AS count FROM course_sessions WHERE ${idsCol} @> ARRAY[$1::int]`,
            [id]
        );
        const refCount = (refCountRes && refCountRes.rows && refCountRes.rows[0] && typeof refCountRes.rows[0].count !== 'undefined')
            ? refCountRes.rows[0].count : 0;

        if (refCount > 0 && !cascade) {
            const entityLabel = userType === 'teacher' ? '教师' : '学生';
            // 冲突细节放进 details（与 errorResponse 的 details 数组形态一致），
            // 前端据此弹级联确认框，不必解析 message 里的数字
            throw new AppError({
                code: 'CONFLICT',
                statusCode: 409,
                message: `该${entityLabel}仍有关联的排课（${refCount} 项），请先删除相关排课或使用级联删除`,
                details: [{ referencedSchedules: refCount }]
            });
        }

        if (refCount > 0 && cascade) {
            // 语义相对旧表**有意改变**：旧实现是 DELETE ... WHERE teacher_id = $1（整行删）。
            // 一场课现在可能还有别的老师和学生，整场删掉会牵连无关的人，所以改成
            // 「从 pair 数组里移除这个人；移完为空的场次才整场删除」。
            const impact = await courseSessionService.countUserImpact(id, userType);
            await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                await courseSessionService.removeUserFromAllSessions(id, userType, { id: req.user && req.user.id, actorType: 'admin' });
                await q(`DELETE FROM ${table} WHERE id = $1`, [id]);
                // AI 模型偏好没有外键（user_id 是多态的），不手动清就会留下孤儿行
                await aiUserModelStore.purgeUserModel(userType, id, q);
                try {
                    await recordAudit(req, {
                        op: 'delete_cascade', entityType: userType, entityId: Number(id),
                        details: { affectedSessions: impact.affectedSessions, deletedSessions: impact.deletedSessions }
                    });
                } catch (_) { /* 审计失败不阻断 */ }
            });   // 不降级：先剥离场次再删用户，半途中止会留下「课没了、人还在」的不一致状态
            return {
                affectedSessions: impact.affectedSessions,
                deletedSessions: impact.deletedSessions,
                deletedSchedules: impact.deletedSessions,
                message: `用户已删除：${impact.affectedSessions} 场课移除了该${userType === 'teacher' ? '教师' : '学生'}，其中 ${impact.deletedSessions} 场因此被整场删除`
            };
        }
    }

    // 外键引用冲突（23503）原样上抛，由 errorHandler 统一映射
    // 两条语句必须同生共死：删用户与清偏好之间中断会留下孤儿偏好行，正是这里要消除的东西。
    // 不降级：降级后顺序执行，孤儿行窗口原样回来，等于没修。
    await db.runInTransaction(async (client, usePool) => {
        const q = usePool ? db.query : client.query.bind(client);
        await q(`DELETE FROM ${table} WHERE id = $1`, [id]);
        // AI 模型偏好没有外键（user_id 是多态的），不手动清就会留下孤儿行
        await aiUserModelStore.purgeUserModel(userType, id, q);
    });
    try {
        await recordAudit(req, { op: 'delete', entityType: userType, entityId: Number(id) });
    } catch (_) { /* 审计失败不阻断 */ }

    return { message: '用户删除成功' };
}

module.exports = {
    TABLES,
    BASE_COLUMNS,
    ALLOWED_ADDITIONAL,
    resolveTable,
    filterAdditional,
    listUsers,
    getUserById,
    getNextUserId,
    createUser,
    updateUser,
    deleteUser
};
