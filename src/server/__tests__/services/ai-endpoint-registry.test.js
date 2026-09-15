/**
 * 端点解析（env 种子）与选择策略单元测试
 * @description 只测纯逻辑，不触达数据库：
 *              ai-endpoint-store 在 NODE_ENV=test 下会短路返回空列表，
 *              所以注册表在无 DB 覆盖时的行为 = 纯 env 视图，正好覆盖向后兼容场景。
 */

// registry → store → db：不 mock 的话 require 链会拉起真实数据库连接，
// 让这个纯逻辑用例在 CI/沙箱里被资源限制杀掉。
jest.mock('../../db/db', () => ({
    query: jest.fn().mockResolvedValue({ rows: [] })
}));

const { buildEnvEndpoints } = require('../../services/preset-models');
const registry = require('../../services/ai-endpoint-registry');

const P = 'LLM_TEST';

/** 清掉本次用例可能用到的所有环境变量 */
function clearEnv() {
    Object.keys(process.env)
        .filter(k => k.startsWith(P))
        .forEach(k => delete process.env[k]);
}

describe('buildEnvEndpoints：端点解析', () => {
    beforeEach(() => {
        clearEnv();
        registry._resetCursor();
    });
    afterAll(clearEnv);

    const base = () => ({
        baseUrls: ['https://a.example.com/v1'],
        apiKey: 'sk-channel',
        protocol: 'openai',
        timeout: 30000,
        maxTokens: 3000,
        models: ['m1', 'm2']
    });

    test('未配置任何端点变量 → 每个地址共享渠道模型清单（向后兼容）', () => {
        const eps = buildEnvEndpoints(P, base());
        expect(eps).toHaveLength(1);
        expect(eps[0].baseUrl).toBe('https://a.example.com/v1');
        expect(eps[0].models).toEqual(['m1', 'm2']);
        expect(eps[0].apiKey).toBe('sk-channel');
        expect(eps[0].inheritsKey).toBe(true);
        expect(eps[0].source).toBe('env');
    });

    test('多地址 + 未配端点变量 → 生成多个共享渠道模型的端点', () => {
        const b = base();
        b.baseUrls = ['https://a.example.com/v1', 'https://b.example.com/v1'];
        const eps = buildEnvEndpoints(P, b);
        expect(eps).toHaveLength(2);
        expect(eps.map(e => e.baseUrl)).toEqual([
            'https://a.example.com/v1',
            'https://b.example.com/v1'
        ]);
        expect(eps[1].models).toEqual(['m1', 'm2']);
    });

    test('ENDPOINT_N_URL 可追加地址列表里没有的端点', () => {
        process.env[`${P}_ENDPOINT_2_URL`] = 'https://backup.example.com/v1';
        process.env[`${P}_ENDPOINT_2_LABEL`] = '备用';
        process.env[`${P}_ENDPOINT_2_KEY`] = 'sk-backup';
        process.env[`${P}_ENDPOINT_2_MODELS`] = 'm3';
        process.env[`${P}_ENDPOINT_2_TIMEOUT`] = '120000';
        process.env[`${P}_ENDPOINT_2_MAX_TOKENS`] = '8192';
        process.env[`${P}_ENDPOINT_2_PARAMS`] = '{"temperature":0.3}';

        const eps = buildEnvEndpoints(P, base());
        expect(eps).toHaveLength(2);
        const ep2 = eps.find(e => e.baseUrl === 'https://backup.example.com/v1');
        expect(ep2.label).toBe('备用');
        expect(ep2.apiKey).toBe('sk-backup');
        expect(ep2.inheritsKey).toBe(false);
        expect(ep2.models).toEqual(['m3']);
        expect(ep2.timeout).toBe(120000);
        expect(ep2.maxTokens).toBe(8192);
        expect(ep2.extraParams).toEqual({ temperature: 0.3 });
    });

    test('ENDPOINT_N_ENABLED=false → 端点被标记为停用', () => {
        process.env[`${P}_ENDPOINT_1_ENABLED`] = 'false';
        const eps = buildEnvEndpoints(P, base());
        expect(eps[0].enabled).toBe(false);
    });

    test('ENDPOINT_N_MODELS 覆盖该端点的模型清单，不影响渠道清单', () => {
        process.env[`${P}_ENDPOINT_1_MODELS`] = 'only-this';
        const eps = buildEnvEndpoints(P, base());
        expect(eps[0].models).toEqual(['only-this']);
    });

    test('非法的 PARAMS JSON 被忽略而不抛错（配错不该让渠道消失）', () => {
        process.env[`${P}_ENDPOINT_1_PARAMS`] = '{not json';
        const eps = buildEnvEndpoints(P, base());
        expect(eps[0].extraParams).toEqual({});
    });

    test('端点按 priority 升序排列', () => {
        process.env[`${P}_ENDPOINT_2_URL`] = 'https://b.example.com/v1';
        process.env[`${P}_ENDPOINT_2_PRIORITY`] = '5';
        const eps = buildEnvEndpoints(P, base());
        expect(eps[0].baseUrl).toBe('https://b.example.com/v1');
    });
});

describe('selectEndpoint：选择策略', () => {
    const eps = [
        { id: 'a', priority: 10, enabled: true },
        { id: 'b', priority: 20, enabled: true },
        { id: 'c', priority: 30, enabled: true }
    ];

    beforeEach(() => registry._resetCursor());

    test('priority → 始终取优先级最高的', () => {
        expect(registry.selectEndpoint(eps, 'priority', 'ch').id).toBe('a');
        expect(registry.selectEndpoint(eps, 'priority', 'ch').id).toBe('a');
    });

    test('round-robin → 在可用端点间轮流', () => {
        const seq = [];
        for (let i = 0; i < 6; i++) seq.push(registry.selectEndpoint(eps, 'round-robin', 'ch').id);
        expect(seq).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
    });

    test('random → 能命中多个不同端点', () => {
        const hit = new Set();
        for (let i = 0; i < 50; i++) hit.add(registry.selectEndpoint(eps, 'random', 'ch').id);
        expect(hit.size).toBeGreaterThan(1);
    });

    test('停用的端点不参与选择', () => {
        const withOff = [
            { id: 'a', priority: 10, enabled: true },
            { id: 'b', priority: 20, enabled: false },
            { id: 'c', priority: 30, enabled: true }
        ];
        const seq = [];
        for (let i = 0; i < 4; i++) seq.push(registry.selectEndpoint(withOff, 'round-robin', 'ch').id);
        expect(seq).toEqual(['a', 'c', 'a', 'c']);
    });

    test('全部停用 → 返回 null', () => {
        const off = eps.map(e => ({ ...e, enabled: false }));
        expect(registry.selectEndpoint(off, 'priority', 'ch')).toBeNull();
    });

    test('空列表 → 返回 null', () => {
        expect(registry.selectEndpoint([], 'priority', 'ch')).toBeNull();
    });

    test('未知名策略 → 退化为 priority', () => {
        expect(registry.selectEndpoint(eps, 'something-else', 'ch').id).toBe('a');
    });
});

describe('normalizeUrl', () => {
    test('去掉结尾斜杠并统一小写，用于端点合并去重', () => {
        expect(registry.normalizeUrl('https://A.com/v1///')).toBe('https://a.com/v1');
        expect(registry.normalizeUrl('  https://a.com/v1  ')).toBe('https://a.com/v1');
    });
});
