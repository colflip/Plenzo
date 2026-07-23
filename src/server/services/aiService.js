/**
 * AI 服务层 (AI Service)
 * @description 统一封装大模型 (LLM) 调用。支持两种协议：
 *              - openai  : OpenAI Chat Completions 协议（OpenAI / DeepSeek 官方 / 通义千问兼容模式）
 *              - messages: Anthropic Messages 协议（Claude，以及按 messages 协议路由的网关模型，
 *                          如 deepseek-v4-flash @ openmodel.ai）
 *              密钥仅存于后端，前端只通过 /api/ai/* 间接调用。
 *
 *              对上层 (controller) 始终暴露 OpenAI 形状的响应（choices[0].message + tool_calls），
 *              messages 协议在本模块内部做双向翻译，controller 无需感知差异。
 * @module services/aiService
 *
 * 环境变量:
 *   AI_ENABLED   (true/false)   AI 总开关，false 时 isAvailable() 返回 false
 *   AI_PROVIDER  openai|deepseek|qwen|anthropic|custom   仅影响默认 BASE_URL / MODEL / PROTOCOL
 *   AI_PROTOCOL  openai|messages   可选，覆盖默认协议（custom 网关常需手动指定）
 *   AI_API_KEY   sk-xxx          LLM 服务商密钥
 *   AI_BASE_URL  可选，覆盖默认 endpoint（需含 /v1 等版本段，如 https://api.openmodel.ai/v1）
 *   AI_MODEL     可选，覆盖默认模型名
 *   AI_TIMEOUT   可选，单次请求超时(毫秒)，默认 30000
 *   AI_MAX_TOKENS 可选，回复最大 token 数，默认 2000
 */

const { AppError } = require('../middleware/error');
const axios = require('axios');
const https = require('https');

// 开发环境下跳过 TLS 验证（解决代理/MITM 导致的 TLS 错误）
const isDev = process.env.NODE_ENV === 'development';
const httpsAgent = isDev ? new https.Agent({
    rejectUnauthorized: false,
    keepAlive: false,           // 禁用连接池复用，避免连接被中间代理断开
    timeout: 30000
}) : undefined;
const axiosInstance = axios.create({
    httpsAgent,
    // 禁用 axios 默认的 proxy 配置，避免干扰
    proxy: false
});

// 各 provider 的默认配置（protocol 决定走哪套请求/响应格式）
const PROVIDER_DEFAULTS = {
    openai: {
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        protocol: 'openai'
    },
    deepseek: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        protocol: 'openai'
    },
    qwen: {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-plus',
        protocol: 'openai'
    },
    anthropic: {
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-haiku-4-5-20251001',
        protocol: 'messages'
    },
    agnes: {
        baseUrl: 'https://api.agnes.ai/v1',
        model: 'gpt-4',
        protocol: 'openai'
    },
    openmodel: {
        baseUrl: 'https://api.openmodel.ai/v1',
        model: 'deepseek-v4-flash',
        protocol: 'openai'
    },
    mistral: {
        baseUrl: 'https://api.mistral.ai/v1',
        model: 'mistral-small-latest',
        protocol: 'openai'
    },
    custom: {
        baseUrl: '',
        model: 'gpt-3.5-turbo',
        protocol: 'openai'
    }
};

const ANTHROPIC_VERSION = '2023-06-01';

/**
 * 读取并归一化 AI 配置
 */
function getAIConfig() {
    const provider = (process.env.AI_PROVIDER || 'deepseek').toLowerCase();
    const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.custom;
    const protocol = (process.env.AI_PROTOCOL || defaults.protocol || 'openai').toLowerCase();
    return {
        enabled: String(process.env.AI_ENABLED || '').toLowerCase() === 'true',
        provider,
        protocol: protocol === 'messages' ? 'messages' : 'openai',
        apiKey: process.env.AI_API_KEY || '',
        baseUrl: process.env.AI_BASE_URL || defaults.baseUrl,
        model: process.env.AI_MODEL || defaults.model,
        timeout: parseInt(process.env.AI_TIMEOUT, 10) || 30000,
        maxTokens: parseInt(process.env.AI_MAX_TOKENS, 10) || 8000
    };
}

/**
 * 是否启用 AI（密钥存在 + AI_ENABLED=true）
 */
function isAvailable() {
    const cfg = getAIConfig();
    return cfg.enabled && !!cfg.apiKey && !!cfg.baseUrl;
}

/**
 * 将 LLM HTTP 错误归一化为 AppError
 */
function normalizeLLMError(err, statusCode) {
    // 提取 LLM API 返回的详细错误信息
    const apiDetail = err.response?.data?.error?.message
        || err.response?.data?.detail
        || err.response?.data?.message;

    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
        return new AppError('AI 请求超时，请稍后重试', 504);
    }
    if (err.code === 'ECONNRESET' || err.code === 'ERR_TLS_HANDSHAKE_TIMEOUT' ||
        err.code === 'EPIPE' || err.message?.includes('TLS') || err.message?.includes('disconnected before secure')) {
        return new AppError('AI 服务连接中断，请稍后重试', 502);
    }
    if (statusCode === 429) {
        return new AppError('AI 请求过于频繁，请稍后重试', 429);
    }
    if (statusCode === 401 || statusCode === 403) {
        return new AppError('AI 服务鉴权失败，请检查 API Key 配置', 503);
    }
    if (statusCode === 404) {
        return new AppError('AI 服务返回 404：请检查 AI_BASE_URL 与 AI_PROTOCOL 是否匹配', 502);
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ENETUNREACH') {
        return new AppError('AI 服务暂时不可用，请稍后重试', 503);
    }
    return new AppError(apiDetail || err?.message || 'AI 服务调用失败', statusCode || 502);
}

/* ============================================================
 * 协议适配层：OpenAI <-> Anthropic Messages 双向翻译
 *
 * controller 始终以 OpenAI 形状思考：
 *   - 入参 messages: [{role:'system'|'user'|'assistant'|'tool', content, tool_calls?, tool_call_id?}]
 *   - 出参 data:     {choices:[{message:{content, tool_calls?}}]}
 *   - tools:         [{type:'function', function:{name, description, parameters}}]
 * 本层把它们翻译成 Anthropic Messages 协议，再把响应翻译回 OpenAI 形状。
 * ============================================================ */

/** OpenAI tools 定义 -> Anthropic tools 定义 */
function toAnthropicTools(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return undefined;
    return tools.map(t => {
        const fn = t.function || t;
        return {
            name: fn.name,
            description: fn.description || '',
            input_schema: fn.parameters || { type: 'object', properties: {} }
        };
    });
}

/** OpenAI tool_choice -> Anthropic tool_choice */
function toAnthropicToolChoice(toolChoice) {
    if (!toolChoice || toolChoice === 'auto') return { type: 'auto' };
    if (toolChoice === 'none') return undefined; // 不传则模型自行决定，none 在 Anthropic 用空 tools 表达
    if (toolChoice === 'required' || toolChoice === 'any') return { type: 'any' };
    if (typeof toolChoice === 'object' && toolChoice.function?.name) {
        return { type: 'tool', name: toolChoice.function.name };
    }
    return { type: 'auto' };
}

/**
 * OpenAI messages -> { system, messages } (Anthropic 形状)
 * 关键点：
 *  - system 角色提取为顶层 system 字符串
 *  - assistant 含 tool_calls -> content 块数组 (优先复用 _anthropicContent 以保留 thinking 块及签名)
 *  - tool 角色 -> user 角色的 tool_result 块；连续多个 tool 合并进同一条 user 消息
 */
function toAnthropicMessages(messages) {
    let system = '';
    const out = [];

    for (const m of messages) {
        if (m.role === 'system') {
            system += (system ? '\n\n' : '') + (m.content || '');
            continue;
        }

        if (m.role === 'tool') {
            // 把 tool 结果挂到上一条 user(tool_result) 消息，或新建一条
            const block = {
                type: 'tool_result',
                tool_use_id: m.tool_call_id,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
            };
            const last = out[out.length - 1];
            if (last && last.role === 'user' && Array.isArray(last.content) &&
                last.content.every(b => b.type === 'tool_result')) {
                last.content.push(block);
            } else {
                out.push({ role: 'user', content: [block] });
            }
            continue;
        }

        if (m.role === 'assistant') {
            // 复用原始 Anthropic content（含 thinking 块 + 签名），保证带工具的续轮不报错
            if (m._anthropicContent) {
                out.push({ role: 'assistant', content: m._anthropicContent });
                continue;
            }
            if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                const blocks = [];
                if (m.content) blocks.push({ type: 'text', text: m.content });
                for (const call of m.tool_calls) {
                    let input = {};
                    try { input = JSON.parse(call.function.arguments || '{}'); } catch (_) { /* noop */ }
                    blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
                }
                out.push({ role: 'assistant', content: blocks });
            } else {
                out.push({ role: 'assistant', content: m.content || '' });
            }
            continue;
        }

        // user
        if (Array.isArray(m.content)) {
            // 多模态：OpenAI 形状的 content 块数组（text / image_url）→ Anthropic 块（text / image）
            const blocks = [];
            for (const part of m.content) {
                if (!part || typeof part !== 'object') continue;
                if (part.type === 'text') {
                    blocks.push({ type: 'text', text: part.text || '' });
                } else if (part.type === 'image_url') {
                    const url = part.image_url?.url || '';
                    const dataMatch = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
                    if (dataMatch) {
                        blocks.push({
                            type: 'image',
                            source: { type: 'base64', media_type: dataMatch[1], data: dataMatch[2] }
                        });
                    } else if (/^https?:\/\//.test(url)) {
                        blocks.push({ type: 'image', source: { type: 'url', url } });
                    }
                }
            }
            out.push({ role: 'user', content: blocks.length > 0 ? blocks : '' });
        } else {
            out.push({ role: 'user', content: m.content || '' });
        }
    }

    return { system: system || undefined, messages: out };
}

/**
 * Anthropic 响应 -> OpenAI 形状响应
 * 把 content 块数组拆成 text（合并）+ tool_calls，并把原始 content 挂到
 * message._anthropicContent，供下一轮 toAnthropicMessages 原样回传（保留 thinking）。
 */
function fromAnthropicResponse(data) {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    let text = '';
    const toolCalls = [];

    for (const b of blocks) {
        if (b.type === 'text') {
            text += b.text || '';
        } else if (b.type === 'tool_use') {
            toolCalls.push({
                id: b.id,
                type: 'function',
                function: {
                    name: b.name,
                    arguments: JSON.stringify(b.input || {})
                }
            });
        }
        // thinking 块不进入 text，但通过 _anthropicContent 原样保留
    }

    const message = { role: 'assistant', content: text || null, _anthropicContent: blocks };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;

    return {
        choices: [{ message, finish_reason: data?.stop_reason || 'stop' }],
        usage: data?.usage
    };
}

/* ============================================================
 * 协议端点拼接
 * ============================================================ */

/**
 * 规整 baseUrl 并拼出最终端点。
 * - openai 协议   -> {base}/chat/completions
 * - messages 协议 -> {base}/messages
 * 若 base 不含版本段（/v1 等），messages 协议会自动补 /v1（多数网关要求）。
 */
function buildEndpoint(baseUrl, protocol) {
    let base = (baseUrl || '').replace(/\/+$/, '');
    if (protocol === 'messages') {
        if (!/\/v\d+$/.test(base)) base += '/v1';
        return `${base}/messages`;
    }
    return `${base}/chat/completions`;
}

/* ============================================================
 * 统一对话调用（按协议分派）
 * ============================================================ */

/**
 * 通用对话调用。对上层始终返回 OpenAI 形状响应（choices[0].message + tool_calls）。
 * @param {Array} messages - [{role, content, tool_calls?, tool_call_id?}]
 * @param {Object} [options]
 * @param {Array} [options.tools]        - OpenAI function calling 工具定义
 * @param {string} [options.toolChoice]  - 'auto' | 'none' | {type:'function',function:{name}}
 * @param {number} [options.maxTokens]
 * @param {number} [options.temperature]
 * @param {Object} [options.configOverride] - 临时配置覆盖（用于模型测试，避免修改全局 process.env）
 * @returns {Promise<Object>} OpenAI 形状响应 JSON
 */
async function chat(messages, options = {}) {
    // 如果提供了临时配置，使用它；否则从环境变量读取
    const cfg = options.configOverride || getAIConfig();
    if (!options.configOverride && !isAvailable()) {
        throw new AppError('AI 功能未启用或未配置', 503);
    }

    const endpoint = buildEndpoint(cfg.baseUrl, cfg.protocol);
    const hasTools = Array.isArray(options.tools) && options.tools.length > 0;
    let headers;
    let body;

    if (cfg.protocol === 'messages') {
        // ---- Anthropic Messages 协议 ----
        const { system, messages: amsgs } = toAnthropicMessages(messages);
        body = {
            model: cfg.model,
            max_tokens: options.maxTokens || cfg.maxTokens,
            temperature: options.temperature ?? 0.1,  // 降低温度加快推理
            messages: amsgs
        };
        if (system) body.system = system;
        if (hasTools) {
            body.tools = toAnthropicTools(options.tools);
            const tc = toAnthropicToolChoice(options.toolChoice || 'auto');
            if (tc) body.tool_choice = tc;
        }
        // 同时带上两种鉴权头，兼容「Bearer 网关」与「原生 x-api-key」
        headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfg.apiKey}`,
            'x-api-key': cfg.apiKey,
            'anthropic-version': ANTHROPIC_VERSION
        };
    } else {
        // ---- OpenAI Chat Completions 协议 ----
        body = {
            model: cfg.model,
            max_tokens: options.maxTokens || cfg.maxTokens,
            temperature: options.temperature ?? 0.1,  // 降低温度加快推理
            messages
        };
        if (hasTools) {
            body.tools = options.tools;
            body.tool_choice = options.toolChoice || 'auto';
        }
        headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfg.apiKey}`
        };
    }

    // 网络级重试：TLS/连接错误时用新连接重试（最多3次）
    const MAX_RETRIES = 3;
    let resp;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // 每次重试创建新的 httpsAgent，强制新 TCP 连接
            const freshAgent = isDev ? new https.Agent({
                rejectUnauthorized: false,
                keepAlive: false,
                timeout: 30000
            }) : undefined;
            const freshAxios = axios.create({ httpsAgent: freshAgent, proxy: false });

            resp = await freshAxios({
                method: 'POST',
                url: endpoint,
                headers,
                data: body,
                timeout: cfg.timeout
            });
            break; // 成功，退出重试循环
        } catch (err) {
            const status = err.response?.status;
            const isNetworkError = !status && (
                err.code === 'ECONNRESET' ||
                err.code === 'ECONNREFUSED' ||
                err.code === 'ETIMEDOUT' ||
                err.code === 'ENETUNREACH' ||
                err.code === 'ERR_TLS_HANDSHAKE_TIMEOUT' ||
                err.code === 'EPIPE' ||
                err.message?.includes('TLS') ||
                err.message?.includes('socket') ||
                err.message?.includes('ECONNRESET') ||
                err.message?.includes('disconnected before secure')
            );

            if (status) {
                throw normalizeLLMError(err, status);
            }

            // 最后一次重试：用 Node.js 原生 fetch 保底（绕过 axios TLS 处理）
            if (isNetworkError && attempt >= MAX_RETRIES) {
                try {
                    const controller = new AbortController();
                    const fetchTimeout = setTimeout(() => controller.abort(), cfg.timeout);
                    const fetchResp = await fetch(endpoint, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(body),
                        signal: controller.signal
                    });
                    clearTimeout(fetchTimeout);
                    if (!fetchResp.ok) {
                        throw normalizeLLMError(new Error(`HTTP ${fetchResp.status}`), fetchResp.status);
                    }
                    resp = { data: await fetchResp.json() };
                    break;
                } catch (fetchErr) {
                    if (fetchErr instanceof AppError) throw fetchErr;
                    throw normalizeLLMError(fetchErr, fetchErr.status);
                }
            }

            if (!isNetworkError) {
                throw normalizeLLMError(err, status);
            }

            // 等待后重试（指数退避）
            await new Promise(r => setTimeout(r, attempt * 1000));
        }
    }

    if (!resp) throw new AppError('AI 服务调用失败，所有重试均未成功', 502);
    const raw = resp.data;

    // 翻译回 OpenAI 形状
    return cfg.protocol === 'messages' ? fromAnthropicResponse(raw) : raw;
}

/**
 * 强制返回 JSON 的对话调用
 * 在 messages 末尾追加 "只返回合法 JSON" 指令，并解析首条回复为对象。
 * @returns {Promise<Object>} 解析后的 JSON 对象
 */
async function chatJSON(messages, options = {}) {
    const finalMessages = [...messages];
    // 追加 JSON 输出约束（不覆盖用户已有 system 消息）
    finalMessages.push({
        role: 'system',
        content: '请严格以合法 JSON 对象响应，不要包含 ```json 代码块标记、注释或任何额外文字。如果无法回答，返回 {"error": "原因"}。'
    });

    const data = await chat(finalMessages, { ...options, temperature: options.temperature ?? 0 });
    const content = data?.choices?.[0]?.message?.content || '';

    let cleaned = content.trim();
    // 去掉可能的 ```json ... ``` 包裹
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
        cleaned = fenceMatch[1].trim();
    }

    try {
        return JSON.parse(cleaned);
    } catch (err) {
        throw new AppError('AI 返回内容无法解析为 JSON', 502);
    }
}

/**
 * 从 LLM 响应中提取助手文本消息
 */
function extractText(data) {
    return data?.choices?.[0]?.message?.content || '';
}

/**
 * 从 LLM 响应中提取 tool_calls 数组（function calling）
 */
function extractToolCalls(data) {
    const calls = data?.choices?.[0]?.message?.tool_calls;
    return Array.isArray(calls) ? calls : [];
}

module.exports = {
    getAIConfig,
    isAvailable,
    chat,
    chatJSON,
    extractText,
    extractToolCalls,
    buildEndpoint,
    PROVIDER_DEFAULTS,
    // 供单元测试使用的协议翻译内部函数
    toAnthropicMessages,
    toAnthropicTools,
    fromAnthropicResponse
};
