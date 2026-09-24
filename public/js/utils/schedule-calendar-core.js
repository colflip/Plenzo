/**
 * 每日排课明细（日历 sheet1 / 报销视图）—— 全系统唯一实现
 *
 * 消费方（一律调用本模块，禁止再各自维护平行实现）：
 *   1. 服务端 Excel  src/server/services/export/calendar-generator.js（导出文件第 1 工作表）
 *   2. 浏览器视图    public/js/components/export-manager.js（报销页面表格 + PNG 导出 + 前端 Excel）
 *
 * 为什么必须只有一个实现：两条链路曾各自维护行拆分、趟费去重、周键、明细排序，
 * 每修一处口径就要两边同步改，实测已多次漂移（同日多场费用被吞、跨年周分组、
 * 同键非合并类型只渲染第一个老师、费用明细老师顺序随机）。本模块收敛：
 *   - 行模型：逻辑行 = (折叠类型, 时段)（多学生模式再按学生拆分），同日两节独立的
 *     同类型课一行一节；计划整段被挪走 ↔ 实际整段 adjusted 视为同一节课的前后身，
 *     配对并到同一行两列（调整前后时段不同也对齐）；
 *   - 课程文本：同一 (折叠类型, 时段, 地点, 学生) 的教师全部并入一段，逗号相连，
 *     段内按 teacher_id 升序；「（记录）」挂在老师名后（周耀华（记录））；
 *     线上：混合组挂名字后缀（高渊(线上)），整段全线上则改挂类型前缀
 *     「（线上）评审」且名字保持干净；同一行内多段之间用 ROW_SEGMENT_SEPARATOR；
 *   - 趟费：明细「填在哪显示在哪」不分摊；合计按 (场次, 教师pair) 计一次，
 *     fee_scope='student' 的键再带学生逐行相加；draft 不计入合计与明细；
 *   - 周键：ISO 年 + 补零周号 'YYYY-Wnn'（周四定年），两侧合并单元格都按它分组；
 *   - 明细展示顺序：老师按 teacher_id、学生按 student_id 升序，保证两边可复现。
 *
 * part 模型（每条 run 可独立着色，同一行可多段不同颜色）：
 *   { text, colorType, dim, isSuperscript, startsLine }
 *   - startsLine: true → 渲染器在本 run 前插入换行（第一 run 跳过）
 *
 * 数据形状兼容：服务端导出行（type_name/type_desc/schedule_id/Date 型 date）与
 * 视图行（中文 type/id/ISO 字符串 date/teacher_uid/student_uid/fee_scope）都能直接喂，
 * 字段读取统一走下方 raw* 系列助手，不再各取各的。
 */
(function (root, factory) {
    const deps = (typeof module === 'object' && module.exports && typeof require === 'function')
        ? {
            TypeConversion: require('./type-conversion.js'),
            ScheduleMarkerPolicy: require('./schedule-marker-policy.js')
        }
        : {
            TypeConversion: root.TypeConversion,
            ScheduleMarkerPolicy: root.ScheduleMarkerPolicy
        };
    const mod = factory(deps);

    if (typeof module === 'object' && module.exports) {
        module.exports = mod;
    }
    if (root) {
        root.ScheduleCalendarCore = mod;
    }
}(typeof window !== 'undefined' ? window : globalThis, function (deps) {
    'use strict';

    const TypeConversion = deps.TypeConversion;
    const ScheduleMarkerPolicy = deps.ScheduleMarkerPolicy;

    // ── 常量（与服务端 export-constants 同源；服务端文件保留 re-export）──
    const TYPE_PRIORITY = {
        '咨询': 1,
        '评审': 2,
        '大评审': 2,
        '集体活动': 3,
        '入户': 4,
        '试教': 5
    };
    const ROW_SEGMENT_SEPARATOR = '；';
    const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const TYPE_DISPLAY_MAP = {
        'visit': '入户',
        'trial': '试教',
        'review': '评审',
        'review_record': '评审记录',
        'half_visit': '半次入户',
        'group_activity': '集体活动',
        'group': '集体活动',
        'advisory': '咨询',
        'consultation': '咨询',
        'consultation_record': '咨询记录',
        'advisory_record': '咨询记录',
        'major-review': '大评审',
        'major-review_online': '(线上)大评审',
        'visit_online': '（线上）入户',
        'review_online': '（线上）评审',
        'advisory_online': '（线上）咨询',
        'consultation_online': '（线上）咨询',
        'trial_online': '（线上）试教',
        'group_activity_online': '（线上）集体活动',
        'online_visit': '（线上）入户',
        'online_review': '（线上）评审',
        'online_advisory': '（线上）咨询',
        'online_consultation': '（线上）咨询',
        'review_record_online': '（线上）评审记录',
        'advisory_record_online': '（线上）咨询记录',
        'consultation_record_online': '（线上）咨询记录',
        'online_review_record': '（线上）评审记录',
        'online_advisory_record': '（线上）咨询记录',
        'online_consultation_record': '（线上）咨询记录',
        '入户': '入户',
        '试教': '试教',
        '评审': '评审',
        '大评审': '评审',
        '大評審': '评审',
        '评审记录': '评审记录',
        '半次入户': '半次入户',
        '集体活动': '集体活动',
        '咨询': '咨询',
        '咨询记录': '咨询记录',
        '线上入户': '（线上）入户',
        '线上评审': '（线上）评审',
        '线上咨询': '（线上）咨询',
        '线上试教': '（线上）试教',
        '线上集体活动': '（线上）集体活动',
        '(线上)入户': '（线上）入户',
        '(线上)评审': '（线上）评审',
        '(线上)咨询': '（线上）咨询',
        '(线上)试教': '（线上）试教',
        '(线上)集体活动': '（线上）集体活动',
        '（线上）入户': '（线上）入户',
        '（线上）评审': '（线上）评审',
        '（线上）咨询': '（线上）咨询',
        '（线上）试教': '（线上）试教',
        '（线上）集体活动': '（线上）集体活动',
        '（线上）评审记录': '（线上）评审记录',
        '（线上）咨询记录': '（线上）咨询记录'
    };

    // ── 日期工具 ──

    function formatLocaleDate(date) {
        if (!date) return '';
        const d = date instanceof Date ? date : new Date(date);
        if (isNaN(d.getTime())) return String(date);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function generateDateRange(startDate, endDate) {
        const dates = [];
        const start = new Date(startDate);
        const end = new Date(endDate);
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            dates.push(formatLocaleDate(d));
        }
        return dates;
    }

    function getISOWeek(date) {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + 4 - (d.getDay() || 7));
        const yearStart = new Date(d.getFullYear(), 0, 1);
        const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
        return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
    }

    // ── 数据形状兼容助手 ──

    function typeLabel(s) {
        if (s.type_desc) return s.type_desc;
        const raw = s.type_name || '';
        if (TYPE_DISPLAY_MAP[raw]) return TYPE_DISPLAY_MAP[raw];
        return raw || s.type || s.schedule_type_cn || s.schedule_type || '';
    }

    function typeKey(s) {
        return s.type_name || typeLabel(s);
    }

    function statusCategory(s) {
        if (s.status_category) return s.status_category;
        if (s.status_code) return String(s.status_code).split('.')[0];
        return 'normal';
    }

    function rowDateKey(row) {
        return formatLocaleDate(row.date || row.class_date || row.arr_date || row['日期']);
    }

    function roundFee(v) {
        return Math.round(v * 100) / 100;
    }

    // ── 课程富文本（原服务端 RichTextFormatter，行为收敛见文件头）──

    const RichText = {
        normalizeOnlineParens(name) {
            return String(name || '').replace(/（线上）/g, '(线上)');
        },

        getDisplayTypeName(schedule) {
            return RichText.normalizeOnlineParens(typeLabel(schedule));
        },

        getBaseTypeName(typeName) {
            const name = String(typeName || '').trim();
            const display = TYPE_DISPLAY_MAP[name];
            if (display) {
                return display.replace(/[（(]线上[）)]/, '').replace(/记录$/, '').trim();
            }
            if (name.includes('评审')) return '评审';
            if (name.includes('咨询')) return '咨询';
            if (name.includes('集体')) return '集体活动';
            if (name.includes('半次')) return '半次入户';
            if (name.includes('入户')) return '入户';
            if (name.includes('试教')) return '试教';
            return name;
        },

        isRecordType(schedule) {
            const name = schedule.type_name || '';
            return name.includes('record') || typeLabel(schedule).includes('记录');
        },

        getFoldedDisplayType(schedule) {
            // 段标签用的折叠名：折叠「记录」后缀 + **整体去掉 (线上) 前缀**。
            // 线上不再单独成段（旧输出「(线上)评审(14:00-15:30)：高渊」），
            // 而是并入基类段、把「线上」挂到老师名后：「评审(...)：…，高渊(线上)，…」
            let dt = RichText.getDisplayTypeName(schedule);
            dt = dt.replace(/[（(]线上[）)]/g, '');
            dt = dt.replace(/记录$/, '');
            return dt.trim();
        },

        getColorType(displayType) {
            return TypeConversion.getColorKind(displayType);
        },

        isMergeable(displayType) {
            const base = displayType.replace(/[（(]线上[）)]/, '');
            return base === '评审' || base === '咨询';
        },

        /**
         * 生成课程文本（计划和实际）
         * 计划列 = 类别位 normal 的课（cancelled/modified_away 以 dim 渲染）
         * 实际列 = status ∉ {cancelled, deleted, modified_away} 的课
         * 合并键 = (归一化显示类型, 时段, 地点, 学生) —— **所有类型**同键的教师都并成一段
         * （旧实现只对评审/咨询合并、其余类型只渲染组内第一个老师，导致同日多师
         *  的入户/大评审在 Excel 里只剩一个名字，视图却是全名单 —— 两边永远对不齐）
         */
        generateCourseText(schedules, isSingleStudent) {
            // 全序排序：仅按 TYPE_PRIORITY 时，同基类不同显示名（评审 vs (线上)评审）
            // 打平后依赖输入行序 —— 后端 SQL 与前端接口的行序不同，段序就漂移。
            // 追加 基类名→是否线上→显示名→type_id 逐级 tie-break，两边必然同序。
            const ranked = [...schedules].map(s => {
                const base = RichText.getBaseTypeName(typeKey(s));
                return {
                    s,
                    p: TYPE_PRIORITY[base] || 999,
                    base,
                    dt: RichText.getFoldedDisplayType(s),
                    id: Number(s.type_id != null ? s.type_id : (s.id != null ? s.id : 0))
                };
            });
            ranked.sort((a, b) =>
                a.p - b.p
                || String(a.base).localeCompare(String(b.base))
                || (a.dt.includes('线上') ? 1 : 0) - (b.dt.includes('线上') ? 1 : 0)
                || String(a.dt).localeCompare(String(b.dt))
                || String(a.s.location || '').localeCompare(String(b.s.location || ''))
                || a.id - b.id
            );
            const sorted = ranked.map(r => r.s);

            const items = sorted.map(s => {
                const dt = RichText.getFoldedDisplayType(s);
                const isRecord = RichText.isRecordType(s);
                const isOnline = RichText.normalizeOnlineParens(typeLabel(s)).includes('(线上)');
                const category = statusCategory(s);
                const marker = category === 'temp' ? '+'
                    : (category === 'adjusted' || s.status === 'modified_away') ? '~'
                        : '';
                const isCancelledOrMoved = s.status === 'cancelled' || s.status === '已取消' ||
                    s.status === 'modified_away' || s.status === '已调整' ||
                    s.status === 0 || s.status === 2;
                return { s, dt, isRecord, isOnline, marker, category, isCancelledOrMoved };
            });

            const planItems = items.filter(it => it.category === 'normal');
            const actualItems = items.filter(it => !it.isCancelledOrMoved);

            const planSegments = [];
            const actualSegments = [];
            let hasColoredCourse = false;

            for (const [key, group] of RichText._groupByMergeKey(planItems)) {
                const [dt, ts] = key.split('|');
                const colorType = RichText.getColorType(dt);
                if (colorType !== 'black') hasColoredCourse = true;
                const runs = [];

                const label = RichText._segmentLabel(group, dt);
                const onlineInName = label === dt;

                if (group.length > 1) {
                    const all = RichText._orderGroupTeachers(group);
                    const sn = all[0].s.student_name;
                    const prefixText = isSingleStudent
                        ? `${label}(${ts})：`
                        : `[${sn}]${label}(${ts})：`;
                    runs.push({
                        text: prefixText, colorType,
                        dim: all[0].isCancelledOrMoved,
                        isSuperscript: false, startsLine: false
                    });
                    all.forEach((it, i) => {
                        runs.push({
                            text: RichText._teacherDisp(it, onlineInName) + (i < all.length - 1 ? '，' : ''),
                            colorType,
                            dim: it.isCancelledOrMoved,
                            isSuperscript: false, startsLine: false
                        });
                    });
                } else {
                    const it = group[0];
                    const text = isSingleStudent
                        ? `${label}(${ts})：${RichText._teacherDisp(it, onlineInName)}`
                        : `[${it.s.student_name || ''}]${label}(${ts})：${RichText._teacherDisp(it, onlineInName)}`;
                    runs.push({
                        text, colorType,
                        dim: it.isCancelledOrMoved,
                        isSuperscript: false, startsLine: false
                    });
                }

                planSegments.push(RichText._makeSegment(group, ts, runs));
            }

            for (const [key, group] of RichText._groupByMergeKey(actualItems)) {
                const [dt, ts] = key.split('|');
                const colorType = RichText.getColorType(dt);
                if (colorType !== 'black') hasColoredCourse = true;
                const runs = [];
                const label = RichText._segmentLabel(group, dt);
                const onlineInName = label === dt;

                if (group.length > 1) {
                    const all = RichText._orderGroupTeachers(group, true);
                    const { courseMarker, teacherMarkers } = ScheduleMarkerPolicy.resolve(
                        all.map(it => it.marker)
                    );

                    const studentPrefix = isSingleStudent ? '' : `[${all[0].s.student_name}]`;
                    if (studentPrefix) {
                        runs.push({ text: studentPrefix, colorType, dim: false, isSuperscript: false, startsLine: false });
                    }
                    if (courseMarker) {
                        runs.push({ text: courseMarker, colorType, dim: false, isSuperscript: true, startsLine: false });
                    }
                    runs.push({ text: `${label}(${ts})：`, colorType, dim: false, isSuperscript: false, startsLine: false });

                    all.forEach((it, i) => {
                        if (teacherMarkers[i]) {
                            runs.push({ text: teacherMarkers[i], colorType, dim: false, isSuperscript: true, startsLine: false });
                        }
                        runs.push({
                            text: RichText._teacherDisp(it, onlineInName) + (i < all.length - 1 ? '，' : ''),
                            colorType,
                            dim: false,
                            isSuperscript: false, startsLine: false
                        });
                    });
                } else {
                    const it = group[0];
                    const studentPrefix = isSingleStudent ? '' : `[${it.s.student_name || ''}]`;
                    const { courseMarker } = ScheduleMarkerPolicy.resolve([it.marker]);

                    if (studentPrefix) {
                        runs.push({ text: studentPrefix, colorType, dim: false, isSuperscript: false, startsLine: false });
                    }
                    if (courseMarker) {
                        runs.push({ text: courseMarker, colorType, dim: false, isSuperscript: true, startsLine: false });
                    }
                    runs.push({
                        text: `${label}(${ts})：${RichText._teacherDisp(it, onlineInName)}`,
                        colorType,
                        dim: false,
                        isSuperscript: false, startsLine: false
                    });
                }

                actualSegments.push(RichText._makeSegment(group, ts, runs));
            }

            const rows = RichText._assembleRows(planSegments, actualSegments, isSingleStudent);

            return {
                planParts: rows.reduce((acc, r) => acc.concat(r.planParts), []),
                actualParts: rows.reduce((acc, r) => acc.concat(r.actualParts), []),
                rows,
                hasColoredCourse
            };
        },

        // 段标签：组内老师**全部线上** → 类型前缀式「（线上）评审」；
        // 线上线下混合 → 基类标签 + 老师名后缀式「评审(...)：…，高渊(线上)」（0829 图2 裁定）
        _segmentLabel(group, dt) {
            return group.every(it => it.isOnline) ? `（线上）${dt}` : dt;
        },

        // 老师展示名：混合组里线上老师挂名字后缀；全线上组后缀让位于段标签，名字保持干净
        _teacherDisp(it, onlineInName = true) {
            const name = it.s.teacher_name || '';
            return name + (onlineInName && it.isOnline ? '(线上)' : '') + (it.isRecord ? '（记录）' : '');
        },

        _groupByMergeKey(items) {
            const groups = new Map();
            for (const it of items) {
                const ts = RichText._timeSlot(it.s);
                const loc = String(it.s.location || '').trim();
                const sid = it.s.student_id != null ? it.s.student_id : (it.s.student_name || '');
                const key = `${it.dt}|${ts}|${loc}|${sid}`;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(it);
            }
            return groups;
        },

        _orderGroupTeachers(group, dedupe = false) {
            const byTeacherId = (a, b) => (a.s.teacher_id || 0) - (b.s.teacher_id || 0);
            const all = [
                ...group.filter(it => !it.isRecord).sort(byTeacherId),
                ...group.filter(it => it.isRecord).sort(byTeacherId)
            ];
            if (!dedupe) return all;

            const identityOf = it => [
                it.s.teacher_id || '',
                it.s.teacher_name || '',
                it.isRecord,
                it.marker
            ].join('|');
            const seen = new Set();
            return all.filter(it => {
                const id = identityOf(it);
                if (seen.has(id)) return false;
                seen.add(id);
                return true;
            });
        },

        _makeSegment(group, ts, runs) {
            const first = group[0].s;
            return {
                runs,
                ts,
                typeKey: group[0].dt,
                // 配对标记：计划段整段「已调整挪走」/ 实际段整段「调整增补」，
                // 用于把同一节课调整前后的两列内容并回同一行（见 _assembleRows）
                allMovedAway: group.every(it =>
                    it.s.status === 'modified_away' || it.s.status === '已调整'),
                allAdjusted: group.every(it => it.category === 'adjusted'),
                timeSortKey: RichText._timeSortKey(ts),
                studentKey: first.student_id != null
                    ? String(first.student_id)
                    : String(first.student_name || ''),
                studentName: first.student_name || ''
            };
        },

        /**
         * 把段归并为逻辑行：**逻辑行 = (折叠类型, 时段)**，多学生模式再按学生拆分。
         * 同一节课调整前后（计划整段 modified_away ↔ 实际整段 adjusted）通过配对
         * 并到同一行两列 —— 时段不同也能对上；而**同日两节独立的同类型课**（各自
         * 时段都有计划/实际）保持一行一节，不再被并进同一单元格（0905 图1 裁定）。
         * @param {Array} planSegments - 计划列的段
         * @param {Array} actualSegments - 实际列的段
         * @param {boolean} isSingleStudent - 是否为单学生模式
         * @returns {Array<Object>} [{ rowKey, planParts, actualParts }]，按行内最早时段从早到晚
         */
        _assembleRows(planSegments, actualSegments, isSingleStudent) {
            const rows = new Map();
            const keyOf = (seg) => isSingleStudent
                ? `${seg.typeKey}|${seg.ts}`
                : `${seg.studentKey}|${seg.typeKey}|${seg.ts}`;
            const rowOf = (seg) => {
                const rowKey = keyOf(seg);
                if (!rows.has(rowKey)) {
                    rows.set(rowKey, {
                        rowKey,
                        typeKey: seg.typeKey,
                        studentKey: seg.studentKey,
                        studentName: seg.studentName,
                        timeSortKey: seg.timeSortKey,
                        planSegs: [],
                        actualSegs: []
                    });
                }
                return rows.get(rowKey);
            };

            planSegments.forEach(seg => rowOf(seg).planSegs.push(seg));
            actualSegments.forEach(seg => rowOf(seg).actualSegs.push(seg));

            // 配对：计划整段被挪走、且本行没有同时段的实际内容 →
            // 找同 (学生, 类型) 的纯实际行（整段 adjusted、无计划内容），按时段就近并入
            const planRows = [...rows.values()].filter(
                r => r.planSegs.length > 0 &&
                     r.planSegs.every(s => s.allMovedAway) &&
                     r.actualSegs.length === 0);
            const used = new Set();
            for (const pr of planRows.sort((a, b) => a.timeSortKey - b.timeSortKey)) {
                const candidates = [...rows.values()].filter(r =>
                    !used.has(r) && r !== pr &&
                    r.planSegs.length === 0 &&
                    r.actualSegs.length > 0 &&
                    r.actualSegs.every(s => s.allAdjusted) &&
                    r.typeKey === pr.typeKey &&
                    r.studentKey === pr.studentKey);
                if (candidates.length === 0) continue;
                candidates.sort((a, b) =>
                    Math.abs(a.timeSortKey - pr.timeSortKey) - Math.abs(b.timeSortKey - pr.timeSortKey) ||
                    a.timeSortKey - b.timeSortKey);
                const donor = candidates[0];
                used.add(donor);
                pr.actualSegs = donor.actualSegs;
                pr.timeSortKey = Math.min(pr.timeSortKey, donor.timeSortKey);
                rows.delete(donor.rowKey);
            }

            const segAsc = (a, b) =>
                (a.timeSortKey - b.timeSortKey) || String(a.ts).localeCompare(String(b.ts));

            return [...rows.values()]
                .sort((a, b) => (a.timeSortKey - b.timeSortKey) ||
                    String(a.studentName).localeCompare(String(b.studentName)) ||
                    String(a.rowKey).localeCompare(String(b.rowKey)))
                .map(r => {
                    const row = { rowKey: r.rowKey, planParts: [], actualParts: [] };
                    r.planSegs.sort(segAsc).forEach(
                        seg => RichText._appendSegment(row.planParts, seg.runs));
                    r.actualSegs.sort(segAsc).forEach(
                        seg => RichText._appendSegment(row.actualParts, seg.runs));
                    return row;
                });
        },

        _appendSegment(target, runs) {
            if (!runs || runs.length === 0) return;
            const isRowStart = target.length === 0;

            if (!isRowStart) {
                const prev = target[target.length - 1];
                target.push({
                    text: ROW_SEGMENT_SEPARATOR,
                    colorType: prev.colorType,
                    dim: prev.dim,
                    isSuperscript: false,
                    startsLine: false
                });
            }

            runs.forEach((run, i) => {
                target.push(Object.assign({}, run, { startsLine: isRowStart && i === 0 }));
            });
        },

        textPartsToPlainText(parts) {
            if (!parts || parts.length === 0) return '';
            let result = '';
            parts.forEach((p, i) => {
                if (i === 0) {
                    result += p.text;
                } else if (p.startsLine) {
                    result += '\n' + p.text;
                } else {
                    result += p.text;
                }
            });
            return result;
        },

        _timeSlot(schedule) {
            const s = String(schedule.start_time || '').substring(0, 5);
            const e = String(schedule.end_time || '').substring(0, 5);
            return `${s}-${e}`;
        },

        _timeSortKey(timeSlot) {
            const [startPart, endPart] = String(timeSlot || '').split('-');
            const [sH, sM] = String(startPart || '').split(':').map(Number);
            const [eH, eM] = String(endPart || '').split(':').map(Number);
            const key = (sH * 60 + sM) * 10000 + (eH * 60 + eM);
            return Number.isFinite(key) ? key : Number.MAX_SAFE_INTEGER;
        }
    };

    // ── 费用聚合 ──

    function calculateFees(rawData, dates, isSingleStudent) {
        const dailyFees = new Map();
        const weeklyFees = new Map();
        const weeklyReimburse = new Map();

        const feesByDateStudent = new Map();
        const dayFlags = new Map();
        const weekFlags = new Map();
        const countedTrips = new Set();

        const ensureFeeData = (dateStr, studentId, studentName) => {
            const key = `${dateStr}_${studentId}`;
            if (!feesByDateStudent.has(key)) {
                feesByDateStudent.set(key, {
                    date: dateStr,
                    studentId,
                    studentName,
                    teacherFees: new Map(),
                    teacherOtherFees: new Map(),
                    teacherIds: new Map(),
                    teacherNames: new Set(),
                    totalTransport: 0,
                    totalOther: 0
                });
            }
            return feesByDateStudent.get(key);
        };

        rawData.forEach(row => {
            const dateStr = rowDateKey(row);
            if (!dateStr) return;

            if (!dayFlags.has(dateStr)) {
                dayFlags.set(dateStr, { anyUnsubmitted: false, hasSubmitted: false, allReimbursed: true, total: 0 });
            }
            const feeStatus = String(row.fee_status || '').toLowerCase();
            const isDraftFee = feeStatus === 'draft';
            if (isDraftFee) dayFlags.get(dateStr).anyUnsubmitted = true;
            else dayFlags.get(dateStr).hasSubmitted = true;
            if (feeStatus !== 'reimbursed') dayFlags.get(dateStr).allReimbursed = false;

            const rowWeekNum = getISOWeek(new Date(dateStr));
            if (!weekFlags.has(rowWeekNum)) {
                weekFlags.set(rowWeekNum, { anyRow: false, allReimbursed: true });
            }
            const weekFlag = weekFlags.get(rowWeekNum);
            weekFlag.anyRow = true;
            if (feeStatus !== 'reimbursed') weekFlag.allReimbursed = false;

            const studentId = row.student_id;
            const studentName = row.student_name || '未知';
            const teacherName = row.teacher_name || '未知';

            const feeData = ensureFeeData(dateStr, studentId, studentName);
            feeData.teacherNames.add(teacherName);
            const tid = Number(row.teacher_id) || 0;
            if (!feeData.teacherIds.has(teacherName) || feeData.teacherIds.get(teacherName) > tid) {
                feeData.teacherIds.set(teacherName, tid);
            }

            const isPerStudent = String(row.fee_scope || 'pair') === 'student';
            // 场次粒度：服务端导出行没有 id，session_id 被 SQL 改名成 schedule_id；
            // 视图行用 id。少一档回落就只能到日期，同日同师第二场会被当成同一趟吞掉。
            const tripKey = `${row.session_id ?? row.schedule_id ?? row.id ?? dateStr}`
                + `|${row.teacher_uid ?? row.teacher_id ?? teacherName}`
                + (isPerStudent ? `|${row.student_uid ?? row.student_id ?? studentName}` : '');
            const counted = countedTrips.has(tripKey);
            countedTrips.add(tripKey);

            const transportFee = parseFloat(row.transport_fee) || 0;
            const otherFee = parseFloat(row.other_fee) || 0;

            if (!isDraftFee) {
                if (transportFee > 0) {
                    feeData.teacherFees.set(
                        teacherName, (feeData.teacherFees.get(teacherName) || 0) + transportFee
                    );
                }
                if (otherFee > 0) {
                    feeData.teacherOtherFees.set(
                        teacherName, (feeData.teacherOtherFees.get(teacherName) || 0) + otherFee
                    );
                }
                feeData.totalTransport += transportFee;
                feeData.totalOther += otherFee;

                if (!counted) {
                    dayFlags.get(dateStr).total += transportFee + otherFee;
                }
            }
        });

        const feesByDate = new Map();
        const feesByWeek = new Map();
        for (const f of feesByDateStudent.values()) {
            if (!feesByDate.has(f.date)) feesByDate.set(f.date, []);
            feesByDate.get(f.date).push(f);

            const fDate = new Date(f.date);
            const weekNum = getISOWeek(fDate);
            if (!feesByWeek.has(weekNum)) feesByWeek.set(weekNum, []);
            feesByWeek.get(weekNum).push(f);
        }
        // 明细展示顺序：学生按 student_id 升序（行到达顺序两边不同，排序后才可复现）
        const studentAsc = (a, b) =>
            ((Number(a.studentId) || 0) - (Number(b.studentId) || 0)) ||
            String(a.studentName).localeCompare(String(b.studentName));
        feesByDate.forEach(list => list.sort(studentAsc));
        feesByWeek.forEach(list => list.sort(studentAsc));

        dates.forEach(dateStr => {
            const dayFlag = dayFlags.get(dateStr);

            if (!dayFlag) {
                dailyFees.set(dateStr, '/');
                return;
            }

            if (dayFlag.anyUnsubmitted && !dayFlag.hasSubmitted) {
                dailyFees.set(dateStr, '-');
            } else if (dayFlag.total === 0) {
                dailyFees.set(dateStr, '0');
            } else {
                const buildParts = (f, showTeacherNames) => {
                    const parts = [];
                    const ordered = [...f.teacherFees.keys()].sort((a, b) =>
                        ((f.teacherIds.get(a) || 0) - (f.teacherIds.get(b) || 0)) ||
                        String(a).localeCompare(String(b))
                    );
                    ordered.forEach(teacher => {
                        const val = roundFee(f.teacherFees.get(teacher));
                        if (val > 0) {
                            parts.push(showTeacherNames ? `${teacher}${val}` : String(val));
                        }
                    });
                    const otherParts = [];
                    [...f.teacherOtherFees.keys()].sort((a, b) =>
                        ((f.teacherIds.get(a) || 0) - (f.teacherIds.get(b) || 0)) ||
                        String(a).localeCompare(String(b))
                    ).forEach(teacher => {
                        const val = roundFee(f.teacherOtherFees.get(teacher));
                        if (val > 0) otherParts.push(String(val));
                    });
                    if (otherParts.length > 0) parts.push(`其他费用${otherParts.join('+')}`);
                    return parts;
                };

                const studentFees = feesByDate.get(dateStr) || [];
                const lines = [];
                studentFees.forEach(f => {
                    const showTeacherNames = !isSingleStudent || f.teacherNames.size > 1;
                    const parts = buildParts(f, showTeacherNames);
                    if (parts.length > 0) {
                        lines.push(isSingleStudent ? parts.join('，') : `${f.studentName}：${parts.join('，')}`);
                    }
                });
                dailyFees.set(dateStr, lines.length > 0 ? lines.join('\n') : '0');
            }
        });

        dates.forEach(dateStr => {
            const dateObj = new Date(dateStr);
            const weekNumber = getISOWeek(dateObj);
            if (weeklyReimburse.has(weekNumber)) return;
            const weekFlag = weekFlags.get(weekNumber);
            if (!weekFlag || !weekFlag.anyRow) {
                weeklyReimburse.set(weekNumber, '-');
            } else {
                weeklyReimburse.set(weekNumber, weekFlag.allReimbursed ? '已报销' : '未报销');
            }
        });

        const processedWeeks = new Set();
        dates.forEach(dateStr => {
            const dateObj = new Date(dateStr);
            const weekNumber = getISOWeek(dateObj);

            if (processedWeeks.has(weekNumber)) return;
            processedWeeks.add(weekNumber);

            const studentFees = feesByWeek.get(weekNumber) || [];
            const weekFlag = weekFlags.get(weekNumber);
            const zeroValue = weekFlag ? '0' : '/';

            if (isSingleStudent) {
                const weekTotal = studentFees.reduce(
                    (sum, f) => sum + f.totalTransport + f.totalOther, 0
                );
                weeklyFees.set(
                    weekNumber,
                    weekTotal > 0 ? String(roundFee(weekTotal)) : zeroValue
                );
            } else {
                const studentWeekTotals = new Map();
                studentFees.forEach(f => {
                    const current = studentWeekTotals.get(f.studentName) || { id: f.studentId, total: 0 };
                    studentWeekTotals.set(f.studentName, {
                        id: f.studentId,
                        total: current.total + f.totalTransport + f.totalOther
                    });
                });

                const lines = [];
                [...studentWeekTotals.entries()]
                    .sort((a, b) =>
                        ((Number(a[1].id) || 0) - (Number(b[1].id) || 0)) ||
                        String(a[0]).localeCompare(String(b[0]))
                    )
                    .forEach(([name, v]) => {
                        if (v.total > 0) {
                            lines.push(`${name}：${roundFee(v.total)}`);
                        }
                    });
                weeklyFees.set(weekNumber, lines.length > 0 ? lines.join('\n') : zeroValue);
            }
        });

        return { dailyFees, weeklyFees, weeklyReimburse };
    }

    // ── 行组装（Excel sheet1 / 视图表格 共用的最终形状）──

    function rowColorKindOf(parts) {
        let kind = 'black';
        (parts || []).forEach(p => {
            if (p.colorType === 'red') kind = 'red';
            else if (p.colorType === 'blue' && kind !== 'red') kind = 'blue';
        });
        return kind;
    }

    function generateCalendarRows(rawData, options) {
        const { startDate, endDate, studentId } = options || {};
        if (!startDate || !endDate) return [];

        const dates = generateDateRange(startDate, endDate);

        const groupedByDate = new Map();
        rawData.forEach(row => {
            const dateStr = rowDateKey(row);
            if (!dateStr) return;
            if (!groupedByDate.has(dateStr)) groupedByDate.set(dateStr, []);
            groupedByDate.get(dateStr).push(row);
        });

        const uniqueStudents = new Set(rawData.map(r => r.student_id).filter(Boolean));
        const isSingleStudent = uniqueStudents.size === 1 ||
            (!!studentId && String(studentId) !== 'all-std');

        const { dailyFees, weeklyFees, weeklyReimburse } = calculateFees(rawData, dates, isSingleStudent);

        const cellOrSlash = (map, key) => (map.has(key) ? map.get(key) : '/');

        const calendarData = [];
        dates.forEach(dateStr => {
            const dateObj = new Date(dateStr);
            const dayOfWeek = dateObj.getDay();
            const weekStr = WEEKDAYS[dayOfWeek];
            const isSunday = dayOfWeek === 0;
            const weekNumber = getISOWeek(dateObj);

            const daySchedules = groupedByDate.get(dateStr) || [];

            if (daySchedules.length > 0) {
                const { rows: scheduleRows } = RichText.generateCourseText(daySchedules, isSingleStudent);
                const rowCount = Math.max(scheduleRows.length, 1);

                for (let index = 0; index < rowCount; index++) {
                    const scheduleRow = scheduleRows[index] || {};
                    const planRowParts = scheduleRow.planParts || [];
                    const actualRowParts = scheduleRow.actualParts || [];

                    const planKind = rowColorKindOf(planRowParts);
                    const actualKind = rowColorKindOf(actualRowParts);
                    const rowKind = planKind === 'red' || actualKind === 'red' ? 'red'
                        : (planKind === 'blue' || actualKind === 'blue' ? 'blue' : 'black');

                    const row = {
                        '日期': dateStr,
                        '星期': weekStr,
                        '计划安排': '',
                        '实际安排': '',
                        '费用': index === 0 ? cellOrSlash(dailyFees, dateStr) : '',
                        '周汇总': index === 0 ? cellOrSlash(weeklyFees, weekNumber) : '',
                        '报销状态': '',

                        '_weekNumber': weekNumber,
                        '_isSunday': isSunday,
                        '_isRedRow': rowKind === 'red',
                        '_rowColorKind': rowKind,
                        '_planColorKind': planKind,
                        '_actualColorKind': actualKind,
                        '_planIsRed': planKind === 'red',
                        '_actualIsRed': actualKind === 'red',
                        '_planIsCancelledGrey': false,
                        '_planIsModifiedAwayGrey': false,
                        '_actualIsCancelledGrey': false,
                        '_actualIsModifiedAwayGrey': false,
                        '_isModifiedDate': actualRowParts.some(p => p.isSuperscript && p.text === '~'),
                        '_isSubRowOfMixed': false,
                        '_planTextParts': planRowParts,
                        '_actualTextParts': actualRowParts
                    };

                    const planText = RichText.textPartsToPlainText(planRowParts);
                    const actualText = RichText.textPartsToPlainText(actualRowParts);
                    row['计划安排'] = planText || '/';
                    row['实际安排'] = actualText || '/';

                    calendarData.push(row);
                }
            } else {
                calendarData.push({
                    '日期': dateStr,
                    '星期': weekStr,
                    '计划安排': '',
                    '实际安排': '',
                    '费用': '/',
                    '周汇总': cellOrSlash(weeklyFees, weekNumber),
                    '报销状态': '',
                    '_weekNumber': weekNumber,
                    '_isSunday': isSunday,
                    '_isRedRow': false,
                    '_rowColorKind': 'black',
                    '_planColorKind': 'black',
                    '_actualColorKind': 'black',
                    '_planIsRed': false,
                    '_actualIsRed': false,
                    '_planIsCancelledGrey': false,
                    '_planIsModifiedAwayGrey': false,
                    '_actualIsCancelledGrey': false,
                    '_actualIsModifiedAwayGrey': false,
                    '_isModifiedDate': false,
                    '_isSubRowOfMixed': false,
                    '_planTextParts': [],
                    '_actualTextParts': []
                });
            }
        });

        // 报销状态只写在每周最后一行（Excel 用；视图不渲染该列）
        const lastRowIndexByWeek = new Map();
        calendarData.forEach((row, idx) => {
            lastRowIndexByWeek.set(row._weekNumber, idx);
        });
        lastRowIndexByWeek.forEach((idx, weekNumber) => {
            calendarData[idx]['报销状态'] = weeklyReimburse.get(weekNumber) || '-';
        });

        return calendarData;
    }

    return {
        TYPE_PRIORITY: TYPE_PRIORITY,
        TYPE_DISPLAY_MAP: TYPE_DISPLAY_MAP,
        ROW_SEGMENT_SEPARATOR: ROW_SEGMENT_SEPARATOR,
        WEEKDAYS: WEEKDAYS,
        formatLocaleDate: formatLocaleDate,
        generateDateRange: generateDateRange,
        getISOWeek: getISOWeek,
        calculateFees: calculateFees,
        generateCalendarRows: generateCalendarRows,
        RichText: RichText
    };
}));
