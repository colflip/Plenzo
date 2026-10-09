/**
 * 会话吊销：判断「这个账号现在还活着吗」。
 *
 * JWT 里只带 id/userType/权限级别，验签本身看不出账号已被停用，所以旧 token 会一直
 * 用到自然过期（审查报告 P1-4 的后半）。这里补上那次状态读取。
 *
 * 成本是被权衡过的：远程 Neon 每条约 250ms，每请求都查等于给所有接口加一次串行往返。
 * 所以每个实例带一层 30 秒 TTL 的进程内缓存 —— 最坏情况下停用在 30 秒后失效，
 * 而不是「等到 token 自然过期」（`JWT_EXPIRES_IN` 实测 24h，勾选记住我是 30d）。执行停用/删除的那台实例
 * 会立刻清掉自己这一条，所以下一次同实例请求就是准的。
 *
 * 查库失败时**放行**（只告警）：这时熔断器多半已经打开，后面的数据接口本来就会 503，
 * 在这里再判一次死刑只会把「数据库抖一下」升级成「所有人被踢下线」。
 *
 * 判定规则本身（含 `administrators` 实测没有 status 列这件事）只有 interpretAccount 一份。
 */
const db = require('../db/db');
const logger = require('./logger');

const SESSION_CACHE_TTL_MS = 30 * 1000;

/** userType → 取状态用的列（管理员表没有 status，只查存在性） */
const ACCOUNT_QUERY = {
    admin: 'SELECT id AS found FROM administrators WHERE id = $1',
    teacher: 'SELECT id AS found, status FROM teachers WHERE id = $1',
    student: 'SELECT id AS found, status FROM students WHERE id = $1'
};

const cache = new Map();

function cacheKey(userType, id) {
    return `${userType}:${id}`;
}

/**
 * 账号可用性判定的唯一来源：登录（auth-service）和每次请求的状态复核都走这里。
 * 两扇门必须说同一句话，否则会出现「登录成功，但之后每个请求都 401」的分裂态。
 *
 * status 取值（管理员在后台的下拉里就是这三档，实测生产 21 个账号当前全是 1）：
 *   1 正常 / 0 暂停 / -1 删除。
 * `administrators` 实测没有 status 列，所以管理员只有「行还在不在」这一档 ——
 * 按「读不到 status 就不猜」处理，将来真加了列，两条路径会自动一起生效。
 *
 * @returns {{alive:boolean, reason?:'gone'|'disabled'}}
 */
function interpretAccount(row) {
    if (!row) return { alive: false, reason: 'gone' };
    // 不能把 undefined 拿去比数字：NaN !== 1 会把根本没有状态列的表整个锁在门外。
    if (row.status === undefined) return { alive: true };

    const status = Number(row.status);
    if (status === 1) return { alive: true };
    return { alive: false, reason: status === -1 ? 'gone' : 'disabled' };
}

/**
 * @returns {Promise<{alive:boolean, reason?:string}>}
 */
async function checkAccount(userType, id) {
    const sql = ACCOUNT_QUERY[userType];
    if (!sql) return { alive: true };        // 未知身份交给上游的角色门禁

    const now = Date.now();
    const hit = cache.get(cacheKey(userType, id));
    if (hit && (now - hit.at) < SESSION_CACHE_TTL_MS) return hit;

    let result;
    try {
        const r = await db.query(sql, [id]);
        result = { ...interpretAccount((r.rows || [])[0]), at: now };
        cache.set(cacheKey(userType, id), result);
    } catch (error) {
        logger.warn('[session] 账号状态读取失败，本次按放行处理:', (error && error.message || '').slice(0, 120));
        result = { alive: true };
    }
    return result;
}

/** 状态可能刚被自己改过（停用/删除/恢复）时，别让本实例再拿旧缓存说话 */
function forgetSession(userType, id) {
    if (userType === undefined || id === undefined || id === null) return;
    cache.delete(cacheKey(String(userType), Number(id)));
}

module.exports = {
    checkAccount,
    forgetSession,
    interpretAccount,
    SESSION_CACHE_TTL_MS,
    _clearSessionCache: () => cache.clear()
};
