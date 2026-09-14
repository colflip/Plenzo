const logger = require('../utils/logger.js');
const db = require('../db/db');
const crypto = require('./ai-config-crypto');

/**
 * AI 渠道端点存储（渠道 → 端点 → 模型）
 * @description
 *  一个渠道原先只有一个 base_url 和一份凭证，多地址/多模型只能靠 env 里的平铺列表表达，
 *  而 env 在 Serverless 下是只读的（见 ai-config-store 的说明），管理员在后台改不了。
 *  本模块把「端点」提升为可持久化的一等公民，支撑：
 *
 *      channel ──┬── endpoint#1 ──┬── model A
 *                │                └── model B
 *                └── endpoint#2 ──┴── model C
 *
 *  env（LLM{P}_ENDPOINT_{N}_*）作为**只读种子**：提供默认端点与默认值，但不可写；
 *  DB 行可以覆盖同名端点，也可以新增 env 里没有的端点。
 *  「哪些端点/模型可用」最终由 ai-endpoint-registry 合并两者后决定。
 *
 *  密钥：api_key 落库前经 ai-config-crypto 做 AES-256-GCM 加密，与 ai_config 同一套机制；
 *  为 NULL 表示「继承渠道级凭证」，不是「空密钥」。对外返回的 apiKey 一律掩码。
 *
 *  降级：数据库不可用时不影响读取主链路 —— listEndpoints 返回空数组（即「没有 DB 覆盖」，
 *  全部回退 env 种子），写操作才报错。这样 DB 抖动不会让 AI 助手整体不可用。
 */

const TABLE = 'ai_channel_endpoints';
const MASK = '***已配置***';

let tableReady = false;

/** 是否 http(s) URL；空字符串不算 */
function isHttpUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return false;
    try {
        const u = new URL(value.trim());
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

/** 正整数或 undefined/null（null 语义是「继承渠道」） */
function optionalPositiveInt(value, field) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
        throw Object.assign(new Error(`${field} 必须是正整数`), { status: 400 });
    }
    return n;
}

/**
 * 校验并规范化一个端点的入参。
 * @param {Object} input
 * @param {boolean} partial - true 表示「更新」：所有字段可选
 * @returns {Object} 规范化后的字段（apiKey 保持明文，落库前才加密）
 */
function normalizeEndpoint(input, partial = false) {
    if (!input || typeof input !== 'object') {
        throw Object.assign(new Error('端点数据不能为空'), { status: 400 });
    }

    const out = {};

    if (input.channelId !== undefined || !partial) {
        const channelId = String(input.channelId || '').trim();
        if (!channelId) throw Object.assign(new Error('缺少 channelId'), { status: 400 });
        out.channelId = channelId;
    }

    if (input.baseUrl !== undefined || !partial) {
        const baseUrl = String(input.baseUrl || '').trim();
        if (!isHttpUrl(baseUrl)) {
            throw Object.assign(new Error('baseUrl 必须是合法的 http/https 地址'), { status: 400 });
        }
        out.baseUrl = baseUrl;
    }

    if (input.label !== undefined) {
        out.label = input.label === null ? null : String(input.label).trim() || null;
    }

    // apiKey: undefined = 不改动；null = 清除（继承渠道）；字符串 = 设置
    if (input.apiKey !== undefined) {
        out.apiKey = (input.apiKey === null || input.apiKey === '') ? null : String(input.apiKey);
    }

    if (input.protocol !== undefined) {
        out.protocol = input.protocol === null ? null : String(input.protocol).trim() || null;
    }

    if (input.timeout !== undefined) out.timeout = optionalPositiveInt(input.timeout, 'timeout');
    if (input.maxTokens !== undefined) out.maxTokens = optionalPositiveInt(input.maxTokens, 'maxTokens');

    if (input.models !== undefined) {
        const list = Array.isArray(input.models) ? input.models : String(input.models).split(',');
        out.models = list.map(m => String(m).trim()).filter(Boolean);
        if (out.models.length === 0) {
            throw Object.assign(new Error('models 至少需要包含一个模型'), { status: 400 });
        }
    }

    if (input.extraParams !== undefined) {
        if (input.extraParams === null) {
            out.extraParams = {};
        } else if (typeof input.extraParams === 'object' && !Array.isArray(input.extraParams)) {
            out.extraParams = input.extraParams;
        } else {
            throw Object.assign(new Error('extraParams 必须是对象'), { status: 400 });
        }
    }

    if (input.enabled !== undefined) out.enabled = input.enabled !== false;
    if (input.priority !== undefined) {
        const n = Number(input.priority);
        out.priority = Number.isInteger(n) ? n : 0;
    }

    return out;
}

/** 数据库行 → 对外结构（解密 apiKey 后立刻掩码） */
function mapRow(row, { withKey = false } = {}) {
    let apiKey = null;
    if (row.api_key) {
        try {
            apiKey = crypto.decrypt(row.api_key);
        } catch (err) {
            // 单条密文损坏不该让整个列表拿不到；标记后由调用方决定
            logger.error('[ai-endpoint-store] 端点 api_key 解密失败:', err.message);
            apiKey = null;
        }
    }
    return {
        id: row.id,
        channelId: row.channel_id,
        label: row.label || null,
        baseUrl: row.base_url,
        apiKey: withKey ? apiKey : (apiKey ? MASK : null),
        hasOwnKey: !!apiKey,
        protocol: row.protocol || null,
        timeout: row.timeout || null,
        maxTokens: row.max_tokens || null,
        models: Array.isArray(row.models) ? row.models : [],
        extraParams: (row.extra_params && typeof row.extra_params === 'object') ? row.extra_params : {},
        enabled: row.enabled !== false,
        priority: row.priority || 0,
        source: row.source || 'db',
        updatedAt: row.updated_at || null
    };
}

/**
 * 确保表存在（幂等）。与 ai-config-store 同样做兜底建表，
 * 避免 Serverless 冷启动时全局迁移尚未执行导致 "relation does not exist"。
 */
async function ensureTable() {
    if (tableReady) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
            id SERIAL PRIMARY KEY,
            channel_id VARCHAR(50) NOT NULL,
            label VARCHAR(100),
            base_url TEXT NOT NULL,
            api_key TEXT,
            protocol VARCHAR(20),
            timeout INTEGER,
            max_tokens INTEGER,
            models JSONB NOT NULL DEFAULT '[]'::jsonb,
            extra_params JSONB NOT NULL DEFAULT '{}'::jsonb,
            enabled BOOLEAN NOT NULL DEFAULT true,
            priority INTEGER NOT NULL DEFAULT 0,
            source VARCHAR(20) NOT NULL DEFAULT 'db',
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await db.query(
        `CREATE INDEX IF NOT EXISTS idx_ai_channel_endpoints_channel ON ${TABLE}(channel_id, priority)`
    );
    tableReady = true;
}

// 端点变更低频，但「用户可选模型清单」等接口每次请求都要读，
// 因此整表缓存一份、按 AI_CONFIG_CACHE_TTL_MS（默认 10s）失效，避免每个请求都查库。
let allRowsCache = null;
let allRowsCacheAt = 0;
const CACHE_TTL_MS = parseInt(process.env.AI_CONFIG_CACHE_TTL_MS, 10) || 10000;

function invalidateCache() {
    allRowsCache = null;
    allRowsCacheAt = 0;
}

/**
 * 列出端点。
 * @param {string} [channelId] - 不传返回全部渠道
 * @param {{includeDisabled?: boolean, withKey?: boolean}} [opts]
 * @returns {Promise<Array>} DB 不可用或表不存在时返回 []（降级为「无覆盖」）
 */
async function listEndpoints(channelId, opts = {}) {
    const { includeDisabled = false, withKey = false } = opts;

    // 测试环境不触发数据库访问（与 ai-config-store 的既有约定一致），
    // 否则 DB 连接超时会把每个用例拖慢数秒。
    if (process.env.NODE_ENV === 'test') return [];

    let rows;
    try {
        if (allRowsCache && Date.now() - allRowsCacheAt < CACHE_TTL_MS) {
            rows = allRowsCache;
        } else {
            await ensureTable();
            const res = await db.query(
                `SELECT * FROM ${TABLE} ORDER BY channel_id, priority ASC, id ASC`
            );
            rows = res.rows || [];
            allRowsCache = rows;
            allRowsCacheAt = Date.now();
        }
    } catch (err) {
        logger.warn('[ai-endpoint-store] 读取端点失败，降级为无覆盖:', err.message);
        return [];
    }

    return rows
        .filter(r => (channelId ? r.channel_id === channelId : true))
        .filter(r => (includeDisabled ? true : r.enabled !== false))
        .map(r => mapRow(r, { withKey }));
}

/**
 * 新增端点。
 * @returns {Promise<Object>} 新建的端点（apiKey 已掩码）
 */
async function createEndpoint(input) {
    const data = normalizeEndpoint(input, false);
    await ensureTable();

    const res = await db.query(
        `INSERT INTO ${TABLE}
            (channel_id, label, base_url, api_key, protocol, timeout, max_tokens,
             models, extra_params, enabled, priority, source, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,'db',CURRENT_TIMESTAMP)
         RETURNING *`,
        [
            data.channelId,
            data.label ?? null,
            data.baseUrl,
            data.apiKey ? crypto.encrypt(data.apiKey) : null,
            data.protocol ?? null,
            data.timeout ?? null,
            data.maxTokens ?? null,
            JSON.stringify(data.models ?? []),
            JSON.stringify(data.extraParams ?? {}),
            data.enabled !== false,
            data.priority ?? 0
        ]
    );
    invalidateCache();
    return mapRow(res.rows[0]);
}

/**
 * 更新端点（部分字段）。
 * @param {number} id
 * @param {Object} patch - updateEndpoint 语义：apiKey 传 null 表示清除
 * @returns {Promise<Object|null>} null 表示 id 不存在
 */
async function updateEndpoint(id, patch) {
    const data = normalizeEndpoint(patch, true);
    await ensureTable();

    const sets = [];
    const params = [];
    const push = (sql, value) => { params.push(value); sets.push(`${sql} = $${params.length}`); };

    if (data.channelId !== undefined) push('channel_id', data.channelId);
    if (data.label !== undefined) push('label', data.label);
    if (data.baseUrl !== undefined) push('base_url', data.baseUrl);
    if (data.apiKey !== undefined) push('api_key', data.apiKey ? crypto.encrypt(data.apiKey) : null);
    if (data.protocol !== undefined) push('protocol', data.protocol);
    if (data.timeout !== undefined) push('timeout', data.timeout);
    if (data.maxTokens !== undefined) push('max_tokens', data.maxTokens);
    if (data.models !== undefined) push('models', JSON.stringify(data.models));
    if (data.extraParams !== undefined) push('extra_params', JSON.stringify(data.extraParams));
    if (data.enabled !== undefined) push('enabled', data.enabled);
    if (data.priority !== undefined) push('priority', data.priority);

    if (sets.length === 0) return getEndpoint(id);

    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);
    const res = await db.query(
        `UPDATE ${TABLE} SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
    );
    invalidateCache();
    return res.rows && res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** 删除端点 */
async function deleteEndpoint(id) {
    await ensureTable();
    const res = await db.query(`DELETE FROM ${TABLE} WHERE id = $1 RETURNING id`, [id]);
    invalidateCache();
    return !!(res.rows && res.rows.length);
}

/** 按 id 读取单个端点 */
async function getEndpoint(id, opts = {}) {
    await ensureTable();
    const res = await db.query(`SELECT * FROM ${TABLE} WHERE id = $1`, [id]);
    return res.rows && res.rows[0] ? mapRow(res.rows[0], opts) : null;
}

/**
 * 按 (channelId, baseUrl) 查找 DB 行。
 * 用途：env 种子端点没有数据库主键，管理员对它做「停用 / 改模型」时，
 * 需要先知道是否已经存在对应的覆盖行 —— 有则更新，无则新建。
 * @returns {Promise<Object|null>}
 */
async function findByUrl(channelId, baseUrl, opts = {}) {
    await ensureTable();
    const res = await db.query(
        `SELECT * FROM ${TABLE} WHERE channel_id = $1 AND base_url = $2 LIMIT 1`,
        [channelId, baseUrl]
    );
    return res.rows && res.rows[0] ? mapRow(res.rows[0], opts) : null;
}

module.exports = {
    TABLE,
    MASK,
    isHttpUrl,
    ensureTable,
    listEndpoints,
    getEndpoint,
    findByUrl,
    createEndpoint,
    updateEndpoint,
    deleteEndpoint,
    invalidateCache,
    // 测试钩子
    _reset: () => { tableReady = false; invalidateCache(); }
};
