// D-新：ai-config-service 的用户模型子域（selectable / my-model / resolveUserConfig）
// 安全约束：前端只提交标识符，凭证由服务端按 presetId 从 env 补全。
const fs = require('fs');
const aiService = require('../../services/ai-service');
const { getPresetModels } = require('../../services/preset-models');
const aiUserModelStore = require('../../services/ai-user-model-store');
const aiConfigService = require('../../services/ai-config-service');

jest.mock('fs', () => ({ ...jest.requireActual('fs'), readFileSync: jest.fn() }));
jest.mock('../../services/ai-service', () => ({ getAIConfig: jest.fn(), chat: jest.fn() }));
jest.mock('../../services/ai-config-manager', () => ({ updateAIConfig: jest.fn() }));
jest.mock('../../services/preset-models', () => ({ getPresetModels: jest.fn() }));
jest.mock('../../services/ai-user-model-store', () => ({
    getUserModel: jest.fn(), setUserModel: jest.fn(), clearUserModel: jest.fn()
}));
jest.mock('../../utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), log: jest.fn(), info: jest.fn(), debug: jest.fn() }));

const CATALOG = {
    mistral: [
        { id: 'mistral-small-latest', name: 'Mistral Small', capabilities: { vision: false, tools: true, reasoning: false }, contextLength: 32768 },
        { id: 'mistral-large-latest', name: 'Mistral Large', capabilities: { vision: false, tools: true, reasoning: false }, contextLength: 128000 }
    ],
    agnes: [
        { id: 'agnes-image-2.1-flash', name: 'Agnes Image 2.1', capabilities: { vision: true, tools: false, reasoning: false }, contextLength: 16384 }
    ]
};

const PRESETS_NO_KEY = [
    { id: 'mistral', name: 'Mistral Small', provider: 'mistral', model: 'mistral-small-latest' },
    { id: 'agnes', name: 'Agnes AI', provider: 'agnes', model: 'agnes-2.0-flash' }
];

const PRESETS_WITH_KEY = [
    { id: 'mistral', provider: 'mistral', protocol: 'openai', apiKey: 'sk-mistral', baseUrl: 'https://m/v1', model: 'mistral-small-latest', timeout: 30000, maxTokens: 3000 }
];

beforeEach(() => {
    jest.clearAllMocks();
    aiService.getAIConfig.mockReturnValue({ provider: 'mistral', model: 'mistral-small-latest', timeout: 45000, maxTokens: 8000 });
    aiUserModelStore.getUserModel.mockResolvedValue(null);
    aiUserModelStore.setUserModel.mockResolvedValue(undefined);
    aiUserModelStore.clearUserModel.mockResolvedValue(undefined);
    getPresetModels.mockImplementation(includeApiKey => (includeApiKey ? PRESETS_WITH_KEY : PRESETS_NO_KEY));
    fs.readFileSync.mockImplementation(() => JSON.stringify(CATALOG));
});

describe('getSelectableModels', () => {
    test('按渠道分组返回模型，且绝不包含 apiKey/baseUrl', async () => {
        const r = await aiConfigService.getSelectableModels('admin', 1);
        const { presets } = r.body.data;

        expect(presets.map(g => g.presetId)).toEqual(['mistral', 'agnes']);
        expect(presets[0].models.map(m => m.id)).toEqual(['mistral-small-latest', 'mistral-large-latest']);

        const serialized = JSON.stringify(r.body);
        expect(serialized).not.toContain('sk-');
        expect(serialized).not.toContain('apiKey');
        expect(serialized).not.toContain('baseUrl');
    });

    test('未收录的预设默认模型会补一条兜底项（isPresetDefault）', async () => {
        const r = await aiConfigService.getSelectableModels('admin', 1);
        const agnes = r.body.data.presets.find(g => g.presetId === 'agnes');

        // agnes 预设默认是 agnes-2.0-flash，但目录里只有 image 版
        expect(agnes.models[0]).toEqual(expect.objectContaining({
            id: 'agnes-2.0-flash', isPresetDefault: true
        }));
    });

    test('用户已自选 → current 反映偏好且 isDefault=false', async () => {
        aiUserModelStore.getUserModel.mockResolvedValue({ presetId: 'mistral', modelId: 'mistral-large-latest' });

        const r = await aiConfigService.getSelectableModels('admin', 1);
        expect(r.body.data.current).toEqual({
            presetId: 'mistral', modelId: 'mistral-large-latest', isDefault: false
        });
    });

    test('用户未自选 → current 回退全局模型且 isDefault=true', async () => {
        const r = await aiConfigService.getSelectableModels('admin', 1);
        expect(r.body.data.current).toEqual({
            presetId: null, modelId: 'mistral-small-latest', isDefault: true
        });
    });
});

describe('getMyModel', () => {
    test('有偏好 → 返回偏好与模型名', async () => {
        aiUserModelStore.getUserModel.mockResolvedValue({ presetId: 'mistral', modelId: 'mistral-large-latest' });

        const r = await aiConfigService.getMyModel('admin', 1);
        expect(r.body.data).toEqual({
            presetId: 'mistral', modelId: 'mistral-large-latest', modelName: 'Mistral Large', isDefault: false
        });
    });

    test('无偏好 → 返回全局模型且 isDefault=true', async () => {
        const r = await aiConfigService.getMyModel('admin', 1);
        expect(r.body.data).toEqual({
            presetId: null, modelId: 'mistral-small-latest', modelName: 'Mistral Small', isDefault: true
        });
    });
});

describe('setMyModel', () => {
    test('合法渠道 + 合法模型 → 落库并返回模型名', async () => {
        const r = await aiConfigService.setMyModel('admin', 1, { presetId: 'mistral', modelId: 'mistral-large-latest' });

        expect(aiUserModelStore.setUserModel).toHaveBeenCalledWith('admin', 1, {
            presetId: 'mistral', modelId: 'mistral-large-latest'
        });
        expect(r.body.data).toEqual(expect.objectContaining({
            presetId: 'mistral', modelId: 'mistral-large-latest', modelName: 'Mistral Large', isDefault: false
        }));
    });

    test('渠道不在 env 预设中 → 400', async () => {
        await expect(aiConfigService.setMyModel('admin', 1, { presetId: 'nope', modelId: 'm' }))
            .rejects.toMatchObject({ statusCode: 400 });
        expect(aiUserModelStore.setUserModel).not.toHaveBeenCalled();
    });

    test('模型不属于该渠道 → 400（防止把任意模型名写进偏好）', async () => {
        await expect(aiConfigService.setMyModel('admin', 1, { presetId: 'agnes', modelId: 'mistral-large-latest' }))
            .rejects.toMatchObject({ statusCode: 400 });
        expect(aiUserModelStore.setUserModel).not.toHaveBeenCalled();
    });

    test('命中该渠道的预设默认模型（未收录目录）→ 允许', async () => {
        const r = await aiConfigService.setMyModel('admin', 1, { presetId: 'agnes', modelId: 'agnes-2.0-flash' });
        expect(r.body.data.modelId).toBe('agnes-2.0-flash');
        expect(aiUserModelStore.setUserModel).toHaveBeenCalled();
    });
});

describe('clearMyModel', () => {
    test('清除偏好并回退全局模型', async () => {
        const r = await aiConfigService.clearMyModel('admin', 1);

        expect(aiUserModelStore.clearUserModel).toHaveBeenCalledWith('admin', 1);
        expect(r.body.data).toEqual(expect.objectContaining({
            presetId: null, modelId: 'mistral-small-latest', isDefault: true
        }));
    });
});

describe('resolveUserConfig', () => {
    test('无 userId → null（走全局配置）', async () => {
        await expect(aiConfigService.resolveUserConfig(undefined)).resolves.toBeNull();
        expect(aiUserModelStore.getUserModel).not.toHaveBeenCalled();
    });

    test('无偏好 → null', async () => {
        await expect(aiConfigService.resolveUserConfig('admin', 1)).resolves.toBeNull();
    });

    test('有偏好 → 拼出含密钥的完整配置，timeout/maxTokens 沿用全局', async () => {
        aiUserModelStore.getUserModel.mockResolvedValue({ presetId: 'mistral', modelId: 'mistral-large-latest' });

        await expect(aiConfigService.resolveUserConfig('admin', 1)).resolves.toEqual({
            enabled: true,
            provider: 'mistral',
            protocol: 'openai',
            apiKey: 'sk-mistral',
            baseUrl: 'https://m/v1',
            model: 'mistral-large-latest',
            timeout: 45000,
            maxTokens: 8000
        });
    });

    test('偏好指向的预设已从 env 移除 → null（静默回退，不让助手不可用）', async () => {
        aiUserModelStore.getUserModel.mockResolvedValue({ presetId: 'gone', modelId: 'm' });
        await expect(aiConfigService.resolveUserConfig('admin', 1)).resolves.toBeNull();
    });

    test('偏好缺少 presetId → null', async () => {
        aiUserModelStore.getUserModel.mockResolvedValue({ presetId: null, modelId: 'm' });
        await expect(aiConfigService.resolveUserConfig('admin', 1)).resolves.toBeNull();
    });

    test('store 抛错 → null（不让偏好读取失败阻断对话）', async () => {
        aiUserModelStore.getUserModel.mockRejectedValue(new Error('db down'));
        await expect(aiConfigService.resolveUserConfig('admin', 1)).resolves.toBeNull();
    });
});

describe('verifyUserModel（先验通再保存）', () => {
    test('上游可用 → available=true 且不落库', async () => {
        aiService.chat.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });

        const r = await aiConfigService.verifyUserModel({ presetId: 'mistral', modelId: 'mistral-large-latest' });

        expect(r.body.data.available).toBe(true);
        expect(aiUserModelStore.setUserModel).not.toHaveBeenCalled();
        // 用的是用户选的模型，而不是全局默认
        expect(aiService.chat.mock.calls[0][1].configOverride.model).toBe('mistral-large-latest');
    });

    test('上游报错 → available=false，仍是 200（业务结果而非服务端错误）', async () => {
        aiService.chat.mockRejectedValue(new Error('upstream 401 unauthorized'));

        const r = await aiConfigService.verifyUserModel({ presetId: 'mistral', modelId: 'mistral-large-latest' });

        expect(r.status).toBe(200);
        expect(r.body.data.available).toBe(false);
        expect(aiUserModelStore.setUserModel).not.toHaveBeenCalled();
    });

    test('渠道未配置凭证 → available=false，且不发起上游请求', async () => {
        getPresetModels.mockImplementation(includeApiKey => (includeApiKey ? [] : PRESETS_NO_KEY));

        const r = await aiConfigService.verifyUserModel({ presetId: 'mistral', modelId: 'mistral-small-latest' });

        expect(r.body.data.available).toBe(false);
        expect(aiService.chat).not.toHaveBeenCalled();
    });

    test('非法组合 → 400（与保存同一套判定，不会「验得过但存不了」）', async () => {
        await expect(aiConfigService.verifyUserModel({ presetId: 'agnes', modelId: 'mistral-large-latest' }))
            .rejects.toMatchObject({ statusCode: 400 });
        expect(aiService.chat).not.toHaveBeenCalled();
    });

    test('响应体不含任何凭证', async () => {
        aiService.chat.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });

        const r = await aiConfigService.verifyUserModel({ presetId: 'mistral', modelId: 'mistral-large-latest' });
        const serialized = JSON.stringify(r.body);

        expect(serialized).not.toContain('sk-');
        expect(serialized).not.toContain('apiKey');
        expect(serialized).not.toContain('baseUrl');
    });
});

describe('getModelCapabilities（按用户模型）', () => {
    test('传 userId 且该用户自选了视觉模型 → 返回该模型能力', async () => {
        aiUserModelStore.getUserModel.mockResolvedValue({ presetId: 'agnes', modelId: 'agnes-image-2.1-flash' });

        const r = await aiConfigService.getModelCapabilities('admin', 1);
        expect(r.body.data).toEqual({
            capabilities: { vision: true, tools: false, reasoning: false },
            model: 'agnes-image-2.1-flash'
        });
    });

    test('不传 userId → 沿用全局模型（旧调用方兼容）', async () => {
        const r = await aiConfigService.getModelCapabilities();
        expect(r.body.data.model).toBe('mistral-small-latest');
        expect(aiUserModelStore.getUserModel).not.toHaveBeenCalled();
    });
});

// 身份必须按 (userType, userId) 传递：只传 user_id 时，号段外的同值 ID
// 会让两个角色读到对方的偏好（管理员 500 与教师 500 曾是同一行）。
describe('角色维度贯穿到 store', () => {
    test('读偏好时把 userType 一并传给 store', async () => {
        await aiConfigService.getMyModel('teacher', 2001);
        expect(aiUserModelStore.getUserModel).toHaveBeenCalledWith('teacher', 2001);
    });

    test('写偏好时把 userType 一并传给 store', async () => {
        await aiConfigService.setMyModel('student', 3001, { presetId: 'mistral', modelId: 'mistral-large-latest' });
        expect(aiUserModelStore.setUserModel).toHaveBeenCalledWith('student', 3001, {
            presetId: 'mistral', modelId: 'mistral-large-latest'
        });
    });

    test('清偏好时把 userType 一并传给 store', async () => {
        await aiConfigService.clearMyModel('teacher', 2001);
        expect(aiUserModelStore.clearUserModel).toHaveBeenCalledWith('teacher', 2001);
    });
});
