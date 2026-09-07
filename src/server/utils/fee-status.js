// 费用报销状态：枚举、流转校验与审计（管理员 / 班主任 / 教师三档权限）
// 与前端 public/js/components/fee-manager.js 的 FEE_STATUS 展示名保持一致。

const SchemaHelper = require('../utils/schema-helper');

const FEE_STATUSES = ['draft', 'teacher_submitted', 'admin_submitted', 'reimbursed', 'returned', 'reimbursement_returned'];

// 前端展示名（状态名与角色无关，身份在后端的 fee_status_logs.actor_type 区分）
const FEE_STATUS_LABELS = {
    draft: '待提交',
    teacher_submitted: '待审核',
    admin_submitted: '已审核',
    reimbursed: '已报销',
    returned: '已退回',
    reimbursement_returned: '退回报销',
};

// 普通教师仅允许的两类流转（首次提交 / 退回后重新提交）
const TEACHER_ALLOWED = {
    draft: ['teacher_submitted'],
    returned: ['teacher_submitted'],
};

// 「保存并提交」费用后的自动流转规则（按操作端区分目标状态）：
// - 教师端（/teacher/dashboard/fees 与 /sd-fees，普通教师与班主任同规则）→ teacher_submitted（待审核）
// - 管理员端（/admin 费用管理）→ admin_submitted（已审核，提交即视为已审核）
// from 白名单只含「尚未进入报销结果」的状态：已报销 / 退回报销 不因编辑金额而回退，
// 避免自动流转撤销财务结果；已是目标状态的记录亦无需流转。
const FEE_AUTO_SUBMIT = {
    teacher: { target: 'teacher_submitted', from: ['draft', 'returned'] },
    headteacher: { target: 'teacher_submitted', from: ['draft', 'returned'] },
    admin: { target: 'admin_submitted', from: ['draft', 'teacher_submitted', 'returned'] },
};

/**
 * 计算「保存并提交」后的自动目标状态。
 * @param {string} actorType - 'admin' | 'headteacher' | 'teacher'
 * @param {string} from - 当前 fee_status（null/未知按 draft 处理）
 * @returns {string|null} 目标状态；null 表示无需流转
 */
function resolveAutoFeeStatus(actorType, from) {
    const rule = FEE_AUTO_SUBMIT[actorType];
    if (!rule) return null;
    const cur = normalizeStatus(from);
    if (cur === rule.target) return null;
    return rule.from.includes(cur) ? rule.target : null;
}

function normalizeStatus(s) {
    return FEE_STATUSES.includes(s) ? s : 'draft';
}

// role: 'admin' | 'headteacher' | 'teacher'
// 返回 { ok: boolean, reason?: string }
function validateFeeStatusTransition(role, from, to) {
    from = normalizeStatus(from);
    to = normalizeStatus(to);
    if (from === to) {
        return { ok: false, reason: '状态未发生变化' };
    }
    if (!FEE_STATUSES.includes(to)) {
        return { ok: false, reason: '非法的目标状态' };
    }
    // 普通教师：仅能在「待提交 / 已退回」时提交（→ 待审核）
    if (role === 'teacher') {
        const allowed = TEACHER_ALLOWED[from] || [];
        if (!allowed.includes(to)) {
            return { ok: false, reason: '教师仅能在「待提交 / 已退回」时提交费用' };
        }
        return { ok: true };
    }
    // admin / headteacher：任意非相同流转（含撤回纠错、退回、标记报销）
    return { ok: true };
}

// 在事务内写入费用状态流转审计（q 为事务 query 或 db.query，均接受 (text, params)）
async function writeFeeStatusLog(q, { sessionId, teacherUid, oldStatus, newStatus, operatorId, actorType, note }) {
    try {
        // 审计按 (session_id, teacher_uid) 记账：费用挂在教师 pair 上，一趟一笔
        if (!(await SchemaHelper.hasTable('session_fee_status_logs'))) return;
        await q(
            `INSERT INTO session_fee_status_logs
             (session_id, teacher_uid, old_status, new_status, operator_id, actor_type, note, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)`,
            [sessionId, teacherUid, normalizeStatus(oldStatus), newStatus, operatorId, actorType || 'admin', note || null]
        );
    } catch (_) {
        // 审计失败不阻断主流程
    }
}

// 批量写入费用状态流转审计：单条多值 INSERT 替代逐条写入。
// Neon HTTP 驱动下每次查询都是一次网络往返，批量场景逐条写审计会显著拖慢响应。
// 审计失败不阻断主流程（与 writeFeeStatusLog 一致）。
async function writeBatchFeeStatusLogs(q, { items, newStatus, operatorId, actorType, note }) {
    try {
        if (!Array.isArray(items) || items.length === 0) return;
        if (!(await SchemaHelper.hasTable('session_fee_status_logs'))) return;
        const valueRows = [];
        const params = [];
        items.forEach((it, i) => {
            const b = i * 7;
            valueRows.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, CURRENT_TIMESTAMP)`);
            params.push(it.sessionId, it.teacherUid, normalizeStatus(it.oldStatus), newStatus, operatorId, actorType || 'admin', note || null);
        });
        await q(
            `INSERT INTO session_fee_status_logs
             (session_id, teacher_uid, old_status, new_status, operator_id, actor_type, note, created_at)
             VALUES ${valueRows.join(', ')}`,
            params
        );
    } catch (_) {
        // 审计失败不阻断主流程
    }
}

// 解析班主任绑定的学生 ID 列表
function parseStudentIds(studentIdsStr) {
    if (!studentIdsStr) return [];
    return String(studentIdsStr)
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !Number.isNaN(n));
}

// 解析教师操作身份：有绑定学生 → headteacher（班主任），否则 teacher（普通教师）
async function resolveActor(db, teacherId) {
    const r = await db.query('SELECT student_ids FROM teachers WHERE id = $1', [teacherId]);
    const ids = parseStudentIds(r.rows[0] && r.rows[0].student_ids);
    return { id: teacherId, actorType: ids.length > 0 ? 'headteacher' : 'teacher', studentIds: ids };
}

module.exports = {
    FEE_STATUSES,
    FEE_STATUS_LABELS,
    TEACHER_ALLOWED,
    FEE_AUTO_SUBMIT,
    normalizeStatus,
    resolveAutoFeeStatus,
    validateFeeStatusTransition,
    writeFeeStatusLog,
    writeBatchFeeStatusLogs,
    parseStudentIds,
    resolveActor,
};
