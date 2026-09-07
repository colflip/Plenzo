/**
 * schedule-type-service.js —— 课程类型子域业务逻辑层（D1-2）
 *
 * 从 admin-controller 下沉的课程类型增删改查。控制器只负责 HTTP 封装，
 * 本层负责数据访问契约与业务规则（名称查重、引用约束检查等）。
 */

const db = require('../db/db');
const { recordAudit } = require('../middleware/audit');
const logger = require('../utils/logger');

/** 列出全部课程类型（按 id 升序） */
async function listScheduleTypes() {
    const result = await db.query('SELECT * FROM schedule_types ORDER BY id ASC');
    return result.rows || [];
}

/**
 * 创建课程类型。
 * 返回 { status: 201, data } 或 { status: 400|409, error }
 */
async function createScheduleType({ name, description }, req) {
    if (!name) {
        return { status: 400, error: '课程类型名称不能为空' };
    }

    const existing = await db.query('SELECT id FROM schedule_types WHERE name = $1', [name]);
    if ((existing.rows || []).length > 0) {
        return { status: 409, error: '课程类型名称已存在' };
    }

    const result = await db.query(
        'INSERT INTO schedule_types (name, description) VALUES ($1, $2) RETURNING *',
        [name, description]
    );

    await recordAudit(req, { op: 'create_schedule_type', details: { name, description } });
    return { status: 201, data: result.rows[0] };
}

/**
 * 更新课程类型（排除自身查重）。
 * 返回 { status: 200, data } 或 { status: 400|404|409, error }
 */
async function updateScheduleType(id, { name, description }, req) {
    if (!name) {
        return { status: 400, error: '课程类型名称不能为空' };
    }

    const existing = await db.query('SELECT id FROM schedule_types WHERE name = $1 AND id <> $2', [name, id]);
    if ((existing.rows || []).length > 0) {
        return { status: 409, error: '课程类型名称已存在' };
    }

    const result = await db.query(
        'UPDATE schedule_types SET name = $1, description = $2 WHERE id = $3 RETURNING *',
        [name, description, id]
    );

    if (result.rows.length === 0) {
        return { status: 404, error: '课程类型不存在' };
    }

    await recordAudit(req, { op: 'update_schedule_type', entityId: id, details: { name, description } });
    return { status: 200, data: result.rows[0] };
}

/**
 * 删除课程类型（有排课引用时禁止删除）。
 * 引用计数改按教师 pair 算：JSONB 元素拿不到外键，所以这里既是业务校验也是唯一的引用守卫。
 * `@?` 的 jsonpath 需要字面量常量才走 GIN 索引，所以先把 id 收敛成整数再拼进 path。
 * 返回 { status: 200 } 或 { status: 404|409, error }
 */
async function deleteScheduleType(id, req) {
    const typeId = Number(id);
    if (!Number.isInteger(typeId) || typeId <= 0) {
        return { status: 404, error: '课程类型不存在' };
    }
    const refCheck = await db.query(
        `SELECT COUNT(*)::int AS count
           FROM course_sessions cs, jsonb_array_elements(cs.teachers) e
          WHERE (e->>'type_id')::int = $1`,
        [typeId]
    );
    const count = Number(refCheck.rows[0].count);
    if (count > 0) {
        return { status: 409, error: `该类型已被引用 ${count} 次，无法删除` };
    }

    const result = await db.query('DELETE FROM schedule_types WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
        return { status: 404, error: '课程类型不存在' };
    }

    await recordAudit(req, { op: 'delete_schedule_type', entityId: id });
    return { status: 200 };
}

module.exports = {
    listScheduleTypes,
    createScheduleType,
    updateScheduleType,
    deleteScheduleType
};
