/**
 * AI 配置管理器
 * @description 支持动态重载配置，无需重启服务
 */

const fs = require('fs');
const path = require('path');

class AIConfigManager {
    constructor() {
        this.envPath = path.join(__dirname, '../../../.env');
        this.configCache = null;
        this.lastModified = null;
    }

    /**
     * 读取 .env 文件并解析为对象
     */
    parseEnvFile() {
        const content = fs.readFileSync(this.envPath, 'utf8');
        const config = {};

        content.split('\n').forEach(line => {
            line = line.trim();
            if (!line || line.startsWith('#')) return;

            const match = line.match(/^([^=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                let value = match[2].trim();
                // 移除引号
                if ((value.startsWith('"') && value.endsWith('"')) ||
                    (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                config[key] = value;
            }
        });

        return config;
    }

    /**
     * 更新 AI 配置
     */
    updateAIConfig(updates) {
        const config = this.parseEnvFile();

        // 更新配置
        if (updates.provider) config.AI_PROVIDER = updates.provider;
        if (updates.protocol) config.AI_PROTOCOL = updates.protocol;
        if (updates.apiKey) config.AI_API_KEY = updates.apiKey;
        if (updates.baseUrl) config.AI_BASE_URL = updates.baseUrl;
        if (updates.model) config.AI_MODEL = updates.model;
        if (updates.timeout) config.AI_TIMEOUT = updates.timeout.toString();
        if (updates.maxTokens) config.AI_MAX_TOKENS = updates.maxTokens.toString();
        config.AI_ENABLED = 'true';

        // 写回 .env 文件
        this.writeEnvFile(config);

        // 立即更新 process.env（使配置生效）
        Object.keys(updates).forEach(key => {
            const envKey = `AI_${key.toUpperCase().replace(/([A-Z])/g, '_$1')}`;
            if (updates[key]) {
                process.env[envKey] = updates[key].toString();
            }
        });
        process.env.AI_ENABLED = 'true';

        // 清除缓存
        this.configCache = null;
    }

    /**
     * 将配置对象写回 .env 文件
     */
    writeEnvFile(config) {
        const lines = [];

        Object.keys(config).forEach(key => {
            const value = config[key];
            // 如果值包含空格或特殊字符，加引号
            if (value.includes(' ') || value.includes('#')) {
                lines.push(`${key}='${value}'`);
            } else {
                lines.push(`${key}=${value}`);
            }
        });

        fs.writeFileSync(this.envPath, lines.join('\n'), 'utf8');
    }
}

// 单例
const configManager = new AIConfigManager();

module.exports = configManager;
