/**
 * schedule-type-service.js —— 课程类型子域业务逻辑层（D1-2）
 *
 * 从 admin-controller 下沉的课程类型增删改查。控制器只负责 HTTP 封装，
 * 本层负责数据访问契约与业务规则（名称查重、引用约束检查等）。
 *
 * service 只返回领域数据；业务错误抛 AppError，由 controller 统一封装 HTTP 响应。
 */

const db = require('../db/db');
const { recordAudit } = require('../middleware/audit');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/error');

/** 列出全部课程类型（按 id 升序） */
async function listScheduleTypes() {
    const result = await db.query('SELECT * FROM schedule_types ORDER BY id ASC');
    return result.rows || [];
}

/** 创建课程类型；返回创建后的记录 */
async function createScheduleType({ name, description }, req) {
    if (!name) {
        throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '课程类型名称不能为空' });
    }

    const existing = await db.query('SELECT id FROM schedule_types WHERE name = $1', [name]);
    if ((existing.rows || []).length > 0) {
        throw new AppError({ code: 'CONFLICT', statusCode: 409, message: '课程类型名称已存在' });
    }

    const result = await db.query(
        'INSERT INTO schedule_types (name, description) VALUES ($1, $2) RETURNING *',
        [name, description]
    );

    await recordAudit(req, { op: 'create_schedule_type', details: { name, description } });
    return result.rows[0];
}

/** 更新课程类型（排除自身查重）；返回更新后的记录 */
async function updateScheduleType(id, { name, description }, req) {
    if (!name) {
        throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '课程类型名称不能为空' });
    }

    const existing = await db.query('SELECT id FROM schedule_types WHERE name = $1 AND id <> $2', [name, id]);
    if ((existing.rows || []).length > 0) {
        throw new AppError({ code: 'CONFLICT', statusCode: 409, message: '课程类型名称已存在' });
    }

    const result = await db.query(
        'UPDATE schedule_types SET name = $1, description = $2 WHERE id = $3 RETURNING *',
        [name, description, id]
    );

    if (result.rows.length === 0) {
        throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '课程类型不存在' });
    }

    await recordAudit(req, { op: 'update_schedule_type', entityId: id, details: { name, description } });
    return result.rows[0];
}

/**
 * 删除课程类型（有排课引用时禁止删除）。
 * 引用计数改按教师 pair 算：JSONB 元素拿不到外键，所以这里既是业务校验也是唯一的引用守卫。
 * `@?` 的 jsonpath 需要字面量常量才走 GIN 索引，所以先把 id 收敛成整数再拼进 path。
 */
async function deleteScheduleType(id, req) {
    const typeId = Number(id);
    if (!Number.isInteger(typeId) || typeId <= 0) {
        throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '课程类型不存在' });
    }
    /**
     * 「查引用」与「删除」必须是同一条语句。
     *
     * 原来分两条发：两条之间新建的排课可以把这个类型引用上，于是类型被删掉、
     * 而那场的 type_id 成了孤儿 —— 所有读路径都以 INNER JOIN 接类型名
     * （schedule-service.js 的网格/统计都是 `JOIN schedule_types st ON vp.type_id = st.id`），
     * 结果这场课从周视图与统计里**整场消失**，却仍在占用时段与冲突检测（审查报告 P2-7）。
     * JSONB 元素挂不上外键，所以这里用「删除以引用数为条件」把时间窗压成零。
     */
    const result = await db.query(
        `WITH ref AS (
             SELECT COUNT(*)::int AS count
               FROM course_sessions cs, jsonb_array_elements(cs.teachers) e
              WHERE (e->>'type_id')::int = $1
         ), del AS (
             DELETE FROM schedule_types
              WHERE id = $1
                AND NOT EXISTS (SELECT 1 FROM ref WHERE count > 0)
              RETURNING id
         )
         SELECT COALESCE((SELECT count FROM ref), 0)::int AS ref_count,
                (SELECT id FROM del) AS deleted_id`,
        [typeId]
    );
    const row = result.rows[0] || {};
    const refCount = Number(row.ref_count || 0);

    if (row.deleted_id === null || row.deleted_id === undefined) {
        if (refCount > 0) {
            throw new AppError({
                code: 'CONFLICT', statusCode: 409,
                message: `该类型已被引用 ${refCount} 次，无法删除`
            });
        }
        throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '课程类型不存在' });
    }

    await recordAudit(req, { op: 'delete_schedule_type', entityId: id });
    return null;
}

module.exports = {
    listScheduleTypes,
    createScheduleType,
    updateScheduleType,
    deleteScheduleType
};
