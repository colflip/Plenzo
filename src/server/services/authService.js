/**
 * 认证服务
 * @description 处理登录、注册、密码管理等核心认证逻辑
 * @module services/authService
 */

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db/db');
const { AppError } = require('../middleware/error');

// 用户类型映射表
const TABLE_MAP = {
    admin: 'administrators',
    teacher: 'teachers',
    student: 'students'
};

/**
 * 获取表名
 * @param {string} userType - 用户类型
 * @returns {string} 数据库表名
 * @private
 */
function getTable(userType) {
    const table = TABLE_MAP[userType];
    if (!table) {
        throw new AppError('无效的用户类型', 400);
    }
    return table;
}

/**
 * 获取 JWT 密钥
 * @returns {string}
 * @private
 */
function getJwtSecret() {
    return process.env.JWT_SECRET || 'dev-insecure-secret';
}

/**
 * 验证密码格式 (Bcrypt)
 * @param {string} val 
 * @returns {boolean}
 * @private
 */
function isBcryptHash(val) {
    return typeof val === 'string' && val.startsWith('$2');
}

/**
 * 获取密码字段 (兼容旧数据)
 * @param {object} user 
 * @returns {string|null}
 * @private
 */
function getPasswordField(user) {
    if (!user) return null;
    return user.password_hash || user.passwordHash || user.password || user.pwd || null;
}

class AuthService {
    /**
     * 用户登录
     * @param {string} username - 用户名
     * @param {string} password - 密码
     * @param {string} userType - 用户类型 (admin/teacher/student)
     * @returns {Promise<object>} { user, token }
     */
    async login(username, password, userType) {
        const table = getTable(userType);

        // 1. 查询用户
        const result = await db.query(
            `SELECT * FROM ${table} WHERE username = $1`,
            [String(username).trim()]
        );

        if (result.rows.length === 0) {
            throw new AppError('用户名或密码错误', 401);
        }

        const user = result.rows[0];

        // 2. 检查账户状态
        if (user.status !== undefined && Number(user.status) === -1) {
            throw new AppError('账号已删除，无法登录', 403);
        }

        // 3. 验证密码
        const storedPwd = getPasswordField(user);
        if (!storedPwd) {
            console.error(`Login Error: User ${user.id} (${username}) missing password field`);
            throw new AppError('账户数据异常，请联系管理员', 500);
        }

        let isValid = false;
        if (isBcryptHash(storedPwd)) {
            isValid = await bcrypt.compare(password, storedPwd);
        } else {
            // 明文密码兼容 (仅开发环境)
            if (process.env.NODE_ENV === 'production') {
                throw new AppError('安全警告：生产环境检测到明文密码', 500);
            }
            isValid = String(password) === String(storedPwd);
        }

        if (!isValid) {
            throw new AppError('用户名或密码错误', 401);
        }

        // 4. 更新登录时间
        try {
            await db.query(`UPDATE ${table} SET last_login = NOW() WHERE id = $1`, [user.id]);
        } catch (err) {
            console.warn('Failed to update last_login:', err.message);
        }

        // 5. 生成 Token
        const token = jwt.sign(
            {
                id: user.id,
                userType,
                permissionLevel: user.permission_level || null
            },
            getJwtSecret(),
            { expiresIn: '24h' }
        );

        // 6. 返回结果 (去除敏感信息)
        const safeUser = { ...user };
        delete safeUser.password;
        delete safeUser.password_hash;
        delete safeUser.passwordHash;
        delete safeUser.pwd;

        return {
            token,
            user: {
                id: safeUser.id,
                username: safeUser.username,
                name: safeUser.name,
                userType,
                status: safeUser.status,
                ...safeUser // 保留其他可能需要的字段
            }
        };
    }

    /**
     * 用户注册
     * @param {object} params
     * @param {string} params.username
     * @param {string} params.password
     * @param {string} params.name
     * @param {string} params.userType
     * @param {object} [params.additionalInfo]
     * @returns {Promise<object>} 新创建的用户信息
     */
    async register({ username, password, name, userType, additionalInfo }) {
        const table = getTable(userType);

        // 1. 检查是否存在
        const existCheck = await db.query(`SELECT id FROM ${table} WHERE username = $1`, [username]);
        if (existCheck.rows.length > 0) {
            throw new AppError('用户名已存在', 400);
        }

        // 2. 加密密码
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // 3. 构建插入语句
        let columns = ['username', 'password_hash', 'name'];
        let values = [username, passwordHash, name];
        let placeholderIdx = 4;

        if (additionalInfo) {
            for (const [key, value] of Object.entries(additionalInfo)) {
                columns.push(key);
                values.push(value);
            }
        }

        // 生成 $1, $2, ... 占位符
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

        const query = `
            INSERT INTO ${table} (${columns.join(', ')})
            VALUES (${placeholders})
            RETURNING id, username, name
        `;

        const result = await db.query(query, values);
        return result.rows[0];
    }

    /**
     * 修改密码
     * @param {string} username 
     * @param {string} oldPassword 
     * @param {string} newPassword 
     * @param {string} userType 
     */
    async changePassword(username, oldPassword, newPassword, userType) {
        const table = getTable(userType);

        // 1. 验证旧密码 (复用登录逻辑的一部分，但不生成token)
        const result = await db.query(`SELECT * FROM ${table} WHERE username = $1`, [username]);
        if (result.rows.length === 0) {
            throw new AppError('用户不存在', 404);
        }

        const user = result.rows[0];
        const storedPwd = getPasswordField(user);

        if (!storedPwd) throw new AppError('账户异常', 500);

        let isValid = false;
        if (isBcryptHash(storedPwd)) {
            isValid = await bcrypt.compare(oldPassword, storedPwd);
        } else {
            isValid = String(oldPassword) === String(storedPwd);
        }

        if (!isValid) {
            throw new AppError('旧密码错误', 401);
        }

        // 2. 加密新密码
        const salt = await bcrypt.genSalt(10);
        const newHash = await bcrypt.hash(newPassword, salt);

        // 3. 更新
        // 尝试更新 password_hash，如果列不存在(兼容性)则更新 password
        try {
            await db.query(`UPDATE ${table} SET password_hash = $1 WHERE username = $2`, [newHash, username]);
        } catch (err) {
            if (err.message.includes('column "password_hash"')) {
                await db.query(`UPDATE ${table} SET password = $1 WHERE username = $2`, [newHash, username]);
            } else {
                throw err;
            }
        }

        return { message: '密码修改成功' };
    }
}

module.exports = new AuthService();
