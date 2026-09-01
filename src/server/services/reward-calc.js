/**
 * 教师端隐藏酬劳计算（服务端版）
 * @description 把 goodluck 页面的客户端聚合/系数/费用逻辑移植到服务端，
 *              供 /teacher/dashboard/teaching-display/goodluck 直接返回 JSON 使用。
 */

const db = require('../db/db');
const SchemaHelper = require('../utils/schema-helper');

// 类型中文 → 英文键（含线上/半次/记录变体）
const TYPE_EN = {
    '试教': 'trial', '入户': 'visit', '半次入户': 'half_visit',
    '（线上）入户': 'online_visit', '(线上)入户': 'online_visit', '线上入户': 'online_visit',
    '评审': 'review', '评审记录': 'review_record',
    '（线上）评审': 'online_review', '(线上)评审': 'online_review', '线上评审': 'online_review',
    '集体活动': 'group_activity',
    '咨询': 'consultation', '咨询记录': 'consultation_record',
    '（线上）咨询': 'online_consultation', '(线上)咨询': 'online_consultation', '线上咨询': 'online_consultation',
    '（线上）评审记录': 'online_review_record', '(线上)评审记录': 'online_review_record', '线上评审记录': 'online_review_record',
    '（线上）咨询记录': 'online_consultation_record', '(线上)咨询记录': 'online_consultation_record', '线上咨询记录': 'online_consultation_record'
};
const ONLINE_CAPABLE = new Set(['visit', 'review', 'consultation', 'review_record', 'consultation_record']);

function toEnKey(cn) {
    const isOnline = cn.includes('（线上）') || cn.includes('(线上)') || cn.startsWith('线上');
    const base = cn.replace(/[（(]线上[)）]/g, '').replace(/^线上/, '');
    let en = TYPE_EN[cn] || TYPE_EN[base] || base;
    if (isOnline && ONLINE_CAPABLE.has(en)) en = 'online_' + en;
    return en;
}

function aggregate(m) {
    const enMap = {};
    for (const [cn, c] of Object.entries(m || {})) {
        const v = Number(c) || 0;
        if (v <= 0) continue;
        const en = toEnKey(cn);
        enMap[en] = (enMap[en] || 0) + v;
    }
    const g = (k) => Number(enMap[k] || 0);
    const visit = g('visit') + g('online_visit');
    const half = g('half_visit');
    const review = g('review') + g('online_review');
    const reviewRec = g('review_record') + g('online_review_record');
    const consult = g('consultation') + g('online_consultation');
    const consultRec = g('consultation_record') + g('online_consultation_record');
    return {
        enMap,
        visitAgg: visit + half * 0.5 + reviewRec * 0.5 + consultRec * 0.5,
        reviewAgg: review + reviewRec,
        consultAgg: consult + consultRec,
        trial: g('trial'),
        group: g('group_activity')
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
    return {
        basic_info: { name, date_range: { start, end }, coefficient: round2(coeff) },
        aggregated: {
            visit: round2(agg.visitAgg),
            review: round2(agg.reviewAgg),
            trial: round2(agg.trial),
            group_activity: round2(agg.group),
            consultation: round2(agg.consultAgg)
        },
        type_stats: typeStats,
        breakdown: fee.breakdown,
        total: fee.total
    };
}

async function getRewardPayload({ userId, name, start, end }) {
    const dateExpr = await SchemaHelper.getDateExpr('ca');
    const typeStatsResult = await db.query(`
        SELECT
            COALESCE(sty.description, sty.name) as type,
            COUNT(*) as count
        FROM course_arrangement ca
        JOIN schedule_types sty ON ca.course_id = sty.id
        WHERE ca.teacher_id = $1
          AND ${dateExpr} BETWEEN $2 AND $3
          AND ca.status NOT IN ('cancelled', '0', 'modified_away')
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
