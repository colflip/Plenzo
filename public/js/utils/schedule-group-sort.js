// public/js/utils/schedule-group-sort.js
// 统一“多人排课合并显示”分组内的排序规则：
//   排序优先级（数值越小越靠前）：
//     1. 活跃状态优先：active(0) < modified_away/cancelled(1)
//     2. 类型分桶：普通类型(0) < 评审(1) < 咨询(2)（评审、咨询都排在最后，且 咨询 在 评审 之后）
//     3. 按 teacher_id 升序
//
// 数据字段兼容：schedule_type / schedule_type_cn / schedule_type_name / type_name /
//             schedule_types / course_type 任一字段命中即可，
//             支持中文 (评审/咨询) 与英文 code (review/review-online/advisory/advisory-online)。

(function (root) {
    const REVIEW_CODES = new Set(['review', 'review-online', 'review_online']);
    const CONSULT_CODES = new Set(['advisory', 'advisory-online', 'advisory_online', 'consult', 'consultation']);

    function readTypeNames(rec) {
        if (!rec) return [];
        return [
            rec.schedule_type,
            rec.schedule_type_cn,
            rec.schedule_type_name,
            rec.type_name,
            rec.schedule_types,
            rec.course_type
        ].filter(v => v != null).map(v => String(v));
    }

    function isReviewRecord(rec) {
        const names = readTypeNames(rec);
        return names.some(name => name.includes('评审') || REVIEW_CODES.has(name.toLowerCase()));
    }

    function isConsultationRecord(rec) {
        const names = readTypeNames(rec);
        return names.some(name => name.includes('咨询') || CONSULT_CODES.has(name.toLowerCase()));
    }

    /** 0 = 普通类型；1 = 评审；2 = 咨询（最后）。 */
    function typeRank(rec) {
        // 咨询的优先级（最后显示）高于评审
        if (isConsultationRecord(rec)) return 2;
        if (isReviewRecord(rec)) return 1;
        return 0;
    }

    function statusRank(rec) {
        const s = (rec && (rec.status || 'pending') + '').toLowerCase();
        return (s === 'modified_away' || s === 'cancelled') ? 1 : 0;
    }

    /**
     * 比较器：用于 group.sort(...)
     * @param {object} a
     * @param {object} b
     * @returns {number}
     */
    function compareGroupRecord(a, b) {
        const sA = statusRank(a);
        const sB = statusRank(b);
        if (sA !== sB) return sA - sB;

        const tA = typeRank(a);
        const tB = typeRank(b);
        if (tA !== tB) return tA - tB;

        return (Number(a && a.teacher_id) || 0) - (Number(b && b.teacher_id) || 0);
    }

    const api = {
        compareGroupRecord,
        isReviewRecord,
        isConsultationRecord,
        typeRank,
        statusRank
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.ScheduleGroupSort = api;
})(typeof window !== 'undefined' ? window : globalThis);
