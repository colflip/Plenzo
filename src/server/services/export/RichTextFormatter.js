/**
 * Rich Text 格式化器
 * 负责生成课程文本、处理颜色样式、状态标记等
 *
 * part 模型（每条 run 可独立着色，同一行可多段不同颜色）：
 *   { text, colorType, dim, isSuperscript, startsLine }
 *   - startsLine: true → 渲染器在本 run 前插入换行（第一 run 跳过）
 */

const { TYPE_PRIORITY, TYPE_DISPLAY_MAP, RICH_TEXT_COLORS } = require('./ExportConstants');

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
        if (schedule.type_desc) {
            return schedule.type_desc;
        }
        const rawName = schedule.type_name || '';
        return TYPE_DISPLAY_MAP[rawName] || rawName;
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
     * 获取归一化显示类型（用于分组键）
     * 保留"（线上）"前缀，折叠"记录"后缀；全角化括号
     * 评审记录 → 评审, (线上)评审 → （线上）评审, 评审 → 评审
     */
    static getFoldedDisplayType(schedule) {
        let dt = RichTextFormatter.getDisplayTypeName(schedule);
        // 全角化半角括号
        dt = dt.replace(/\(/g, '（').replace(/\)/g, '）');
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
     *   评审/咨询 合并键 = (归一化显示类型, 标记, 时段, 地点)，按老师各自 dim
     *
     * @param {Array} schedules - 课程列表（已剔除 deleted，保留 cancelled/modified_away）
     * @param {boolean} isSingleStudent - 是否为单学生模式
     * @returns {Object} { planParts, actualParts, hasColoredCourse }
     */
    static generateCourseText(schedules, isSingleStudent) {
        // 按类型优先级排序
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

        const planLines = [];
        const actualLines = [];
        let hasColoredCourse = false;

        // ── 计划列：合并键 = (归一化显示类型, 标记, 时段, 地点) ──
        const planGroups = new Map();
        for (const it of planItems) {
            const ts = RichTextFormatter._timeSlot(it.s);
            const loc = String(it.s.location || '').trim();
            const key = `${it.dt}|${it.marker}|${ts}|${loc}`;
            if (!planGroups.has(key)) planGroups.set(key, []);
            planGroups.get(key).push(it);
        }
        for (const [key, group] of planGroups) {
            const [dt, , ts] = key.split('|');
            const colorType = RichTextFormatter.getColorType(dt);
            if (colorType !== 'black') hasColoredCourse = true;
            const timeSortKey = RichTextFormatter._timeSortKey(ts);

            if (group.length > 1 && RichTextFormatter.isMergeable(dt)) {
                // 合并行：行内不同老师可能不同颜色（dim/正常）
                const base = dt.replace(/[（(]线上[）)]/, '');
                const regular = group.filter(it => !it.isRecord)
                    .sort((a, b) => (a.s.teacher_id || 0) - (b.s.teacher_id || 0));
                const records = group.filter(it => it.isRecord)
                    .sort((a, b) => (a.s.teacher_id || 0) - (b.s.teacher_id || 0));
                const all = [...regular, ...records];

                // 前缀：前缀颜色跟首个老师走
                const firstDim = all[0].isCancelledOrMoved;
                const sn = all[0].s.student_name;
                const prefixText = isSingleStudent
                    ? `${base}(${ts})：`
                    : `[${sn}]${base}(${ts})：`;
                const prefixRun = { text: prefixText, colorType, dim: firstDim, isSuperscript: false, startsLine: true };
                planLines.push([prefixRun, timeSortKey]);

                // 每位老师一个 run
                for (let i = 0; i < all.length; i++) {
                    const it = all[i];
                    const teacherText = it.isRecord
                        ? `${it.s.teacher_name || ''}（记录）`
                        : (it.s.teacher_name || '');
                    if (i < all.length - 1) {
                        planLines.push([{ text: teacherText + '，', colorType, dim: it.isCancelledOrMoved, isSuperscript: false, startsLine: false }, timeSortKey]);
                    } else {
                        planLines.push([{ text: teacherText, colorType, dim: it.isCancelledOrMoved, isSuperscript: false, startsLine: false }, timeSortKey]);
                    }
                }
            } else {
                // 单课程行（或非合并类型）
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
                planLines.push([{
                    text,
                    colorType,
                    dim: it.isCancelledOrMoved,
                    isSuperscript: false,
                    startsLine: true
                }, timeSortKey]);
            }
        }

        // ── 实际列：合并键 = (归一化显示类型, 标记, 时段, 地点) ──
        const actualGroups = new Map();
        for (const it of actualItems) {
            const ts = RichTextFormatter._timeSlot(it.s);
            const loc = String(it.s.location || '').trim();
            const key = `${it.dt}|${it.marker}|${ts}|${loc}`;
            if (!actualGroups.has(key)) actualGroups.set(key, []);
            actualGroups.get(key).push(it);
        }
        for (const [key, group] of actualGroups) {
            const [dt, marker, ts] = key.split('|');
            const colorType = RichTextFormatter.getColorType(dt);
            if (colorType !== 'black') hasColoredCourse = true;
            const timeSortKey = RichTextFormatter._timeSortKey(ts);

            // 标记（~/+）为上标，startsLine=true 开新行
            if (marker) {
                actualLines.push([{
                    text: marker,
                    colorType,
                    dim: false,
                    isSuperscript: true,
                    startsLine: true
                }, timeSortKey]);
            }

            if (group.length > 1 && RichTextFormatter.isMergeable(dt)) {
                const base = dt.replace(/[（(]线上[）)]/, '');
                const regular = group.filter(it => !it.isRecord)
                    .sort((a, b) => (a.s.teacher_id || 0) - (b.s.teacher_id || 0));
                const records = group.filter(it => it.isRecord)
                    .sort((a, b) => (a.s.teacher_id || 0) - (b.s.teacher_id || 0));
                const all = [...regular, ...records];

                const sn = all[0].s.student_name;
                const prefixText = isSingleStudent
                    ? `${dt}(${ts})：`
                    : `[${sn}]${dt}(${ts})：`;
                actualLines.push([{ text: prefixText, colorType, dim: false, isSuperscript: false, startsLine: !marker }, timeSortKey]);

                for (let i = 0; i < all.length; i++) {
                    const it = all[i];
                    const teacherText = it.isRecord
                        ? `${it.s.teacher_name || ''}（记录）`
                        : (it.s.teacher_name || '');
                    if (i < all.length - 1) {
                        actualLines.push([{ text: teacherText + '，', colorType, dim: false, isSuperscript: false, startsLine: false }, timeSortKey]);
                    } else {
                        actualLines.push([{ text: teacherText, colorType, dim: false, isSuperscript: false, startsLine: false }, timeSortKey]);
                    }
                }
            } else {
                const it = group[0];
                const dtDisp = it.isRecord
                    ? RichTextFormatter.getFoldedDisplayType(it.s)  // "评审记录" → "评审"
                    : RichTextFormatter.getDisplayTypeName(it.s);
                const teacherDisp = it.isRecord
                    ? `${it.s.teacher_name || ''}（记录）`
                    : (it.s.teacher_name || '');
                const text = isSingleStudent
                    ? `${dtDisp}(${ts})：${teacherDisp}`
                    : `[${it.s.student_name || ''}]${dtDisp}(${ts})：${teacherDisp}`;
                actualLines.push([{
                    text,
                    colorType,
                    dim: false,
                    isSuperscript: false,
                    startsLine: !marker
                }, timeSortKey]);
            }
        }

        // 各列按时间从早到晚独立排序
        planLines.sort((a, b) => a[1] - b[1]);
        actualLines.sort((a, b) => a[1] - b[1]);

        return {
            planParts: planLines.map(e => e[0]),
            actualParts: actualLines.map(e => e[0]),
            hasColoredCourse
        };
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
        const [sH, sM] = timeSlot.split('-')[0].split(':').map(Number);
        const [eH, eM] = timeSlot.split('-')[1].split(':').map(Number);
        return (sH * 60 + sM) * 10000 + (eH * 60 + eM);
    }
}

module.exports = RichTextFormatter;
