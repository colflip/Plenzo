/**
 * Rich Text 格式化器
 * 负责生成课程文本、处理颜色样式、状态标记等
 *
 * part 模型（每条 run 可独立着色，同一行可多段不同颜色）：
 *   { text, colorType, dim, isSuperscript, startsLine }
 *   - startsLine: true → 渲染器在本 run 前插入换行（第一 run 跳过）
 */

const { TYPE_PRIORITY, TYPE_DISPLAY_MAP, RICH_TEXT_COLORS, ROW_SEGMENT_SEPARATOR } = require('./export-constants');
const ScheduleMarkerPolicy = require('../../../../public/js/utils/schedule-marker-policy');

class RichTextFormatter {
    /**
     * 获取类型的中文显示名
     * 优先使用 type_desc（数据库 description 字段），
     * 其次使用 TYPE_DISPLAY_MAP 映射，
     * 最后回退到原始名称
     * @param {Object} schedule - 课程记录
     * @returns {string} 中文显示名
     */
    static getDisplayTypeName(schedule) {
        let name;
        if (schedule.type_desc) {
            name = schedule.type_desc;
        } else {
            const rawName = schedule.type_name || '';
            name = TYPE_DISPLAY_MAP[rawName] || rawName;
        }
        // 统一“线上”前缀为半角括号
        return RichTextFormatter.normalizeOnlineParens(name);
    }

    /**
     * 将“（线上）”统一规格化为半角“(线上)”
     * @param {string} text
     * @returns {string}
     */
    static _halfWidthOnline(text) {
        return String(text || '').replace(/（线上）/g, '(线上)');
    }

    /**
     * 获取类型的基础中文名（用于分类匹配和排序）
     * "（线上）评审" → "评审"，"review" → "评审"，"咨询" → "咨询"
     * @param {string} typeName - 原始类型名
     * @returns {string} 基础中文名
     */
    static getBaseTypeName(typeName) {
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
    }

    /**
     * 判断是否为记录类课程（评审记录、咨询记录）
     * @param {Object} schedule
     * @returns {boolean}
     */
    static isRecordType(schedule) {
        const name = schedule.type_name || '';
        const desc = schedule.type_desc || '';
        return name.includes('record') || desc.includes('记录');
    }

    /**
     * 将"（线上）"前缀规格化为半角括号（统一输出为 (线上)）
     * @param {string} name
     * @returns {string}
     */
    static normalizeOnlineParens(name) {
        return String(name || '').replace(/（线上）/g, '(线上)');
    }

    /**
     * 获取归一化显示类型（用于分组键）
     * 保留"(线上)"前缀（半角），折叠"记录"后缀
     * 评审记录 → 评审, （线上）评审 → (线上)评审, 评审 → 评审
     */
    static getFoldedDisplayType(schedule) {
        let dt = RichTextFormatter.getDisplayTypeName(schedule);
        // 统一线上前缀为半角括号
        dt = RichTextFormatter.normalizeOnlineParens(dt);
        // 折叠"记录"后缀（但保留线上前缀）
        dt = dt.replace(/记录$/, '');
        return dt;
    }

    /**
     * 获取课程的颜色类型
     * @param {string} displayType - 显示类型名
     * @returns {'red'|'blue'|'black'} 颜色类型
     */
    static getColorType(displayType) {
        const base = displayType.replace(/[（(]线上[）)]/, '');
        if (base === '评审' || base === '咨询') return 'red';
        if (base === '集体活动') return 'blue';
        return 'black';
    }

    /**
     * 判断是否为需要合并的类型（评审/咨询）
     */
    static isMergeable(displayType) {
        const base = displayType.replace(/[（(]线上[）)]/, '');
        return base === '评审' || base === '咨询';
    }
    /**
     * 生成课程文本（计划和实际）
     *
     * 核心规则：
     *   计划列 = adj ∈ {0, null} 的课（含 cancelled/modified_away，dim 渲染）
     *   实际列 = status ∉ {cancelled, deleted, modified_away} 的课
     *   评审/咨询 合并键 = (归一化显示类型, 时段, 地点, 学生)，不含状态/标记
     *   单人标记放课程前；多人全员有标记时多数标记放课程前（并列时 ~ 优先），少数标记跟老师
     *   多人中存在无标记成员时，已有标记全部跟随对应老师
     *   逻辑行 = 时段（多学生模式下再按学生拆分）：同一时段的课程排在同一行，
     *            即使类型不同，段与段之间以 ROW_SEGMENT_SEPARATOR 分隔；
     *            计划列与实际列共用行键，因此同一时段在两列里落在同一物理行
     *
     * @param {Array} schedules - 课程列表（已剔除 deleted，保留 cancelled/modified_away）
     * @param {boolean} isSingleStudent - 是否为单学生模式
     * @returns {Object} { planParts, actualParts, rows, hasColoredCourse }
     *                   rows: [{ rowKey, planParts, actualParts }] —— 两列已按时段对齐的逻辑行
     */
    static generateCourseText(schedules, isSingleStudent) {
        // 按类型优先级排序（决定同一行内不同类型段的先后）
        const sorted = [...schedules].sort((a, b) => {
            const pA = TYPE_PRIORITY[RichTextFormatter.getBaseTypeName(a.type_name)] || 999;
            const pB = TYPE_PRIORITY[RichTextFormatter.getBaseTypeName(b.type_name)] || 999;
            return pA - pB;
        });

        // 为每条课程预计算关键字段
        const items = sorted.map(s => {
            const dt = RichTextFormatter.getFoldedDisplayType(s);
            const isRecord = RichTextFormatter.isRecordType(s);
            const marker = s.adjustment_type == 1 ? '+' : (s.adjustment_type == 2 ? '~' : '');
            const isCancelledOrMoved = s.status === 'cancelled' || s.status === '已取消' ||
                                        s.status === 'modified_away' || s.status === '已调整' ||
                                        s.status === 0 || s.status === 2;
            return { s, dt, isRecord, marker, isCancelledOrMoved };
        });

        // ── 计划列筛选：adj ∈ {0, null}（排除 adj=1 临时加课、adj=2 调整来的课）──
        const planItems = items.filter(it => it.marker === '');
        // ── 实际列筛选：排除 cancelled / modified_away ──
        const actualItems = items.filter(it => !it.isCancelledOrMoved);

        const planSegments = [];
        const actualSegments = [];
        let hasColoredCourse = false;

        // ── 计划列：合并键 = (归一化显示类型, 时段, 地点, 学生) ──
        for (const [key, group] of RichTextFormatter._groupByMergeKey(planItems)) {
            const [dt, ts] = key.split('|');
            const colorType = RichTextFormatter.getColorType(dt);
            if (colorType !== 'black') hasColoredCourse = true;
            const runs = [];

            if (group.length > 1 && RichTextFormatter.isMergeable(dt)) {
                // 合并段：段内不同老师可能不同颜色（dim/正常）
                const base = dt.replace(/[（(]线上[）)]/, '');
                const all = RichTextFormatter._orderGroupTeachers(group);

                // 前缀颜色跟首个老师走
                const sn = all[0].s.student_name;
                const prefixText = isSingleStudent
                    ? `${base}(${ts})：`
                    : `[${sn}]${base}(${ts})：`;
                runs.push({
                    text: prefixText,
                    colorType,
                    dim: all[0].isCancelledOrMoved,
                    isSuperscript: false,
                    startsLine: false
                });

                // 每位老师一个 run
                all.forEach((it, i) => {
                    const teacherText = it.isRecord
                        ? `${it.s.teacher_name || ''}（记录）`
                        : (it.s.teacher_name || '');
                    runs.push({
                        text: teacherText + (i < all.length - 1 ? '，' : ''),
                        colorType,
                        dim: it.isCancelledOrMoved,
                        isSuperscript: false,
                        startsLine: false
                    });
                });
            } else {
                // 单课程段（或非合并类型）
                const it = group[0];
                const dtDisp = it.isRecord
                    ? RichTextFormatter.getFoldedDisplayType(it.s)
                    : RichTextFormatter.getDisplayTypeName(it.s);
                const teacherDisp = it.isRecord
                    ? `${it.s.teacher_name || ''}（记录）`
                    : (it.s.teacher_name || '');
                const text = isSingleStudent
                    ? `${dtDisp}(${ts})：${teacherDisp}`
                    : `[${it.s.student_name || ''}]${dtDisp}(${ts})：${teacherDisp}`;
                runs.push({
                    text,
                    colorType,
                    dim: it.isCancelledOrMoved,
                    isSuperscript: false,
                    startsLine: false
                });
            }

            planSegments.push(RichTextFormatter._makeSegment(group, ts, runs));
        }

        // ── 实际列：合并键同上 ──
        // 方案甲：合并组内每位老师带自己的 +/~ 上标（标记跟老师走）
        for (const [key, group] of RichTextFormatter._groupByMergeKey(actualItems)) {
            const [dt, ts] = key.split('|');
            const colorType = RichTextFormatter.getColorType(dt);
            if (colorType !== 'black') hasColoredCourse = true;
            const runs = [];

            if (group.length > 1 && RichTextFormatter.isMergeable(dt)) {
                const all = RichTextFormatter._orderGroupTeachers(group, true);
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
                runs.push({ text: `${dt}(${ts})：`, colorType, dim: false, isSuperscript: false, startsLine: false });

                all.forEach((it, i) => {
                    if (teacherMarkers[i]) {
                        runs.push({ text: teacherMarkers[i], colorType, dim: false, isSuperscript: true, startsLine: false });
                    }
                    const teacherText = it.isRecord
                        ? `${it.s.teacher_name || ''}（记录）`
                        : (it.s.teacher_name || '');
                    runs.push({
                        text: teacherText + (i < all.length - 1 ? '，' : ''),
                        colorType,
                        dim: false,
                        isSuperscript: false,
                        startsLine: false
                    });
                });
            } else {
                const it = group[0];
                const dtDisp = it.isRecord
                    ? RichTextFormatter.getFoldedDisplayType(it.s)
                    : RichTextFormatter.getDisplayTypeName(it.s);
                const teacherDisp = it.isRecord
                    ? `${it.s.teacher_name || ''}（记录）`
                    : (it.s.teacher_name || '');
                const studentPrefix = isSingleStudent ? '' : `[${it.s.student_name || ''}]`;
                const { courseMarker } = ScheduleMarkerPolicy.resolve([it.marker]);

                if (studentPrefix) {
                    runs.push({ text: studentPrefix, colorType, dim: false, isSuperscript: false, startsLine: false });
                }
                if (courseMarker) {
                    runs.push({ text: courseMarker, colorType, dim: false, isSuperscript: true, startsLine: false });
                }
                runs.push({
                    text: `${dtDisp}(${ts})：${teacherDisp}`,
                    colorType,
                    dim: false,
                    isSuperscript: false,
                    startsLine: false
                });
            }

            actualSegments.push(RichTextFormatter._makeSegment(group, ts, runs));
        }

        const rows = RichTextFormatter._assembleRows(planSegments, actualSegments, isSingleStudent);

        return {
            planParts: rows.reduce((acc, r) => acc.concat(r.planParts), []),
            actualParts: rows.reduce((acc, r) => acc.concat(r.actualParts), []),
            rows,
            hasColoredCourse
        };
    }

    /**
     * 按合并键分组：(归一化显示类型, 时段, 地点, 学生)
     * 同一组内的老师会被并入同一段（评审/咨询）
     * @param {Array} items - 预计算过关键字段的课程项
     * @returns {Map<string, Array>} 合并键 → 课程项数组（插入序 = 类型优先级序）
     */
    static _groupByMergeKey(items) {
        const groups = new Map();
        for (const it of items) {
            const ts = RichTextFormatter._timeSlot(it.s);
            const loc = String(it.s.location || '').trim();
            const sid = it.s.student_id != null ? it.s.student_id : (it.s.student_name || '');
            const key = `${it.dt}|${ts}|${loc}|${sid}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(it);
        }
        return groups;
    }

    /**
     * 合并组内老师排序：常规课按 teacher_id，记录类排在后面
     * @param {Array} group - 同一合并键下的课程项
     * @param {boolean} dedupe - 是否按 (教师, 记录类, 标记) 去重（实际列用）
     * @returns {Array} 排序后的课程项
     */
    static _orderGroupTeachers(group, dedupe = false) {
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
    }

    /**
     * 将一个合并组的 runs 包装为“段”，附带归行/排序所需的元信息
     * @param {Array} group - 同一合并键下的课程项
     * @param {string} ts - 时段（HH:mm-HH:mm）
     * @param {Array} runs - 该段的文本片段
     * @returns {Object} 段对象
     */
    static _makeSegment(group, ts, runs) {
        const first = group[0].s;
        return {
            runs,
            ts,
            timeSortKey: RichTextFormatter._timeSortKey(ts),
            studentKey: first.student_id != null
                ? String(first.student_id)
                : String(first.student_name || ''),
            studentName: first.student_name || ''
        };
    }

    /**
     * 把段按时段归并为逻辑行：同一时段的课程同行显示，即使类型不同
     * 多学生模式下再按学生拆分，避免一行内塞进全部学生
     * @param {Array} planSegments - 计划列的段
     * @param {Array} actualSegments - 实际列的段
     * @param {boolean} isSingleStudent - 是否为单学生模式
     * @returns {Array<Object>} [{ rowKey, planParts, actualParts }]，按时段从早到晚
     */
    static _assembleRows(planSegments, actualSegments, isSingleStudent) {
        const rows = new Map();
        const rowOf = (seg) => {
            const rowKey = isSingleStudent ? seg.ts : `${seg.studentKey}|${seg.ts}`;
            if (!rows.has(rowKey)) {
                rows.set(rowKey, {
                    rowKey,
                    timeSortKey: seg.timeSortKey,
                    studentName: seg.studentName,
                    planParts: [],
                    actualParts: []
                });
            }
            return rows.get(rowKey);
        };

        planSegments.forEach(seg => RichTextFormatter._appendSegment(rowOf(seg).planParts, seg.runs));
        actualSegments.forEach(seg => RichTextFormatter._appendSegment(rowOf(seg).actualParts, seg.runs));

        return [...rows.values()]
            .sort((a, b) => (a.timeSortKey - b.timeSortKey) ||
                String(a.studentName).localeCompare(String(b.studentName)))
            .map(r => ({ rowKey: r.rowKey, planParts: r.planParts, actualParts: r.actualParts }));
    }

    /**
     * 把一个段追加进逻辑行：非首段前插入分隔符，仅行首 run 标记 startsLine
     * 分隔符沿用前一 run 的颜色/dim，避免整行全 dim 时插入一个突兀的黑色分号
     * @param {Array} target - 该逻辑行已累积的 runs（原地追加）
     * @param {Array} runs - 待追加段的 runs
     */
    static _appendSegment(target, runs) {
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
    }

    /**
     * 将 textParts 转换为纯文本（按 startsLine 分行）
     * @param {Array} parts - 文本片段数组
     * @returns {string} 纯文本字符串
     */
    static textPartsToPlainText(parts) {
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
    }

    /**
     * 获取文本片段的颜色（优先读 dim，向下兼容 isCancelled/isAdjusted）
     * @param {Object} part - 文本片段
     * @returns {string} 颜色代码
     */
    static getTextColor(part) {
        const isDim = part.dim || part.isCancelled || part.isAdjusted;
        switch (part.colorType) {
            case 'red':
                return isDim ? RICH_TEXT_COLORS.RED_LIGHT : RICH_TEXT_COLORS.RED;
            case 'blue':
                return isDim ? RICH_TEXT_COLORS.BLUE_LIGHT : RICH_TEXT_COLORS.BLUE;
            default:
                return isDim ? RICH_TEXT_COLORS.BLACK_LIGHT : RICH_TEXT_COLORS.BLACK;
        }
    }

    // ── 私有工具 ──

    static _timeSlot(schedule) {
        const s = String(schedule.start_time || '').substring(0, 5);
        const e = String(schedule.end_time || '').substring(0, 5);
        return `${s}-${e}`;
    }

    static _timeSortKey(timeSlot) {
        const [startPart, endPart] = String(timeSlot || '').split('-');
        const [sH, sM] = String(startPart || '').split(':').map(Number);
        const [eH, eM] = String(endPart || '').split(':').map(Number);
        const key = (sH * 60 + sM) * 10000 + (eH * 60 + eM);
        // 无时间信息的记录排到最后：行序依赖该键，NaN 会让排序结果不确定
        return Number.isFinite(key) ? key : Number.MAX_SAFE_INTEGER;
    }
}

module.exports = RichTextFormatter;
