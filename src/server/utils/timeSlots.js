/**
 * 简单工具函数，确保使用预定义的时间段和时间范围。
 * 统一维护时间段的映射关系，避免在不同文件中重复定义。
 */

// 用于公开给其他模块使用的时间段常量
const TIME_SLOTS = {
    MORNING: 'morning',
    AFTERNOON: 'afternoon',
    EVENING: 'evening'
};

// 时间段和标签的映射
const SLOT_LABELS = {
    [TIME_SLOTS.MORNING]: '上午 (08:00-12:00)',
    [TIME_SLOTS.AFTERNOON]: '下午 (13:00-17:00)',
    [TIME_SLOTS.EVENING]: '晚上 (18:00-21:00)'
};

// 时间段和时间范围的映射
const SLOT_RANGES = {
    [TIME_SLOTS.MORNING]: ['08:00', '12:00'],
    [TIME_SLOTS.AFTERNOON]: ['13:00', '17:00'],
    [TIME_SLOTS.EVENING]: ['18:00', '21:00']
};

// 可用状态的常量定义
const AVAILABILITY_STATUS = {
    AVAILABLE: 'available',
    UNAVAILABLE: 'unavailable',
    NOT_SET: 'not-set'
};

// 验证时间段是否有效
function isValidTimeSlot(slot) {
    return Object.values(TIME_SLOTS).includes(slot);
}

// 获取时间段的显示标签
function getSlotLabel(slot) {
    return SLOT_LABELS[slot] || '未知时间段';
}

// 获取时间段的时间范围
function getSlotRange(slot) {
    return SLOT_RANGES[slot] || [null, null];
}

// 根据开始时间确定时间段
function getTimeSlotFromStartTime(startTime) {
    if (!startTime) return null;
    
    // 解析时间字符串 (HH:MM格式)
    const [hours, minutes] = startTime.split(':').map(Number);
    const totalMinutes = hours * 60 + minutes;
    
    // 根据时间段定义确定所属时间段
    if (totalMinutes >= 8 * 60 && totalMinutes < 12 * 60) {
        return TIME_SLOTS.MORNING;
    } else if (totalMinutes >= 13 * 60 && totalMinutes < 17 * 60) {
        return TIME_SLOTS.AFTERNOON;
    } else if (totalMinutes >= 18 * 60 && totalMinutes < 21 * 60) {
        return TIME_SLOTS.EVENING;
    }
    
    return null;
}

// 对外暴露的接口
module.exports = {
    TIME_SLOTS,
    SLOT_LABELS,
    SLOT_RANGES,
    AVAILABILITY_STATUS,
    isValidTimeSlot,
    getSlotLabel,
    getSlotRange,
    getTimeSlotFromStartTime
};