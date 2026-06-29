/**
 * 导出常量定义
 * 集中管理导出功能相关的常量和配置
 */

// 类型优先级排序（用于课程排序，按中文基础类型）
const TYPE_PRIORITY = {
    '咨询': 1,
    '评审': 2,
    '集体活动': 3,
    '入户': 4,
    '试教': 5
};

// 星期映射
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 状态映射
const STATUS_MAP = {
    'pending': '待确认',
    'confirmed': '已确认',
    'cancelled': '已取消',
    'completed': '已完成',
    'modified_away': '已调整'
};

// 家庭参与人员映射
const FAMILY_MAP = {
    0: '无人',
    1: '妈',
    2: '爸',
    3: '爸妈',
    4: '多人',
    10: '学生',
    11: '学生+妈',
    12: '学生+爸',
    13: '学生+爸妈',
    14: '学生+多人'
};

// 类型归一化映射（线上类型 → 标准类型，用于统计聚合）
const TYPE_NORMALIZATION = {
    '线上入户': '入户',
    '线上评审': '评审',
    '线上咨询': '咨询',
    '线上试教': '试教',
    '线上集体活动': '集体活动',
    '半次入户': '半次入户',
    '评审记录': '评审记录'
};

// 类型名称映射：数据库 name → 中文显示名（不能机器翻译，必须与数据库定义一致）
// 前端参考：public/js/core/schedule-types-store.js LEGACY_MAP
// 前端参考：public/js/components/export-manager.js 第 194-206 行
const TYPE_DISPLAY_MAP = {
    // 英文标识 → 中文
    'visit': '入户',
    'trial': '试教',
    'review': '评审',
    'review_record': '评审记录',
    'half_visit': '半次入户',
    'group_activity': '集体活动',
    'group': '集体活动',
    'advisory': '咨询',
    'consultation': '咨询',
    'consultation_record': '咨询记录',
    'advisory_record': '咨询记录',
    // 英文线上标识 → 中文（线上）格式
    'visit_online': '（线上）入户',
    'review_online': '（线上）评审',
    'advisory_online': '（线上）咨询',
    'consultation_online': '（线上）咨询',
    'trial_online': '（线上）试教',
    'group_activity_online': '（线上）集体活动',
    'online_visit': '（线上）入户',
    'online_review': '（线上）评审',
    'online_advisory': '（线上）咨询',
    'online_consultation': '（线上）咨询',
    // 中文已有名称 → 保持不变
    '入户': '入户',
    '试教': '试教',
    '评审': '评审',
    '评审记录': '评审记录',
    '半次入户': '半次入户',
    '集体活动': '集体活动',
    '咨询': '咨询',
    '咨询记录': '咨询记录',
    '线上入户': '（线上）入户',
    '线上评审': '（线上）评审',
    '线上咨询': '（线上）咨询',
    '线上试教': '（线上）试教',
    '线上集体活动': '（线上）集体活动',
    // 带括号的变体 → 保持不变
    '(线上)入户': '（线上）入户',
    '(线上)评审': '（线上）评审',
    '(线上)咨询': '（线上）咨询',
    '(线上)试教': '（线上）试教',
    '(线上)集体活动': '（线上）集体活动',
    '（线上）入户': '（线上）入户',
    '（线上）评审': '（线上）评审',
    '（线上）咨询': '（线上）咨询',
    '（线上）试教': '（线上）试教',
    '（线上）集体活动': '（线上）集体活动',
    '（线上）评审记录': '（线上）评审记录',
    '（线上）咨询记录': '（线上）咨询记录'
};

// Rich Text 颜色配置（8位 ARGB 格式：FF + 6位RGB）
// 按色系组织：评审/咨询=红色，集体活动=蓝色，其他=黑色
// 取消/调整课程使用对应色系的浅色 + 斜体
const RICH_TEXT_COLORS = {
    RED: 'FFFF0000',          // 评审/咨询：红色
    RED_LIGHT: 'FFDD8888',    // 评审/咨询 取消/调整：浅红色
    BLUE: 'FF2F5496',         // 集体活动：蓝色
    BLUE_LIGHT: 'FF8DB4E2',   // 集体活动 取消/调整：浅蓝色
    BLACK: 'FF000000',        // 其他课程：黑色
    BLACK_LIGHT: 'FF999999'   // 其他课程 取消/调整：浅灰色
};

// 不可计数的状态
const NON_COUNTABLE_STATUSES = ['cancelled', 'modified_away'];

// 导出记录限制
const EXPORT_LIMITS = {
    DEFAULT: 5000,    // 默认限制
    MAX: 20000        // 最大限制（分批处理）
};

// 分批处理配置
const BATCH_CONFIG = {
    SIZE: 1000,              // 每批处理的记录数
    THRESHOLD: 5000          // 触发分批处理的阈值
};

// 缓存配置
const CACHE_CONFIG = {
    TTL: 5 * 60 * 1000  // 5分钟
};

module.exports = {
    TYPE_PRIORITY,
    WEEKDAYS,
    STATUS_MAP,
    FAMILY_MAP,
    TYPE_NORMALIZATION,
    TYPE_DISPLAY_MAP,
    RICH_TEXT_COLORS,
    NON_COUNTABLE_STATUSES,
    EXPORT_LIMITS,
    BATCH_CONFIG,
    CACHE_CONFIG
};
