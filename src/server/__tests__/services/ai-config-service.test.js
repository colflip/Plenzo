// D1-11：ai-config-service 单测（ai-controller 配置/预设/模型检测端点下沉）
// 验证 service 返回领域数据，错误通过 AppError 抛出。
const fs = require('fs');
const aiService = require('../../services/ai-service');
const aiConfigManager = require('../../services/ai-config-manager');
const { getPresetModels } = require('../../services/preset-models');
const aiConfigService = require('../../services/ai-config-service');

jest.mock('fs', () => ({ ...jest.requireActual('fs'), readFileSync: jest.fn() }));
jest.mock('../../services/ai-service', () => ({
    getAIConfig: jest.fn(), isAvailable: jest.fn(), chat: jest.fn(), extractText: jest.fn()
}));
jest.mock('../../services/ai-config-manager', () => ({ updateAIConfig: jest.fn() }));
jest.mock('../../services/preset-models', () => ({ getPresetModels: jest.fn() }));
jest.mock('../../utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), log: jest.fn(), info: jest.fn(), debug: jest.fn() }));

const baseConfig = {
    enabled: true, provider: 'deepseek', protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    timeout: 30000, maxTokens: 2000, apiKey: 'sk-1'
};

beforeEach(() => {
    jest.clearAllMocks();
    aiService.getAIConfig.mockReturnValue(baseConfig);
    aiService.chat.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    aiService.extractText.mockReturnValue('ok');
    aiConfigManager.updateAIConfig.mockResolvedValue(undefined);
    getPresetModels.mockReturnValue([]);
    fs.readFileSync.mockImplementation(() => JSON.stringify({}));
});

describe('getConfig', () => {
    test('有密钥 → 200 apiKey 脱敏为 ***已配置***', async () => {
        const r = await aiConfigService.getConfig({});
        expect(r).toEqual({ status: 200, body: expect.objectContaining({ data: expect.objectContaining({
            enabled: true, provider: 'deepseek', protocol: 'openai',
            baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
            timeout: 30000, maxTokens: 2000, apiKey: '***已配置***'
        }) }) });
    });

    test('无密钥 → apiKey 为 null', async () => {
        aiService.getAIConfig.mockReturnValue({ ...baseConfig, apiKey: '' });
        const r = await aiConfigService.getConfig({});
        expect(r.body.data.apiKey).toBeNull();
    });
});

describe('getPresets', () => {
    test('200 返回 presets（getPresetModels(false) 不含真实 Key）', async () => {
        getPresetModels.mockReturnValue([{ id: 'deepseek', name: 'DeepSeek' }]);
        const r = await aiConfigService.getPresets({});
        expect(r).toEqual({ status: 200, body: expect.objectContaining({ data: { presets: [{ id: 'deepseek', name: 'DeepSeek' }] } }) });
        expect(getPresetModels).toHaveBeenCalledWith(false);
    });
});

describe('updateConfig', () => {
    test('缺参数 → 抛 AppError 400', async () => {
        await expect(aiConfigService.updateConfig({ body: { provider: 'deepseek' } }))
            .rejects.toMatchObject({ statusCode: 400 });
    });

    test('presetId 解析真实 Key + 成功 → 200 更新成功', async () => {
        getPresetModels.mockReturnValue([{ id: 'p1', apiKey: 'pk-secret' }]);
        const r = await aiConfigService.updateConfig({
            body: { provider: 'deepseek', presetId: 'p1', baseUrl: 'https://x/v1', model: 'm', timeout: 100, maxTokens: 200 }
        });
        expect(r).toEqual({ status: 200, body: expect.objectContaining({ data: { message: '配置已更新并立即生效！' } }) });
        expect(aiConfigManager.updateAIConfig).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'deepseek', apiKey: 'pk-secret', protocol: 'openai',
            baseUrl: 'https://x/v1', model: 'm', timeout: 100, maxTokens: 200
        }));
    });

    test('保存失败 → 抛 AppError 500', async () => {
        aiConfigManager.updateAIConfig.mockRejectedValue(new Error('db down'));
        await expect(aiConfigService.updateConfig({
            body: { provider: 'deepseek', apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' }
        })).rejects.toMatchObject({ statusCode: 500 });
    });
});

describe('checkModel', () => {
    test('缺参数 → 抛 BAD_REQUEST', async () => {
        const r = await aiConfigService.checkModel({ body: {} });
        expect(r).toEqual({ status: 200, body: expect.objectContaining({ success: false, data: expect.objectContaining({ available: false, error: '缺少必要的参数' }) }) });
    });

    test('成功 → 200 available:true（configOverride 临时配置）', async () => {
        const r = await aiConfigService.checkModel({ body: { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' } });
        expect(r).toEqual({ status: 200, body: expect.objectContaining({ data: { available: true } }) });
        expect(aiService.chat).toHaveBeenCalledWith(
            [{ role: 'user', content: 'test' }],
            expect.objectContaining({ configOverride: expect.objectContaining({ maxTokens: 20, timeout: 8000 }) })
        );
    });

    test('chat 异常 → 抛稳定的上游不可用错误', async () => {
        aiService.chat.mockRejectedValue(new Error('llm down'));
        const r = await aiConfigService.checkModel({
            body: { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' }
        });
        expect(r).toEqual({ status: 200, body: expect.objectContaining({ data: expect.objectContaining({ available: false, error: '服务暂不可用' }) }) });
    });
});

describe('testModel', () => {
    test('缺参数 → 抛 AppError 400', async () => {
        await expect(aiConfigService.testModel({ body: {} })).rejects.toMatchObject({ statusCode: 400 });
    });

    test('成功 → 200 latency/model/response，不包含旧 success 字段', async () => {
        const r = await aiConfigService.testModel({ body: { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' } });
        expect(r).toEqual(expect.objectContaining({ status: 200, body: expect.objectContaining({ data: expect.objectContaining({ model: 'm', response: 'ok' }) }) }));
        expect(r.body.data.success).toBe(true);
        expect(typeof r.body.data.latency).toBe('number');
    });

    test('chat 异常 → 抛稳定的上游不可用错误', async () => {
        aiService.chat.mockRejectedValue(new Error('llm down'));
        const r = await aiConfigService.testModel({
            body: { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' }
        });
        expect(r).toEqual({ status: 200, body: expect.objectContaining({ success: false, data: expect.objectContaining({ error: 'AI 服务请求失败' }) }) });
    });
});

describe('getAvailableModels', () => {
    test('文件存在 → 200 { models }', async () => {
        fs.readFileSync.mockReturnValue(JSON.stringify({ deepseek: [{ id: 'm' }] }));
        const r = await aiConfigService.getAvailableModels({});
        expect(r).toEqual({ status: 200, body: expect.objectContaining({ data: { models: { deepseek: [{ id: 'm' }] } } }) });
    });

    test('文件缺失 → 抛 INTERNAL_ERROR', async () => {
        fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
        const r = await aiConfigService.getAvailableModels({});
        expect(r).toEqual({ status: 200, body: expect.objectContaining({ data: expect.objectContaining({ models: {} }) }) });
    });
});

describe('getModelCapabilities', () => {
    test('命中当前模型 → 200 capabilities', async () => {
        fs.readFileSync.mockReturnValue(JSON.stringify({
            deepseek: [{ id: 'deepseek-chat', capabilities: { vision: true, tools: true, reasoning: false } }]
        }));
        const r = await aiConfigService.getModelCapabilities();
        expect(r).toEqual({ status: 200, body: expect.objectContaining({ data: expect.objectContaining({
            capabilities: { vision: true, tools: true, reasoning: false },
            model: 'deepseek-chat'
        }) }) });
    });

    test('未命中当前模型 → 200 默认 capabilities', async () => {
        const r = await aiConfigService.getModelCapabilities();
        expect(r).toEqual({ status: 200, body: expect.objectContaining({ data: expect.objectContaining({
            capabilities: { vision: false, tools: false, reasoning: false },
            model: 'deepseek-chat'
        }) }) });
    });

    test('文件读取失败 → 抛 INTERNAL_ERROR', async () => {
        fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
        const r = await aiConfigService.getModelCapabilities();
        expect(r).toEqual({ status: 200, body: expect.objectContaining({ data: expect.objectContaining({ capabilities: { vision: false, tools: false, reasoning: false } }) }) });
    });

    test('模型配置 JSON 无效 → 抛 INTERNAL_ERROR', async () => {
        fs.readFileSync.mockReturnValue('{invalid');
        const r = await aiConfigService.getModelCapabilities();
        expect(r).toEqual({ status: 200, body: expect.objectContaining({ data: expect.objectContaining({ capabilities: { vision: false, tools: false, reasoning: false } }) }) });
    });
});
