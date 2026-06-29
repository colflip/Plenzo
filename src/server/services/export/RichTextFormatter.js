/**
 * Rich Text 格式化器
 * 负责生成课程文本、处理颜色样式、状态标记等
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
        // 1. 优先使用数据库的 type_desc（COALESCE(description, name)）
        if (schedule.type_desc) {
            return schedule.type_desc;
        }
        // 2. 通过映射表查找
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
        // 先尝试 TYPE_DISPLAY_MAP 获取显示名
        const display = TYPE_DISPLAY_MAP[name];
        if (display) {
            // 从显示名中提取基础名：去掉"（线上）"前缀和"记录"后缀
            // 评审记录 → 评审，咨询记录 → 咨询（用于合并分组判断）
            return display.replace(/[（(]线上[）)]/, '').replace(/记录$/, '').trim();
        }
        // 回退：尝试子串匹配
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
     * 将课程按时间段、地址和基础类型分组，合并评审类和咨询类课程
     * 评审 + 评审记录 → 合并，咨询 + 咨询记录 → 合并
     * 合并条件：同一时间段 + 同一地址 + 同一基础类型
     * @param {Array} schedules - 已排序的课程列表
     * @returns {Array} 合并后的课程组
     */
    static buildMergedGroups(schedules) {
        const MERGE_TYPES = new Set(['评审', '咨询']);
        const groups = [];

        for (const schedule of schedules) {
            const baseType = RichTextFormatter.getBaseTypeName(schedule.type_name);
            const startTime = String(schedule.start_time || '').substring(0, 5);
            const endTime = String(schedule.end_time || '').substring(0, 5);
            const timeSlot = `${startTime}-${endTime}`;
            const location = String(schedule.location || '').trim();

            if (MERGE_TYPES.has(baseType)) {
                // 查找已有的同类型同时段同地址分组
                const existing = groups.find(g =>
                    g.isMerged &&
                    g.baseType === baseType &&
                    g.timeSlot === timeSlot &&
                    g.location === location
                );
                if (existing) {
                    existing.schedules.push(schedule);
                    existing.allTeachers.push(schedule.teacher_name || '');
                    if (RichTextFormatter.isRecordType(schedule)) {
                        existing.hasRecord = true;
                    }
                } else {
                    groups.push({
                        isMerged: true,
                        baseType,
                        timeSlot,
                        location,
                        schedules: [schedule],
                        allTeachers: [schedule.teacher_name || ''],
                        hasRecord: RichTextFormatter.isRecordType(schedule)
                    });
                }
            } else {
                groups.push({
                    isMerged: false,
                    schedule,
                    baseType,
                    timeSlot
                });
            }
        }

        return groups;
    }

    /**
     * 生成课程文本（计划和实际）
     * @param {Array} schedules - 课程列表
     * @param {boolean} isSingleStudent - 是否为单学生模式
     * @returns {Object} { planParts, actualParts, hasColoredCourse }
     */
    /**
     * 获取课程的颜色类型
     * @param {string} baseType - 基础类型名
     * @returns {'red'|'blue'|'black'} 颜色类型
     */
    static getColorType(baseType) {
        if (baseType === '评审' || baseType === '咨询') return 'red';
        if (baseType === '集体活动') return 'blue';
        return 'black';
    }

    static generateCourseText(schedules, isSingleStudent) {
        // 按类型优先级排序
        const sorted = [...schedules].sort((a, b) => {
            const priorityA = TYPE_PRIORITY[RichTextFormatter.getBaseTypeName(a.type_name)] || 999;
            const priorityB = TYPE_PRIORITY[RichTextFormatter.getBaseTypeName(b.type_name)] || 999;
            return priorityA - priorityB;
        });

        // 构建合并分组（评审类和咨询类合并）
        const mergedGroups = RichTextFormatter.buildMergedGroups(sorted);

        // 收集所有条目（含时间信息），用于独立排序
        const planEntries = [];
        const actualEntries = [];
        let hasColoredCourse = false;

        mergedGroups.forEach(group => {
            const baseType = group.baseType;
            const colorType = RichTextFormatter.getColorType(baseType);
            if (colorType !== 'black') hasColoredCourse = true;

            // 生成合并后的课程文本
            let courseText;
            if (group.isMerged) {
                // 合并分组使用基础类型名（评审/咨询），不带"记录"后缀
                const displayType = group.baseType;
                const regularTeachers = [];
                const recordTeachers = [];
                group.schedules.forEach(s => {
                    const entry = { id: s.teacher_id || 0, name: s.teacher_name || '' };
                    if (RichTextFormatter.isRecordType(s)) {
                        recordTeachers.push(entry);
                    } else {
                        regularTeachers.push(entry);
                    }
                });
                // 按教师ID排序，记录类教师排在最后
                regularTeachers.sort((a, b) => a.id - b.id);
                recordTeachers.sort((a, b) => a.id - b.id);
                // 普通教师正常显示，记录教师名后加"（记录）"
                const teacherParts = [
                    ...regularTeachers.map(t => t.name),
                    ...recordTeachers.map(t => t.name ? `${t.name}（记录）` : '')
                ].filter(Boolean);
                const teacherStr = teacherParts.join('，');
                courseText = isSingleStudent
                    ? `${displayType}(${group.timeSlot})：${teacherStr}`
                    : `[${group.schedules[0].student_name}]${displayType}(${group.timeSlot})：${teacherStr}`;
            } else {
                const schedule = group.schedule;
                const displayType = RichTextFormatter.getDisplayTypeName(schedule);
                const otherName = isSingleStudent ? schedule.teacher_name : schedule.student_name;
                courseText = isSingleStudent
                    ? `${displayType}(${group.timeSlot})：${otherName}`
                    : `[${schedule.student_name}]${displayType}(${group.timeSlot})：${schedule.teacher_name}`;
            }

            // 取分组中第一个课程的状态用于判断
            const refSchedule = group.isMerged ? group.schedules[0] : group.schedule;
            const isCancelled = refSchedule.status === 'cancelled' || refSchedule.status === '已取消' ||
                                refSchedule.status === 'modified_away' || refSchedule.status === '已调整' ||
                                refSchedule.status === 0 || refSchedule.status === 2;
            const isNew = refSchedule.adjustment_type == 1;
            const isAdjusted = refSchedule.adjustment_type == 2;

            // 用时间排序的键（startTime * 10000 + endTime）
            const [sH, sM] = group.timeSlot.split('-')[0].split(':').map(Number);
            const [eH, eM] = group.timeSlot.split('-')[1].split(':').map(Number);
            const timeSortKey = (sH * 60 + sM) * 10000 + (eH * 60 + eM);

            // 计划列：临时加课不显示，已调整后新生成的课程不显示
            if (!isNew && !isAdjusted) {
                planEntries.push({
                    sortKey: timeSortKey,
                    part: {
                        text: courseText,
                        colorType,
                        isCancelled,
                        isAdjusted: false
                    }
                });
            }

            // 实际列：已取消课程不显示
            if (!isCancelled) {
                if (isNew) {
                    // 临时加课：+ 为上标，课程文本正常
                    actualEntries.push({
                        sortKey: timeSortKey,
                        parts: [
                            { text: '+', isSuperscript: true, colorType },
                            { text: courseText, colorType }
                        ]
                    });
                } else if (isAdjusted) {
                    // 调整课程：~ 为上标，课程文本正常
                    actualEntries.push({
                        sortKey: timeSortKey,
                        parts: [
                            { text: '~', isSuperscript: true, colorType },
                            { text: courseText, colorType }
                        ]
                    });
                } else {
                    actualEntries.push({
                        sortKey: timeSortKey,
                        parts: [{ text: courseText, colorType }]
                    });
                }
            }
        });

        // 各列按时间从早到晚独立排序
        planEntries.sort((a, b) => a.sortKey - b.sortKey);
        actualEntries.sort((a, b) => a.sortKey - b.sortKey);

        return {
            planParts: planEntries.map(e => e.part),
            actualParts: actualEntries.flatMap(e => e.parts),
            hasColoredCourse
        };
    }

    /**
     * 将 textParts 转换为纯文本（换行分隔）
     * @param {Array} parts - 文本片段数组
     * @returns {string} 纯文本字符串
     */
    static textPartsToPlainText(parts) {
        return parts.map(p => p.text).join('\n');
    }

    /**
     * 获取文本片段的颜色
     * @param {Object} part - 文本片段
     * @returns {string} 颜色代码
     */
    static getTextColor(part) {
        const isCancelledOrAdjusted = part.isCancelled || part.isAdjusted;
        switch (part.colorType) {
            case 'red':
                return isCancelledOrAdjusted ? RICH_TEXT_COLORS.RED_LIGHT : RICH_TEXT_COLORS.RED;
            case 'blue':
                return isCancelledOrAdjusted ? RICH_TEXT_COLORS.BLUE_LIGHT : RICH_TEXT_COLORS.BLUE;
            default:
                return isCancelledOrAdjusted ? RICH_TEXT_COLORS.BLACK_LIGHT : RICH_TEXT_COLORS.BLACK;
        }
    }
}

module.exports = RichTextFormatter;
