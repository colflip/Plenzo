/**
 * AI 配置管理器（兼容层）
 * @description
 *  历史实现会在运行时 fs 读写项目根目录的 .env 文件，这在 Vercel/ShServerless 环境下
 *  会因 /var/task/.env 不存在而抛 ENOENT，且只读文件系统导致修改无法持久生效。
 *
 *  现在改为把配置持久化到数据库（见 ai-config-store.js）。本模块仅作为兼容层，
 *  保留原有方法名（updateAIConfig / getConfig），供 ai-controller 调用。
 */

const store = require('./ai-config-store');

/**
 * 更新 AI 配置（持久化到数据库，跨实例生效）
 * @param {Object} updates - 部分字段更新
 * @returns {Promise<Object>} 合并后的完整配置
 */
async function updateAIConfig(updates) {
    return store.saveConfig(updates);
}

/**
 * 同步获取当前生效配置（环境变量默认值 + 数据库覆盖项）
 * @returns {Object}
 */
function getConfig() {
    return store.getEffectiveConfig();
}

/**
 * 后台加载数据库配置（幂等）
 */
async function ensureLoaded() {
    return store.ensureLoaded();
}

module.exports = {
    updateAIConfig,
    getConfig,
    ensureLoaded,
    _store: store
};
