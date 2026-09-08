/**
 * 迁移脚本共用的表存在性探测。
 * @description 刻意不做缓存 —— 迁移是「建表前探测、建表后继续」，缓存会把
 *              同一进程内的时序弄错。运行期的表/列探测请走 utils/schema-helper.js
 *              （那边带缓存，面向请求路径）。
 */
const db = require('./db');

async function tableExists(name) {
    const r = await db.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
        [name]
    );
    return (r.rows || []).length > 0;
}

module.exports = { tableExists };
