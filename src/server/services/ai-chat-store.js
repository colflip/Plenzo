/**
 * AI 助手会话与消息存储（DB 后端，带内存兜底）
 * @description
 *   会话/消息是**长期资产**（保留 90 天），与 ai-operation-store 的 5 分钟短时操作态不同。
 *   写入采用 write-through（内存 Map + 数据库双写），读取先查内存再回源数据库，
 *   与 ai-operation-store / ai-user-model-store 同构。数据库一旦失败即降级为纯内存，
 *   保证「AI 对话与反馈」在 DB 抖动时不崩（代价：跨实例一致性丢失、会话不持久）。
 *
 *   归属键是 (user_type, user_id) 两元组：user_id 是三张角色表共用的多态 id，
 *   号段外的历史存量可以同值存在于两张表，只按 user_id 取会跨角色串会话。
 *   内存 Map 的键与主键同构。所有按 id 取/改的路径都把归属条件下推到 SQL，
 *   不取回全量再判断（与 ai-operation-store 的 owner 下推一致）。
 *
 *   表不带外键（migrations.test.js 对全部批次断言 SQL 里不含 REFERENCES），
 *   所以 messages → sessions 的级联删除在本模块的 sweepExpired / purgeUser 里显式执行。
 * @module services/ai-chat-store
 */

const logger = require('../utils/logger.js');
const db = require('../db/db');

const SESSION_TABLE = 'ai_chat_sessions';
const MESSAGE_TABLE = 'ai_chat_messages';
const USER_TYPES = ['admin', 'teacher', 'student'];

/** 会话保留期：90 天（毫秒），由每日 cron 清理 expire_at 已过的会话 */
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const memSessions = new Map();
const memMessages = new Map();
let dbAvailable = true;
let lastDbError = null;
let dbDownAt = 0;

/**
 * DB 降级后的重试冷却期。为什么不像旧约定那样「一次失败直到进程重启」：
 * 本模块的表由**启动时 fire-and-forget 的迁移**创建，首个请求可能早于迁移完成，
 * 这时一次失败就把本进程永久打成内存模式，直到重启才恢复 —— 反馈全丢且无感。
 * 带冷却期的可恢复降级：失败后短时间内走内存，过了冷却期再试一次 DB，
 * 成功即自动恢复（迁移迟到／DB 抖动都能自愈）。冷却期不是自循环定时器，
 * 不制造额外的 Neon 唤醒（见 ai-operation-store 的同款理由）。
 */
const DB_RETRY_COOLDOWN_MS = Math.max(1000, parseInt(process.env.AI_CHAT_DB_RETRY_MS, 10) || 10000);

function assertUserType(userType) {
    if (!USER_TYPES.includes(userType)) {
        throw new Error(`invalid userType: ${userType}`);
    }
}

function sessionMemKey(userType, userId) {
    return `${userType}:${userId}`;
}

function nowIso() {
    return new Date().toISOString();
}

function expiryIso() {
    return new Date(Date.now() + RETENTION_MS).toISOString();
}

/** 当前是否该尝试走 DB：未降级，或已过冷却期（给一次重试机会） */
function dbUsable() {
    if (dbAvailable) return true;
    if (Date.now() - dbDownAt >= DB_RETRY_COOLDOWN_MS) {
        dbAvailable = true;   // 放行一次重试；若再失败，degrade() 会重新计时
        return true;
    }
    return false;
}

/** DB 重试成功，清除降级状态 */
function markDbRecovered() {
    if (!dbAvailable && lastDbError !== null) {
        logger.log('[ai-chat-store] DB 已恢复，退出内存降级');
    }
    dbAvailable = true;
    dbDownAt = 0;
    lastDbError = null;
}

function degrade(err, action) {
    dbAvailable = false;
    dbDownAt = Date.now();
    lastDbError = err.message;
    logger.warn(`[ai-chat-store] ${action} 失败，降级内存（${DB_RETRY_COOLDOWN_MS}ms 后重试）:`, err.message);
}

/* ============================================================
 * 会话
 * ============================================================ */

/**
 * 取当前用户的活跃会话；没有就建一个。
 * 每用户一个默认会话（不做会话列表 UI），所以按 (user_type, user_id) 定位。
 */
async function getOrCreateSession(userType, userId) {
    assertUserType(userType);
    const key = sessionMemKey(userType, userId);
    const cached = memSessions.get(key);
    // 冷却期已过时，dbUsable() 会把 dbAvailable 置回 true 以放行一次重试；
    // 这时不能让缓存命中直接返回，否则永远不会真正探测 DB（迁移迟到完成也永远发现不了）。
    const retrying = !dbAvailable && Date.now() - dbDownAt >= DB_RETRY_COOLDOWN_MS;
    if (cached && !retrying && (!cached.expireAt || Date.parse(cached.expireAt) > Date.now())) return cached;

    if (dbUsable()) {
        try {
            const res = await db.query(
                `SELECT id, user_id, user_type, created_at, expire_at
                   FROM ${SESSION_TABLE}
                  WHERE user_id = $1 AND user_type = $2
                    AND (expire_at IS NULL OR expire_at > CURRENT_TIMESTAMP)
                  ORDER BY created_at DESC LIMIT 1`,
                [userId, userType]
            );
            // 查询成功即证明 DB 可用（可能是冷却期后的重试），清除降级状态
            markDbRecovered();
            if (res.rows && res.rows.length) {
                const value = res.rows[0];
                memSessions.set(key, value);
                return value;
            }
        } catch (err) {
            degrade(err, '读取会话');
        }
    }

    // 内存兜底或库里确实没有：建一个新会话
    const session = {
        id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        user_id: userId,
        user_type: userType,
        created_at: nowIso(),
        expire_at: expiryIso()
    };
    memSessions.set(key, session);
    if (dbUsable()) {
        try {
            // 唯一约束 (user_id, user_type) 保证并发下只会有一个会话：
            // 两个实例同时 INSERT 时，一个成功、一个命中冲突并 RETURNING 胜出者的 id，
            // 两边统一用同一条会话，消息不会分裂到两个 id 下。
            const res = await db.query(
                `INSERT INTO ${SESSION_TABLE} (id, user_id, user_type, created_at, expire_at)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (user_id, user_type) DO UPDATE SET expire_at = EXCLUDED.expire_at
                 RETURNING id, user_id, user_type, created_at, expire_at`,
                [session.id, userId, userType, session.created_at, session.expire_at]
            );
            markDbRecovered();
            const winner = (res.rows || [])[0];
            if (winner) {
                memSessions.set(key, winner);
                return winner;
            }
        } catch (err) {
            degrade(err, '创建会话');
        }
    }
    return session;
}

/**
 * 列出用户的会话（社交/审计用；当前 UI 不用，接口留着）
 */
async function listSessions(userType, userId, limit = 20) {
    assertUserType(userType);
    const rows = [];
    const key = sessionMemKey(userType, userId);
    const cached = memSessions.get(key);
    if (cached) rows.push(cached);

    if (dbUsable()) {
        try {
            const res = await db.query(
                `SELECT id, user_id, user_type, created_at, expire_at
                   FROM ${SESSION_TABLE}
                  WHERE user_id = $1 AND user_type = $2
                    AND (expire_at IS NULL OR expire_at > CURRENT_TIMESTAMP)
                  ORDER BY created_at DESC LIMIT $3`,
                [userId, userType, Math.min(Number(limit) || 20, 100)]
            );
            markDbRecovered();
            // 内存里的新会话可能还没进库：按 id 去重，DB 结果优先（事实来源）
            // 内存缓存也必须过滤已过期会话，否则和 DB 口径不一致
            const seen = new Set((res.rows || []).map(r => r.id));
            const liveCached = rows.filter(r => !r.expireAt || Date.parse(r.expireAt) > Date.now());
            return [...(res.rows || []), ...liveCached.filter(r => !seen.has(r.id))]
                .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
                .slice(0, Math.min(Number(limit) || 20, 100));
        } catch (err) {
            degrade(err, '列出会话');
        }
    }
    return rows;
}

/* ============================================================
 * 消息
 * ============================================================ */

/**
 * 追加一条消息。
 * @param {object} m
 * @param {string} m.sessionId
 * @param {string} m.role - user / assistant
 * @param {string} m.content
 * @param {string[]} [m.toolsUsed]
 * @param {string} [m.model]
 * @param {number} [m.promptTokens]
 * @param {number} [m.completionTokens]
 * @param {string} m.userType
 * @param {number} m.userId
 */
async function appendMessage(m) {
    assertUserType(m.userType);
    const row = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        session_id: m.sessionId,
        user_id: m.userId,
        user_type: m.userType,
        role: m.role,
        content: String(m.content == null ? '' : m.content),
        tools_used: Array.isArray(m.toolsUsed) ? JSON.stringify(m.toolsUsed) : null,
        model: m.model || null,
        prompt_tokens: Number.isFinite(m.promptTokens) ? m.promptTokens : null,
        completion_tokens: Number.isFinite(m.completionTokens) ? m.completionTokens : null,
        feedback: '',
        feedback_at: null,
        created_at: nowIso()
    };

    const list = memMessages.get(m.sessionId) || [];
    list.push(row);
    memMessages.set(m.sessionId, list);

    if (dbUsable()) {
        try {
            await db.query(
                `INSERT INTO ${MESSAGE_TABLE}
                    (id, session_id, user_id, user_type, role, content, tools_used,
                     model, prompt_tokens, completion_tokens, feedback, feedback_at, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                 ON CONFLICT (id) DO NOTHING`,
                [row.id, row.session_id, row.user_id, row.user_type, row.role, row.content,
                 row.tools_used, row.model, row.prompt_tokens, row.completion_tokens,
                 row.feedback, row.feedback_at, row.created_at]
            );
            markDbRecovered();
        } catch (err) {
            degrade(err, '写入消息');
        }
    }
    return row;
}

/**
 * 列出某会话的消息。归属条件在 SQL 里，越权会话直接空列表。
 */
async function listMessages(sessionId, userType, userId, limit = 100) {
    assertUserType(userType);
    const cached = memMessages.get(sessionId) || [];
    if (!dbUsable()) return cached.slice(-Math.min(Number(limit) || 100, 300));

    try {
        const res = await db.query(
            `SELECT id, session_id, role, content, tools_used, model,
                    prompt_tokens, completion_tokens, feedback, feedback_at, created_at
               FROM ${MESSAGE_TABLE}
              WHERE session_id = $1 AND user_id = $2 AND user_type = $3
              ORDER BY created_at ASC, id ASC LIMIT $4`,
            [sessionId, userId, userType, Math.min(Number(limit) || 100, 300)]
        );
        markDbRecovered();
        if (res.rows && res.rows.length) return res.rows;
        // DB 里还没有（刚写内存、还没落库）：用内存兜底
        return cached.slice(-Math.min(Number(limit) || 100, 300));
    } catch (err) {
        degrade(err, '列出消息');
        return cached.slice(-Math.min(Number(limit) || 100, 300));
    }
}

/**
 * 标记「没用」。只认本人的消息；重复标记幂等。
 * @returns {Promise<{found:boolean, degraded:boolean, row?:object}>}
 *   found=false 且 degraded=false = 消息不存在或越权（调用方应回 404）
 *   found=true 且 degraded=true  = 内存已标记但 DB 降级，未持久化
 */
async function markUnhelpful(messageId, userType, userId) {
    assertUserType(userType);
    // 内存里也更新（write-through 的本地缓存层）
    let foundInMem = false;
    for (const [, list] of memMessages) {
        const hit = list.find(m => m.id === messageId && m.user_type === userType && m.user_id === userId);
        if (hit) {
            hit.feedback = 'unhelpful';
            hit.feedback_at = nowIso();
            foundInMem = true;
        }
    }

    if (!dbUsable()) return { found: foundInMem, degraded: true };
    try {
        const res = await db.query(
            `UPDATE ${MESSAGE_TABLE}
                SET feedback = 'unhelpful', feedback_at = CURRENT_TIMESTAMP
              WHERE id = $1 AND user_id = $2 AND user_type = $3
              RETURNING id, session_id, feedback, feedback_at`,
            [messageId, userId, userType]
        );
        markDbRecovered();
        const row = (res.rows || [])[0];
        return { found: !!row || foundInMem, degraded: false, row: row || null };
    } catch (err) {
        degrade(err, '标记没用');
        return { found: foundInMem, degraded: true };
    }
}

/* ============================================================
 * 清理
 * ============================================================ */

/**
 * 清理过期会话及其消息。两条 DELETE 显式执行（表间无外键）。
 * 由每日 cron 调用，不建自循环定时器 —— Neon 按计算唤醒时长计费，
 * 自循环会让库永远睡不着（见 ai-operation-store 的同款理由）。
 */
async function sweepExpired() {
    memSessions.clear();
    memMessages.clear();
    if (!dbUsable()) return { ok: false, skipped: true };

    try {
        // 先删消息：消息表没有外键，靠 session_id 关联
        await db.query(
            `DELETE FROM ${MESSAGE_TABLE}
              WHERE session_id IN (SELECT id FROM ${SESSION_TABLE} WHERE expire_at <= CURRENT_TIMESTAMP)`
        );
        const res = await db.query(
            `DELETE FROM ${SESSION_TABLE} WHERE expire_at <= CURRENT_TIMESTAMP`
        );
        markDbRecovered();
        return { ok: true, deleted: (res && (res.rowCount || (res.rows || []).length)) || 0 };
    } catch (err) {
        degrade(err, '清理过期会话');
        return { ok: false, error: err.message };
    }
}

/**
 * 清空当前用户的会话（及其消息）。用于前端「清空对话」——
 * 只清本地缓存的话，下次打开 loadServerHistory 会把服务端旧消息全部拉回来。
 */
async function clearSession(sessionId, userType, userId) {
    assertUserType(userType);
    if (!sessionId) return { ok: true, deleted: 0 };

    // 先删 DB 再删内存：反过来的话 DB 失败时内存已清空且无法回滚，
    // DB 恢复后旧会话又被读回缓存，用户以为清掉的对话会「复活」。
    if (!dbUsable()) {
        // 降级路径下 DB 操作不可知：只在内存命中本人会话时清本地，
        // 并如实标记 degraded，让调用方知道这不是一次可靠的清空。
        const key = sessionMemKey(userType, userId);
        const cached = memSessions.get(key);
        const localHit = !!cached && cached.id === sessionId;
        if (localHit) { memMessages.delete(sessionId); memSessions.delete(key); }
        return { ok: localHit, deleted: 0, degraded: true };
    }
    try {
        // 两条 DELETE 都带归属条件：不能靠 sessionId 就把别人的消息清掉
        const msgRes = await db.query(
            `DELETE FROM ${MESSAGE_TABLE} WHERE session_id = $1 AND user_id = $2 AND user_type = $3`,
            [sessionId, userId, userType]
        );
        await db.query(
            `DELETE FROM ${SESSION_TABLE} WHERE id = $1 AND user_id = $2 AND user_type = $3`,
            [sessionId, userId, userType]
        );
        markDbRecovered();
        // DB 删成功后再清内存，保证内存不会先于 DB 被清掉
        memMessages.delete(sessionId);
        const key = sessionMemKey(userType, userId);
        const cached = memSessions.get(key);
        if (cached && cached.id === sessionId) memSessions.delete(key);
        return { ok: true, deleted: (msgRes && (msgRes.rowCount || (msgRes.rows || []).length)) || 0, sessionId };
    } catch (err) {
        degrade(err, '清空会话');
        // DB 失败：内存保持原样，下次还能重试
        return { ok: false, error: err.message };
    }
}

/**
 * 删除某用户的所有会话与消息（删除用户时调用）。
 * 同样不动 dbAvailable：一行没清掉不代表整个模块要降级。
 */
async function purgeUser(userType, userId) {
    assertUserType(userType);
    const key = sessionMemKey(userType, userId);
    const session = memSessions.get(key);
    if (session) memMessages.delete(session.id);
    memSessions.delete(key);

    try {
        await db.query(
            `DELETE FROM ${MESSAGE_TABLE} WHERE user_id = $1 AND user_type = $2`,
            [userId, userType]
        );
        await db.query(
            `DELETE FROM ${SESSION_TABLE} WHERE user_id = $1 AND user_type = $2`,
            [userId, userType]
        );
    } catch (err) {
        logger.warn('[ai-chat-store] 清理用户会话失败:', err.message);
    }
}

module.exports = {
    DB_RETRY_COOLDOWN_MS,
    RETENTION_MS,
    getOrCreateSession,
    listSessions,
    appendMessage,
    listMessages,
    markUnhelpful,
    sweepExpired,
    clearSession,
    purgeUser,
    // 测试钩子
    _mem: { memSessions, memMessages },
    _state: () => ({ dbAvailable, lastDbError, dbDownAt }),
    _reset: () => {
        memSessions.clear(); memMessages.clear();
        dbAvailable = true; lastDbError = null; dbDownAt = 0;
    }
};
