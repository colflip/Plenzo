/**
 * 自定义模型 / 自定义端点 的本机存储
 * @description
 *  这两个东西是「个人自定义」，不进服务端数据库、不跨用户共享：
 *    - 新增模型：只有本机浏览器知道，属于谁加的、谁能用
 *    - 新增端点：同上（此前落 ai_channel_endpoints 表，属于全局基础设施配置）
 *
 *  因此统一存在 localStorage，并在每次提问时由客户端把「当前选中的自定义配置」
 *  作为 customConfig 一并发给 /api/ai/query。服务端会做出站地址护栏校验
 *  （见 src/server/utils/ssrf-guard.js），所以这里的 baseUrl 必须是公网 http(s) 地址。
 *
 *  存储结构（都带版本前缀，便于以后迁移）：
 *    customAIModels      [{ name, provider, protocol, baseUrl, apiKey, model, timeout, maxTokens }]
 *    customAIEndpoints   [{ id, label, baseUrl, apiKey, models: [string], protocol, timeout, maxTokens, enabled, extraParams }]
 *    aiActiveCustomModel { kind: 'model'|'endpoint', ref, model } | 不存在
 *
 *  apiKey 以明文存在 localStorage —— 与改造前的行为一致（本就如此），
 *  能读到 localStorage 的脚本本来就能读到页面上的密钥输入框，不额外放大风险。
 */
(function () {
    'use strict';

    const MODELS_KEY = 'customAIModels';
    const ENDPOINTS_KEY = 'customAIEndpoints';
    const ACTIVE_KEY = 'aiActiveCustomModel';

    function readJson(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : fallback;
        } catch (_) {
            return fallback;
        }
    }

    function writeJson(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }

    function listModels() {
        return readJson(MODELS_KEY, []);
    }

    function saveModels(list) {
        writeJson(MODELS_KEY, Array.isArray(list) ? list : []);
        // 被删掉的模型可能正是当前生效的那个
        const active = getActive();
        if (active && active.kind === 'model' && !list.some(m => m.name === active.ref)) clearActive();
    }

    function listEndpoints() {
        return readJson(ENDPOINTS_KEY, []);
    }

    function saveEndpoints(list) {
        writeJson(ENDPOINTS_KEY, Array.isArray(list) ? list : []);
        const active = getActive();
        if (active && active.kind === 'endpoint' && !list.some(e => String(e.id) === String(active.ref))) {
            clearActive();
        }
    }

    /** 端点里挂的模型名 → 端点级配置（端点级超时/参数覆盖端点默认值） */
    function configFromEndpoint(endpoint, modelId) {
        return {
            provider: 'custom',
            protocol: endpoint.protocol || 'openai',
            apiKey: endpoint.apiKey || '',
            baseUrl: endpoint.baseUrl || '',
            model: modelId || (endpoint.models || [])[0] || '',
            timeout: endpoint.timeout || undefined,
            maxTokens: endpoint.maxTokens || undefined,
            extraParams: endpoint.extraParams || undefined
        };
    }

    function configFromModel(model) {
        return {
            provider: model.provider || 'custom',
            protocol: model.protocol || 'openai',
            apiKey: model.apiKey || '',
            baseUrl: model.baseUrl || '',
            model: model.model || '',
            timeout: model.timeout || undefined,
            maxTokens: model.maxTokens || undefined
        };
    }

    function getActive() {
        try {
            const raw = localStorage.getItem(ACTIVE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (_) {
            return null;
        }
    }

    function setActive(active) {
        localStorage.setItem(ACTIVE_KEY, JSON.stringify(active));
    }

    function clearActive() {
        localStorage.removeItem(ACTIVE_KEY);
    }

    /**
     * 当前生效的自定义配置 → /api/ai/query 的 customConfig。
     * @returns {Object|null} 未选中自定义模型时返回 null（此时请求不带 customConfig，
     *                        服务端按「用户自选模型 → 全局配置」的老路径走）
     */
    function getQueryConfig() {
        const active = getActive();
        if (!active) return null;

        if (active.kind === 'model') {
            const model = listModels().find(m => m.name === active.ref);
            if (!model) { clearActive(); return null; }
            const cfg = configFromModel(model);
            return (cfg.baseUrl && cfg.apiKey && cfg.model) ? cfg : null;
        }

        if (active.kind === 'endpoint') {
            const endpoint = listEndpoints().find(e => String(e.id) === String(active.ref));
            if (!endpoint || endpoint.enabled === false) { clearActive(); return null; }
            const cfg = configFromEndpoint(endpoint, active.model);
            return (cfg.baseUrl && cfg.apiKey && cfg.model) ? cfg : null;
        }

        return null;
    }

    /** 生成一个本机端点 id（不联网、不需要服务端发号） */
    function nextEndpointId() {
        return 'local-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    }

    window.AICustomModelStore = {
        MODELS_KEY,
        ENDPOINTS_KEY,
        ACTIVE_KEY,
        listModels,
        saveModels,
        listEndpoints,
        saveEndpoints,
        configFromEndpoint,
        configFromModel,
        getActive,
        setActive,
        clearActive,
        getQueryConfig,
        nextEndpointId
    };
})();
