// 费用报销状态：枚举、流转校验与审计（管理员 / 班主任 / 教师三档权限）
// 与前端 public/js/components/fee-manager.js 的 FEE_STATUS 展示名保持一致。

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
async function writeFeeStatusLog(q, { scheduleId, oldStatus, newStatus, operatorId, actorType, note }) {
    try {
        const tableCheck = await q(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'fee_status_logs'
        `);
        if (tableCheck.rows.length === 0) return;
        await q(
            `INSERT INTO fee_status_logs
             (schedule_id, old_status, new_status, operator_id, actor_type, note, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
            [scheduleId, normalizeStatus(oldStatus), newStatus, operatorId, actorType || 'admin', note || null]
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
    return { actorType: ids.length > 0 ? 'headteacher' : 'teacher', studentIds: ids };
}

module.exports = {
    FEE_STATUSES,
    FEE_STATUS_LABELS,
    TEACHER_ALLOWED,
    normalizeStatus,
    validateFeeStatusTransition,
    writeFeeStatusLog,
    parseStudentIds,
    resolveActor,
};
