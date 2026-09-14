// B2（M3）：availability 共享纯函数单元测试
// 原 services/availability.js 与 availability-service.js 重复（前者只导出 3 个纯函数，
// 却被控制器按完整版解构，拿到 undefined），已归档至 _archive/，统一使用 availability-service。
const { SLOT_COLUMNS, slotToColumn, toSlotBit } = require('../../services/availability-service');

describe('availability 共享纯函数', () => {
    test('SLOT_COLUMNS 映射固定', () => {
        expect(SLOT_COLUMNS).toEqual({
            morning: 'morning_available',
            afternoon: 'afternoon_available',
            evening: 'evening_available'
        });
    });

    test('slotToColumn 合法键返回列名，非法键返回 null', () => {
        expect(slotToColumn('morning')).toBe('morning_available');
        expect(slotToColumn('afternoon')).toBe('afternoon_available');
        expect(slotToColumn('evening')).toBe('evening_available');
        expect(slotToColumn('noon')).toBeNull();
        expect(slotToColumn(undefined)).toBeNull();
    });

    test('toSlotBit 真值转 1、假值转 0（与 admin 原 `flag ? 1 : 0` 语义一致）', () => {
        expect(toSlotBit(true)).toBe(1);
        expect(toSlotBit(1)).toBe(1);
        expect(toSlotBit('x')).toBe(1);
        expect(toSlotBit(false)).toBe(0);
        expect(toSlotBit(0)).toBe(0);
        expect(toSlotBit(undefined)).toBe(0);
        expect(toSlotBit(null)).toBe(0);
    });
});
