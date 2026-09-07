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
 * 判断错误是否为 Neon 超时/连接错误（可重试）
 * @param {Error} error
 * @returns {boolean}
 */
function isNeonTimeout(error) {
    const code = error?.sourceError?.code || error?.code;
    const msg = String(error?.message || '');
    return code === 'UND_ERR_CONNECT_TIMEOUT' ||
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        msg.includes('fetch failed') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('socket disconnected') ||
        msg.includes('connection reset') ||
        msg.includes('timeout');
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
 * 获取类别徽标文本（普通课返回空串）。全仓禁止手写 status.split('.')，统一走这里。
 * @param {string} status
 * @returns {string}
 */
function getStatusBadge(status) {
    return CATEGORY_MAP[splitStatus(status).category] || '';
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

module.exports = {
    validateDateFormat,
    getTimestamp,
    isNeonTimeout,
    resolveTableName,
    resolveUserName,
    STATUS_MAP,
    LIFECYCLE_MAP,
    CATEGORY_MAP,
    INACTIVE_LIFECYCLES,
    splitStatus,
    getStatusLabel,
    getStatusBadge,
    formatDateTime
};
