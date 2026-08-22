/**
 * feedback-service.js —— 反馈管理子域业务逻辑层（D1-3）
 *
 * 从 admin-controller 下沉的反馈（功能反馈 / Bug / 新功能需求）增删改查。
 * 控制器只负责 HTTP 封装，本层负责数据访问契约与业务规则
 * （类型/优先级枚举校验、权限约束、字段默认值与截断）。
 */

const db = require('../db/db');
const logger = require('../utils/logger');

const ALLOWED_TYPES = ['feature', 'bug', 'request', 'other'];
const ALLOWED_PRIORITIES = ['high', 'medium', 'low'];
const ALLOWED_STATUS = ['open', 'in_progress', 'done', 'rejected'];

/** 列出全部反馈（按创建时间倒序） */
async function listFeedbacks() {
    const result = await db.query(
        `SELECT id, type, priority, title, description, status,
                submitter_id, submitter_role, submitter_name,
                created_at, updated_at
           FROM feedbacks
          ORDER BY created_at DESC`
    );
    return result.rows || [];
}

/**
 * 创建反馈（任意已登录用户均可提交）
 * 返回 { status: 200, data } 或 { status: 400, error }
 */
async function createFeedback(payload, req) {
    const body = payload || {};
    const { type, priority, title, description } = body;

    if (!type || !ALLOWED_TYPES.includes(type)) {
        return { status: 400, error: '反馈类型无效' };
    }
    const pri = ALLOWED_PRIORITIES.includes(priority) ? priority : 'medium';
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
        return { status: 400, error: '请填写详细描述' };
    }
    const desc = description.trim();
    const ttl = (title && String(title).trim().length > 0)
        ? String(title).trim().slice(0, 120)
        : desc.slice(0, 50);

    const user = (req && req.user) || {};
    const submitterId = user.id || null;
    const submitterRole = user.userType || null;
    const submitterName = user.name || user.username || null;

    const result = await db.query(
        `INSERT INTO feedbacks (type, priority, title, description, status,
                                submitter_id, submitter_role, submitter_name)
         VALUES ($1,$2,$3,$4,'open',$5,$6,$7)
         RETURNING *`,
        [type, pri, ttl, desc, submitterId, submitterRole, submitterName]
    );
    return { status: 200, data: result.rows[0] };
}

/**
 * 更新反馈（状态/优先级/标题/描述）
 * 管理员可改任意；其它角色仅能改自己提交的。
 * 返回 { status: 200, data } 或 { status: 403|404, error }
 */
async function updateFeedback(id, payload, req) {
    const body = payload || {};
    const { type, priority, title, description, status } = body;
    const user = (req && req.user) || {};

    const cur = await db.query('SELECT * FROM feedbacks WHERE id = $1', [id]);
    if (!cur.rows.length) {
        return { status: 404, error: '反馈不存在' };
    }
    const row = cur.rows[0];
    const isAdmin = user.userType === 'admin';
    const isOwner = row.submitter_id && user.id && row.submitter_id === user.id;
    if (!isAdmin && !isOwner) {
        return { status: 403, error: '无权修改该反馈' };
    }

    const next = {
        type: ALLOWED_TYPES.includes(type) ? type : row.type,
        priority: ALLOWED_PRIORITIES.includes(priority) ? priority : row.priority,
        title: (title && String(title).trim().length) ? String(title).trim().slice(0, 120) : row.title,
        description: (description && String(description).trim().length) ? String(description).trim() : row.description,
        status: ALLOWED_STATUS.includes(status) ? status : row.status
    };

    const result = await db.query(
        `UPDATE feedbacks
            SET type=$1, priority=$2, title=$3, description=$4, status=$5,
                updated_at=CURRENT_TIMESTAMP
          WHERE id=$6
          RETURNING *`,
        [next.type, next.priority, next.title, next.description, next.status, id]
    );
    return { status: 200, data: result.rows[0] };
}

/**
 * 删除反馈：管理员或提交人本人
 * 返回 { status: 200, data } 或 { status: 403|404, error }
 */
async function deleteFeedback(id, req) {
    const user = (req && req.user) || {};
    const cur = await db.query('SELECT submitter_id FROM feedbacks WHERE id = $1', [id]);
    if (!cur.rows.length) {
        return { status: 404, error: '反馈不存在' };
    }
    const ownerId = cur.rows[0].submitter_id;
    const isAdmin = user.userType === 'admin';
    const isOwner = ownerId && user.id && ownerId === user.id;
    if (!isAdmin && !isOwner) {
        return { status: 403, error: '无权删除该反馈' };
    }
    await db.query('DELETE FROM feedbacks WHERE id = $1', [id]);
    return { status: 200, data: { id } };
}

module.exports = {
    ALLOWED_TYPES,
    ALLOWED_PRIORITIES,
    ALLOWED_STATUS,
    listFeedbacks,
    createFeedback,
    updateFeedback,
    deleteFeedback
};
