const logger = require('../utils/logger.js');
const db = require('../db/db');

/**
 * 用户级 AI 模型偏好存储
 * @description
 *  全局 AI 配置（ai_config 单行）是管理员维护的默认值；本模块存的是「某个用户自己
 *  选了哪个模型」，只影响该用户自己的会话，互不干扰。
 *
 *  只持久化 presetId + modelId 这两个标识符，不存 baseUrl / apiKey：
 *  真实密钥始终留在服务端 env（见 preset-models.js），由 ai-config-service
 *  在请求内解析成完整配置，避免密钥随偏好数据扩散或泄漏到客户端。
 *
 *  写入采用 write-through（内存 Map + 数据库双写），读取先查内存再回源数据库，
 *  与 ai-operation-store 一致；区别是用户偏好属长期状态，不设 TTL。
 *  数据库一旦失败即降级为纯内存，保证「切换模型」在 DB 抖动时仍可用（只是不跨实例）。
 *
 *  身份是 (userType, userId) 两元组而不是单 user_id：user_id 是多态的，三张角色表的
 *  号段虽不重叠，但号段外的历史存量 ID 可以同值存在于两张表（见 user-service 的
 *  findCrossRoleConflict），只按 user_id 存取会让两个角色互相顶掉对方的偏好。
 *  内存 Map 的键必须与主键同构，否则内存层仍会跨角色串。
 */

const TABLE = 'ai_user_model_prefs';
const USER_TYPES = ['admin', 'teacher', 'student'];

const memPrefs = new Map();
let dbAvailable = true;
let lastDbError = null;

function memKey(userType, userId) {
    return `${userType}:${userId}`;
}

/**
 * 校验角色，把非法值挡在写库之前。
 * 不校验的话 `user_type = undefined` 会以 NULL 落库并被 NOT NULL 约束拒绝，
 * 表现成「切换模型时好时坏」；内存层则会把所有角色塞进同一个 `undefined:` 键。
 */
function assertUserType(userType) {
    if (!USER_TYPES.includes(userType)) {
        throw new Error(`invalid userType: ${userType}`);
    }
}

/**
 * 保存用户选定的模型
 * @param {string} userType - admin / teacher / student
 * @param {number} userId
 * @param {{presetId: string|null, modelId: string}} pref
 */
async function setUserModel(userType, userId, pref) {
    assertUserType(userType);
    const value = {
        presetId: pref.presetId || null,
        modelId: pref.modelId
    };
    memPrefs.set(memKey(userType, userId), value);

    if (dbAvailable) {
        try {
            await db.query(
                `INSERT INTO ${TABLE} (user_id, user_type, preset_id, model_id, updated_at)
                 VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
                 ON CONFLICT (user_id, user_type) DO UPDATE SET
                    preset_id = EXCLUDED.preset_id,
                    model_id = EXCLUDED.model_id,
                    updated_at = CURRENT_TIMESTAMP`,
                [userId, userType, value.presetId, value.modelId]
            );
        } catch (err) {
            dbAvailable = false;
            lastDbError = err.message;
            logger.warn('[ai-user-model-store] 保存用户模型偏好到 DB 失败，降级内存:', err.message);
        }
    }
    return value;
}

/**
 * 读取用户选定的模型
 * @param {string} userType - admin / teacher / student
 * @param {number} userId
 * @returns {Promise<{presetId: string|null, modelId: string}|null>} null 表示未设置，调用方应回退到全局配置
 */
async function getUserModel(userType, userId) {
    assertUserType(userType);
    const cached = memPrefs.get(memKey(userType, userId));
    if (cached) return cached;
    if (!dbAvailable) return null;

    try {
        const res = await db.query(
            `SELECT preset_id, model_id FROM ${TABLE} WHERE user_id = $1 AND user_type = $2`,
            [userId, userType]
        );
        if (!res.rows || !res.rows.length) return null;
        const value = {
            presetId: res.rows[0].preset_id || null,
            modelId: res.rows[0].model_id
        };
        memPrefs.set(memKey(userType, userId), value);
        return value;
    } catch (err) {
        dbAvailable = false;
        lastDbError = err.message;
        logger.warn('[ai-user-model-store] 读取用户模型偏好失败，降级内存:', err.message);
        return null;
    }
}

/**
 * 清除用户偏好（回到跟随全局默认）
 * @param {string} userType - admin / teacher / student
 * @param {number} userId
 */
async function clearUserModel(userType, userId) {
    assertUserType(userType);
    memPrefs.delete(memKey(userType, userId));
    if (dbAvailable) {
        try {
            await db.query(`DELETE FROM ${TABLE} WHERE user_id = $1 AND user_type = $2`, [userId, userType]);
        } catch (err) {
            dbAvailable = false;
            lastDbError = err.message;
            logger.warn('[ai-user-model-store] 删除用户模型偏好失败:', err.message);
        }
    }
}

/**
 * 删除某个用户时顺带清掉偏好行。
 * @description 与 clearUserModel 的区别：这里不动 dbAvailable —— 调用方是 user-service
 *              的删除流程，失败只说明这一行没清掉，不该把整个模块降级为纯内存（其他
 *              用户还要继续用 DB）。失败只记日志，不阻断删用户。
 * @param {string} userType - admin / teacher / student
 * @param {number} userId
 * @param {Function} [q] - 可选查询执行器，级联删除时传入事务内的 client.query，
 *                         让偏好清理和删用户同属一个事务
 */
async function purgeUserModel(userType, userId, q = db.query) {
    assertUserType(userType);
    memPrefs.delete(memKey(userType, userId));
    try {
        await q(`DELETE FROM ${TABLE} WHERE user_id = $1 AND user_type = $2`, [userId, userType]);
    } catch (err) {
        logger.warn('[ai-user-model-store] 清理被删用户的模型偏好失败:', err.message);
    }
}

module.exports = {
    setUserModel,
    getUserModel,
    clearUserModel,
    purgeUserModel,
    // 测试钩子
    _mem: memPrefs,
    _memKey: memKey,
    _state: () => ({ dbAvailable, lastDbError }),
    _reset: () => { memPrefs.clear(); dbAvailable = true; lastDbError = null; }
};
