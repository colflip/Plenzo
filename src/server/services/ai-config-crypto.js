const logger = require('../utils/logger.js');
/**
 * AI 配置字段级加密（api_key at rest）
 * @description
 *  把落在数据库 public.ai_config.api_key 的 API Key 做 AES-256-GCM 加密，
 *  避免密钥以明文形式持久化（原 .env / 当前 DB 明文同等级风险）。
 *
 *  设计要点：
 *   - 算法：AES-256-GCM（带认证标签，防篡改）。
 *   - 密钥来源：环境变量 AI_CONFIG_ENCRYPTION_KEY（回退 AI_ENCRYPTION_KEY）。
 *       支持三种写法：
 *         a) 64 位十六进制（32 字节）；
 *         b) 44 字符 base64（32 字节，标准 base64 长度含 1 个 '='）；
 *         c) 任意口令/短语：用固定 salt 经 scrypt 派生 32 字节（多实例一致，适合 Serverless）。
 *   - 未配置密钥：降级为「明文存储 + 仅一次告警」，保证存量部署不崩、可平滑升级。
 *   - 存储格式：enc:v1:<ivB64>:<tagB64>:<ctB64>，便于识别与向后兼容。
 *   - 读取兼容：无 enc:v1: 前缀的值按存量明文原样返回。
 *   - 解密失败（密钥轮换/损坏）：告警并返回空串，绝不返回乱码密钥。
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
const SALT = 'plenzo-ai-config-v1'; // 固定 salt：确保 Serverless 多实例派生出同一密钥
const KEY_BYTES = 32;

let warnedNoKey = false;

/**
 * 解析返回 32 字节密钥；未配置则返回 null（调用方据此降级为明文）。
 */
function resolveKey() {
    const raw = process.env.AI_CONFIG_ENCRYPTION_KEY || process.env.AI_ENCRYPTION_KEY;
    if (!raw) return null;

    // (a) 64 位十六进制
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
        return Buffer.from(raw, 'hex');
    }
    // (b) 44 字符 base64（标准编码，含一个 '=' 填充）
    if (raw.length === 44 && /^[A-Za-z0-9+/=]+$/.test(raw)) {
        try {
            const buf = Buffer.from(raw, 'base64');
            if (buf.length === KEY_BYTES) return buf;
        } catch (_) { /* fall through */ }
    }
    // (c) 任意口令：scrypt 派生（确定性，跨实例一致）
    return crypto.scryptSync(raw, SALT, KEY_BYTES);
}

/**
 * 加密明文。
 * @param {string} plain - 待加密的明文（如 API Key）
 * @returns {string} 加密后的可存储串；未配置密钥时原样返回（明文降级）。
 */
function encrypt(plain) {
    if (plain === undefined || plain === null || plain === '') return plain === undefined ? '' : plain;
    const key = resolveKey();
    if (!key) {
        if (!warnedNoKey) {
            logger.warn(
                '[AIConfigCrypto] 未配置 AI_CONFIG_ENCRYPTION_KEY，API Key 将以明文写入数据库。' +
                '生产环境请设置 32 字节密钥（hex/base64）或口令以启用加密。'
            );
            warnedNoKey = true;
        }
        return plain; // 降级：明文
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * 解密存储串。
 * @param {string} stored - 数据库中的值（可能是 enc:v1: 密文，也可能是存量明文）
 * @returns {string} 明文；解密失败或无前缀时按规则回退。
 */
function decrypt(stored) {
    if (!stored) return '';
    if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) {
        return stored; // 存量明文，原样返回
    }

    const key = resolveKey();
    if (!key) {
        // 有密文但当前实例未配置密钥：无法解密，告警并返回空串
        logger.error('[AIConfigCrypto] 数据库中存在加密的 API Key，但本实例未配置 AI_CONFIG_ENCRYPTION_KEY，无法解密。');
        return '';
    }

    try {
        const rest = stored.slice(PREFIX.length);
        const [ivB64, tagB64, ctB64] = rest.split(':');
        if (!ivB64 || !tagB64 || !ctB64) {
            logger.error('[AIConfigCrypto] 密文格式非法，无法解密。');
            return '';
        }
        const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
        decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
        const plain = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
        return plain.toString('utf8');
    } catch (err) {
        // 密钥轮换 / 数据损坏：绝不返回乱码
        logger.error('[AIConfigCrypto] 解密 API Key 失败（密钥不匹配或数据损坏）:', err && err.message ? err.message : err);
        return '';
    }
}

module.exports = { encrypt, decrypt, PREFIX, _resolveKey: resolveKey };
