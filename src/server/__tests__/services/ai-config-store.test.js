jest.mock('../../db/db', () => ({ query: jest.fn() }));
jest.mock('../../services/ai-config-crypto', () => ({
    decrypt: jest.fn(),
    encrypt: jest.fn(value => `enc:${value}`)
}));
jest.mock('../../utils/logger', () => ({ error: jest.fn(), warn: jest.fn() }));

const db = require('../../db/db');
const configCrypto = require('../../services/ai-config-crypto');
const store = require('../../services/ai-config-store');

function resetStore() {
    store.cache = null;
    store.loaded = false;
    store.loadError = null;
    store.loadingPromise = null;
    store.nextLoadRetryAt = 0;
    store.tableReady = false;
}

beforeEach(() => {
    jest.clearAllMocks();
    resetStore();
    process.env.AI_ENABLED = 'true';
    process.env.AI_API_KEY = 'env-key-for-test';
});

afterAll(() => {
    delete process.env.AI_ENABLED;
    delete process.env.AI_API_KEY;
});

describe('AIConfigStore', () => {
    test('成功查询且没有持久化记录时使用环境变量默认值', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        await store.ensureLoaded();

        expect(store.getEffectiveConfig().apiKey).toBe('env-key-for-test');
        expect(store.loaded).toBe(true);
    });

    test('数据库读取失败不会伪装成无记录，并允许后续重试', async () => {
        const dbError = Object.assign(new Error('database unavailable'), { code: '08006' });
        db.query.mockRejectedValueOnce(dbError);

        await expect(store.ensureLoaded()).rejects.toBe(dbError);
        expect(() => store.getEffectiveConfig()).toThrow(expect.objectContaining({
            code: 'DB_UNAVAILABLE',
            statusCode: 503
        }));
        expect(store.loaded).toBe(false);
        expect(store.loadingPromise).toBeNull();

        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });
        await expect(store.ensureLoaded()).resolves.toBeNull();
        expect(store.getEffectiveConfig().apiKey).toBe('env-key-for-test');
    });

    test('失败后的业务读取会触发受控后台重试', async () => {
        const dbError = Object.assign(new Error('database unavailable'), { code: '08006' });
        db.query.mockRejectedValueOnce(dbError);
        await expect(store.ensureLoaded()).rejects.toBe(dbError);

        store.nextLoadRetryAt = 0;
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        expect(() => store.getEffectiveConfig()).toThrow(expect.objectContaining({
            code: 'DB_UNAVAILABLE'
        }));
        expect(store.loadingPromise).not.toBeNull();
        await store.loadingPromise;

        expect(store.loaded).toBe(true);
        expect(store.getEffectiveConfig().apiKey).toBe('env-key-for-test');
    });

    test('刷新失败保留 last-known-good 配置', async () => {
        store.cache = { enabled: true, provider: 'custom', protocol: 'openai', apiKey: 'cached-key', baseUrl: 'https://example.test/v1', model: 'test-model', timeout: 1000, maxTokens: 50 };
        const dbError = Object.assign(new Error('database unavailable'), { code: '08006' });
        db.query.mockRejectedValueOnce(dbError);

        await expect(store.ensureLoaded()).rejects.toBe(dbError);
        expect(store.getEffectiveConfig().apiKey).toBe('cached-key');
    });

    test('持久化密文解密失败时不使用环境变量 API key 顶替', async () => {
        const decryptError = Object.assign(new Error('cannot decrypt'), { code: 'AI_CONFIG_DECRYPT_FAILED' });
        configCrypto.decrypt.mockImplementationOnce(() => { throw decryptError; });
        db.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{
                enabled: true,
                provider: 'custom',
                protocol: 'openai',
                api_key: 'enc:v1:broken',
                base_url: 'https://example.test/v1',
                model: 'test-model',
                timeout: 1000,
                max_tokens: 50
            }] });

        await expect(store.ensureLoaded()).rejects.toBe(decryptError);
        expect(() => store.getEffectiveConfig()).toThrow(expect.objectContaining({
            code: 'AI_NOT_CONFIGURED'
        }));
    });
});
