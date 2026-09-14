/**
 * ai-operation-store 单测：内存兜底路径（不依赖真实 DB）
 * 覆盖 save / get / delete / 过期清理，以及「DB 失败降级内存」的写穿透行为。
 */
// mock db：单测不依赖真实 DATABASE_URL（真连接会让 savePreview 卡 4s+ 直到超时）
jest.mock('../../db/db', () => ({
    query: jest.fn(async () => { throw new Error('db unavailable in test'); })
}));

const aiOperationStore = require('../../services/ai-operation-store');

describe('ai-operation-store（内存兜底路径）', () => {
    beforeEach(() => {
        aiOperationStore._mem.memPreviews.clear();
        aiOperationStore._mem.memOperations.clear();
    });

    test('savePreview → getPreview 往返拿到 groups', async () => {
        await aiOperationStore.savePreview('pv_1', { created_by: 9, groups: [{ a: 1 }] });
        const got = await aiOperationStore.getPreview('pv_1');
        expect(got).not.toBeNull();
        expect(got.previewId).toBe('pv_1');
        expect(got.groups).toEqual([{ a: 1 }]);
    });

    test('deletePreview 后读取返回 null', async () => {
        await aiOperationStore.savePreview('pv_2', { created_by: 9, groups: [] });
        await aiOperationStore.deletePreview('pv_2');
        expect(await aiOperationStore.getPreview('pv_2')).toBeNull();
    });

    test('saveOperation 完整对象原样返回（含 type / scheduleIds）', async () => {
        const payload = { type: 'update', scheduleIds: [1, 2], fields: { status: 'confirmed' } };
        await aiOperationStore.saveOperation('op_1', payload);
        const got = await aiOperationStore.getOperation('op_1');
        expect(got.id).toBe('op_1');
        expect(got.type).toBe('update');
        expect(got.scheduleIds).toEqual([1, 2]);
    });

    test('deleteOperation 后读取返回 null', async () => {
        await aiOperationStore.saveOperation('op_2', { type: 'delete', scheduleIds: [3] });
        await aiOperationStore.deleteOperation('op_2');
        expect(await aiOperationStore.getOperation('op_2')).toBeNull();
    });

    test('过期条目读取返回 null 并清理（Mock 时间）', async () => {
        await aiOperationStore.saveOperation('op_3', { type: 'delete', scheduleIds: [4] });
        const realNow = Date.now;
        Date.now = () => realNow() + 6 * 60 * 1000; // 跳过 5 分钟 TTL
        try {
            expect(await aiOperationStore.getOperation('op_3')).toBeNull();
        } finally {
            Date.now = realNow;
        }
    });

    test('TTL_MS 为 5 分钟', () => {
        expect(aiOperationStore.TTL_MS).toBe(5 * 60 * 1000);
    });
});
