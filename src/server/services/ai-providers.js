/**
 * AI provider 默认配置（单一来源）
 * @description 替代原本散落在 ai-service.js 与 ai-config-store.js 两处的重复定义。
 *              两个模块都应从这里 import，避免新增 provider 时漏改一边导致行为漂移。
 *              注意：此处的 baseUrl/model/protocol 仅作为「未配置时的兜底默认值」，
 *              真正的生效配置以 ai-config-store（DB 或环境变量）为准。
 */

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
        baseUrl: 'https://apihub.agnes-ai.com/v1',
        model: 'agnes-3.0-flash',
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

/**
 * 解析 provider 名到其默认配置；未知 provider 回退到 custom。
 * @param {string} provider
 * @returns {{baseUrl:string, model:string, protocol:string}}
 */
function providerDefault(provider) {
    const p = (provider || '').toLowerCase();
    return PROVIDER_DEFAULTS[p] || PROVIDER_DEFAULTS.custom;
}

module.exports = { PROVIDER_DEFAULTS, providerDefault };
