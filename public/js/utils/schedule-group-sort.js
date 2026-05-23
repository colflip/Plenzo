// public/js/utils/schedule-group-sort.js
// 统一“多人排课合并显示”同一合并卡片内多条记录的排序规则。
//
// 优先级（数值越小越靠前）：
//   1. 带「记录」标识的类型最后显示（最高优先级）
//      —— 仅指 评审记录 / 咨询记录（含其 online 变体、英文 code review_record /
//         consultation_record 等），普通 评审 / 咨询 不参与此规则。
//   2. 活跃状态优先：active(0) < modified_away/cancelled(1)
//   3. 教师ID升序（学生视图同理，调用方可传入对应字段）
//
// 注：不同开始时间的记录会先在 groupSchedulesBySlot 步骤中分到不同的卡片，
//    所以“不同类型按开始时间排序”体现在卡片间（外层）而非卡片内（本比较器）。
//
// 数据字段兼容：schedule_type / schedule_type_cn / schedule_type_name / type_name /
//             schedule_types / course_type。

(function (root) {
    // 中文标识：包含“评审记录”或“咨询记录”即视为记录类
    const RECORD_CN_TOKENS = ['评审记录', '咨询记录'];

    // 英文 code 表（含 - / _ / 空格 / online 变体）
    const RECORD_EN_CODES = new Set([
        'review_record', 'review-record', 'review record',
        'review_record_online', 'review-record-online', 'review record online',
        'online_review_record', 'online-review-record',
        'consultation_record', 'consultation-record', 'consultation record',
        'consultation_record_online', 'consultation-record-online', 'consultation record online',
        'online_consultation_record', 'online-consultation-record',
        // 兼容 advisory_record 别名
        'advisory_record', 'advisory-record', 'advisory record',
        'advisory_record_online', 'advisory-record-online'
    ]);

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

    function isRecordTypeRecord(rec) {
        const names = readTypeNames(rec);
        return names.some(name => {
            if (!name) return false;
            // 中文 token 子串命中
            if (RECORD_CN_TOKENS.some(t => name.includes(t))) return true;
            // 英文 code（小写后 normalize 空格）整体命中
            const low = name.toLowerCase().trim();
            if (RECORD_EN_CODES.has(low)) return true;
            // 兜底：英文 code 同时包含 review/consultation/advisory 与 record
            return /(review|consultation|advisory)[\s_-]?record/i.test(name);
        });
    }

    function recordRank(rec) {
        return isRecordTypeRecord(rec) ? 1 : 0;
    }

    function statusRank(rec) {
        const s = (rec && ((rec.status || 'pending') + '')).toLowerCase();
        return (s === 'modified_away' || s === 'cancelled') ? 1 : 0;
    }

    /**
     * 默认比较器：教师 ID 维度（适用于学生 / 管理员 / 班主任视图）
     */
    function compareGroupRecord(a, b) {
        // 1. 「记录」类放最后 —— 最高优先级
        const rA = recordRank(a);
        const rB = recordRank(b);
        if (rA !== rB) return rA - rB;

        // 2. 活跃状态优先
        const sA = statusRank(a);
        const sB = statusRank(b);
        if (sA !== sB) return sA - sB;

        // 3. 教师 ID 升序
        return (Number(a && a.teacher_id) || 0) - (Number(b && b.teacher_id) || 0);
    }

    /**
     * 教师视图变体：以学生 ID 为最终 tiebreaker
     */
    function compareGroupRecordByStudent(a, b) {
        const rA = recordRank(a);
        const rB = recordRank(b);
        if (rA !== rB) return rA - rB;

        const sA = statusRank(a);
        const sB = statusRank(b);
        if (sA !== sB) return sA - sB;

        return (Number(a && a.student_id) || 0) - (Number(b && b.student_id) || 0);
    }

    const api = {
        compareGroupRecord,
        compareGroupRecordByStudent,
        isRecordTypeRecord,
        recordRank,
        statusRank
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.ScheduleGroupSort = api;
})(typeof window !== 'undefined' ? window : globalThis);
