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
const aiUserModelStore = require('./ai-user-model-store');

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
     * @param {string} [userType] - admin / teacher / student，与 userId 一起定位偏好行
     * @param {number} [userId] - 传入时优先按该用户自选的模型返回能力，
     *                            使前端「上传图片」等按钮跟随用户实际会用到的模型。
     */
    async getModelCapabilities(userType, userId) {
        let model = aiService.getAIConfig().model;

        if (userId && userType) {
            const pref = await aiUserModelStore.getUserModel(userType, userId).catch(() => null);
            if (pref && pref.modelId) model = pref.modelId;
        }

        const allModels = this._loadModelCatalog();
        const found = this._findModelInCatalog(allModels, model);

        return {
            status: 200,
            body: standardResponse(true, {
                capabilities: found ? found.capabilities : { vision: false, tools: false, reasoning: false },
                model
            })
        };
    }

    /**
     * 读取模型目录（ai-models.json）。读失败返回空目录，调用方按「无能力」降级。
     */
    _loadModelCatalog() {
        try {
            return JSON.parse(fs.readFileSync(MODELS_FILE_PATH, 'utf8'));
        } catch (error) {
            logger.warn('[AI] 读取模型目录失败:', error.message || error);
            return {};
        }
    }

    /**
     * 在模型目录中按 id 查找模型定义
     * @param {Object} catalog
     * @param {string} modelId
     * @param {string} [provider] - 限定渠道；不传则跨渠道查找首个同名模型
     */
    _findModelInCatalog(catalog, modelId, provider) {
        if (!modelId) return null;
        const entries = provider
            ? [[provider, catalog[provider] || []]]
            : Object.entries(catalog);
        for (const [, models] of entries) {
            const hit = (models || []).find(m => m.id === modelId);
            if (hit) return hit;
        }
        return null;
    }

    /**
     * 用户可选的模型清单（GET /api/ai/selectable-models）
     * @description 只暴露 env 中已配置好的预设渠道 × 模型目录的交集，且**不含任何密钥**：
     *              前端拿到的仅是 presetId / modelId 标识符，真实凭证在 resolveUserConfig
     *              里由服务端补全。
     * @param {string} userType - admin / teacher / student
     * @param {number} userId
     */
    async getSelectableModels(userType, userId) {
        const catalog = this._loadModelCatalog();
        const presets = getPresetModels(false);
        const globalConfig = aiService.getAIConfig();

        const options = presets.map(preset => {
            const catalogModels = catalog[preset.provider] || [];
            // 预设默认模型可能未收录在目录里，补一条兜底项，避免用户看不到当前渠道默认值
            const hasDefault = catalogModels.some(m => m.id === preset.model);
            const models = catalogModels.map(m => ({
                id: m.id,
                name: m.name,
                capabilities: m.capabilities,
                contextLength: m.contextLength,
                isPresetDefault: m.id === preset.model
            }));
            if (!hasDefault && preset.model) {
                models.unshift({
                    id: preset.model,
                    name: preset.model,
                    capabilities: { vision: false, tools: false, reasoning: false },
                    contextLength: null,
                    isPresetDefault: true
                });
            }
            return {
                presetId: preset.id,
                presetName: preset.name,
                provider: preset.provider,
                models
            };
        }).filter(group => group.models.length > 0);

        const pref = await aiUserModelStore.getUserModel(userType, userId).catch(() => null);

        return {
            status: 200,
            body: standardResponse(true, {
                presets: options,
                current: {
                    presetId: pref ? pref.presetId : null,
                    modelId: pref ? pref.modelId : globalConfig.model,
                    isDefault: !pref
                },
                defaultModel: {
                    modelId: globalConfig.model,
                    provider: globalConfig.provider
                }
            })
        };
    }

    /**
     * 读取当前用户的模型选择（GET /api/ai/my-model）
     * @param {string} userType
     * @param {number} userId
     */
    async getMyModel(userType, userId) {
        const pref = await aiUserModelStore.getUserModel(userType, userId).catch(() => null);
        const globalConfig = aiService.getAIConfig();
        const modelId = pref ? pref.modelId : globalConfig.model;
        const found = this._findModelInCatalog(this._loadModelCatalog(), modelId);

        return {
            status: 200,
            body: standardResponse(true, {
                presetId: pref ? pref.presetId : null,
                modelId,
                modelName: found ? found.name : modelId,
                isDefault: !pref
            })
        };
    }

    /**
     * 校验「用户提交的渠道 + 模型」是允许的组合。
     * 保存（setMyModel）与验通（verifyUserModel）共用同一套判定：两处若各写一份，
     * 就会出现「能保存但验不过」或反之的组合。
     * @returns {{preset: object, known: object|null}}
     * @throws {AppError} 400
     */
    _resolveCandidate(presetId, modelId) {
        const preset = getPresetModels(false).find(p => p.id === presetId);
        if (!preset) {
            throw new AppError('指定的 AI 渠道不可用', 400);
        }

        const known = this._findModelInCatalog(this._loadModelCatalog(), modelId, preset.provider);
        if (!known && modelId !== preset.model) {
            throw new AppError('指定的模型不在该渠道的可选范围内', 400);
        }
        return { preset, known };
    }

    /**
     * 设置当前用户的模型（PUT /api/ai/my-model）
     * @description 只接受 presetId + modelId，且必须命中「env 已配置的预设 × 模型目录」，
     *              防止把任意字符串写进偏好后在请求时打到未预期的端点。
     * @param {string} userType
     * @param {number} userId
     */
    async setMyModel(userType, userId, { presetId, modelId }) {
        const { known } = this._resolveCandidate(presetId, modelId);

        await aiUserModelStore.setUserModel(userType, userId, { presetId, modelId });

        return {
            status: 200,
            body: standardResponse(true, {
                presetId,
                modelId,
                modelName: known ? known.name : modelId,
                isDefault: false,
                message: '已切换模型，仅对你本人生效'
            })
        };
    }

    /**
     * 验通「用户想切换到的模型」但不落库（POST /api/ai/my-model/check）。
     * @description 存在的理由：模型选错时不该等到用户下次提问才发现助手已经坏了。
     *              只做一次极小的补全请求，判定「能不能用」，然后由前端决定是否真的保存。
     *
     *              不接收客户端传来的 baseUrl / apiKey —— 渠道凭证一律由服务端按 presetId
     *              从 env 补全。否则这个接口就成了「带着服务端密钥去打任意地址」的探测器。
     *              返回体同样不含任何密钥。
     * @returns {Promise<{status:number, body:object}>} available=false 也是 200：
     *          「这个模型不通」是正常业务结果，不是服务端错误。
     */
    async verifyUserModel({ presetId, modelId }) {
        // 先用与保存同一套规则挡掉非法组合，避免拿脏参数去打上游
        const { preset } = this._resolveCandidate(presetId, modelId);

        const full = getPresetModels(true).find(p => p.id === presetId);
        if (!full || !full.apiKey || !full.baseUrl) {
            return {
                status: 200,
                body: standardResponse(true, { available: false, error: '该渠道未配置凭证，请联系管理员' })
            };
        }

        const globalConfig = aiService.getAIConfig();
        const testConfig = {
            enabled: true,
            provider: full.provider,
            protocol: full.protocol,
            apiKey: full.apiKey,
            baseUrl: full.baseUrl,
            model: modelId,
            // 探活不该按用户模型的大 token 预算花上游的钱，固定小上限
            timeout: Math.min(10000, globalConfig.timeout || full.timeout || 10000),
            maxTokens: 20
        };

        try {
            const startTime = Date.now();
            await aiService.chat([{ role: 'user', content: 'test' }], { configOverride: testConfig });
            return {
                status: 200,
                body: standardResponse(true, { available: true, latency: Date.now() - startTime })
            };
        } catch (error) {
            logger.warn('[AI] 用户模型验通失败:', error.message || error);
            // 上游错误细节（可能含端点/凭证片段）不外传，只给「不通」
            return {
                status: 200,
                body: standardResponse(true, { available: false, error: '该模型当前不可用，请换一个或保持原选择' })
            };
        }
    }

    /**
     * 清除当前用户的模型选择，回到跟随全局默认（DELETE /api/ai/my-model）
     * @param {string} userType
     * @param {number} userId
     */
    async clearMyModel(userType, userId) {
        await aiUserModelStore.clearUserModel(userType, userId);
        const globalConfig = aiService.getAIConfig();
        return {
            status: 200,
            body: standardResponse(true, {
                presetId: null,
                modelId: globalConfig.model,
                isDefault: true,
                message: '已恢复为系统默认模型'
            })
        };
    }

    /**
     * 把用户偏好解析成完整的 LLM 调用配置（含密钥，**仅服务端使用**）
     * @description 供 ai-controller 作为 aiService.chat 的 configOverride 传入。
     *              渠道/模型来自用户选择，timeout 与 maxTokens 沿用全局配置，
     *              让切换模型只改「用哪个模型」，不改助手的行为参数。
     * @param {string} userType
     * @param {number} userId
     * @returns {Promise<Object|null>} null 表示该用户未自选，按全局配置走
     */
    async resolveUserConfig(userType, userId) {
        if (!userId || !userType) return null;

        const pref = await aiUserModelStore.getUserModel(userType, userId).catch(() => null);
        if (!pref || !pref.presetId || !pref.modelId) return null;

        const preset = getPresetModels(true).find(p => p.id === pref.presetId);
        // 预设可能因 env 调整而消失，此时静默回退全局配置，不让用户的助手直接不可用
        if (!preset || !preset.apiKey || !preset.baseUrl) return null;

        const globalConfig = aiService.getAIConfig();
        return {
            enabled: true,
            provider: preset.provider,
            protocol: preset.protocol,
            apiKey: preset.apiKey,
            baseUrl: preset.baseUrl,
            model: pref.modelId,
            timeout: globalConfig.timeout || preset.timeout,
            maxTokens: globalConfig.maxTokens || preset.maxTokens
        };
    }
}

module.exports = new AIConfigService();
