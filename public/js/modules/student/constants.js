/**
 * Student Dashboard Constants
 */

export const API_ENDPOINTS = {
    PROFILE: '/api/student/profile',
    AVAILABILITY: '/api/student/availability',
    SCHEDULES: '/api/student/schedules',
    DATA_SUMMARY: '/api/student/data-summary',
    OVERVIEW: '/api/student/overview',
    CONFIRM_SCHEDULE: '/api/student/confirm-schedule'
};

export const TIME_SLOTS = {
    MORNING: 'morning',
    AFTERNOON: 'afternoon',
    EVENING: 'evening'
};

export const TIME_SLOT_LABELS = {
    [TIME_SLOTS.MORNING]: '上午',
    [TIME_SLOTS.AFTERNOON]: '下午',
    [TIME_SLOTS.EVENING]: '晚上'
};

export const SCHEDULE_STATUS = {
    PENDING: 'pending',
    CONFIRMED: 'confirmed',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled'
};

export const STATUS_LABELS = {
    [SCHEDULE_STATUS.PENDING]: '待确认',
    [SCHEDULE_STATUS.CONFIRMED]: '已确认',
    [SCHEDULE_STATUS.COMPLETED]: '已完成',
    [SCHEDULE_STATUS.CANCELLED]: '已取消'
};

export const STATUS_COLORS = {
    [SCHEDULE_STATUS.PENDING]: '#FFA726',
    [SCHEDULE_STATUS.CONFIRMED]: '#66BB6A',
    [SCHEDULE_STATUS.COMPLETED]: '#42A5F5',
    [SCHEDULE_STATUS.CANCELLED]: '#EF5350'
};

export const TIME_SLOT_CONFIG = Object.freeze([
    { id: 'morning', label: '上午', rangeLabel: '上午', start: '08:00', end: '12:00' },
    { id: 'afternoon', label: '下午', rangeLabel: '下午', start: '13:00', end: '17:00' },
    { id: 'evening', label: '晚上', rangeLabel: '晚上', start: '18:00', end: '21:00' }
]);

export const EMPTY_STATES = Object.freeze({
    todaySchedules: '今日暂无课程安排',
    availability: '当前周暂无可用时间，勾选后保存即可添加新的时间安排',
    schedules: '这一周暂无课程安排',
    statistics: '所选日期范围内没有学习数据'
});

export const SCHEDULE_TYPE_MAP = {
    'home_visit': '入户',
    'trial': '试教',
    'review': '评审',
    'review_record': '评审记录',
    'counseling': '心理咨询',
    'online_tutoring': '线上辅导',
    'offline_tutoring': '线下辅导',
    'group_activity': '集体活动',
    'half_visit': '半次入户',
    'visit': '入户',
    'other': '其他'
};

export function getScheduleTypeLabel(rawType) {
    if (!rawType) return '未分类';
    const normalized = String(rawType).trim();
    if (!normalized) return '未分类';

    if (window.ScheduleTypesStore && window.ScheduleTypesStore.getLabel) {
        return window.ScheduleTypesStore.getLabel(normalized);
    }

    return SCHEDULE_TYPE_MAP[normalized] || normalized;
}
