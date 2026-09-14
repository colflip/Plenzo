// 用户级 AI 模型偏好：store（DB 双写 + 降级）与 service 解析层
// 关键安全断言：可选清单与「我的模型」接口都不得回传任何密钥。
const mockQuery = jest.fn();

jest.mock('../../db/db', () => ({ query: mockQuery }));
jest.mock('../../utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), log: jest.fn(), info: jest.fn(), debug: jest.fn() }));

const aiUserModelStore = require('../../services/ai-user-model-store');

const key = (userType, userId) => aiUserModelStore._memKey(userType, userId);

describe('ai-user-model-store', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
        aiUserModelStore._reset();
    });

    test('setUserModel 同时写内存与数据库（write-through）', async () => {
        const value = await aiUserModelStore.setUserModel('admin', 7, { presetId: 'mistral', modelId: 'mistral-large-latest' });

        expect(value).toEqual({ presetId: 'mistral', modelId: 'mistral-large-latest' });
        expect(aiUserModelStore._mem.get(key('admin', 7))).toEqual(value);
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO ai_user_model_prefs'),
            [7, 'admin', 'mistral', 'mistral-large-latest']
        );
    });

    test('presetId 为空时落库为 null（允许只绑模型）', async () => {
        await aiUserModelStore.setUserModel('teacher', 9, { presetId: '', modelId: 'm1' });
        expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [9, 'teacher', null, 'm1']);
    });

    test('getUserModel 命中内存时不再查库', async () => {
        aiUserModelStore._mem.set(key('admin', 7), { presetId: 'agnes', modelId: 'agnes-2.0-flash' });

        await expect(aiUserModelStore.getUserModel('admin', 7)).resolves.toEqual({
            presetId: 'agnes', modelId: 'agnes-2.0-flash'
        });
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('getUserModel 未命中内存 → 回源数据库并回填缓存', async () => {
        mockQuery.mockResolvedValue({ rows: [{ preset_id: 'openmodel', model_id: 'deepseek-v4-flash' }] });

        await expect(aiUserModelStore.getUserModel('student', 3)).resolves.toEqual({
            presetId: 'openmodel', modelId: 'deepseek-v4-flash'
        });
        expect(aiUserModelStore._mem.get(key('student', 3))).toEqual({ presetId: 'openmodel', modelId: 'deepseek-v4-flash' });
        // 查询必须带角色，否则同值 ID 会串到另一个角色
        expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('user_type = $2'), [3, 'student']);
    });

    test('数据库无记录 → null（调用方回退全局配置）', async () => {
        await expect(aiUserModelStore.getUserModel('admin', 3)).resolves.toBeNull();
    });

    test('同值 ID 的两个角色互不覆盖（内存层）', async () => {
        await aiUserModelStore.setUserModel('admin', 500, { presetId: 'mistral', modelId: 'mistral-large-latest' });
        await aiUserModelStore.setUserModel('teacher', 500, { presetId: 'agnes', modelId: 'agnes-2.0-flash' });

        await expect(aiUserModelStore.getUserModel('admin', 500)).resolves.toEqual({
            presetId: 'mistral', modelId: 'mistral-large-latest'
        });
        await expect(aiUserModelStore.getUserModel('teacher', 500)).resolves.toEqual({
            presetId: 'agnes', modelId: 'agnes-2.0-flash'
        });
    });

    test('clearUserModel 只清当前角色的行，不动同值 ID 的另一个角色', async () => {
        await aiUserModelStore.setUserModel('admin', 500, { presetId: 'mistral', modelId: 'mistral-large-latest' });
        await aiUserModelStore.setUserModel('student', 500, { presetId: 'agnes', modelId: 'agnes-2.0-flash' });

        await aiUserModelStore.clearUserModel('admin', 500);

        expect(aiUserModelStore._mem.has(key('admin', 500))).toBe(false);
        await expect(aiUserModelStore.getUserModel('student', 500)).resolves.toEqual({
            presetId: 'agnes', modelId: 'agnes-2.0-flash'
        });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringContaining('DELETE FROM ai_user_model_prefs'),
            [500, 'admin']
        );
    });

    test('purgeUserModel 用调用方给的执行器删行（级联删除时并入同一事务）', async () => {
        const txQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
        aiUserModelStore._mem.set(key('teacher', 42), { presetId: 'mistral', modelId: 'm' });

        await aiUserModelStore.purgeUserModel('teacher', 42, txQuery);

        expect(txQuery).toHaveBeenCalledWith(
            expect.stringContaining('DELETE FROM ai_user_model_prefs'),
            [42, 'teacher']
        );
        expect(mockQuery).not.toHaveBeenCalled();
        expect(aiUserModelStore._mem.has(key('teacher', 42))).toBe(false);
    });

    test('purgeUserModel 失败只记日志，不把 store 降级为纯内存', async () => {
        const txQuery = jest.fn().mockRejectedValue(new Error('deadlock detected'));

        await expect(aiUserModelStore.purgeUserModel('teacher', 42, txQuery)).resolves.toBeUndefined();
        expect(aiUserModelStore._state().dbAvailable).toBe(true);
    });

    test('非法 userType 直接拒绝，不写库也不写内存', async () => {
        await expect(aiUserModelStore.setUserModel(undefined, 7, { presetId: 'mistral', modelId: 'm' }))
            .rejects.toThrow(/invalid userType/);
        expect(mockQuery).not.toHaveBeenCalled();
        expect(aiUserModelStore._mem.size).toBe(0);
    });

    test('DB 失败一次即降级为内存，后续不再尝试连接', async () => {
        mockQuery.mockRejectedValue(new Error('relation does not exist'));

        await aiUserModelStore.setUserModel('admin', 5, { presetId: 'mistral', modelId: 'm' });
        expect(aiUserModelStore._state().dbAvailable).toBe(false);

        // 降级后仍能从内存读到本实例写入的偏好
        await expect(aiUserModelStore.getUserModel('admin', 5)).resolves.toEqual({ presetId: 'mistral', modelId: 'm' });

        const callsAfterFallback = mockQuery.mock.calls.length;
        await aiUserModelStore.getUserModel('admin', 999);
        expect(mockQuery.mock.calls.length).toBe(callsAfterFallback);
    });

    test('clearUserModel 同时清内存与数据库', async () => {
        aiUserModelStore._mem.set(key('admin', 7), { presetId: 'mistral', modelId: 'm' });
        await aiUserModelStore.clearUserModel('admin', 7);

        expect(aiUserModelStore._mem.has(key('admin', 7))).toBe(false);
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringContaining('DELETE FROM ai_user_model_prefs'),
            [7, 'admin']
        );
    });
});
