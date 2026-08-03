/**
 * Schema 助手
 * @description 统一的数据库 schema 检测工具，消除各控制器中的重复实现
 * @module utils/schemaHelper
 */

const db = require('../db/db');

class SchemaHelper {
    /** @type {string|null} 缓存的日期列表达式 */
    static _dateExprCache = null;

    /** @type {Map<string, boolean>} 列存在性缓存 */
    static _columnCache = new Map();

    /**
     * 获取 course_arrangement 表的日期列表达式
     * 自动检测 arr_date / class_date / date 列，构建 COALESCE 表达式
     * @param {string} [alias='ca'] 表别名
     * @returns {Promise<string>} 日期列表达式，如 "COALESCE(ca.arr_date, ca.class_date, ca.date)"
     */
    static async getDateExpr(alias = 'ca') {
        if (SchemaHelper._dateExprCache) {
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
            console.warn('检测日期列失败，使用默认 date:', error.message);
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
        if (SchemaHelper._columnCache.has(cacheKey)) {
            return SchemaHelper._columnCache.get(cacheKey);
        }

        try {
            const result = await db.query(
                `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
                [table, column]
            );
            const exists = result.rows.length > 0;
            SchemaHelper._columnCache.set(cacheKey, exists);
            return exists;
        } catch (error) {
            console.warn(`检测列 ${table}.${column} 失败:`, error.message);
            return false;
        }
    }

    /**
     * 清除所有缓存（用于测试）
     */
    static clearCache() {
        SchemaHelper._dateExprCache = null;
        SchemaHelper._columnCache.clear();
    }
}

module.exports = SchemaHelper;
