/**
 * 课程类型折算 —— 全系统唯一实现
 *
 * 消费方（一律调用本模块，禁止再各自维护别名表 / 折算分支）：
 *   1. 浏览页统计    public/js/modules/admin/stats-logic.js（统计页「教师统计 / 学生统计」折算文案与个人卡）
 *   2. Excel 导出    src/server/services/export/stats-aggregator.js（第 2/3 工作表「教师授课汇总 / 学生上课汇总」）
 *   3. 教师酬劳      src/server/services/reward-calc.js（教师端酬劳计算）
 *   4. 图片截图导出  public/js/components/export-manager.js
 *
 * 折算规则（业务口径）：
 *   线上类型等同线下；半次入户 = 0.5 次入户；评审记录 = 1 评审 + 0.5 入户；
 *   咨询记录 = 1 咨询 + 0.5 入户；大评审（含线上）= 1 评审；试教 / 集体活动 取原值。
 *
 * 为什么两个空间都要覆盖：
 *   浏览页与酬劳拿到的是 schedule_types.description（中文），导出拿到的是 schedule_types.name（英文 slug）；
 *   且 DB 里咨询族用 advisory* 而评审族用 review*，历史别名还有 big_review / major-review 等。
 *   所有写法集中在本文件的 TYPE_ALIASES，新增课程类型时**只改这里**。
 */
(function (root, factory) {
    const mod = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = mod;
    }

    if (root) {
        root.TypeConversion = mod;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // 折算后的 5 个口径桶（顺序即导出/摘要的展示顺序）
    const CONVERTED_KEYS = ['trial', 'visit', 'review', 'group_activity', 'consultation'];
    const CONVERTED_LABELS = {
        trial: '试教',
        visit: '入户',
        review: '评审',
        group_activity: '集体活动',
        consultation: '咨询'
    };

    // 规范类型键 → 各消费方的原始计数列名（用于把已按类型分列的统计对象送回折算）
    const RAW_LABELS = {
        trial: '试教',
        visit: '入户',
        half_visit: '半次入户',
        review: '评审',
        review_record: '评审记录',
        group_activity: '集体活动',
        consultation: '咨询',
        consultation_record: '咨询记录'
    };

    /**
     * 类型别名 → 规范类型键。**唯一真源**。
     * 同时覆盖：中文 description、英文 slug（含历史命名）、连字符/下划线/空格变体。
     */
    const TYPE_ALIASES = {
        // 试教
        '试教': 'trial', 'trial': 'trial',
        // 入户
        '入户': 'visit', '入户课': 'visit', 'visit': 'visit',
        // 半次入户
        '半次入户': 'half_visit', 'half_visit': 'half_visit', 'half-visit': 'half_visit',
        'half visit': 'half_visit', 'half_home_visit': 'half_visit', 'half-home-visit': 'half_visit',
        // 评审（「大评审」及其全部历史别名，含线上形态由 stripOnline 归一）
        '评审': 'review', 'review': 'review',
        '大评审': 'review', '大評審': 'review',
        'bigreview': 'review', 'big_review': 'review', 'big-review': 'review', 'big review': 'review',
        'major-review': 'review', 'major_review': 'review', 'major review': 'review', 'majorreview': 'review',
        // 评审记录
        '评审记录': 'review_record', 'review_record': 'review_record',
        'review-record': 'review_record', 'review record': 'review_record',
        // 集体活动
        '集体活动': 'group_activity', 'group': 'group_activity', 'group_activity': 'group_activity',
        'group-activity': 'group_activity', 'group activity': 'group_activity',
        // 咨询
        '咨询': 'consultation', '咨询课': 'consultation', 'consult': 'consultation',
        'consultation': 'consultation', 'advisory': 'consultation',
        '线上辅导': 'consultation', '辅导': 'consultation', '心理咨询': 'consultation',
        // 咨询记录（DB 用 advisory*，历史代码写 consultation*，两套都要认）
        '咨询记录': 'consultation_record', 'consult_record': 'consultation_record',
        'consult-record': 'consultation_record', 'consultation_record': 'consultation_record',
        'consultation-record': 'consultation_record', 'advisory_record': 'consultation_record',
        'advisory-record': 'consultation_record'
    };

    // 线上形态有 4 种：中文前缀「线上X」、括号「(线上)X / （线上）X」、slug 后缀「x_online」、slug 前缀「online_x」
    const ONLINE_PATTERN = /[（(]线上[)）]|^线上|online/i;

    function isOnline(rawType) {
        return ONLINE_PATTERN.test(String(rawType == null ? '' : rawType));
    }

    /** 剥离线上标记（前缀 / 括号 / slug 前后缀），保留基础类型名 */
    function stripOnline(rawType) {
        return String(rawType == null ? '' : rawType)
            .replace(/[（(]线上[)）]/g, '')
            .replace(/^线上/, '')
            .replace(/[_\-\s]?online$/i, '')
            .replace(/^online[_\-\s]?/i, '')
            .trim();
    }

    function lookup(candidate) {
        return Object.prototype.hasOwnProperty.call(TYPE_ALIASES, candidate)
            ? TYPE_ALIASES[candidate]
            : null;
    }

    /**
     * 解析任意类型写法。
     * @returns {{ key: string|null, online: boolean, raw: string, unknown: boolean }}
     *          key 为 null 表示未识别（调用方应告警而不是静默丢数据）
     */
    function resolveType(rawType) {
        const trimmed = String(rawType == null ? '' : rawType).trim();
        if (!trimmed) return { key: null, online: false, raw: '', unknown: true };

        const online = isOnline(trimmed);
        const base = stripOnline(trimmed);

        const candidates = [trimmed, base, trimmed.toLowerCase(), base.toLowerCase()];
        for (let i = 0; i < candidates.length; i++) {
            const hit = candidates[i] && lookup(candidates[i]);
            if (hit) return { key: hit, online: online, raw: trimmed, unknown: false };
        }
        return { key: null, online: online, raw: trimmed, unknown: true };
    }

    /** 规范类型键（trial/visit/half_visit/review/review_record/group/consult/consult_record），未识别返回 null */
    function normalizeTypeKey(rawType) {
        return resolveType(rawType).key;
    }

    /** 是否等价于「评审」——「大评审」「(线上)大评审」都算，供图例合并等处使用 */
    function isReviewType(rawType) {
        return normalizeTypeKey(rawType) === 'review';
    }

    function createConvertedTotals() {
        return { trial: 0, visit: 0, review: 0, group_activity: 0, consultation: 0 };
    }

    /**
     * 把单个课程类型按折算规则累加进 totals。
     * @param {Object} totals - createConvertedTotals() 的结果
     * @param {string} rawType - 任意写法（中文 / slug / 线上变体）
     * @param {number} count - 可小数（摘要面板按类型总数累加）
     */
    function accumulateConvertedType(totals, rawType, count) {
        const t = totals || createConvertedTotals();
        const n = count === undefined ? 1 : Number(count);
        if (!Number.isFinite(n) || n === 0) return t;

        switch (normalizeTypeKey(rawType)) {
            case 'trial': t.trial += n; break;
            case 'visit': t.visit += n; break;
            case 'half_visit': t.visit += n * 0.5; break;
            case 'review': t.review += n; break;
            case 'review_record': t.review += n; t.visit += n * 0.5; break;
            case 'group_activity': t.group_activity += n; break;
            case 'consultation': t.consultation += n; break;
            case 'consultation_record': t.consultation += n; t.visit += n * 0.5; break;
            default: break;
        }
        return t;
    }

    /** 逗号分隔的类型串（grid 行 schedule_types 字段的形态） */
    function accumulateTypeList(totals, typeList, count) {
        const t = totals || createConvertedTotals();
        const n = (count === undefined || !Number.isFinite(Number(count))) ? 1 : Number(count);
        String(typeList == null ? '' : typeList)
            .split(',')
            .map(one => one.trim())
            .filter(Boolean)
            .forEach(one => accumulateConvertedType(t, one, n));
        return t;
    }

    /** 把「已按规范类型分列」的统计对象（键为 RAW_LABELS 里的中文列名）折算成 totals */
    function accumulateConvertedColumns(totals, columns) {
        const t = totals || createConvertedTotals();
        const source = columns || {};
        Object.keys(RAW_LABELS).forEach(function (key) {
            const label = RAW_LABELS[key];
            const val = Number(source[label]);
            if (Number.isFinite(val) && val > 0) accumulateConvertedType(t, label, val);
        });
        return t;
    }

    function fmtCount(v) {
        const n = Number(v) || 0;
        return Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : String(Number(n.toFixed(1)));
    }

    /**
     * 折算文本：试教 X · 入户 Y · 评审 Z · 集体活动 W · 咨询 V（仅显示非 0 项）
     * @param {Object} totals
     * @param {{keys?: string[], labels?: Object}} [options] keys 用于裁剪展示口径
     */
    function formatConvertedText(totals, options) {
        const opts = options || {};
        const order = opts.keys || CONVERTED_KEYS;
        const labels = opts.labels || CONVERTED_LABELS;
        const t = totals || createConvertedTotals();
        return order
            .filter(function (key) { return Number(t[key]) > 0; })
            .map(function (key) { return (labels[key] || key) + ' ' + fmtCount(t[key]); })
            .join(' · ');
    }

    /** 汇总文本（导出「汇总」列形态）：3次试教、2次入户 */
    function formatConvertedSummary(totals) {
        return CONVERTED_KEYS
            .filter(function (key) { return Number((totals || {})[key]) > 0; })
            .map(function (key) { return fmtCount(totals[key]) + '次' + CONVERTED_LABELS[key]; })
            .join('、');
    }

    return {
        CONVERTED_KEYS: CONVERTED_KEYS,
        CONVERTED_LABELS: CONVERTED_LABELS,
        RAW_LABELS: RAW_LABELS,
        TYPE_ALIASES: TYPE_ALIASES,
        isOnline: isOnline,
        stripOnline: stripOnline,
        resolveType: resolveType,
        normalizeTypeKey: normalizeTypeKey,
        isReviewType: isReviewType,
        createConvertedTotals: createConvertedTotals,
        accumulateConvertedType: accumulateConvertedType,
        accumulateTypeList: accumulateTypeList,
        accumulateConvertedColumns: accumulateConvertedColumns,
        formatConvertedText: formatConvertedText,
        formatConvertedSummary: formatConvertedSummary,
        fmtCount: fmtCount
    };
});
