/**
 * 教师端隐藏酬劳计算（服务端版）
 * @description 把 goodluck 页面的客户端聚合/系数/费用逻辑移植到服务端，
 *              供 /teacher/dashboard/teaching-display/goodluck 直接返回 JSON 使用。
 */

const db = require('../db/db');
const logger = require('../utils/logger');
// 类型别名与折算的唯一实现（与浏览页统计、Excel 导出共用同一份规则）
const TypeConversion = require('../../../public/js/utils/type-conversion');

// 未识别类型告警去重
const reportedUnknownTypes = new Set();

function aggregate(m) {
    const totals = TypeConversion.createConvertedTotals();
    const enMap = {};
    for (const [cn, c] of Object.entries(m || {})) {
        const v = Number(c) || 0;
        if (v <= 0) continue;
        const key = TypeConversion.normalizeTypeKey(cn);
        if (!key) {
            // 无法归类：不静默丢掉 —— 计入「未归类」桶（酬劳按 0 计）并告警，
            // 「大评审」曾因静默丢弃而整类漏算 ¥2400。
            const name = String(cn).trim();
            if (name && !reportedUnknownTypes.has(name)) {
                reportedUnknownTypes.add(name);
                logger.warn(`[reward] 无法归类的课程类型「${name}」已计入「未归类」（不计酬劳），请按命名约定（review/visit/trial/group/advisory…）调整 schedule_types.name，或在 public/js/utils/type-conversion.js 的 TYPE_ALIASES 中补别名`);
            }
            enMap[TypeConversion.UNCATEGORIZED_KEY] = (enMap[TypeConversion.UNCATEGORIZED_KEY] || 0) + v;
            TypeConversion.accumulateConvertedType(totals, TypeConversion.UNCATEGORIZED_KEY, v);
            continue;
        }
        enMap[key] = (enMap[key] || 0) + v;
        TypeConversion.accumulateConvertedType(totals, cn, v);
    }
    return {
        enMap,
        visitAgg: totals.visit,
        reviewAgg: totals.review,
        consultAgg: totals.consultation,
        trial: totals.trial,
        group: totals.group_activity,
        uncategorized: totals.uncategorized
    };
}

function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }

function computeCoefficient(v) { return 1.0 + Math.floor(v / 5) * 0.1; }

function computeFee(a, c) {
    const vs = round2(a.visitAgg * 200 * c);
    const rs = round2(a.reviewAgg * 100);
    const ts = round2(a.trial * 100);
    const gs = round2(a.group * 100);
    const cs = round2(a.consultAgg * 100);
    return {
        breakdown: [
            { item: 'visit', count: a.visitAgg, unit_price: 200, coefficient: c, subtotal: vs },
            { item: 'review', count: a.reviewAgg, unit_price: 100, coefficient: 1.0, subtotal: rs },
            { item: 'trial', count: a.trial, unit_price: 100, coefficient: 1.0, subtotal: ts },
            { item: 'group_activity', count: a.group, unit_price: 100, coefficient: 1.0, subtotal: gs },
            { item: 'consultation', count: a.consultAgg, unit_price: 100, coefficient: 1.0, subtotal: cs }
        ],
        total: round2(vs + rs + ts + gs + cs)
    };
}

function buildPayload(name, start, end, coeff, agg, fee) {
    const typeStats = {};
    for (const [k, v] of Object.entries(agg.enMap)) if (v > 0) typeStats[k] = v;
    const uncategorized = round2(agg.uncategorized);
    return {
        basic_info: { name, date_range: { start, end }, coefficient: round2(coeff) },
        aggregated: {
            visit: round2(agg.visitAgg),
            review: round2(agg.reviewAgg),
            trial: round2(agg.trial),
            group_activity: round2(agg.group),
            consultation: round2(agg.consultAgg),
            // 兜底口径：无法归类的课程数（不计酬劳，但必须可见）
            uncategorized: uncategorized
        },
        type_stats: typeStats,
        breakdown: fee.breakdown,
        total: fee.total
    };
}

async function getRewardPayload({ userId, name, start, end }) {
    // 计数落在 v_session_pairs（教师 pair × 学生 pair 展开）上：
    // 「一师带 N 生按 N 次算」的口径要的正是这个展开形状，计数与系数逻辑一字未改。
    // 旧过滤里的 '0' 随旧表一并消失；活跃判定改看生命周期位。
    const typeStatsResult = await db.query(`
        SELECT
            COALESCE(sty.description, sty.name) as type,
            COUNT(*) as count
        FROM v_session_pairs vp
        JOIN schedule_types sty ON vp.type_id = sty.id
        WHERE vp.teacher_id = $1
          AND vp.class_date BETWEEN $2 AND $3
          AND vp.status NOT IN ('cancelled', 'modified_away')
        GROUP BY COALESCE(sty.description, sty.name)
        ORDER BY count DESC
    `, [userId, start, end]);

    const rawMap = {};
    for (const r of typeStatsResult.rows || []) rawMap[r.type] = Number(r.count) || 0;

    const agg = aggregate(rawMap);
    const coeff = computeCoefficient(agg.visitAgg);
    const fee = computeFee(agg, coeff);
    return buildPayload(name, start, end, coeff, agg, fee);
}

function buildEmptyPayload(name, start, end) {
    return buildPayload(name || '未知', start, end, 1.0, aggregate({}), computeFee(aggregate({}), 1.0));
}

module.exports = { getRewardPayload, buildEmptyPayload, aggregate, computeCoefficient, computeFee, buildPayload };
