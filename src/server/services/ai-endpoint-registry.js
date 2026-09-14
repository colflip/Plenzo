const logger = require('../utils/logger');
const { getPresetModels } = require('./preset-models');
const endpointStore = require('./ai-endpoint-store');

/**
 * 渠道端点注册表（Channel → Endpoint → Model）
 * @description
 *  把「env 里的只读种子」和「数据库里可增删改的覆盖项」合并成一份最终视图，
 *  并按策略挑选端点，供 ai-service 直接消费。
 *
 *  合并规则：
 *    1. env 种子（LLM{P}_ENDPOINT_{N}_* / LLM{P}_BASE_URLS）提供基线端点；
 *    2. DB 行按 baseUrl 与 env 端点匹配 —— 匹配上则**覆盖**（DB 优先），
 *       匹配不上则作为**新增端点**追加；
 *    3. DB 行 enabled=false 视为「停用」，即使 env 里有同名端点也不参与选择；
 *    4. 最终按 priority 升序排序，priority 相同则 env 端点在前（保持配置的确定性）。
 *
 *  为什么要 DB 优先：env 在 Serverless 下不可写，若 env 优先则管理后台永远改不动；
 *  但为了让「删库重来」不至于丢配置，env 种子始终存在、只可被停用或覆盖。
 *
 *  降级：数据库不可用时 listEndpoints 返回 []，合并结果等于纯 env 视图，
 *  与改造前行为一致 —— 主链路不会因为新表出问题就整体不可用。
 */

/** round-robin 游标（进程内）。Serverless 多实例下各实例独立计数，不保证全局均匀。 */
const rrCursor = new Map();

/**
 * 合并某个渠道的 env 种子与 DB 覆盖。
 * @param {string} channelId - 渠道 id，如 'agnes'
 * @param {{includeDisabled?: boolean}} [opts]
 * @returns {Promise<Array<Object>>} 合并后的端点列表（含明文 apiKey，**仅服务端使用**）
 */
async function listMergedEndpoints(channelId, opts = {}) {
    const { includeDisabled = false } = opts;
    const preset = getPresetModels(true).find(p => p.id === channelId);
    if (!preset) return [];

    const seeded = (preset.endpoints || []).map(ep => ({ ...ep }));
    const dbRows = await endpointStore.listEndpoints(channelId, { includeDisabled: true, withKey: true });

    // 以 baseUrl 为合并键：同一地址视为同一端点，无论它来自 env 还是 DB。
    // 不用 id 是因为 env 端点没有 DB 主键，且管理员更可能按地址思考。
    const byUrl = new Map();
    for (const ep of seeded) byUrl.set(normalizeUrl(ep.baseUrl), ep);

    for (const row of dbRows) {
        const key = normalizeUrl(row.baseUrl);
        const base = byUrl.get(key);
        if (base) {
            // 覆盖：DB 有值的字段覆盖 env，DB 为 null 的字段表示「继承渠道」
            byUrl.set(key, {
                ...base,
                id: row.id,
                label: row.label ?? base.label,
                apiKey: row.apiKey || base.apiKey,
                inheritsKey: !row.apiKey,
                protocol: row.protocol || base.protocol,
                timeout: row.timeout ?? base.timeout,
                maxTokens: row.maxTokens ?? base.maxTokens,
                models: (row.models && row.models.length) ? row.models : base.models,
                extraParams: Object.keys(row.extraParams || {}).length ? row.extraParams : base.extraParams,
                enabled: row.enabled !== false,
                priority: row.priority ?? base.priority,
                source: 'env+db'
            });
        } else {
            byUrl.set(key, {
                id: row.id,
                label: row.label || row.baseUrl,
                baseUrl: row.baseUrl,
                apiKey: row.apiKey || preset.apiKey,
                inheritsKey: !row.apiKey,
                protocol: row.protocol || preset.protocol,
                timeout: row.timeout ?? preset.timeout,
                maxTokens: row.maxTokens ?? preset.maxTokens,
                models: row.models || [],
                extraParams: row.extraParams || {},
                enabled: row.enabled !== false,
                priority: row.priority ?? 1000,
                source: 'db'
            });
        }
    }

    let list = [...byUrl.values()];
    if (!includeDisabled) list = list.filter(ep => ep.enabled !== false);
    return list.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        // 同优先级：env 种子在前，保证未配置 priority 时顺序确定
        if (a.source !== b.source) return a.source.startsWith('env') ? -1 : 1;
        return String(a.baseUrl).localeCompare(String(b.baseUrl));
    });
}

function normalizeUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * 按策略从候选端点中挑一个。
 * @param {Array<Object>} endpoints - 已按 priority 排序
 * @param {string} strategy - priority | round-robin | random
 * @param {string} [channelId] - round-robin 的游标键
 * @returns {Object|null}
 */
function selectEndpoint(endpoints, strategy = 'priority', channelId = '') {
    const usable = endpoints.filter(ep => ep.enabled !== false);
    if (usable.length === 0) return null;
    if (usable.length === 1) return usable[0];

    switch (strategy) {
        case 'round-robin': {
            const key = channelId || '_default';
            const next = (rrCursor.get(key) || 0) % usable.length;
            rrCursor.set(key, next + 1);
            return usable[next];
        }
        case 'random':
            return usable[Math.floor(Math.random() * usable.length)];
        case 'priority':
        default:
            return usable[0];
    }
}

/**
 * 解析出「用哪个端点、以什么参数」去调用某个模型。
 * @description 只在端点确实挂载了目标模型时选用它；否则回退到渠道默认端点，
 *              保证「模型不在任何端点清单里」时行为与改造前一致（仍可调用）。
 * @param {string} channelId
 * @param {string} modelId
 * @param {Object} [globalConfig] - 全局配置，用于兜底 timeout/maxTokens
 * @returns {Promise<Object|null>} ai-service 的 configOverride；null 表示渠道不可用
 */
async function resolveCallConfig(channelId, modelId, globalConfig = {}) {
    const preset = getPresetModels(true).find(p => p.id === channelId);
    if (!preset) return null;

    const endpoints = await listMergedEndpoints(channelId);
    const strategy = preset.endpointStrategy || 'priority';

    const serving = endpoints.filter(ep => (ep.models || []).includes(modelId));
    const chosen = serving.length
        ? selectEndpoint(serving, strategy, channelId)
        : selectEndpoint(endpoints, strategy, channelId);

    if (!chosen) {
        // 极端情况：env 有渠道但所有端点都被停用 —— 回退渠道默认地址，不让助手直接死掉
        logger.warn(`[ai-endpoint-registry] 渠道 ${channelId} 无可用端点，回退渠道默认地址`);
        return {
            enabled: true,
            provider: preset.provider,
            protocol: preset.protocol,
            apiKey: preset.apiKey,
            baseUrl: preset.baseUrl,
            model: modelId,
            timeout: globalConfig.timeout || preset.timeout,
            maxTokens: globalConfig.maxTokens || preset.maxTokens
        };
    }

    return {
        enabled: true,
        provider: preset.provider,
        protocol: chosen.protocol || preset.protocol,
        apiKey: chosen.apiKey || preset.apiKey,
        baseUrl: chosen.baseUrl,
        model: modelId,
        timeout: chosen.timeout || globalConfig.timeout || preset.timeout,
        maxTokens: chosen.maxTokens || globalConfig.maxTokens || preset.maxTokens,
        extraParams: chosen.extraParams || {},
        // 便于日志/排障：记录实际命中的端点
        _endpoint: { id: chosen.id, label: chosen.label, baseUrl: chosen.baseUrl, source: chosen.source }
    };
}

/**
 * 汇总某个渠道下所有端点挂出的模型（去重，保持首次出现顺序）。
 * 用于「用户可选模型清单」—— 模型挂在哪个端点是服务端的事，用户只需看到有哪些模型。
 * @param {string} channelId
 * @returns {Promise<string[]>}
 */
async function listChannelModels(channelId) {
    const preset = getPresetModels(false).find(p => p.id === channelId);
    if (!preset) return [];

    const endpoints = await listMergedEndpoints(channelId);
    const seen = new Set();
    for (const ep of endpoints) {
        for (const m of (ep.models || [])) seen.add(m);
    }
    // 渠道默认模型若没被任何端点挂出，补在最前，避免「渠道默认模型反而选不到」
    if (preset.model && !seen.has(preset.model)) {
        return [preset.model, ...seen];
    }
    return [...seen];
}

module.exports = {
    listMergedEndpoints,
    selectEndpoint,
    resolveCallConfig,
    listChannelModels,
    normalizeUrl,
    // 测试钩子
    _resetCursor: () => rrCursor.clear()
};
