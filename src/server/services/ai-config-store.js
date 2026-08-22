const logger = require('../utils/logger.js');
/**
 * AI 运行时配置存储（数据库持久化）
 * @description
 *  替代老旧的「运行时读写 .env 文件」方案。原方案在 Vercel 等 Serverless 环境
 *  下存在两个致命问题：
 *    1) 崩溃：Serverless 运行时不会把 .env 文件打进部署包（环境变量由平台直接注入
 *       process.env），fs.readFileSync('.env') 会抛出 ENOENT（/var/task/.env）。
 *    2) 失效：即使文件存在，Serverless 文件系统只读且实例无状态，写入 .env 或修改
 *       process.env 都无法跨请求/跨实例生效，导致「切换模型」看着成功实则无效。
 *
 *  本模块把 AI 运行时配置单行持久化到数据库（public.ai_config, id=1），
 *  并在内存中缓存，使「管理后台切换模型」真正跨实例生效。
 *
 *  安全：api_key 落库前经 ai-config-crypto 做 AES-256-GCM 加密（at rest），
 *  缓存与运行时仍使用明文；密钥来自 AI_CONFIG_ENCRYPTION_KEY，未配置则降级明文。
 *
 *  读取为同步（getEffectiveConfig），方便 ai-service 在每次请求中无阻塞取值；
 *  数据库加载在后台异步完成，未加载完成前回退到环境变量默认值。
 */

const db = require('../db/db');
const crypto = require('./ai-config-crypto');

// 各 provider 的默认配置（与 ai-service.PROVIDER_DEFAULTS 保持一致）
const PROVIDER_DEFAULTS = {
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', protocol: 'openai' },
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', protocol: 'openai' },
    qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', protocol: 'openai' },
    anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-haiku-4-5-20251001', protocol: 'messages' },
    agnes: { baseUrl: 'https://api.agnes.ai/v1', model: 'gpt-4', protocol: 'openai' },
    openmodel: { baseUrl: 'https://api.openmodel.ai/v1', model: 'deepseek-v4-flash', protocol: 'openai' },
    mistral: { baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', protocol: 'openai' },
    custom: { baseUrl: '', model: 'gpt-3.5-turbo', protocol: 'openai' }
};

const TABLE = 'ai_config';

class AIConfigStore {
    constructor() {
        this.cache = null;     // 已加载的数据库配置（null 表示使用环境变量默认值）
        this.loaded = false;   // 是否已尝试加载（成功或失败都置 true，避免反复打库）
        this.loadingPromise = null;
        this.tableReady = false; // 是否已确认 ai_config 表存在

        // 后台异步预热（测试环境不触发数据库访问）
        if (process.env.NODE_ENV !== 'test') {
            this.ensureLoaded().catch(err => {
                logger.error('[AIConfigStore] 初始加载失败:', err && err.message ? err.message : err);
            });
        }
    }

    /**
     * 仅从环境变量计算默认配置（数据库不可用时的回退）
     */
    _envDefaults() {
        const provider = (process.env.AI_PROVIDER || 'deepseek').toLowerCase();
        const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.custom;
        const protocol = (process.env.AI_PROTOCOL || defaults.protocol || 'openai').toLowerCase();
        return {
            enabled: String(process.env.AI_ENABLED || '').toLowerCase() === 'true',
            provider,
            protocol: protocol === 'messages' ? 'messages' : 'openai',
            apiKey: process.env.AI_API_KEY || '',
            baseUrl: process.env.AI_BASE_URL || defaults.baseUrl || '',
            model: process.env.AI_MODEL || defaults.model || '',
            timeout: parseInt(process.env.AI_TIMEOUT, 10) || 30000,
            maxTokens: parseInt(process.env.AI_MAX_TOKENS, 10) || 8000
        };
    }

    /**
     * 确保 ai_config 表存在（幂等）。
     * 兜底：即使全局迁移因 Serverless 冷启动竞态尚未执行，首次读写前也会自建表，
     * 避免出现 "relation ai_config does not exist"。
     */
    async ensureTable() {
        if (this.tableReady) return;
        await db.query(`
            CREATE TABLE IF NOT EXISTS ${TABLE} (
                id INTEGER PRIMARY KEY DEFAULT 1,
                provider VARCHAR(50) NOT NULL DEFAULT 'deepseek',
                protocol VARCHAR(20) NOT NULL DEFAULT 'openai',
                api_key TEXT,
                base_url TEXT,
                model VARCHAR(100),
                timeout INTEGER NOT NULL DEFAULT 30000,
                max_tokens INTEGER NOT NULL DEFAULT 8000,
                enabled BOOLEAN NOT NULL DEFAULT false,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        this.tableReady = true;
    }

    /**
     * 后台加载数据库配置到缓存（幂等，并发合并为同一个 Promise）
     */
    async ensureLoaded() {
        if (this.loaded) return this.cache;
        if (this.loadingPromise) return this.loadingPromise;

        this.loadingPromise = (async () => {
            try {
                await this.ensureTable();
                const res = await db.query(
                    `SELECT provider, protocol, api_key, base_url, model, timeout, max_tokens, enabled
                     FROM ${TABLE} WHERE id = 1`
                );
                if (res.rows && res.rows.length) {
                    const r = res.rows[0];
                    this.cache = {
                        enabled: r.enabled,
                        provider: (r.provider || '').toLowerCase(),
                        protocol: (r.protocol || 'openai').toLowerCase(),
                        // 数据库中的 api_key 已加密，读取时解密为明文供运行时使用
                        apiKey: crypto.decrypt(r.api_key) || '',
                        baseUrl: r.base_url || '',
                        model: r.model || '',
                        timeout: parseInt(r.timeout, 10) || 30000,
                        maxTokens: parseInt(r.max_tokens, 10) || 8000
                    };
                } else {
                    this.cache = null; // 无持久化记录，回退到环境变量
                }
                this.loaded = true;
            } catch (err) {
                // 数据库暂不可用（如无 DB 的本地场景）：回退到环境变量，不阻断启动
                logger.warn('[AIConfigStore] 读取配置失败，回退到环境变量:', err && err.message ? err.message : err);
                this.cache = null;
                this.loaded = true; // 标记已加载，避免每次调用都打库；后续写入会重新尝试
            }
            return this.cache;
        })();

        return this.loadingPromise;
    }

    /**
     * 同步获取生效配置：环境变量默认值 + 数据库覆盖项
     */
    getEffectiveConfig() {
        const env = this._envDefaults();
        if (!this.cache) return env;

        return {
            enabled: (this.cache.enabled === null || this.cache.enabled === undefined) ? env.enabled : this.cache.enabled,
            provider: this.cache.provider || env.provider,
            protocol: this.cache.protocol || env.protocol,
            apiKey: this.cache.apiKey || env.apiKey,
            baseUrl: this.cache.baseUrl || env.baseUrl,
            model: this.cache.model || env.model,
            timeout: this.cache.timeout || env.timeout,
            maxTokens: this.cache.maxTokens || env.maxTokens
        };
    }

    /**
     * 持久化配置（upsert 单行 id=1），并更新内存缓存与当前进程 process.env
     * @param {Object} updates - 部分字段更新（provider/protocol/apiKey/baseUrl/model/timeout/maxTokens/enabled）
     * @returns {Object} 合并后的完整配置
     */
    async saveConfig(updates = {}) {
        const current = this.getEffectiveConfig();
        const merged = {
            provider: (updates.provider || current.provider || 'deepseek').toLowerCase(),
            protocol: (updates.protocol || current.protocol || 'openai').toLowerCase(),
            apiKey: updates.apiKey !== undefined ? updates.apiKey : current.apiKey,
            baseUrl: updates.baseUrl !== undefined ? updates.baseUrl : current.baseUrl,
            model: updates.model !== undefined ? updates.model : current.model,
            timeout: updates.timeout || current.timeout || 30000,
            maxTokens: updates.maxTokens || current.maxTokens || 8000,
            enabled: updates.enabled !== undefined ? updates.enabled : true
        };

        await this.ensureTable();
        // 仅落库字段加密；缓存、process.env、返回值仍保留明文，供运行时与接口使用
        const dbApiKey = crypto.encrypt(merged.apiKey);
        await db.query(
            `INSERT INTO ${TABLE} (id, provider, protocol, api_key, base_url, model, timeout, max_tokens, enabled, updated_at)
             VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
             ON CONFLICT (id) DO UPDATE SET
                provider = EXCLUDED.provider,
                protocol = EXCLUDED.protocol,
                api_key = EXCLUDED.api_key,
                base_url = EXCLUDED.base_url,
                model = EXCLUDED.model,
                timeout = EXCLUDED.timeout,
                max_tokens = EXCLUDED.max_tokens,
                enabled = EXCLUDED.enabled,
                updated_at = CURRENT_TIMESTAMP`,
            [
                merged.provider, merged.protocol, dbApiKey, merged.baseUrl, merged.model,
                merged.timeout, merged.maxTokens, merged.enabled
            ]
        );

        // 更新内存缓存，使本次进程立即生效
        this.cache = merged;
        this.loaded = true;

        // 兜底：同步写入 process.env（GET /ai/config 与 ai-service 以缓存为准，此处仅作双保险）
        process.env.AI_PROVIDER = merged.provider;
        process.env.AI_PROTOCOL = merged.protocol;
        process.env.AI_API_KEY = merged.apiKey;
        process.env.AI_BASE_URL = merged.baseUrl;
        process.env.AI_MODEL = merged.model;
        process.env.AI_TIMEOUT = String(merged.timeout);
        process.env.AI_MAX_TOKENS = String(merged.maxTokens);
        process.env.AI_ENABLED = merged.enabled ? 'true' : 'false';

        return merged;
    }
}

const store = new AIConfigStore();

module.exports = store;
