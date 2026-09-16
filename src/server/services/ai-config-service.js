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
const endpointStore = require('./ai-endpoint-store');
const endpointRegistry = require('./ai-endpoint-registry');
const { assertSafeBaseUrl } = require('../utils/ssrf-guard');

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
                // 未显式传入时保留现值，不再兜底成 3000
                // （原写法会把「切渠道」顺手把 maxTokens 压回 3000，静默截断长回复）
                maxTokens: maxTokens || undefined
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

        // baseUrl 由客户端提供（本机自定义模型/端点靠它探测连通性），必须过出站护栏
        await assertSafeBaseUrl(baseUrl).catch(err => {
            throw new AppError(err.message, err.status || 400);
        });

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

        // 同 checkModel：baseUrl 来自客户端，必须过出站护栏
        await assertSafeBaseUrl(baseUrl).catch(err => {
            throw new AppError(err.message, err.status || 400);
        });

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

        const options = [];
        for (const preset of presets) {
            const catalogModels = catalog[preset.provider] || [];
            const byId = new Map(catalogModels.map(m => [m.id, m]));

            // 模型清单优先取「端点树上实际挂载的模型」（env 种子 ∪ 数据库覆盖）。
            // 端点一个模型都没挂（DB 不可用等极端情况）时，才回退到渠道级清单与模型目录，
            // 保证新结构出问题时用户看到的清单与改造前一致。
            let ids = await endpointRegistry.listChannelModels(preset.id);
            if (!ids.length) {
                ids = Array.isArray(preset.models) && preset.models.length
                    ? [...preset.models]
                    : catalogModels.map(m => m.id);
            }
            // 渠道默认模型若未出现在清单/目录里，补一条兜底项，避免用户看不到当前渠道默认值
            if (preset.model && !ids.includes(preset.model)) ids.unshift(preset.model);

            const models = ids.map(id => {
                const known = byId.get(id);
                return {
                    id,
                    name: known ? known.name : id,
                    capabilities: known ? known.capabilities : { vision: false, tools: false, reasoning: false },
                    // 目录没收录时用渠道级规格兜底，至少让用户看到数量级
                    contextLength: (known && known.contextLength) || preset.contextWindow || null,
                    maxOutput: (known && known.maxOutput) || preset.maxTokens || null,
                    isPresetDefault: id === preset.model
                };
            });
            if (models.length) {
                options.push({
                    presetId: preset.id,
                    presetName: preset.name,
                    provider: preset.provider,
                    models
                });
            }
        }

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
        // 可选范围 = 模型目录收录 ∪ env 的 LLMx_MODELS 清单 ∪ 渠道默认模型
        const declared = Array.isArray(preset.models) ? preset.models : [];
        if (!known && !declared.includes(modelId) && modelId !== preset.model) {
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
     * 组装单个模型的展示信息（能力 + 上下文 + 最大输出）。
     * @description 目录没收录的模型不给空值，而是回退到渠道级规格 ——
     *              否则「.env 里新加的模型」在界面上会显示成一整片「未知」。
     */
    _describeModel(preset, modelId) {
        const known = this._findModelInCatalog(this._loadModelCatalog(), modelId, preset && preset.provider);
        return {
            id: modelId,
            name: known ? known.name : modelId,
            capabilities: known ? known.capabilities : { vision: false, tools: false, reasoning: false },
            contextLength: (known && known.contextLength) || (preset && preset.contextWindow) || null,
            maxOutput: (known && known.maxOutput) || (preset && preset.maxTokens) || null,
            fromCatalog: !!known
        };
    }

    /**
     * 列出渠道 → 端点 → 模型 树（GET /api/ai/endpoints）
     * @description 合并 env 种子与数据库覆盖；**不含任何真实密钥**，只给 hasOwnKey 标记。
     *              includeDisabled=true 让管理端能看到被停用的端点，否则它们会凭空消失。
     * @param {string} [channelId] - 不传返回所有渠道
     */
    async listEndpoints(channelId) {
        const presets = getPresetModels(false);
        const targets = channelId ? presets.filter(p => p.id === channelId) : presets;

        // 并行读各渠道：某个 DB 查询慢时最多只阻塞一次 READ_TIMEOUT_MS，
        // 不要按渠道串行放大为 4 × timeout。
        const channels = await Promise.all(targets.map(async preset => {
            const endpoints = await endpointRegistry.listMergedEndpoints(preset.id, { includeDisabled: true });
            return {
                channelId: preset.id,
                channelName: preset.name,
                provider: preset.provider,
                strategy: preset.endpointStrategy || 'priority',
                // 渠道级规格，供端点未覆盖字段的展示与前端默认值参考
                channelDefaults: {
                    protocol: preset.protocol,
                    timeout: preset.timeout,
                    maxTokens: preset.maxTokens,
                    contextWindow: preset.contextWindow,
                    models: preset.models
                },
                endpoints: endpoints.map(ep => ({
                    id: ep.id,
                    label: ep.label,
                    baseUrl: ep.baseUrl,
                    hasOwnKey: !!ep.apiKey && !ep.inheritsKey,
                    // env 种子端点没有数据库行：可停用/覆盖（会新建 DB 行），但不可删除
                    editable: typeof ep.id === 'number',
                    inherited: !ep.inheritsKey ? false : true,
                    protocol: ep.protocol,
                    timeout: ep.timeout,
                    maxTokens: ep.maxTokens,
                    enabled: ep.enabled !== false,
                    priority: ep.priority,
                    source: ep.source,
                    extraParams: ep.extraParams || {},
                    models: (ep.models || []).map(m => this._describeModel(preset, m))
                }))
            };
        }));

        return { status: 200, body: standardResponse(true, { channels }) };
    }

    /**
     * 新增端点（POST /api/ai/endpoints）
     */
    async createEndpoint(body) {
        try {
            const created = await endpointStore.createEndpoint(body);
            return { status: 201, body: standardResponse(true, { endpoint: created }) };
        } catch (err) {
            // normalizeEndpoint 抛的是带 status=400 的校验错误，直接透传给用户
            if (err && err.status === 400) throw new AppError(err.message, 400);
            logger.error('[AI] 新增端点失败:', err && err.message ? err.message : err);
            throw new AppError('端点保存失败，请稍后重试', 500);
        }
    }

    /**
     * 更新端点（PUT /api/ai/endpoints/:id）
     * @description id 可以是数据库主键，也可以是 env 种子的 `env:LLM2:1` 形式：
     *              后者没有数据库行，管理员对它做「停用 / 改模型清单」时，
     *              按 (channelId, baseUrl) upsert 一条覆盖行 —— 这也是唯一能
     *              「停用 env 端点」的办法，因为 env 本身不可写。
     */
    async updateEndpoint(id, patch) {
        try {
            if (typeof id === 'number' || /^\d+$/.test(String(id))) {
                const updated = await endpointStore.updateEndpoint(Number(id), patch);
                if (!updated) throw new AppError('端点不存在', 404);
                return { status: 200, body: standardResponse(true, { endpoint: updated }) };
            }

            // env 种子端点：env:LLM2:1
            const [, prefix, index] = String(id).split(':');
            const preset = getPresetModels(false).find(p => p.id === this._channelIdOfPrefix(prefix));
            if (!preset) throw new AppError('端点不存在', 404);
            const seed = (preset.endpoints || [])[Number(index) - 1];
            if (!seed) throw new AppError('端点不存在', 404);

            const existing = await endpointStore.findByUrl(preset.id, seed.baseUrl);
            if (existing) {
                const updated = await endpointStore.updateEndpoint(existing.id, patch);
                return { status: 200, body: standardResponse(true, { endpoint: updated }) };
            }
            const created = await endpointStore.createEndpoint({
                channelId: preset.id,
                baseUrl: seed.baseUrl,
                label: patch.label ?? seed.label,
                models: patch.models ?? seed.models,
                enabled: patch.enabled !== undefined ? patch.enabled : true,
                priority: patch.priority ?? seed.priority,
                timeout: patch.timeout ?? null,
                maxTokens: patch.maxTokens ?? null,
                extraParams: patch.extraParams ?? {}
            });
            return { status: 200, body: standardResponse(true, { endpoint: created }) };
        } catch (err) {
            if (err instanceof AppError) throw err;
            if (err && err.status === 400) throw new AppError(err.message, 400);
            logger.error('[AI] 更新端点失败:', err && err.message ? err.message : err);
            throw new AppError('端点更新失败，请稍后重试', 500);
        }
    }

    /** env 前缀 → 渠道 id（LLM2 → agnes），供 env 种子端点定位渠道 */
    _channelIdOfPrefix(prefix) {
        const map = { LLM: 'mistral', LLM2: 'agnes', LLM3: 'openmodel', LLM4: 'sensenova' };
        return map[prefix] || null;
    }

    /**
     * 删除端点（DELETE /api/ai/endpoints/:id）
     * @description 只能删除数据库行。env 种子端点删不掉（env 不可写），
     *              想停用它请走「停用」，那会写一条 enabled=false 的覆盖行。
     */
    async deleteEndpoint(id) {
        if (typeof id !== 'number' && !/^\d+$/.test(String(id))) {
            throw new AppError('该端点来自环境变量，无法删除；可改为停用', 400);
        }
        const ok = await endpointStore.deleteEndpoint(Number(id));
        if (!ok) throw new AppError('端点不存在', 404);
        return { status: 200, body: standardResponse(true, { message: '端点已删除' }) };
    }

    /**
     * 测试端点连通性（POST /api/ai/endpoints/:id/test）
     * @description 用端点自己的凭证与地址打一次极小请求；不落库、不影响全局配置。
     *              不指定 modelId 时取该端点挂载的第一个模型。
     */
    async testEndpoint(id, modelId) {
        const channels = await this.listEndpoints();
        let target = null;
        for (const ch of channels.body.data.channels) {
            const hit = ch.endpoints.find(e => String(e.id) === String(id));
            if (hit) { target = { channel: ch, endpoint: hit }; break; }
        }
        if (!target) throw new AppError('端点不存在', 404);

        const model = modelId || (target.endpoint.models[0] && target.endpoint.models[0].id);
        if (!model) throw new AppError('该端点未挂载任何模型', 400);

        const config = await endpointRegistry.resolveCallConfig(target.channel.channelId, model);
        if (!config) throw new AppError('渠道不可用', 400);

        const testConfig = { ...config, timeout: Math.min(15000, config.timeout || 15000), maxTokens: 20 };
        try {
            const start = Date.now();
            await aiService.chat([{ role: 'user', content: 'test' }], { configOverride: testConfig });
            return {
                status: 200,
                body: standardResponse(true, { available: true, latency: Date.now() - start, model })
            };
        } catch (error) {
            logger.warn('[AI] 端点测试失败:', error.message || error);
            return {
                status: 200,
                body: standardResponse(true, { available: false, error: '端点当前不可用', model })
            };
        }
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
        // 走端点注册表：按渠道的选择策略挑出实际服务该模型的端点（含端点级凭证/超时/自定义参数）。
        // 渠道未配置任何端点时，注册表会回退到渠道默认地址，行为与改造前一致。
        const resolved = await endpointRegistry
            .resolveCallConfig(pref.presetId, pref.modelId, globalConfig)
            .catch(() => null);
        if (resolved) return resolved;

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

    /**
     * 把「浏览器本地新增的模型/端点」解析成 LLM 调用配置（含密钥，**仅服务端使用**）
     * @description 自定义模型/端点只存在用户自己的 localStorage 里，不落库、不同步，
     *              所以由客户端随每次提问带上，优先级高于用户偏好与全局配置。
     *
     *              baseUrl 由客户端指定，等于把服务端当成出站代理，因此必须过
     *              assertSafeBaseUrl：内网/环回/链路本地/云元数据地址一律 400。
     *              这里**不做静默回退**——地址不安全就报错，不能让用户以为在用
     *              自己的模型、实际却打到了别的 provider。
     *
     * @param {Object|undefined} raw - req.body.customConfig
     * @returns {Promise<Object|null>} aiService.chat 的 configOverride；未提供时 null
     */
    async resolveCustomConfig(raw) {
        if (raw === undefined || raw === null) return null;
        if (typeof raw !== 'object' || Array.isArray(raw)) {
            throw new AppError('customConfig 必须是对象', 400);
        }

        const model = String(raw.model || '').trim();
        const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
        if (!model || !apiKey) {
            throw new AppError('customConfig 缺少 model 或 apiKey', 400);
        }

        // 抛出的 Error 带 status=400，交给全局错误中间件转成 4xx
        const url = await assertSafeBaseUrl(String(raw.baseUrl || '')).catch(err => {
            throw new AppError(err.message, err.status || 400);
        });

        const globalConfig = aiService.getAIConfig();
        return {
            enabled: true,
            provider: raw.provider ? String(raw.provider) : 'custom',
            protocol: raw.protocol === 'messages' ? 'messages' : 'openai',
            apiKey,
            baseUrl: normalizeBase(this._baseOf(url)),
            model,
            timeout: clampInt(raw.timeout, 1000, 120000, globalConfig.timeout || 30000),
            maxTokens: clampInt(raw.maxTokens, 1, 32000, globalConfig.maxTokens || 3000),
            extraParams: sanitizeExtraParams(raw.extraParams)
        };
    }

    /** URL → 不含查询串/锚点、末尾无斜杠的基地址（ai-service 会自己拼 /chat/completions） */
    _baseOf(url) {
        return url.origin + url.pathname;
    }
}

/** 去掉末尾斜杠；空路径时只剩 origin */
function normalizeBase(base) {
    return base.replace(/\/+$/, '');
}

/**
 * 请求参数收敛：正整数取原值（上限截断），其余一律回落到全局默认。
 * @description 负数/0/非整数是「填错了」而不是「想要很小的值」，夹到 1 反而会把
 *              错误藏起来，所以只有超上限才截断。
 */
function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) return fallback;
    return Math.min(max, n);
}

// 与 ai-service 的 RESERVED_BODY_KEYS 同源的那几个决定调用语义的字段，外加
// max_tokens/temperature：这两个已经被上面的 timeout/maxTokens 与固定 0.1 管住，
// 再让 extraParams 覆盖就等于绕过了 maxTokens 的上限。
const EXTRA_PARAM_DENYLIST = ['model', 'messages', 'system', 'stream', 'tools', 'tool_choice', 'max_tokens', 'temperature'];

function sanitizeExtraParams(extraParams) {
    if (!extraParams || typeof extraParams !== 'object' || Array.isArray(extraParams)) return undefined;
    const out = {};
    for (const [key, value] of Object.entries(extraParams)) {
        if (EXTRA_PARAM_DENYLIST.includes(key)) continue;
        out[key] = value;
    }
    return Object.keys(out).length ? out : undefined;
}

module.exports = new AIConfigService();
