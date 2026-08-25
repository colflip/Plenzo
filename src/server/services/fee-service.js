/**
 * fee-service.js —— 费用子域共享逻辑层（D1-5）
 *
 * 集中 admin / teacher 两端共用的费用金额解析、费用更新（含审计）与
 * 费用报销状态机流转逻辑。控制器负责：请求校验、权限/范围约束、HTTP 封装；
 * 本层负责数据访问契约与业务规则（金额归一、状态机校验、审计写入、范围授权）。
 *
 * 设计约定：
 * - 纯函数（parseFeeAmount / checkScheduleScope）零副作用，可单测；
 * - 事务方法接受 `tx`（事务内查询函数），由控制器负责事务边界；
 * - SQL 逐字沿用原控制器实现，保证行为一致、零回归。
 */

const SchemaHelper = require('../utils/schema-helper');
const { validateFeeStatusTransition, writeFeeStatusLog, writeBatchFeeStatusLogs, resolveAutoFeeStatus } = require('../utils/feeStatus');

/**
 * 费用金额归一：空值/未传 → null（NULL，表示未填）；数字字符串 → number；
 * 非法 → null。保留 null 与 0 的语义差异（未填 vs 填 0）。
 */
function parseFeeAmount(val) {
    if (val === null || val === undefined || val === '') return null;
    const n = parseFloat(val);
    return Number.isNaN(n) ? null : n;
}

/**
 * 本次提交是否「填写了费用」：交通 / 其他任一非 null 即视为填写（0 = 主动填 0，算填写）。
 * 决定「保存并提交」是否触发状态流转：批量弹窗会带上范围内全部课时（未填写的为 null），
 * 只有本次填写的记录才应改状态，留空 / 清除的记录保持原状态不动。
 */
function hasFilledFee(tFee, oFee) {
    return tFee !== null || oFee !== null;
}

/**
 * 排课范围授权（领域规则，集中此处以便 admin/teacher 复用）：
 * - admin：无限制；
 * - headteacher：仅能操作绑定学生（actor.studentIds）；
 * - teacher：仅能操作本人课时（actor.id）。
 * 返回 null 表示通过；返回字符串表示越权原因（供控制器 403 / service 跳过）。
 */
function checkScheduleScope(actor, row, id) {
    if (!actor || actor.actorType === 'admin') return null;
    if (actor.actorType === 'headteacher') {
        if (!actor.studentIds || !actor.studentIds.includes(Number(row.student_id))) {
            return `排课 ID ${id} 不在您管理的班级范围内`;
        }
        return null;
    }
    // teacher
    if (Number(row.teacher_id) !== Number(actor.id)) {
        return `排课 ID ${id} 不属于您`;
    }
    return null;
}

/**
 * 在事务内更新单条排课费用，并按需在 fee_audit_logs 写入审计。
 * 返回 { updated: true }；费用审计表不存在时静默跳过（不影响主流程）。
 */
async function updateScheduleFeesInTx(tx, id, { tFee, oFee, oldTFee, oldOFee, operatorId, operatorRole }) {
    await tx(
        `UPDATE course_arrangement
         SET transport_fee = $1, other_fee = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [tFee, oFee, id]
    );

    if (await SchemaHelper.hasTable('fee_audit_logs')) {
        await tx(
            `INSERT INTO fee_audit_logs
             (schedule_id, operator_id, operator_role, old_transport_fee, new_transport_fee, old_other_fee, new_other_fee)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, operatorId, operatorRole, oldTFee, tFee, oldOFee, oFee]
        );
    }
    return { updated: true };
}

/**
 * 单条费用报销状态流转（含状态机校验 + 审计）。
 * 返回 { ok: true, fee_status } 或 { ok: false, error }
 */
async function transitionFeeStatus(tx, { id, from, target, note, operatorId, actorType }) {
    const check = validateFeeStatusTransition(actorType, from, target);
    if (!check.ok) {
        return { ok: false, error: check.reason };
    }
    await tx(
        `UPDATE course_arrangement SET fee_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [target, id]
    );
    await writeFeeStatusLog(tx, {
        scheduleId: id, oldStatus: from, newStatus: target,
        operatorId, actorType, note
    });
    return { ok: true, fee_status: target };
}

/**
 * 「保存并提交」费用后的自动状态流转（教师端 → 待审核；管理员端 → 已审核）。
 * 规则见 utils/feeStatus.js#FEE_AUTO_SUBMIT：已报销 / 退回报销 不回退，已是目标状态不重复写审计。
 * 幂等：无需流转时不产生任何写入。
 * @returns {{ changed: boolean, fee_status: string }} fee_status 为流转后的最终状态
 */
async function autoSubmitFeeStatus(tx, { id, from, actorType, operatorId, note }) {
    const target = resolveAutoFeeStatus(actorType, from);
    if (!target) return { changed: false, fee_status: from };
    const r = await transitionFeeStatus(tx, {
        id, from, target, note: note || '保存并提交', operatorId, actorType
    });
    return r.ok ? { changed: true, fee_status: r.fee_status } : { changed: false, fee_status: from };
}

/**
 * 批量费用报销状态流转（已授权 targetIds 内逐条校验 + 审计）。
 * actor：可选，传入后对非 admin 身份逐条做范围授权（越权记录跳过，与历史行为一致）。
 * skipStatus：跳过已是该状态的记录（避免重复审计）。
 * 返回实际更新条数。
 *
 * 性能约定：Neon HTTP 驱动下每条 SQL 都是一次网络往返（本机实测 ~300ms/次），
 * 旧实现逐条 SELECT+UPDATE+INSERT 在整周记录上可达数十秒，前端表现为点击后长时间无响应。
 * 此处压缩为固定 3 次往返：批量读 → 批量写 → 批量审计；逐条校验逻辑保持不变。
 */
async function batchTransitionFeeStatus(tx, { targetIds, target, note, operatorId, actorType, skipStatus, actor }) {
    if (!Array.isArray(targetIds) || targetIds.length === 0) return 0;

    // 去重：与旧实现语义一致（同 id 二次出现时 from===to 必然被状态机拒绝，不应产生重复审计）
    const ids = [...new Set(targetIds.map(Number).filter(n => !Number.isNaN(n)))];
    if (ids.length === 0) return 0;

    const cur = await tx(
        'SELECT id, fee_status, student_id, teacher_id FROM course_arrangement WHERE id = ANY($1)',
        [ids]
    );
    const byId = new Map();
    (cur.rows || []).forEach(r => byId.set(Number(r.id), r));

    const updatableIds = [];
    const auditItems = [];
    for (const sid of ids) {
        const row = byId.get(Number(sid));
        if (!row) continue;
        if (actor) {
            const scopeMsg = checkScheduleScope(actor, row, sid);
            if (scopeMsg) continue; // 越权记录跳过
        }
        const from = row.fee_status;
        if (skipStatus && from === skipStatus) continue;
        const check = validateFeeStatusTransition(actorType, from, target);
        if (!check.ok) continue;
        updatableIds.push(Number(row.id));
        auditItems.push({ scheduleId: Number(row.id), oldStatus: from });
    }
    if (updatableIds.length === 0) return 0;

    await tx(
        `UPDATE course_arrangement SET fee_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($2)`,
        [target, updatableIds]
    );
    await writeBatchFeeStatusLogs(tx, {
        items: auditItems, newStatus: target, operatorId, actorType, note
    });
    return updatableIds.length;
}

/**
 * 批量更新排课费用（事务内逐条：解析 + 负数拒绝 + 范围授权 + 无变化跳过 + 写入 + 审计）。
 * actor：resolveActor 结果，用于范围授权（班主任限关联学生、普通教师限本人课时）。
 * autoSubmitActorType：传入后对每条「本次填写了费用」的已授权记录执行「保存并提交」自动流转
 *   （教师端 → 待审核）。留空 / 清除（金额置 null）的记录不改状态，避免批量弹窗里
 *   未填写的同学生课时被连带提交。金额填写但未变化的记录仍会流转（点击提交即表示提交本条）。
 * 任一记录负数或越权均抛错（由控制器事务回滚）；无变化记录跳过不写费用审计。
 * 返回 { changed, submitted }。
 */
async function batchUpdateScheduleFeesInTx(tx, updates, { actor, operatorId, autoSubmitActorType }) {
    const hasAuditTable = await SchemaHelper.hasTable('fee_audit_logs');
    let changed = 0;
    let submitted = 0;
    for (const item of updates) {
        const id = item.id;
        const tFee = parseFeeAmount(item.transport_fee);
        const oFee = parseFeeAmount(item.other_fee);

        if ((tFee !== null && tFee < 0) || (oFee !== null && oFee < 0)) {
            throw new Error(`排课 ID ${id} 包含负数费用`);
        }

        const originalResult = await tx(
            'SELECT transport_fee, other_fee, student_id, teacher_id, fee_status FROM course_arrangement WHERE id = $1',
            [id]
        );
        if (originalResult.rows.length === 0) continue;

        const row = originalResult.rows[0];
        const scopeMsg = checkScheduleScope(actor, row, id);
        if (scopeMsg) throw new Error(scopeMsg);

        const { transport_fee: old_t_fee, other_fee: old_o_fee } = row;

        // 「保存并提交」自动流转：仅对本次填写了费用的记录（留空 / 清除的不动状态）
        if (autoSubmitActorType && hasFilledFee(tFee, oFee)) {
            const auto = await autoSubmitFeeStatus(tx, {
                id, from: row.fee_status, actorType: autoSubmitActorType, operatorId
            });
            if (auto.changed) submitted++;
        }

        // null 安全对比：NULL 与 0 视为不同值；原值可能为字符串/数字/NULL
        const norm = (v) => (v === null || v === undefined ? null : parseFloat(v));
        if (norm(old_t_fee) === tFee && norm(old_o_fee) === oFee) continue; // 无变化

        await tx(
            `UPDATE course_arrangement
             SET transport_fee = $1, other_fee = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [tFee, oFee, id]
        );

        if (hasAuditTable) {
            await tx(
                `INSERT INTO fee_audit_logs
                 (schedule_id, operator_id, operator_role, old_transport_fee, new_transport_fee, old_other_fee, new_other_fee)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [id, operatorId, 'teacher_batch', old_t_fee, tFee, old_o_fee, oFee]
            );
        }
        changed++;
    }
    return { changed, submitted };
}

module.exports = {
    parseFeeAmount,
    hasFilledFee,
    checkScheduleScope,
    updateScheduleFeesInTx,
    transitionFeeStatus,
    autoSubmitFeeStatus,
    batchTransitionFeeStatus,
    batchUpdateScheduleFeesInTx
};
