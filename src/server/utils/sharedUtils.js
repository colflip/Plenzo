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
        console.warn('获取用户名失败:', e.message);
    }
    return userType === 'admin' ? '管理员' : userType === 'teacher' ? '教师' : '学生';
}

/**
 * 统一状态映射（单一权威来源）
 */
const STATUS_MAP = {
    'pending': '待确认',
    'confirmed': '已确认',
    'cancelled': '已取消',
    'completed': '已完成',
    'modified_away': '已调整',
    // 数字键兼容
    '0': '待确认',
    '1': '已确认',
    '2': '已完成'
};

/**
 * 获取状态中文标签
 * @param {string} status
 * @returns {string}
 */
function getStatusLabel(status) {
    return STATUS_MAP[String(status)] || String(status || '未知');
}

module.exports = {
    validateDateFormat,
    getTimestamp,
    isNeonTimeout,
    resolveTableName,
    resolveUserName,
    STATUS_MAP,
    getStatusLabel
};
