import { STATUS_LABELS } from '../shared/schedule-helpers.js';

// 时段定义统一由 shared/schedule-helpers.js 提供（原此处有一份逐字相同的副本）
export { TIME_SLOT_CONFIG } from '../shared/schedule-helpers.js';

// 状态文案同样统一到 shared 的单一权威来源：本地副本曾漏掉「已调整」，
// 遇到 modified_away 会直接显示原始英文。
export const SCHEDULE_STATUS_LABELS = STATUS_LABELS;

export const SCHEDULE_STATUS_OPTIONS = Object.freeze([
    { value: 'pending', label: SCHEDULE_STATUS_LABELS.pending },
    { value: 'confirmed', label: SCHEDULE_STATUS_LABELS.confirmed },
    { value: 'completed', label: SCHEDULE_STATUS_LABELS.completed },
    { value: 'cancelled', label: SCHEDULE_STATUS_LABELS.cancelled },
    { value: 'modified_away', label: SCHEDULE_STATUS_LABELS.modified_away }
]);

export function getStatusLabel(status) {
    return SCHEDULE_STATUS_LABELS[String(status).toLowerCase()] || status || '未知状态';
}

const TYPE_LABEL_MAP = Object.freeze({
    'home-visit': '入户',
    'home_visit': '入户',
    'home visit': '入户',
    'visit': '入户',
    'trial-teaching': '试教',
    'trial_teaching': '试教',
    'trial teaching': '试教',
    'trial': '试教',
    'review': '评审',
    'review-record': '评审记录',
    'review_record': '评审记录',
    'review record': '评审记录',
    'half-home-visit': '半次入户',
    'half_home_visit': '半次入户',
    'half visit': '半次入户',
    'group-activity': '集体活动',
    'group_activity': '集体活动',
    'group activity': '集体活动',
    'psychological-counseling': '心理咨询',
    'psychological_counseling': '心理咨询',
    'psychological counseling': '心理咨询',
    'online-tutoring': '线上辅导',
    'online_tutoring': '线上辅导',
    'online tutoring': '线上辅导',
    'offline-tutoring': '线下辅导',
    'offline_tutoring': '线下辅导',
    'offline tutoring': '线下辅导',
    'default': '课程',
    'other': '其他'
});

export function getScheduleTypeLabel(rawType) {
    if (!rawType) return '未分类';
    const normalized = String(rawType).trim();
    if (!normalized) return '未分类';

    // Prioritize Dynamic Store
    if (window.ScheduleTypesStore && window.ScheduleTypesStore.getLabel) {
        return window.ScheduleTypesStore.getLabel(normalized);
    }

    const lower = normalized.toLowerCase();
    return TYPE_LABEL_MAP[lower] || normalized;
}

export const EMPTY_STATES = Object.freeze({
    todaySchedules: '今日暂无排课安排',
    availability: '当前周暂无可用时间，勾选后保存即可添加新的时间安排',
    schedules: '这一周暂无课程安排',
    statistics: '所选日期范围内没有课程数据'
});

export const DEFAULT_LOCATION_PLACEHOLDER = '未指定地点';
