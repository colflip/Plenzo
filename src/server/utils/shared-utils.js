const logger = require('./logger.js');
/**
 * 服务端共享工具函数
 * @description 消除控制器和服务层之间的重复代码
 * @module utils/sharedUtils
 */

/**
 * 验证日期格式 (YYYY-MM-DD)
 * @param {string} dateStr
 * @returns {boolean}
 */
function validateDateFormat(dateStr) {
    return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !isNaN(new Date(dateStr).getTime());
}

/**
 * 生成东八区时间戳字符串
 * @returns {string} 格式: YYYYMMDDHHmmss
 */
function getTimestamp() {
    const now = new Date();
    const utc8Time = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const y = utc8Time.getUTCFullYear();
    const m = String(utc8Time.getUTCMonth() + 1).padStart(2, '0');
    const d = String(utc8Time.getUTCDate()).padStart(2, '0');
    const h = String(utc8Time.getUTCHours()).padStart(2, '0');
    const mi = String(utc8Time.getUTCMinutes()).padStart(2, '0');
    const s = String(utc8Time.getUTCSeconds()).padStart(2, '0');
    return `${y}${m}${d}${h}${mi}${s}`;
}

/**
 * 用户类型到数据库表名映射
 * @param {string} userType
 * @returns {string}
 */
function resolveTableName(userType) {
    switch (userType) {
        case 'admin': return 'administrators';
        case 'teacher': return 'teachers';
        case 'student': return 'students';
        default: throw new Error(`无效的用户类型: ${userType}`);
    }
}

/**
 * 解析用户名（通用）
 * @param {object} db - 数据库实例
 * @param {string} userType
 * @param {number} userId
 * @returns {Promise<string>}
 */
async function resolveUserName(db, userType, userId) {
    try {
        const table = resolveTableName(userType);
        const r = await db.query(`SELECT name, username FROM ${table} WHERE id = $1`, [userId]);
        if (r.rows.length > 0) {
            return r.rows[0].name || r.rows[0].username || '用户';
        }
    } catch (e) {
        logger.warn('获取用户名失败:', e.message);
    }
    return userType === 'admin' ? '管理员' : userType === 'teacher' ? '教师' : '学生';
}

/**
 * 统一状态映射（单一权威来源）
 *
 * 教师状态是「类别.生命周期」两段可读码（例 normal.completed / temp.cancelled），
 * 一个字段承载两个正交维度，取代旧表的 status + adjustment_type + is_temp 三列。
 * 生命周期字面量沿用旧表原名（含 modified_away），前端判定与 CSS 类名因此无需改动。
 */
const LIFECYCLE_MAP = {
    'pending': '待确认',
    'confirmed': '已确认',
    'completed': '已完成',
    'cancelled': '已取消',
    'modified_away': '已调整'
};

/** 类别位标签：normal 不出徽标（普通课不需要标记），temp/adjusted 各出一个 */
const CATEGORY_MAP = {
    'normal': '',
    'adjusted': '调整增补',
    'temp': '临时加课'
};

/** 生命周期位为这两个值的 pair 视为不活跃：不占教师活跃名额、不参与冲突与统计 */
const INACTIVE_LIFECYCLES = ['cancelled', 'modified_away'];

/**
 * session_change_logs.action 的取值：唯一源放这儿，因为写方（course-session-service）
 * 与约束方（迁移里的 chk_scl_action CHECK）都要吃它 —— 以前各抄一份，加一个动作就得记着改两处。
 * 值的**声明顺序**就是下发给 CHECK 的顺序，动它等于动 DDL 文本。
 */
const CHANGE_ACTIONS = Object.freeze({
    CREATE: 'create',
    HEADER: 'header',
    PAIR_PATCH: 'pair_patch',
    PAIR_ADD: 'pair_add',
    PAIR_REMOVE: 'pair_remove',
    DELETE: 'delete',
    USER_CLEANUP: 'user_cleanup',
    USER_ID_MIGRATED: 'user_id_migrated'
});

/** 兼容名：历史调用点把生命周期映射叫 STATUS_MAP */
const STATUS_MAP = LIFECYCLE_MAP;

/** 拆两段码；传入单值（只有生命周期）时类别按 normal 处理 */
function splitStatus(status) {
    const s = String(status || '');
    const i = s.indexOf('.');
    return i < 0
        ? { category: 'normal', lifecycle: s }
        : { category: s.slice(0, i), lifecycle: s.slice(i + 1) };
}

/**
 * 获取状态中文标签。接受完整两段码或单独的生命周期位。
 * @param {string} status
 * @returns {string}
 */
function getStatusLabel(status) {
    const { lifecycle } = splitStatus(status);
    return LIFECYCLE_MAP[lifecycle] || String(status || '未知');
}

/**
 * 格式化日期时间为 zh-CN 本地格式（YYYY-MM-DD HH:mm:ss）
 * @param {string|Date} datetime
 * @returns {string}
 */
function formatDateTime(datetime) {
    if (!datetime) return '';
    try {
        const d = new Date(datetime);
        return d.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    } catch (e) {
        return String(datetime);
    }
}

/**
 * DATE → 日历日 'YYYY-MM-DD'，按**本地**分量取。
 * node-pg 把 DATE 解析成本地零点的 Date：在 UTC+8 机器上 `toISOString()` 会回退一天，
 * 周日课被算成周六（星期错位的同类坑，getDayOfWeek 已经踩过一次）。
 */
function toDateKey(value) {
    if (value instanceof Date) {
        const p = (n) => String(n).padStart(2, '0');
        return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
    }
    return String(value == null ? '' : value).slice(0, 10);
}

/** TIME → 'HH:MM:SS'。REST 表单给 'HH:MM'、库里给 'HH:MM:SS'，直接字符串比较会造出假重叠 */
function normTime(value) {
    // 逐位补零：validation 的时间 pattern 允许 '9:00' 这种单位数小时，只补秒不补时/分的话
    // '9:00:00' 字典序会大于 '09:30:00'，重叠判定与 slotKeyOf 同时失效（冲突提示静默消失）。
    const parts = String(value || '').slice(0, 8).split(':');
    if (parts.length < 2) return String(value || '');
    const p = (n) => String(n).padStart(2, '0');
    return [p(parts[0]), p(parts[1]), p(parts[2] ?? '00')].join(':');
}

/** 时段键（本地日历日|起|止）：冲突结果靠它挂回到具体的某一行 */
function slotKeyOf(date, startTime, endTime) {
    return `${toDateKey(date)}|${normTime(startTime)}|${normTime(endTime)}`;
}

/**
 * 北京时区（UTC+8）的业务日历工具。
 *
 * 为什么必须有：服务跑在 UTC（Vercel 默认、db.js 也把会话时区钉在 UTC），
 * 而排课的「今天/本周/本月」按北京日历定义。用 `now.getMonth()` / `toISOString()`
 * 这类 UTC 组件算出来的窗口，在北京时间每天 00:00–08:00 与每月 1 号 00:00–08:00
 * 会整体错一天 / 错到上一月（审查报告 P1-17 的实测复现：北京 11-01 00:30 时
 * 「本月」= 2026-10-01…10-31）。
 *
 * 做法是先按 Asia/Shanghai 取出**日历三元组**，再用 Date.UTC 构造做加减法，
 * 全程不依赖宿主时区，也不会再踩「UTC 组件 + 上海渲染」混用同一天里的两个日期。
 */
function beijingCalendarParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const pick = (t) => Number(parts.find(p => p.type === t).value);
    return { year: pick('year'), month: pick('month'), day: pick('day') };
}

/**
 * 北京日历日 YYYY-MM-DD（接受 Date / 类日期字符串）。
 * 不设默认值：缺日期必须返回空串，不能被悄悄当成「今天」而错挂到当前窗口。
 */
function toBeijingDateKey(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        const { year, month, day } = beijingCalendarParts(value);
        const p = (n) => String(n).padStart(2, '0');
        return `${year}-${p(month)}-${p(day)}`;
    }
    // 字符串形态：库里取出的 date 已是 YYYY-MM-DD（业务日本身），截前 10 位即可
    return String(value == null ? '' : value).slice(0, 10);
}

/** 本自然月首末日（北京日历），返回 { startDate, endDate } */
function beijingMonthWindow(now = new Date()) {
    const { year, month } = beijingCalendarParts(now);
    const first = new Date(Date.UTC(year, month - 1, 1));
    const last = new Date(Date.UTC(year, month, 0));
    return {
        startDate: first.toISOString().slice(0, 10),
        endDate: last.toISOString().slice(0, 10)
    };
}

/** 本周一~周日（北京日历，周一为一周起点），返回 { startDate, endDate } */
function beijingWeekWindow(now = new Date()) {
    const { year, month, day } = beijingCalendarParts(now);
    const anchor = new Date(Date.UTC(year, month - 1, day, 12));
    const dow = anchor.getUTCDay() || 7;              // 周一=1 … 周日=7
    const monday = new Date(Date.UTC(year, month - 1, day - dow + 1));
    const sunday = new Date(Date.UTC(year, month - 1, day - dow + 7));
    return {
        startDate: monday.toISOString().slice(0, 10),
        endDate: sunday.toISOString().slice(0, 10)
    };
}

module.exports = {
    validateDateFormat,
    getTimestamp,
    resolveTableName,
    resolveUserName,
    STATUS_MAP,
    LIFECYCLE_MAP,
    CATEGORY_MAP,
    INACTIVE_LIFECYCLES,
    CHANGE_ACTIONS,
    splitStatus,
    getStatusLabel,
    formatDateTime,
    toDateKey,
    toBeijingDateKey,
    beijingCalendarParts,
    beijingMonthWindow,
    beijingWeekWindow,
    normTime,
    slotKeyOf
};
