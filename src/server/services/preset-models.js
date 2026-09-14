/**
 * 预设 AI 模型配置
 * @description 从环境变量读取系统预设的 AI 模型。
 *
 * 三级结构：渠道 Channel → 端点 Endpoint → 模型 Model
 *
 *      LLM2 (Agnes) ──┬── 端点1 https://apihub.agnes-ai.com/v1 ──┬── agnes-3.0-flash
 *                     │                                          └── agnes-2.5-pro
 *                     └── 端点2 https://backup.example.com/v1 ───┴── agnes-2.0-flash
 *
 * 渠道级变量（对所有端点生效，端点可覆盖）：
 *   LLM2_API_KEY=sk-xxx                       # 渠道默认凭证
 *   LLM2_BASE_URLS=https://a/v1,https://b/v1  # 端点地址列表，首个 = 默认端点
 *   LLM2_MODELS=agnes-3.0-flash,agnes-2.5-pro # 渠道默认模型清单，首个 = 默认模型
 *   LLM2_PROTOCOL=openai
 *   LLM2_TIMEOUT=600000
 *   LLM2_MAX_TOKENS=65536
 *   LLM2_CONTEXT_WINDOW=524288                # 上下文窗口（tokens）
 *   LLM2_INPUT_MODALITIES=text,image_url
 *   LLM2_OUTPUT_MODALITIES=text
 *   LLM2_ENDPOINT_STRATEGY=priority           # priority | round-robin | random
 *
 * 端点级变量（N 从 1 起，与 BASE_URLS 顺序一一对应；N 超出地址个数时为「追加端点」）：
 *   LLM2_ENDPOINT_1_LABEL=主站                # 展示名，缺省「端点 N」
 *   LLM2_ENDPOINT_1_MODELS=agnes-3.0-flash    # 覆盖该端点的模型清单
 *   LLM2_ENDPOINT_2_URL=https://backup/v1     # 追加/覆盖端点地址
 *   LLM2_ENDPOINT_2_KEY=sk-backup             # 端点独立凭证，缺省继承渠道
 *   LLM2_ENDPOINT_2_TIMEOUT=120000
 *   LLM2_ENDPOINT_2_MAX_TOKENS=8192
 *   LLM2_ENDPOINT_2_ENABLED=false
 *   LLM2_ENDPOINT_2_PARAMS={"temperature":0.3}  # 自定义参数，透传给上游
 *
 * 兼容：单值写法 LLM2_MODEL / LLM2_BASE_URL 仍然支持，且优先级更高
 *      （会被插到列表最前、成为默认项），避免旧部署配置失效。
 *      未配置任何 LLMx_ENDPOINT_* 时，端点退化为「每个地址共享渠道模型清单」，
 *      行为与改造前完全一致。
 */

const logger = require('../utils/logger');

/** 未显式配置 maxTokens 时的兜底值 */
const DEFAULT_MAX_TOKENS = 65536;
/** 未显式配置 timeout 时的兜底值（毫秒） */
const DEFAULT_TIMEOUT = 30000;
/** 端点序号探测上限，防止误配超大序号时无限循环 */
const MAX_ENDPOINT_INDEX = 50;

const ENDPOINT_STRATEGIES = ['priority', 'round-robin', 'random'];

/**
 * 读取逗号分隔的列表型环境变量。
 * @param {string} key
 * @returns {string[]} 已 trim、已剔除空项
 */
function envList(key) {
    const raw = process.env[key];
    if (!raw) return [];
    return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * 读取正整数型环境变量；非法或缺失时返回 fallback。
 * @param {string} key
 * @param {number|null} fallback
 */
function envInt(key, fallback) {
    const n = parseInt(process.env[key], 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 解析布尔型环境变量；非法或缺失时返回 fallback */
function envBool(key, fallback) {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return fallback;
    return String(raw).toLowerCase() === 'true';
}

/**
 * 解析 JSON 型环境变量（自定义参数）。
 * 解析失败不抛错：配错了只该丢掉这段参数，不该让整个渠道消失。
 */
function envJson(key, fallback) {
    const raw = process.env[key];
    if (!raw) return fallback;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        logger.warn(`[preset-models] ${key} 不是 JSON 对象，已忽略`);
    } catch (_) {
        logger.warn(`[preset-models] ${key} 不是合法 JSON，已忽略`);
    }
    return fallback;
}

/**
 * 组装渠道下的端点列表（env 种子）。
 *
 * @param {string} p - 环境变量前缀，如 'LLM2'
 * @param {Object} base - 渠道级默认值
 * @param {string[]} base.baseUrls - 端点地址列表
 * @param {string} base.apiKey - 渠道凭证
 * @param {string} base.protocol
 * @param {number} base.timeout
 * @param {number} base.maxTokens
 * @param {string[]} base.models - 渠道模型清单
 * @returns {Array<Object>} 端点数组（source='env'，按 priority 升序）
 */
function buildEnvEndpoints(p, base) {
    // 先探测实际配置了多少个端点：取「地址个数」与「显式 ENDPOINT_N_* 的最大序号」的较大者，
    // 这样 ENDPOINT_3_URL 这种「只写了序号没写进 BASE_URLS」的追加端点也能被识别。
    let maxIndex = base.baseUrls.length;
    for (let n = 1; n <= MAX_ENDPOINT_INDEX; n++) {
        const hasAny = process.env[`${p}_ENDPOINT_${n}_URL`]
            || process.env[`${p}_ENDPOINT_${n}_MODELS`]
            || process.env[`${p}_ENDPOINT_${n}_KEY`]
            || process.env[`${p}_ENDPOINT_${n}_LABEL`];
        if (hasAny) maxIndex = Math.max(maxIndex, n);
    }

    const endpoints = [];
    for (let n = 1; n <= maxIndex; n++) {
        const url = (process.env[`${p}_ENDPOINT_${n}_URL`] || base.baseUrls[n - 1] || '').trim();
        if (!url) continue; // 序号中间有空洞则跳过

        const modelsRaw = process.env[`${p}_ENDPOINT_${n}_MODELS`];
        endpoints.push({
            // id 用「渠道:序号」：env 端点没有 DB 主键，但前端需要稳定 key 做 diff
            id: `env:${p}:${n}`,
            label: process.env[`${p}_ENDPOINT_${n}_LABEL`] || `端点 ${n}`,
            baseUrl: url,
            apiKey: process.env[`${p}_ENDPOINT_${n}_KEY`] || base.apiKey,
            // 端点级 API Key 是「自带」还是「继承渠道」，前端据此提示
            inheritsKey: !process.env[`${p}_ENDPOINT_${n}_KEY`],
            protocol: process.env[`${p}_ENDPOINT_${n}_PROTOCOL`] || base.protocol,
            timeout: envInt(`${p}_ENDPOINT_${n}_TIMEOUT`, base.timeout),
            maxTokens: envInt(`${p}_ENDPOINT_${n}_MAX_TOKENS`, base.maxTokens),
            models: modelsRaw ? envList(`${p}_ENDPOINT_${n}_MODELS`) : [...base.models],
            enabled: envBool(`${p}_ENDPOINT_${n}_ENABLED`, true),
            extraParams: envJson(`${p}_ENDPOINT_${n}_PARAMS`, {}),
            priority: envInt(`${p}_ENDPOINT_${n}_PRIORITY`, n * 10),
            source: 'env'
        });
    }
    return endpoints.sort((a, b) => a.priority - b.priority);
}

/**
 * 组装单个渠道的预设；关键配置缺失时返回 null（该渠道不注册）。
 * @param {Object} opts
 * @param {string} opts.envPrefix        - 环境变量前缀，如 'LLM2'
 * @param {string} opts.id               - 渠道标识，如 'agnes'
 * @param {string} opts.provider
 * @param {string} opts.fallbackLabel
 * @param {string} opts.fallbackProtocol
 * @param {string} opts.fallbackModel    - 既没配 LLMx_MODELS 也没配 LLMx_MODEL 时的模型
 * @param {number} opts.fallbackMaxTokens
 * @param {number} [opts.fallbackContextWindow]
 * @param {boolean} opts.includeApiKey
 */
function buildPreset(opts) {
    const p = opts.envPrefix;
    const apiKey = process.env[`${p}_API_KEY`];
    if (!apiKey) return null;

    // 基础地址：单值写法优先，其次列表；都没有则不注册该渠道
    const baseUrls = envList(`${p}_BASE_URLS`);
    const singleBaseUrl = process.env[`${p}_BASE_URL`];
    if (singleBaseUrl) baseUrls.unshift(singleBaseUrl);
    if (baseUrls.length === 0) return null;

    // 模型清单：单值写法优先，其次列表，最后兜底模型
    const models = envList(`${p}_MODELS`);
    const singleModel = process.env[`${p}_MODEL`];
    if (singleModel) models.unshift(singleModel);
    if (models.length === 0 && opts.fallbackModel) models.push(opts.fallbackModel);

    const inputModalities = envList(`${p}_INPUT_MODALITIES`);
    const outputModalities = envList(`${p}_OUTPUT_MODALITIES`);

    const protocol = process.env[`${p}_PROTOCOL`] || opts.fallbackProtocol;
    const timeout = envInt(`${p}_TIMEOUT`, DEFAULT_TIMEOUT);
    const maxTokens = envInt(`${p}_MAX_TOKENS`, opts.fallbackMaxTokens);
    const strategy = (process.env[`${p}_ENDPOINT_STRATEGY`] || 'priority').toLowerCase();

    // 端点树：env 种子；未配 LLMx_ENDPOINT_* 时退化为「每个地址共享渠道模型清单」
    const endpoints = buildEnvEndpoints(p, { baseUrls, apiKey, protocol, timeout, maxTokens, models });

    return {
        id: opts.id,
        name: process.env[`${p}_LABEL`] || opts.fallbackLabel,
        provider: opts.provider,
        protocol,
        apiKey: opts.includeApiKey ? apiKey : '***已配置***',
        // 默认项（列表首个）与完整清单
        baseUrl: baseUrls[0],
        baseUrls,
        model: models[0] || '',
        models,
        // 端点树（渠道 → 端点 → 模型）
        endpoints,
        endpointStrategy: ENDPOINT_STRATEGIES.includes(strategy) ? strategy : 'priority',
        // 默认模型的能力规格
        maxTokens,
        contextWindow: envInt(`${p}_CONTEXT_WINDOW`, opts.fallbackContextWindow || null),
        inputModalities: inputModalities.length ? inputModalities : ['text'],
        outputModalities: outputModalities.length ? outputModalities : ['text'],
        timeout
    };
}

/**
 * 获取系统预设的 AI 模型列表
 * @param {boolean} includeApiKey - 是否包含真实的 API Key（用于后端操作）
 */
function getPresetModels(includeApiKey = false) {
    return [
        // LLM1 (Mistral)
        buildPreset({
            envPrefix: 'LLM',
            id: 'mistral',
            provider: 'mistral',
            fallbackLabel: 'Mistral Small',
            fallbackProtocol: 'openai',
            fallbackModel: 'mistral-small-latest',
            fallbackMaxTokens: 3000,
            fallbackContextWindow: 32768,
            includeApiKey
        }),
        // LLM2 (Agnes AI)
        buildPreset({
            envPrefix: 'LLM2',
            id: 'agnes',
            provider: 'agnes',
            fallbackLabel: 'Agnes AI',
            fallbackProtocol: 'openai',
            fallbackModel: 'agnes-3.0-flash',
            fallbackMaxTokens: DEFAULT_MAX_TOKENS,
            fallbackContextWindow: 524288,
            includeApiKey
        }),
        // LLM3 (OpenModel API)
        buildPreset({
            envPrefix: 'LLM3',
            id: 'openmodel',
            provider: 'openmodel',
            fallbackLabel: 'OpenModel API',
            fallbackProtocol: 'messages',
            fallbackModel: 'deepseek-v4-flash',
            fallbackMaxTokens: 3000,
            includeApiKey
        }),
        // LLM4 (SenseNova)
        buildPreset({
            envPrefix: 'LLM4',
            id: 'sensenova',
            provider: 'sensenova',
            fallbackLabel: 'SenseNova',
            fallbackProtocol: 'openai',
            fallbackModel: 'sensenova-6.7-flash-lite',
            fallbackMaxTokens: 3000,
            includeApiKey
        })
    ].filter(Boolean);
}

module.exports = {
    getPresetModels,
    buildEnvEndpoints,
    envList,
    envInt,
    envBool,
    envJson,
    ENDPOINT_STRATEGIES,
    DEFAULT_MAX_TOKENS,
    DEFAULT_TIMEOUT
};
