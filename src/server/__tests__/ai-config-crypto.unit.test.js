/**
 * ai-config-crypto 单元测试
 * 纯函数，无需数据库。覆盖：hex 密钥、口令派生、存量明文兼容、
 * 无密钥降级、密钥不匹配/损坏密文显式失败、空串处理。
 */

const crypto = require('../services/ai-config-crypto');

const HEX_KEY = 'a'.repeat(64); // 合法的 64 位十六进制 32 字节密钥

describe('ai-config-crypto', () => {
    const OLD = process.env.AI_CONFIG_ENCRYPTION_KEY;
    const OLD2 = process.env.AI_ENCRYPTION_KEY;

    afterEach(() => {
        // 还原环境变量，避免用例间互相污染
        if (OLD === undefined) delete process.env.AI_CONFIG_ENCRYPTION_KEY;
        else process.env.AI_CONFIG_ENCRYPTION_KEY = OLD;
        if (OLD2 === undefined) delete process.env.AI_ENCRYPTION_KEY;
        else process.env.AI_ENCRYPTION_KEY = OLD2;
    });

    test('hex 密钥可正确加解密（明文不在密文中出现）', () => {
        process.env.AI_CONFIG_ENCRYPTION_KEY = HEX_KEY;
        const plain = 'sk-test-1234567890-secret';
        const enc = crypto.encrypt(plain);
        expect(enc).not.toBe(plain);
        expect(enc.startsWith(crypto.PREFIX)).toBe(true);
        expect(enc).not.toContain(plain);
        expect(crypto.decrypt(enc)).toBe(plain);
    });

    test('口令派生密钥可跨调用保持一致性（Serverless 多实例）', () => {
        process.env.AI_CONFIG_ENCRYPTION_KEY = 'my-secret-passphrase';
        const plain = 'another-secret-key';
        const enc1 = crypto.encrypt(plain);
        const enc2 = crypto.encrypt(plain);
        // 随机 IV 导致密文不同，但解密结果一致
        expect(enc1).not.toBe(enc2);
        expect(crypto.decrypt(enc1)).toBe(plain);
        expect(crypto.decrypt(enc2)).toBe(plain);
    });

    test('无 enc: 前缀的存量明文原样返回', () => {
        process.env.AI_CONFIG_ENCRYPTION_KEY = HEX_KEY;
        const legacy = 'plaintext-legacy-key';
        expect(crypto.decrypt(legacy)).toBe(legacy);
    });

    test('未配置密钥时降级为明文存储（不抛错）', () => {
        delete process.env.AI_CONFIG_ENCRYPTION_KEY;
        delete process.env.AI_ENCRYPTION_KEY;
        const plain = 'fallback-plain-key';
        const out = crypto.encrypt(plain);
        expect(out).toBe(plain); // 降级：原样返回
    });

    test('密钥不匹配时抛出可识别错误', () => {
        process.env.AI_CONFIG_ENCRYPTION_KEY = HEX_KEY;
        const enc = crypto.encrypt('top-secret');
        process.env.AI_CONFIG_ENCRYPTION_KEY = 'b'.repeat(64);
        expect(() => crypto.decrypt(enc)).toThrow(expect.objectContaining({
            code: 'AI_CONFIG_DECRYPT_FAILED'
        }));
    });

    test('密文格式损坏时抛出可识别错误', () => {
        process.env.AI_CONFIG_ENCRYPTION_KEY = HEX_KEY;
        expect(() => crypto.decrypt(`${crypto.PREFIX}broken`)).toThrow(expect.objectContaining({
            code: 'AI_CONFIG_DECRYPT_FAILED'
        }));
    });

    test('空串/空值处理不报错', () => {
        delete process.env.AI_CONFIG_ENCRYPTION_KEY;
        delete process.env.AI_ENCRYPTION_KEY;
        expect(crypto.encrypt('')).toBe('');
        expect(crypto.decrypt('')).toBe('');
        expect(crypto.decrypt(null)).toBe('');
    });

    test('base64 形式 32 字节密钥可用', () => {
        // 取 HEX_KEY 对应字节的 base64（44 字符标准编码，含 '='）
        const buf = Buffer.from(HEX_KEY, 'hex');
        const b64 = buf.toString('base64');
        process.env.AI_CONFIG_ENCRYPTION_KEY = b64;
        const plain = 'b64-key-secret';
        const enc = crypto.encrypt(plain);
        expect(crypto.decrypt(enc)).toBe(plain);
    });
});
