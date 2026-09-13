/**
 * 课程类型归属自检
 *
 * @description 「所有课程类型都必须有折算归属」的第三道保障。
 *              服务启动（数据库可用后）时把 schedule_types 全表的 name + description
 *              送进 type-conversion.js 的三层解析（精确别名 → 关键词规则 → 兜底桶），
 *              任何三层都无法归类的类型都会在启动日志里被点名。
 *              这样新增课程类型后，即使没人来登记别名，也会立刻可见而不是悄悄漏算。
 *
 * 失败一律不抛：自检只是可观测性手段，绝不能影响启动。
 */

const db = require('../db/db');
const logger = require('./logger');
const TypeConversion = require('../../../public/js/utils/type-conversion');

async function auditScheduleTypes() {
    const result = await db.query('SELECT id, name, description FROM schedule_types ORDER BY id');
    const rows = (result && result.rows) || [];

    const labels = [];
    const labelToId = {};
    rows.forEach(r => {
        [r.description, r.name].forEach(label => {
            const name = String(label == null ? '' : label).trim();
            if (!name) return;
            labels.push(name);
            labelToId[name] = r.id;
        });
    });

    const audit = TypeConversion.auditTypes(labels);
    if (audit.ok) {
        logger.log(`✅ 课程类型折算归属自检通过（${rows.length} 个类型 / ${audit.total} 个名称全部可归类）`);
        return audit;
    }

    const named = audit.unresolved.map(name => `「${name}」(id=${labelToId[name]})`).join('、');
    logger.warn(
        `⚠️ 课程类型折算归属自检发现 ${audit.unresolved.length} 个名称无法归类：${named}\n` +
        '   这些类型的课程会全部落入「未归类」桶（不计酬劳）。\n' +
        '   处理方式（二选一）：\n' +
        '   1) 按命名约定调整 schedule_types.name，让 slug 带上语义词根（review / visit / trial / group / advisory / consultation …）；\n' +
        '   2) 在 public/js/utils/type-conversion.js 的 TYPE_ALIASES 中登记该别名。'
    );
    return audit;
}

module.exports = { auditScheduleTypes };
