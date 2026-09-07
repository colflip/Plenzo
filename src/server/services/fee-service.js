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
const { validateFeeStatusTransition, writeFeeStatusLog, writeBatchFeeStatusLogs, resolveAutoFeeStatus } = require('../utils/fee-status');
const logger = require('../utils/logger');

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
 * - headteacher：仅能操作绑定学生（actor.studentIds）—— 场次里任一学生在名下即通过；
 * - teacher：仅能操作本人的教师 pair。
 * 入参 `pair` 是 { session, teacher }（场次行 + 该教师 pair）。
 * 返回 null 表示通过；返回字符串表示越权原因（供控制器 403 / service 跳过）。
 */
function checkScheduleScope(actor, pair, id) {
    if (!actor || actor.actorType === 'admin') return null;
    const session = pair && pair.session ? pair.session : pair;
    const teacher = pair && pair.teacher ? pair.teacher : null;

    if (actor.actorType === 'headteacher') {
        const bound = actor.studentIds || [];
        const inScope = (session.students || []).some(s => bound.includes(Number(s.student_id)));
        if (!inScope) return `排课 ID ${id} 不在您管理的班级范围内`;
        return null;
    }
    // teacher：只能碰自己那个 pair
    if (!teacher || Number(teacher.teacher_id) !== Number(actor.id)) {
        return `排课 ID ${id} 不属于您`;
    }
    return null;
}

/** 从场次里取出某个教师 pair；uid 缺省时若本场只有一位教师就用那一位 */
function locateTeacherPair(session, teacherUid) {
    const teachers = (session && session.teachers) || [];
    if (teacherUid) return teachers.find(t => String(t.uid) === String(teacherUid)) || null;
    return teachers.length === 1 ? teachers[0] : null;
}

/**
 * 原地重建教师 pair 的若干键（费用 / 费用状态共用）。
 * 与状态路径同形：一条语句、按 uid 匹配、EXISTS 守卫、ORDER BY ord 保序，
 * 结构上改不到别的 pair、也改不到别的字段。
 */
function buildPairPatchSql(keys) {
    // jsonb_set 逐键嵌套：jsonb_set(jsonb_set(e,'{a}',$3),'{b}',$4)
    let expr = 'e';
    keys.forEach((k, i) => {
        expr = `jsonb_set(${expr}, '{${k}}', $${i + 3}::jsonb)`;
    });
    return `
        UPDATE course_sessions cs
           SET teachers = (
                 SELECT jsonb_agg(CASE WHEN e->>'uid' = $2 THEN ${expr} ELSE e END ORDER BY ord)
                   FROM jsonb_array_elements(cs.teachers) WITH ORDINALITY AS a(e, ord)),
               updated_at = CURRENT_TIMESTAMP
         WHERE cs.id = $1
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(cs.teachers) x WHERE x->>'uid' = $2)`;
}

const asJsonb = (v) => JSON.stringify(v === undefined ? null : v);

/**
 * 在事务内更新单个教师 pair 的费用（必要时同步折叠费用报销状态）。
 * 费用是「一趟一笔」：挂在教师 pair 上，与本场学生人数无关 —— 旧实现按行累加，
 * 一位老师带 2 个学生的上门会被算两笔交通费，那个重复计费在新结构下从根上消失。
 *
 * 性能契约：**单条 UPDATE 一次完成**。旧实现是「更新金额」+「autoSubmit 再单独
 * 更新 fee_status」两条语句（各一次远程往返 ≈250ms）；这里把 fee_status 并入同一
 * 条 buildPairPatchSql 的键集合，两条变一条。审计两行（金额 + 状态）随后并行落地，
 * 失败只告警不阻断（与 recordAudit / writeStatusLogs 同口径）。
 *
 * @param {*} q 事务内查询函数（controller 传 client.query；无事务时传 db.query）
 * @param {{sessionId:number, teacherUid:string}} target
 * @param {object} opt tFee/oFee 金额；targetStatus 非 null 时一并写入 fee_status
 *   （由调用方按 resolveAutoFeeStatus 决定；null = 保持原状态）
 */
async function updateScheduleFeesInTx(tx, target, {
    tFee, oFee, oldTFee, oldOFee, targetStatus, oldStatus, operatorId, operatorRole
}) {
    const sessionId = typeof target === 'object' ? target.sessionId : target;
    const teacherUid = typeof target === 'object' ? target.teacherUid : null;

    const keys = ['transport_fee', 'other_fee'];
    if (targetStatus != null) keys.push('fee_status');
    const params = [sessionId, String(teacherUid), asJsonb(tFee), asJsonb(oFee)];
    if (targetStatus != null) params.push(asJsonb(targetStatus));
    await tx(buildPairPatchSql(keys), params);

    // 金额审计与状态审计互不依赖，并发落地省一次往返；任一条失败只告警。
    await Promise.all([
        (async () => {
            try {
                await tx(
                    `INSERT INTO session_fee_audit_logs
                     (session_id, teacher_uid, operator_id, operator_role,
                      old_transport_fee, new_transport_fee, old_other_fee, new_other_fee)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [sessionId, String(teacherUid), operatorId, operatorRole, oldTFee, tFee, oldOFee, oFee]
                );
            } catch (e) {
                logger.warn('[fee-service] 费用审计写入跳过:', e.message);
            }
        })(),
        (async () => {
            if (targetStatus == null) return;
            try {
                await writeFeeStatusLog(tx, {
                    sessionId, teacherUid, oldStatus, newStatus: targetStatus,
                    operatorId, actorType: operatorRole || 'admin', note: '保存并提交'
                });
            } catch (e) {
                logger.warn('[fee-service] 费用状态审计写入跳过:', e.message);
            }
        })()
    ]);
    return { updated: true };
}

/**
 * 单个教师 pair 的费用报销状态流转（含状态机校验 + 审计）。
 * 返回 { ok: true, fee_status } 或 { ok: false, error }
 */
async function transitionFeeStatus(tx, { sessionId, teacherUid, id, from, target, note, operatorId, actorType }) {
    const sid = sessionId != null ? sessionId : id;
    const check = validateFeeStatusTransition(actorType, from, target);
    if (!check.ok) {
        return { ok: false, error: check.reason };
    }
    await tx(buildPairPatchSql(['fee_status']), [sid, String(teacherUid), asJsonb(target)]);
    await writeFeeStatusLog(tx, {
        sessionId: sid, teacherUid, oldStatus: from, newStatus: target,
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
async function autoSubmitFeeStatus(tx, { sessionId, teacherUid, id, from, actorType, operatorId, note }) {
    const target = resolveAutoFeeStatus(actorType, from);
    if (!target) return { changed: false, fee_status: from };
    const r = await transitionFeeStatus(tx, {
        sessionId: sessionId != null ? sessionId : id, teacherUid,
        from, target, note: note || '保存并提交', operatorId, actorType
    });
    return r.ok ? { changed: true, fee_status: r.fee_status } : { changed: false, fee_status: from };
}

/**
 * 批量费用报销状态流转。
 *
 * 性能约定（不可回退成逐条循环）：Neon HTTP 驱动下每条 SQL 都是一次网络往返（实测 ~300ms），
 * 所以固定 3 步：① 一次批量读场次 → ② Node 内逐 pair 跑状态机与范围授权 → ③ 一次批量写 + 一次批量审计。
 * targets 支持两种写法：`{ session_id, teacher_uid }` 对象，或旧的裸 id（此时取本场唯一教师 pair）。
 * 返回实际生效的 pair 数。
 */
async function batchTransitionFeeStatus(tx, { targetIds, targets, target, note, operatorId, actorType, skipStatus, actor }) {
    const list = Array.isArray(targets) && targets.length ? targets : (targetIds || []);
    if (!Array.isArray(list) || list.length === 0) return 0;

    // 去重：同一 (场次, uid) 二次出现时 from===to 必然被状态机拒绝，不应产生重复审计
    const wanted = new Map();
    for (const item of list) {
        const sid = Number(typeof item === 'object' ? (item.session_id ?? item.id) : item);
        if (!Number.isFinite(sid)) continue;
        const uid = typeof item === 'object' ? (item.teacher_uid || null) : null;
        wanted.set(`${sid}|${uid || ''}`, { sid, uid });
    }
    if (wanted.size === 0) return 0;

    const sessionIds = [...new Set([...wanted.values()].map(v => v.sid))];
    const cur = await tx(
        'SELECT id, teachers, students, version FROM course_sessions WHERE id = ANY($1::int[])',
        [sessionIds]
    );
    const byId = new Map((cur.rows || []).map(r => [Number(r.id), r]));

    const writes = new Map();   // sessionId → teachers 数组（改完的）
    const auditItems = [];
    for (const { sid, uid } of wanted.values()) {
        const session = byId.get(sid);
        if (!session) continue;
        const teachers = writes.get(sid) || session.teachers || [];
        // uid 为空 → 覆盖本场全部教师 pair（与旧的「按 id 改整行」语义最接近）
        const picks = uid ? teachers.filter(t => String(t.uid) === String(uid)) : teachers;
        let next = teachers;
        for (const pair of picks) {
            if (actor) {
                const scopeMsg = checkScheduleScope(actor, { session, teacher: pair }, sid);
                if (scopeMsg) continue;   // 越权记录跳过，与历史行为一致
            }
            const from = pair.fee_status;
            if (skipStatus && from === skipStatus) continue;
            const check = validateFeeStatusTransition(actorType, from, target);
            if (!check.ok) continue;
            next = next.map(t => (String(t.uid) === String(pair.uid) ? { ...t, fee_status: target } : t));
            auditItems.push({ sessionId: sid, teacherUid: pair.uid, oldStatus: from });
        }
        if (next !== teachers) writes.set(sid, next);
    }
    if (auditItems.length === 0) return 0;

    // 批量写回：一条 UPDATE ... FROM (VALUES ...) 覆盖所有受影响场次
    const rows = [...writes.entries()];
    const valueRows = rows.map((_, i) => `($${i * 2 + 2}::int, $${i * 2 + 3}::jsonb)`);
    const params = [operatorId, ...rows.flatMap(([sid, teachers]) => [sid, JSON.stringify(teachers)])];
    await tx(
        `UPDATE course_sessions cs
            SET teachers = v.teachers, version = cs.version + 1,
                updated_at = CURRENT_TIMESTAMP, updated_by = $1
           FROM (VALUES ${valueRows.join(', ')}) AS v(id, teachers)
          WHERE cs.id = v.id`,
        params
    );
    await writeBatchFeeStatusLogs(tx, {
        items: auditItems, newStatus: target, operatorId, actorType, note
    });
    return auditItems.length;
}

/**
 * 批量更新费用（事务内：解析 + 负数拒绝 + 范围授权 + 无变化跳过 + 写入 + 审计）。
 * 同样压成固定几步往返：一次批量读 → Node 内计算 → 一次批量写 → 一次批量审计。
 * autoSubmitActorType：对每条「本次填写了费用」的已授权 pair 执行「保存并提交」自动流转；
 *   留空 / 清除（金额置 null）的不改状态，避免批量弹窗里未填写的同学生课时被连带提交。
 * 返回 { changed, submitted }。
 */
async function batchUpdateScheduleFeesInTx(tx, updates, { actor, operatorId, autoSubmitActorType }) {
    if (!Array.isArray(updates) || updates.length === 0) return { changed: 0, submitted: 0 };

    const norm = updates.map(u => ({
        sessionId: Number(u.session_id ?? u.id),
        teacherUid: u.teacher_uid || null,
        tFee: parseFeeAmount(u.transport_fee),
        oFee: parseFeeAmount(u.other_fee)
    })).filter(u => Number.isFinite(u.sessionId));

    for (const u of norm) {
        if ((u.tFee !== null && u.tFee < 0) || (u.oFee !== null && u.oFee < 0)) {
            throw new Error(`排课 ID ${u.sessionId} 包含负数费用`);
        }
    }

    const cur = await tx(
        'SELECT id, teachers, students, version FROM course_sessions WHERE id = ANY($1::int[])',
        [[...new Set(norm.map(u => u.sessionId))]]
    );
    const byId = new Map((cur.rows || []).map(r => [Number(r.id), r]));

    const hasAuditTable = await SchemaHelper.hasTable('session_fee_audit_logs');
    const writes = new Map();
    const feeAudits = [];
    const statusAudits = [];
    let changed = 0;
    let submitted = 0;

    for (const u of norm) {
        const session = byId.get(u.sessionId);
        if (!session) continue;
        const teachers = writes.get(u.sessionId) || session.teachers || [];
        const pair = locateTeacherPair({ teachers }, u.teacherUid);
        if (!pair) continue;

        const scopeMsg = checkScheduleScope(actor, { session, teacher: pair }, u.sessionId);
        if (scopeMsg) throw new Error(scopeMsg);

        let nextPair = { ...pair };

        // 「保存并提交」自动流转：仅对本次填写了费用的 pair
        if (autoSubmitActorType && hasFilledFee(u.tFee, u.oFee)) {
            const target = resolveAutoFeeStatus(autoSubmitActorType, pair.fee_status);
            if (target && validateFeeStatusTransition(autoSubmitActorType, pair.fee_status, target).ok) {
                statusAudits.push({ sessionId: u.sessionId, teacherUid: pair.uid, oldStatus: pair.fee_status, newStatus: target });
                nextPair.fee_status = target;
                submitted++;
            }
        }

        // null 安全对比：NULL 与 0 视为不同值（未填 vs 填 0）
        const toNum = (v) => (v === null || v === undefined ? null : parseFloat(v));
        const feeChanged = toNum(pair.transport_fee) !== u.tFee || toNum(pair.other_fee) !== u.oFee;
        if (feeChanged) {
            if (hasAuditTable) {
                feeAudits.push({
                    sessionId: u.sessionId, teacherUid: pair.uid,
                    oldT: pair.transport_fee, newT: u.tFee,
                    oldO: pair.other_fee, newO: u.oFee
                });
            }
            nextPair.transport_fee = u.tFee;
            nextPair.other_fee = u.oFee;
            changed++;
        }

        if (feeChanged || nextPair.fee_status !== pair.fee_status) {
            writes.set(u.sessionId, teachers.map(t => (String(t.uid) === String(pair.uid) ? nextPair : t)));
        }
    }

    // 全部跳过：输入有更新但无一命中（session 不存在 / teacher pair 未匹配），抛错让调用方感知
    if (norm.length > 0 && writes.size === 0 && feeAudits.length === 0 && statusAudits.length === 0) {
        throw new Error('未能定位到任何有效的排课记录，请确认 teacher_uid 已正确传递');
    }

    if (writes.size > 0) {
        const rows = [...writes.entries()];
        const valueRows = rows.map((_, i) => `($${i * 2 + 2}::int, $${i * 2 + 3}::jsonb)`);
        const params = [operatorId, ...rows.flatMap(([sid, teachers]) => [sid, JSON.stringify(teachers)])];
        await tx(
            `UPDATE course_sessions cs
                SET teachers = v.teachers, version = cs.version + 1,
                    updated_at = CURRENT_TIMESTAMP, updated_by = $1
               FROM (VALUES ${valueRows.join(', ')}) AS v(id, teachers)
              WHERE cs.id = v.id`,
            params
        );
    }

    if (feeAudits.length > 0) {
        const valueRows = feeAudits.map((_, i) => {
            const b = i * 8;
            return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`;
        });
        await tx(
            `INSERT INTO session_fee_audit_logs
             (session_id, teacher_uid, operator_id, operator_role,
              old_transport_fee, new_transport_fee, old_other_fee, new_other_fee)
             VALUES ${valueRows.join(', ')}`,
            feeAudits.flatMap(a => [a.sessionId, a.teacherUid, operatorId, 'teacher_batch', a.oldT, a.newT, a.oldO, a.newO])
        );
    }

    // 状态审计按目标状态分组批量写：resolveAutoFeeStatus 的结果依赖每个 pair 的原状态，
    // 所以不能一把塞进同一个 newStatus；但实际只会有一两个不同的目标状态，
    // 分组后往返次数是「目标状态种数」而不是「pair 数」（每条语句约 250ms）。
    const byTarget = new Map();
    for (const a of statusAudits) {
        if (!byTarget.has(a.newStatus)) byTarget.set(a.newStatus, []);
        byTarget.get(a.newStatus).push({ sessionId: a.sessionId, teacherUid: a.teacherUid, oldStatus: a.oldStatus });
    }
    for (const [newStatus, items] of byTarget) {
        await writeBatchFeeStatusLogs(tx, {
            items, newStatus, operatorId, actorType: autoSubmitActorType, note: '保存并提交'
        });
    }

    return { changed, submitted };
}

module.exports = {
    parseFeeAmount,
    hasFilledFee,
    checkScheduleScope,
    locateTeacherPair,
    buildPairPatchSql,
    updateScheduleFeesInTx,
    transitionFeeStatus,
    autoSubmitFeeStatus,
    batchTransitionFeeStatus,
    batchUpdateScheduleFeesInTx
};
