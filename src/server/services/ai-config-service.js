/**
 * AI 配置/模型管理服务 (AI Config Service)
 * @description 下沉 ai-controller 的配置/预设/模型检测类端点逻辑：
 *              getConfig / getPresets / updateConfig / checkModel / testModel /
 *              getAvailableModels / getModelCapabilities。
 *              统一沿用「{status, body}」适配器模式；AppError 向上抛出，由全局错误中间件收口。
 *              LLM 调用层仍在 ai-service（chat/configOverride）；持久化仍在 ai-config-manager。
 * @module services/aiConfigService
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { standardResponse } = require('../middleware/validation');
const { AppError } = require('../middleware/error');
const aiService = require('./ai-service');
const { getPresetModels } = require('./preset-models');
const aiConfigManager = require('./ai-config-manager');

// ai-models.json 与控制器同目录层级（controllers/../data == services/../data）
const MODELS_FILE_PATH = path.join(__dirname, '../data/ai-models.json');

class AIConfigService {
    /**
     * 获取当前 AI 配置（GET /api/ai/config）
     */
    async getConfig() {
        const config = aiService.getAIConfig();
        return {
            status: 200,
            body: standardResponse(true, {
                enabled: config.enabled,
                provider: config.provider,
                protocol: config.protocol,
                baseUrl: config.baseUrl,
                model: config.model,
                timeout: config.timeout,
                maxTokens: config.maxTokens,
                apiKey: config.apiKey ? '***已配置***' : null
            })
        };
    }

    /**
     * 获取预设 AI 模型列表（GET /api/ai/presets，不含真实 API Key）
     */
    async getPresets() {
        const presets = getPresetModels(false); // 不包含真实 API Key
        return { status: 200, body: standardResponse(true, { presets }) };
    }

    /**
     * 更新 AI 配置（PUT /api/ai/config，持久化到数据库跨实例生效）
     */
    async updateConfig(req) {
        const { provider, protocol, apiKey, baseUrl, model, timeout, maxTokens, presetId } = req.body;

        // 如果是预设模型切换，从环境变量获取真实的 API Key
        let realApiKey = apiKey;
        if (presetId) {
            const presets = getPresetModels(true); // 包含真实 API Key
            const preset = presets.find(p => p.id === presetId);
            if (preset) {
                realApiKey = preset.apiKey;
            }
        }

        if (!provider || !realApiKey || !baseUrl || !model) {
            throw new AppError('缺少必要的配置参数', 400);
        }

        // 使用配置管理器更新配置（持久化到数据库，跨实例立即生效，无需重启）
        try {
            await aiConfigManager.updateAIConfig({
                provider,
                protocol: protocol || 'openai',
                apiKey: realApiKey,
                baseUrl,
                model,
                timeout: timeout || 30000,
                maxTokens: maxTokens || 3000
            });
        } catch (err) {
            logger.error('[AI] 更新配置失败:', err && err.message ? err.message : err);
            throw new AppError('配置保存失败，请稍后重试', 500);
        }

        return { status: 200, body: standardResponse(true, { message: '配置已更新并立即生效！' }) };
    }

    /**
     * 检测 AI 模型状态（POST /api/ai/check，快速检测）
     */
    async checkModel(req) {
        const { provider, protocol, apiKey, baseUrl, model, presetId } = req.body;

        // 如果是预设模型，从环境变量获取真实的 API Key
        let realApiKey = apiKey;
        if (presetId) {
            const presets = getPresetModels(true);
            const preset = presets.find(p => p.id === presetId);
            if (preset) {
                realApiKey = preset.apiKey;
            }
        }

        if (!realApiKey || !baseUrl || !model) {
            return {
                status: 200,
                body: standardResponse(false, {
                    available: false,
                    error: '缺少必要的参数'
                })
            };
        }

        try {
            // 快速检测：使用临时配置，避免修改全局 process.env（消除竞态条件）
            const testConfig = {
                enabled: true,
                provider: provider || 'custom',
                protocol: protocol || 'openai',
                apiKey: realApiKey,
                baseUrl,
                model,
                timeout: 8000, // 8秒超时
                maxTokens: 20  // 20 token 足够返回简短响应
            };

            // 发送极简测试请求（通过 configOverride 传入临时配置）
            await aiService.chat([
                { role: 'user', content: 'test' }
            ], { configOverride: testConfig });

            return { status: 200, body: standardResponse(true, { available: true }) };
        } catch (error) {
            logger.error('[AI] 可用性检查失败:', error.message || error);
            return {
                status: 200,
                body: standardResponse(true, {
                    available: false,
                    error: '服务暂不可用'
                })
            };
        }
    }

    /**
     * 测试 AI 模型连接（POST /api/ai/test，完整测试）
     */
    async testModel(req) {
        const { provider, protocol, apiKey, baseUrl, model, timeout, maxTokens, presetId } = req.body;

        // 如果是预设模型测试，从环境变量获取真实的 API Key
        let realApiKey = apiKey;
        if (presetId) {
            const presets = getPresetModels(true); // 包含真实 API Key
            const preset = presets.find(p => p.id === presetId);
            if (preset) {
                realApiKey = preset.apiKey;
            }
        }

        if (!realApiKey || !baseUrl || !model) {
            throw new AppError('缺少必要的测试参数', 400);
        }

        // 使用临时配置（通过 configOverride 传入，避免修改全局 process.env）
        const testConfig = {
            enabled: true,
            provider: provider || 'custom',
            protocol: protocol || 'openai',
            apiKey: realApiKey,
            baseUrl,
            model,
            timeout: timeout || 30000,
            maxTokens: 100  // 增加到 100 token，确保完整响应
        };

        try {
            const startTime = Date.now();

            // 发送测试消息（通过 configOverride 传入临时配置）
            const response = await aiService.chat([
                { role: 'user', content: '请简单回复"测试成功"' }
            ], { configOverride: testConfig });

            const latency = Date.now() - startTime;
            const text = aiService.extractText(response);

            return {
                status: 200,
                body: standardResponse(true, {
                    success: true,
                    latency,
                    model: testConfig.model,
                    response: text
                })
            };
        } catch (error) {
            logger.error('[AI] 模型测试失败:', error.message || error);
            return {
                status: 200,
                body: standardResponse(false, {
                    success: false,
                    error: 'AI 服务请求失败'
                })
            };
        }
    }

    /**
     * 获取所有渠道支持的模型列表（GET /api/ai/models）
     */
    async getAvailableModels() {
        try {
            const modelsData = fs.readFileSync(MODELS_FILE_PATH, 'utf8');
            const models = JSON.parse(modelsData);
            return { status: 200, body: standardResponse(true, { models }) };
        } catch (error) {
            // 如果文件不存在，返回空对象
            return { status: 200, body: standardResponse(true, { models: {} }) };
        }
    }

    /**
     * 获取当前模型的能力信息（GET /api/ai/capabilities）
     */
    async getModelCapabilities() {
        const config = aiService.getAIConfig();

        try {
            const modelsData = fs.readFileSync(MODELS_FILE_PATH, 'utf8');
            const allModels = JSON.parse(modelsData);

            // 根据当前配置查找对应的模型能力
            let capabilities = {
                vision: false,
                tools: false,
                reasoning: false
            };

            // 查找匹配的 provider
            for (const [provider, models] of Object.entries(allModels)) {
                const model = models.find(m => m.id === config.model);
                if (model) {
                    capabilities = model.capabilities;
                    break;
                }
            }

            return { status: 200, body: standardResponse(true, { capabilities, model: config.model }) };
        } catch (error) {
            // 默认返回不支持任何高级功能
            return {
                status: 200,
                body: standardResponse(true, {
                    capabilities: {
                        vision: false,
                        tools: false,
                        reasoning: false
                    },
                    model: config.model
                })
            };
        }
    }
}

module.exports = new AIConfigService();
