const logger = require('./logger.js');
/**
 * Schema 助手
 * @description 统一的数据库 schema 检测工具，消除各控制器中的重复实现
 * @module utils/schemaHelper
 */

const db = require('../db/db');

// 探测结果缓存：表/列结构在部署后恒定，进程内缓存即可复用，避免每个写请求重复打
// information_schema（Neon HTTP 下每条 ≈250ms）。永不过期会有风险 —— 首次探测若早于
// 启动迁移补列，会永久遮蔽新列；因此统一带 TTL（60s），稳态 0 探测、迁移窗口自动重探。
const PROBE_TTL_MS = 60 * 1000;

function probeCacheGet(map, key) {
    const entry = map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expireAt) {
        map.delete(key);
        return undefined;
    }
    return entry.value;
}

function probeCacheSet(map, key, value) {
    map.set(key, { value, expireAt: Date.now() + PROBE_TTL_MS });
}

class SchemaHelper {
    /** @type {string|null} 缓存的日期列表达式 */
    static _dateExprCache = null;

    /** @type {number} 日期列表达式缓存过期时间戳 */
    static _dateExprExpireAt = 0;

    /** @type {Map<string, {value: *, expireAt: number}>} 表/列存在性缓存 */
    static _columnCache = new Map();

    /**
     * 获取排课表的日期列表达式
     *
     * @deprecated 一场一行改造后已无运行时调用者：新表 `course_sessions` 与视图
     * `v_session_pairs` 的日期列固定为 `class_date`，动态列探测（arr_date/class_date/date
     * 三选一）随旧表 `course_arrangement` 一并作废。保留导出仅为兼容既有单测，
     * 旧表 DROP 时连这个方法一起删。
     * @param {string} [alias='ca'] 表别名
     * @returns {Promise<string>} 日期列表达式，如 "COALESCE(ca.arr_date, ca.class_date, ca.date)"
     */
    static async getDateExpr(alias = 'ca') {
        if (SchemaHelper._dateExprCache && Date.now() < SchemaHelper._dateExprExpireAt) {
            if (!alias) {
                // 无别名：移除所有表别名前缀
                return SchemaHelper._dateExprCache.replace(/\w+\./g, '');
            }
            return SchemaHelper._dateExprCache.replace(/\w+\./g, `${alias}.`);
        }

        try {
            const result = await db.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'course_arrangement'
                AND column_name IN ('arr_date', 'class_date', 'date')
            `);

            const columns = result.rows.map(r => r.column_name);
            let expr;

            // 始终使用 ca 作为基准别名构建表达式
            if (columns.includes('arr_date')) {
                expr = 'ca.arr_date';
                if (columns.includes('class_date')) {
                    expr = 'COALESCE(ca.arr_date, ca.class_date)';
                }
            } else if (columns.includes('class_date')) {
                expr = 'ca.class_date';
            } else {
                expr = 'ca.date';
            }

            // 缓存带 ca 前缀的表达式
            SchemaHelper._dateExprCache = expr;
            SchemaHelper._dateExprExpireAt = Date.now() + PROBE_TTL_MS;

            // 根据 alias 参数返回对应的表达式
            if (!alias) {
                // 无别名：移除所有表别名前缀
                return expr.replace(/\w+\./g, '');
            }
            if (alias === 'ca') {
                return expr;
            }
            // 其他别名：替换 ca 为目标别名
            return expr.replace(/ca\./g, `${alias}.`);
        } catch (error) {
            logger.warn('检测日期列失败，使用默认 date:', error.message);
            return `${alias}.date`;
        }
    }

    /**
     * 检查表是否存在某列
     * @param {string} table 表名
     * @param {string} column 列名
     * @returns {Promise<boolean>}
     */
    static async hasColumn(table, column) {
        const cacheKey = `${table}.${column}`;
        const cached = probeCacheGet(SchemaHelper._columnCache, cacheKey);
        if (cached !== undefined) return cached;

        try {
            const result = await db.query(
                `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
                [table, column]
            );
            const exists = result.rows.length > 0;
            probeCacheSet(SchemaHelper._columnCache, cacheKey, exists);
            return exists;
        } catch (error) {
            logger.warn(`检测列 ${table}.${column} 失败:`, error.message);
            return false;
        }
    }

    /**
     * 检查表是否存在
     * @param {string} table 表名
     * @returns {Promise<boolean>}
     */
    static async hasTable(table) {
        const cacheKey = `table:${table}`;
        const cached = probeCacheGet(SchemaHelper._columnCache, cacheKey);
        if (cached !== undefined) return cached;
        try {
            const result = await db.query(
                `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
                [table]
            );
            const exists = result.rows.length > 0;
            probeCacheSet(SchemaHelper._columnCache, cacheKey, exists);
            return exists;
        } catch (error) {
            logger.warn(`检测表 ${table} 失败:`, error.message);
            return false;
        }
    }

    /**
     * 批量检测表中给定列名的存在性，返回实际存在的列名集合（Set）
     * @param {string} table 表名
     * @param {string[]} columns 待检测列名列表
     * @returns {Promise<Set<string>>}
     */
    static async getColumns(table, columns) {
        if (!Array.isArray(columns) || columns.length === 0) return new Set();
        const cacheKey = `cols:${table}:${columns.slice().sort().join(',')}`;
        const cached = probeCacheGet(SchemaHelper._columnCache, cacheKey);
        if (cached !== undefined) return cached;
        try {
            const result = await db.query(
                `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2)`,
                [table, columns]
            );
            const existing = new Set(result.rows.map(r => r.column_name));
            probeCacheSet(SchemaHelper._columnCache, cacheKey, existing);
            return existing;
        } catch (error) {
            logger.warn(`检测列 ${table}.${columns.join('/')} 失败:`, error.message);
            return new Set();
        }
    }

    /**
     * 清除所有缓存（用于测试，或迁移后强制重探）
     */
    static clearCache() {
        SchemaHelper._dateExprCache = null;
        SchemaHelper._dateExprExpireAt = 0;
        SchemaHelper._columnCache.clear();
    }
}

module.exports = SchemaHelper;
