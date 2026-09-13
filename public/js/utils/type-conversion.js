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
 *
 * 「所有课程类型都必须有折算归属」的三层保障（2026-09-13）：
 *   1. 精确别名  TYPE_ALIASES      —— 覆盖 DB 现存全部 15 个类型的中文 description + 英文 slug。
 *   2. 关键词规则 PATTERN_RULES    —— 按 slug/中文里的语义词根（review / visit / trial / group / advisory …）
 *                                    兜住**将来新增**的类型，即便没人来登记别名也能自动落桶。
 *   3. 兜底桶     UNCATEGORIZED_KEY —— 前两层都没命中的类型不会被丢弃，而是明确计入「未归类」桶，
 *                                    出现在汇总文案里（`未归类 N`）+ 调用方告警 + 服务启动自检点名。
 *   任何新增类型都不会再「静默消失」，这是本模块对外的硬承诺。
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

    // 折算后的 5 个业务口径桶 + 1 个兜底桶（顺序即导出/摘要的展示顺序）
    const UNCATEGORIZED_KEY = 'uncategorized';
    const CONVERTED_KEYS = ['trial', 'visit', 'review', 'group_activity', 'consultation'];
    const CONVERTED_LABELS = {
        trial: '试教',
        visit: '入户',
        review: '评审',
        group_activity: '集体活动',
        consultation: '咨询'
    };
    // 兜底桶单独维护：不进 CONVERTED_KEYS 的正序展示，但计入 totals 并在有值时渲染
    const DISPLAY_KEYS = CONVERTED_KEYS.concat([UNCATEGORIZED_KEY]);
    const DISPLAY_LABELS = Object.assign({}, CONVERTED_LABELS, { uncategorized: '未归类' });

    // 规范类型键 → 各消费方的原始计数列名（用于把已按类型分列的统计对象送回折算）
    const RAW_LABELS = {
        trial: '试教',
        visit: '入户',
        half_visit: '半次入户',
        review: '评审',
        review_record: '评审记录',
        group_activity: '集体活动',
        consultation: '咨询',
        consultation_record: '咨询记录',
        // 兜底列：导出侧遇到无法归类的类型时记在「未归类」列，折算时同样要带过来
        uncategorized: '未归类'
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
        'advisory-record': 'consultation_record',
        // 兜底桶自身的写法（避免「未归类」被当成未识别类型反复告警）
        '未归类': 'uncategorized', '未分类': 'uncategorized', '其他': 'uncategorized',
        'uncategorized': 'uncategorized', 'unknown': 'uncategorized', 'other': 'uncategorized'
    };

    /**
     * 第 2 层保障：**关键词规则**。
     * 按语义词根兜住将来新增的类型，即使没人来 TYPE_ALIASES 登记别名也能自动落桶。
     *
     * 约定（新增类型时的命名规范）：schedule_types.name 的 slug 必须带上所属语义词根，
     * 例如 review / major-review / review_record / visit / half-visit / trial /
     * group_activity / advisory / consultation —— 这样即便新增也自动有归属。
     *
     * 顺序敏感：更具体的规则必须排在更宽泛的规则之前（记录族 → 半次 → 大评审 → 评审 → …）。
     */
    const PATTERN_RULES = [
        // 记录族（必须先于「评审」「咨询」）
        { re: /review-?record|评审-?记录|評審-?記錄/, key: 'review_record' },
        { re: /advisory-?record|consult(?:ation)?-?record|咨询记录|諮詢記錄|辅导记录|輔導記錄/, key: 'consultation_record' },
        // 半次入户（必须先于「入户」）
        { re: /半次|half-?visit|half-?home/, key: 'half_visit' },
        // 大评审（含线上；线上标记已被 stripOnline 剥离）
        { re: /大评审|大評審|大評|major-?review|big-?review/, key: 'review' },
        // 评审族
        { re: /review|评审|評審|评课|評課|听课|聽課|观课|觀課/, key: 'review' },
        // 试教
        { re: /试教|試教|试讲|試講|trial|demo/, key: 'trial' },
        // 集体活动
        { re: /集体|集體|团队活动|團隊活動|group|activity|party/, key: 'group_activity' },
        // 咨询族（含辅导 / 心理）
        { re: /咨询|諮詢|辅导|輔導|心理|advisory|consult|psych/, key: 'consultation' },
        // 入户（含家访）
        { re: /入户|家访|家訪|上门|上門|visit/, key: 'visit' }
    ];

    // 未识别类型登记表：只用于告警/自检，不参与折算
    const unresolvedTypes = [];

    function noteUnresolved(rawType) {
        const name = String(rawType == null ? '' : rawType).trim();
        if (name && unresolvedTypes.indexOf(name) === -1) unresolvedTypes.push(name);
    }

    /** 是否线上形态（4 种写法） */
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

    /** 折成便于匹配的 token：小写 + 统一分隔符（- _ 空格 → -） */
    function foldToken(rawType) {
        return stripOnline(rawType)
            .toLowerCase()
            .replace(/[\s_]+/g, '-')
            .replace(/-{2,}/g, '-')
            .replace(/^-|-$/g, '');
    }

    /** 第 2 层：关键词规则匹配 */
    function matchPattern(rawType) {
        const folded = foldToken(rawType);
        if (!folded) return null;
        for (let i = 0; i < PATTERN_RULES.length; i++) {
            const rule = PATTERN_RULES[i];
            // re 只有 g 以外的标志，test 无 lastIndex 副作用；此处仍显式置 0 以防将来加 g
            rule.re.lastIndex = 0;
            if (rule.re.test(folded)) return rule.key;
        }
        return null;
    }

    function lookup(candidate) {
        return Object.prototype.hasOwnProperty.call(TYPE_ALIASES, candidate)
            ? TYPE_ALIASES[candidate]
            : null;
    }

    /**
     * 解析任意类型写法。三层依次尝试：精确别名 → 关键词规则 → 兜底（未归类）。
     * @returns {{ key: string|null, online: boolean, raw: string, unknown: boolean, via: string }}
     *          key 为 null 表示**完全无法解析**（空串）或**无法归类**（unknown=true）；
     *          调用方拿到 null 时必须告警而不是静默丢数据。
     *          via: 'alias' | 'pattern' | 'none' —— 走的是哪一层。
     */
    function resolveType(rawType) {
        const trimmed = String(rawType == null ? '' : rawType).trim();
        if (!trimmed) return { key: null, online: false, raw: '', unknown: true, via: 'none' };

        const online = isOnline(trimmed);
        const base = stripOnline(trimmed);

        const candidates = [trimmed, base, trimmed.toLowerCase(), base.toLowerCase()];
        for (let i = 0; i < candidates.length; i++) {
            const hit = candidates[i] && lookup(candidates[i]);
            if (hit) return { key: hit, online: online, raw: trimmed, unknown: false, via: 'alias' };
        }

        // 第 2 层：关键词规则（新增类型自动落桶的主要保障）
        const patterned = matchPattern(trimmed);
        if (patterned) return { key: patterned, online: online, raw: trimmed, unknown: false, via: 'pattern' };

        noteUnresolved(trimmed);
        return { key: null, online: online, raw: trimmed, unknown: true, via: 'none' };
    }

    /** 规范类型键（trial/visit/half_visit/review/review_record/group_activity/consultation/consultation_record），无法归类返回 null */
    function normalizeTypeKey(rawType) {
        return resolveType(rawType).key;
    }

    /** 折算桶键：无法归类的类型一律落到兜底桶，保证「所有课程都有归属」 */
    function toBucketKey(rawType) {
        const key = normalizeTypeKey(rawType);
        if (key) return key;
        // 空串（根本没有类型信息）不算类型，不落桶
        return String(rawType == null ? '' : rawType).trim() ? UNCATEGORIZED_KEY : null;
    }

    /** 是否已被明确归类（命中别名或关键词规则） */
    function isKnownType(rawType) {
        return resolveType(rawType).key !== null;
    }

    /** 是否等价于「评审」——「大评审」「(线上)大评审」都算，供图例合并等处使用 */
    function isReviewType(rawType) {
        return normalizeTypeKey(rawType) === 'review';
    }

    /** 本次进程内出现过的「无法归类」类型名（告警/自检用） */
    function getUnresolvedTypes() {
        return unresolvedTypes.slice();
    }

    /**
     * 归属自检：给定一批类型名（如 schedule_types 全表的 name + description），
     * 报告哪些类型三层全未命中 —— 服务启动时调用，保证任何新类型都不会悄悄失去归属。
     * @returns {{ total: number, ok: boolean, resolved: Object, unresolved: string[] }}
     */
    function auditTypes(rawList) {
        const resolved = {};
        const unresolved = [];
        const seen = {};
        (Array.isArray(rawList) ? rawList : []).forEach(function (raw) {
            const name = String(raw == null ? '' : raw).trim();
            if (!name || seen[name]) return;
            seen[name] = true;
            const r = resolveType(name);
            if (r.key) resolved[name] = r.key;
            else unresolved.push(name);
        });
        return {
            total: Object.keys(seen).length,
            ok: unresolved.length === 0,
            resolved: resolved,
            unresolved: unresolved
        };
    }

    function createConvertedTotals() {
        return { trial: 0, visit: 0, review: 0, group_activity: 0, consultation: 0, uncategorized: 0 };
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

        switch (toBucketKey(rawType)) {
            case 'trial': t.trial += n; break;
            case 'visit': t.visit += n; break;
            case 'half_visit': t.visit += n * 0.5; break;
            case 'review': t.review += n; break;
            case 'review_record': t.review += n; t.visit += n * 0.5; break;
            case 'group_activity': t.group_activity += n; break;
            case 'consultation': t.consultation += n; break;
            case 'consultation_record': t.consultation += n; t.visit += n * 0.5; break;
            // 兜底桶：无法归类也要计数，绝不让课程凭空消失
            case UNCATEGORIZED_KEY: t.uncategorized = (Number(t.uncategorized) || 0) + n; break;
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
     * 有无法归类的类型时，末尾追加「未归类 N」—— 让数据缺口感立刻可见。
     * @param {Object} totals
     * @param {{keys?: string[], labels?: Object}} [options] keys 用于裁剪展示口径
     */
    function formatConvertedText(totals, options) {
        const opts = options || {};
        const order = opts.keys || CONVERTED_KEYS;
        const labels = opts.labels || CONVERTED_LABELS;
        const t = totals || createConvertedTotals();
        const text = order
            .filter(function (key) { return Number(t[key]) > 0; })
            .map(function (key) { return (labels[key] || key) + ' ' + fmtCount(t[key]); })
            .join(' · ');
        // 兜底桶独立追加，避免被 opts.keys 裁剪掉后消失
        if (Number(t[UNCATEGORIZED_KEY]) > 0) {
            const tail = DISPLAY_LABELS[UNCATEGORIZED_KEY] + ' ' + fmtCount(t[UNCATEGORIZED_KEY]);
            return text ? text + ' · ' + tail : tail;
        }
        return text;
    }

    /** 汇总文本（导出「汇总」列形态）：3次试教、2次入户（含未归类兜底项） */
    function formatConvertedSummary(totals) {
        return DISPLAY_KEYS
            .filter(function (key) { return Number((totals || {})[key]) > 0; })
            .map(function (key) { return fmtCount(totals[key]) + '次' + DISPLAY_LABELS[key]; })
            .join('、');
    }

    return {
        CONVERTED_KEYS: CONVERTED_KEYS,
        CONVERTED_LABELS: CONVERTED_LABELS,
        UNCATEGORIZED_KEY: UNCATEGORIZED_KEY,
        PATTERN_RULES: PATTERN_RULES,
        RAW_LABELS: RAW_LABELS,
        TYPE_ALIASES: TYPE_ALIASES,
        isOnline: isOnline,
        stripOnline: stripOnline,
        resolveType: resolveType,
        normalizeTypeKey: normalizeTypeKey,
        toBucketKey: toBucketKey,
        isKnownType: isKnownType,
        isReviewType: isReviewType,
        getUnresolvedTypes: getUnresolvedTypes,
        auditTypes: auditTypes,
        createConvertedTotals: createConvertedTotals,
        accumulateConvertedType: accumulateConvertedType,
        accumulateTypeList: accumulateTypeList,
        accumulateConvertedColumns: accumulateConvertedColumns,
        formatConvertedText: formatConvertedText,
        formatConvertedSummary: formatConvertedSummary,
        fmtCount: fmtCount
    };
});
