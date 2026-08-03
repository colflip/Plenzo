/**
 * 预设 AI 模型配置
 * @description 从环境变量读取系统预设的 AI 模型
 */

/**
 * 获取系统预设的 AI 模型列表
 * @param {boolean} includeApiKey - 是否包含真实的 API Key（用于后端操作）
 */
function getPresetModels(includeApiKey = false) {
    const presets = [];

    // LLM1 (Mistral)
    if (process.env.LLM_API_KEY && process.env.LLM_BASE_URL) {
        presets.push({
            id: 'mistral',
            name: process.env.LLM_LABEL || 'Mistral Small',
            provider: 'mistral',
            protocol: process.env.LLM_PROTOCOL || 'openai',
            apiKey: includeApiKey ? process.env.LLM_API_KEY : '***已配置***',
            baseUrl: process.env.LLM_BASE_URL,
            model: process.env.LLM_MODEL || 'mistral-small-latest',
            timeout: 30000,
            maxTokens: 3000
        });
    }

    // LLM2 (Agnes AI)
    if (process.env.LLM_ALT_API_KEY && process.env.LLM_ALT_BASE_URL) {
        presets.push({
            id: 'agnes',
            name: process.env.LLM_ALT_LABEL || 'Agnes AI',
            provider: 'agnes',
            protocol: process.env.LLM_ALT_PROTOCOL || 'openai',
            apiKey: includeApiKey ? process.env.LLM_ALT_API_KEY : '***已配置***',
            baseUrl: process.env.LLM_ALT_BASE_URL,
            model: process.env.LLM_ALT_MODEL || 'agnes-2.0-flash',
            timeout: 30000,
            maxTokens: 3000
        });
    }

    // LLM3 (OpenModel API)
    if (process.env.LLM_ALT2_API_KEY && process.env.LLM_ALT2_BASE_URL) {
        presets.push({
            id: 'openmodel',
            name: process.env.LLM_ALT2_LABEL || 'OpenModel API',
            provider: 'openmodel',
            protocol: process.env.LLM_ALT2_PROTOCOL || 'messages',
            apiKey: includeApiKey ? process.env.LLM_ALT2_API_KEY : '***已配置***',
            baseUrl: process.env.LLM_ALT2_BASE_URL,
            model: process.env.LLM_ALT2_MODEL || 'deepseek-v4-flash',
            timeout: 30000,
            maxTokens: 3000
        });
    }

    // LLM4 (SenseNova)
    if (process.env.LLM_ALT3_API_KEY && process.env.LLM_ALT3_BASE_URL) {
        presets.push({
            id: 'sensenova',
            name: process.env.LLM_ALT3_LABEL || 'SenseNova',
            provider: 'sensenova',
            protocol: process.env.LLM_ALT3_PROTOCOL || 'openai',
            apiKey: includeApiKey ? process.env.LLM_ALT3_API_KEY : '***已配置***',
            baseUrl: process.env.LLM_ALT3_BASE_URL,
            model: process.env.LLM_ALT3_MODEL || 'sensenova-6.7-flash-lite',
            timeout: 30000,
            maxTokens: 3000
        });
    }

    return presets;
}

module.exports = { getPresetModels };
