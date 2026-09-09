/**
 * 今日排课共享渲染模块（管理员 / 教师 / 学生三端复用）
 * @description 以教师端 overview 的表格实现为基准抽取，统一三端总览页「今日排课」的显示
 */

import { getStatusLabel } from './schedule-helpers.js';
import { createInlineLoading } from './loading-ui.js';

// 需要在“今日排课”中隐藏的状态
const HIDDEN_TODAY_STATUSES = new Set(['cancelled', 'modified_away']);

// —— 日期导航辅助（上一天 / 下一天）——

/**
 * Date -> 'YYYY-MM-DD'（本地时区，避免 UTC 偏移问题）
 */
function toDateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function getTodayStr() {
    return toDateStr(new Date());
}

/**
 * 'YYYY-MM-DD' 日期偏移（days 为负数即往前）
 */
export function shiftDateStr(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + days);
    return toDateStr(date);
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 日期中文展示：'2026-08-24' -> '8月24日（周一）'
 */
export function formatDateCn(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const weekday = WEEKDAY_LABELS[new Date(y, m - 1, d).getDay()] || '';
    return `${m}月${d}日（${weekday}）`;
}

const DEFAULT_OPTIONS = Object.freeze({
    emptyText: '今日暂无排课安排',
    nameField: 'student_name',
    fallbackName: '未指定学生',
    secondaryNameField: null,
    secondaryFallback: '',
    // true 时人员姓名放在行首（时段/时间之前）
    nameFirst: false,
    // 非空时在时段前显示日期文案（如 '8月24日（周一）'，用于查看非今天日期）
    dateText: ''
});

const TYPE_LABEL_MAP = Object.freeze({
    'home-visit': '入户',
    'home_visit': '入户',
    'home visit': '入户',
    'visit': '入户',
    'trial-teaching': '试教',
    'trial_teaching': '试教',
    'trial teaching': '试教',
    'trial': '试教',
    'review': '评审',
    'review-record': '评审记录',
    'review_record': '评审记录',
    'review record': '评审记录',
    'half-home-visit': '半次入户',
    'half_home_visit': '半次入户',
    'half visit': '半次入户',
    'group-activity': '集体活动',
    'group_activity': '集体活动',
    'group activity': '集体活动',
    'psychological-counseling': '心理咨询',
    'psychological_counseling': '心理咨询',
    'psychological counseling': '心理咨询',
    'online-tutoring': '线上辅导',
    'online_tutoring': '线上辅导',
    'offline-tutoring': '线下辅导',
    'offline_tutoring': '线下辅导',
    'default': '课程',
    'other': '其他'
});

export function getScheduleTypeLabel(schedule) {
    const rawType = schedule.schedule_type_cn
        || schedule.schedule_type_name
        || schedule.schedule_types
        || schedule.schedule_type
        || '';
    if (!rawType) {
        // 降级：通过 course_id 从动态类型存储中解析
        if (schedule.course_id != null && window.ScheduleTypesStore && window.ScheduleTypesStore.getById) {
            const found = window.ScheduleTypesStore.getById(schedule.course_id);
            if (found) return found.description || found.name;
        }
        return '未分类';
    }

    const normalized = String(rawType).trim();
    if (!normalized) return '未分类';

    // Prioritize Dynamic Store
    if (window.ScheduleTypesStore && window.ScheduleTypesStore.getLabel) {
        return window.ScheduleTypesStore.getLabel(normalized);
    }

    const lower = normalized.toLowerCase();
    return TYPE_LABEL_MAP[lower] || normalized;
}

function createElement(tag, className, props = {}) {
    const el = document.createElement(tag);
    if (className) el.className = className;

    const { dataset, classList: extraClasses, ...rest } = props || {};

    if (rest && Object.keys(rest).length > 0) {
        Object.assign(el, rest);
    }

    if (dataset && typeof dataset === 'object') {
        Object.entries(dataset).forEach(([key, value]) => {
            if (value === undefined || value === null) return;
            el.dataset[key] = String(value);
        });
    }

    if (extraClasses) {
        const values = Array.isArray(extraClasses)
            ? extraClasses
            : String(extraClasses).split(/\s+/);
        el.classList.add(...values.filter(Boolean));
    }

    return el;
}

function clearChildren(el) {
    while (el.firstChild) {
        el.removeChild(el.firstChild);
    }
}

function formatTimeDisplay(timeString) {
    if (!timeString) return '';
    return String(timeString).slice(0, 5);
}

function formatTimeRange(start, end) {
    const safeStart = formatTimeDisplay(start);
    const safeEnd = formatTimeDisplay(end);
    if (!safeStart && !safeEnd) return '';
    if (!safeEnd) return safeStart;
    return `${safeStart} - ${safeEnd}`;
}

/**
 * 显示加载占位（紧凑横向 spinner + 文案）
 */
export function showTodayScheduleLoading(container, text = '正在加载今日排课...') {
    if (!container) return;
    container.replaceChildren(createInlineLoading(text, { compact: true }));
}

/**
 * 显示错误占位（统一错误态：与空态明确区分，可带重试入口）
 * @param {HTMLElement} container
 * @param {string} [text] - 兼容旧签名的自定义文案；不传时走 error-ui 标准文案
 * @param {Object} [options]
 * @param {Error}  [options.error]  - 原始错误（用于推断标准文案）
 * @param {Function} [options.onRetry] - 重试回调；提供时显示「重试」按钮
 */
export function showTodayScheduleError(container, text = '', options = {}) {
    if (!container) return;
    // 未传自定义文案时使用统一错误态卡片（图标 + 标准文案 + 重试）；传了文案则保持旧行为
    if (!text && typeof window !== 'undefined' && window.ErrorUI?.createErrorState) {
        container.replaceChildren(window.ErrorUI.createErrorState({
            error: options.error,
            title: '今日排课加载失败',
            detail: '请点击重试；若多次失败请联系管理员',
            onRetry: options.onRetry,
            compact: true
        }));
        return;
    }
    clearChildren(container);
    container.appendChild(createElement('div', 'today-empty-state', { textContent: text || '今日排课加载失败，请稍后重试' }));
}

/**
 * 过滤隐藏状态并按开始时间排序
 * @param {Array<Object>} schedules
 * @returns {Array<Object>}
 */
function getVisibleTodaySchedules(schedules) {
    return (Array.isArray(schedules) ? schedules : [])
        .filter(schedule => {
            const status = String(schedule.status || 'pending').toLowerCase();
            return !HIDDEN_TODAY_STATUSES.has(status);
        })
        .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
}

/**
 * 渲染“今日排课”列表（教师端表格样式，三端共用）
 *
 * @param {HTMLElement} container 目标容器（#todayScheduleList）
 * @param {Array<Object>} schedules 排课记录数组
 * @param {Object} [options]
 * @param {string} [options.emptyText] 空状态文案
 * @param {string} [options.nameField] 行内主要人员字段名（默认 student_name）
 * @param {string} [options.fallbackName] 主要人员缺失时的兜底文案
 * @param {string|null} [options.secondaryNameField] 可选次要人员字段名（如 teacher_name）
 * @param {string} [options.secondaryFallback] 次要人员为空时不显示；非空时使用该兜底
 * @param {boolean} [options.nameFirst] 人员姓名是否放在行首（时段/时间之前），默认 false
 */
function renderTodayScheduleList(container, schedules, options = {}) {
    if (!container) return;

    const opts = { ...DEFAULT_OPTIONS, ...options };

    clearChildren(container);

    const visibleSchedules = getVisibleTodaySchedules(schedules);

    if (visibleSchedules.length === 0) {
        container.appendChild(createElement('div', 'today-empty-state', {
            textContent: opts.emptyText
        }));
        return;
    }

    const table = createElement('table', 'today-schedule-table');

    const tbody = createElement('tbody');
    const fragment = document.createDocumentFragment();
    visibleSchedules.forEach(schedule => fragment.appendChild(buildTodayScheduleRow(schedule, opts)));
    tbody.appendChild(fragment);
    table.appendChild(tbody);

    container.appendChild(table);
}

/**
 * 构建单行“今日排课”表格行（tr）
 *
 * @param {Object} schedule 排课记录
 * @param {Object} [options] 同 renderTodayScheduleList 的 options，另支持：
 * @param {boolean} [options.hidePerson] 为 true 时主要人员姓名隐藏但保留占位（用于同学生多节课的续行对齐）
 * @returns {HTMLTableRowElement}
 */
function buildTodayScheduleRow(schedule, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const status = String(opts.statusOverride || schedule.status || 'pending').toLowerCase();
    const displayStatus = getStatusLabel(status);
    const typeLabel = getScheduleTypeLabel(schedule);

    // 时段（上午/下午/晚上）
    const h = parseInt((schedule.start_time || '00:00').substring(0, 2), 10);
    let slotId = 'morning';
    let slotLabel = '上午';
    if (h >= 12) {
        slotId = 'afternoon';
        slotLabel = '下午';
    }
    if (h >= 18) {
        slotId = 'evening';
        slotLabel = '晚上';
    }

    let typeClass = 'type-default';
    if (typeLabel.includes('入户')) typeClass = 'type-visit';
    else if (typeLabel.includes('试教')) typeClass = 'type-trial';
    else if (typeLabel.includes('评审')) typeClass = 'type-review';

    const primaryName = schedule[opts.nameField] || opts.fallbackName;

    // 主要人员：hidePerson 时（同学生续行）姓名与其后分隔符整体隐藏但保留占位宽度
    const primaryPart = opts.hidePerson
        ? { className: 'today-schedule-student', textContent: primaryName, placeholderHidden: true }
        : { className: 'today-schedule-student', textContent: primaryName };

    // 次要人员（如授课教师）：每行独立显示
    let secondaryPart = null;
    if (opts.secondaryNameField) {
        const secondaryName = schedule[opts.secondaryNameField];
        if (secondaryName || opts.secondaryFallback) {
            secondaryPart = {
                className: 'today-schedule-teacher',
                textContent: secondaryName || opts.secondaryFallback
            };
        }
    }

    const timeParts = [
        { className: `today-schedule-slot slot-${slotId}`, textContent: slotLabel },
        { className: 'today-schedule-time', textContent: formatTimeRange(schedule.start_time, schedule.end_time) }
    ];

    // 查看非今天日期时，时段前显示日期
    const leadingTimeParts = opts.dateText
        ? [{ className: 'today-schedule-date', textContent: opts.dateText }, ...timeParts]
        : timeParts;

    // 行内顺序：
    // - nameFirst（管理端）：学生姓名 → （日期）→ 时段 → 时间 → 教师姓名 → 课程类型…
    // - 默认（教师端/学生端）：时段 → 时间 → 人员姓名 → 课程类型…
    // - mergedParts（评审/咨询合并段）：替代教师姓名与类型徽章
    const hasMerged = Array.isArray(opts.mergedParts) && opts.mergedParts.length > 0;
    const mergedPart = hasMerged
        ? { className: 'today-schedule-merged', merged: true, children: opts.mergedParts, badge: opts.mergedBadge || null }
        : null;

    let parts;
    if (hasMerged) {
        parts = opts.nameFirst
            ? [primaryPart, ...leadingTimeParts, mergedPart]
            : [...leadingTimeParts, mergedPart, primaryPart];
    } else if (opts.nameFirst) {
        parts = [primaryPart, ...leadingTimeParts];
        if (secondaryPart) parts.push(secondaryPart);
    } else {
        parts = [...leadingTimeParts, primaryPart];
        if (secondaryPart) parts.push(secondaryPart);
    }

    parts.push(
        ...(hasMerged ? [] : [{ className: `today-schedule-type ${typeClass}`, textContent: typeLabel }]),
        { className: 'today-schedule-location', textContent: schedule.location || '未指定地点' },
        { className: `status-pill ${status}`, textContent: displayStatus }
    );

    // 备注标记放最后：临时加课 / 调整来的课。数据源换成状态码的类别位
    // （normal|adjusted|temp），旧的 is_temp / adjustment_type 两列已不再返回。
    const cat = schedule.status_category || (schedule.status_code ? String(schedule.status_code).split('.')[0] : '');
    const adjustmentType = cat === 'temp' ? 1 : (cat === 'adjusted' ? 2 : 0);
    if (adjustmentType === 1) {
        parts.push({ className: 'today-schedule-remark remark-temp', textContent: '临时加课' });
    } else if (adjustmentType === 2) {
        parts.push({ className: 'today-schedule-remark remark-adjusted', textContent: '已调整' });
    }

    // 单元格内用“，”分割（逗号后加一个汉字间距）、从左侧 10% 开始显示
    // placeholderHidden 的部分：姓名+分隔符整体隐藏但占位，避免续行出现多余“，”
    const cell = createElement('td', 'today-schedule-cell-main');
    const SEPARATOR = '，　';
    parts.forEach((part, index) => {
        if (part.placeholderHidden) {
            const ghost = createElement('span', 'today-schedule-placeholder');
            ghost.appendChild(document.createTextNode(part.textContent));
            if (index < parts.length - 1) {
                ghost.appendChild(document.createTextNode(SEPARATOR));
            }
            cell.appendChild(ghost);
            return;
        }
        if (part.merged) {
            // 合并段：教师列表（记录类老师带类型徽章）+ 类别徽章（列表之后）
            if (index > 0 && !parts[index - 1].placeholderHidden) {
                cell.appendChild(document.createTextNode(SEPARATOR));
            }
            const wrapper = createElement('span', part.className);
            part.children.forEach((child, childIndex) => {
                if (childIndex > 0) wrapper.appendChild(document.createTextNode('，'));
                wrapper.appendChild(createElement('span', child.className, {
                    textContent: child.text,
                    title: child.text
                }));
                if (child.badge) {
                    wrapper.appendChild(createElement('span', `today-schedule-type ${child.badge.typeClass}`, {
                        textContent: child.badge.label,
                        title: child.badge.label
                    }));
                }
            });
            if (part.badge) {
                wrapper.appendChild(document.createTextNode(SEPARATOR));
                wrapper.appendChild(createElement('span', `today-schedule-type ${part.badge.typeClass}`, {
                    textContent: part.badge.label,
                    title: part.badge.label
                }));
            }
            cell.appendChild(wrapper);
            return;
        }
        if (index > 0 && !parts[index - 1].placeholderHidden) {
            cell.appendChild(document.createTextNode(SEPARATOR));
        }
        cell.appendChild(createElement('span', part.className, {
            textContent: part.textContent,
            title: part.textContent
        }));
    });

    const row = createElement('tr', `today-schedule-row sc-status-${status}`);
    row.appendChild(cell);
    return row;
}

// —— 评审/咨询合并 + 按人员分组渲染（管理端/教师端/学生端共用）——

// 类别识别：类型名含「评审」→ 评审类；含「咨询」→ 咨询类
function getMergeCategory(label) {
    if (label.includes('评审')) return '评审';
    if (label.includes('咨询')) return '咨询';
    return null;
}

// 是否「记录」类类型（评审记录/咨询记录）
function isRecordType(label) {
    return label.includes('记录');
}

/**
 * 合并同人员下同日期/同时间段/同地址的评审、咨询课程（已取消课程不参与显示）
 * @param {Array<Object>} items 参与合并的课程
 * @param {Object} groupFields 分组依据字段 { id, name }
 */
function mergeReviewCounseling(items, groupFields) {
    const groups = new Map();
    items.forEach(item => {
        const key = [
            getMergeCategory(getScheduleTypeLabel(item)),
            item[groupFields.id] != null ? item[groupFields.id] : item[groupFields.name] || '',
            item.date || '',
            item.start_time || '',
            item.end_time || '',
            item.location || ''
        ].join('|');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    });

    return Array.from(groups.values()).map(courses => {
        const sorted = courses.slice().sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
        const first = sorted[0];
        return {
            __merged: true,
            [groupFields.id]: first[groupFields.id],
            [groupFields.name]: first[groupFields.name],
            date: first.date,
            start_time: first.start_time,
            end_time: first.end_time,
            location: first.location,
            courses: sorted
        };
    });
}

/**
 * 合并段教师列表：普通老师在前、「记录」类老师（评审记录/咨询记录）最后；
 * 记录类老师名称后跟随类型徽章（评审记录/咨询记录），临时加课为文本标注（临时加课）。
 * 类别徽章（评审/咨询）由渲染器放在教师列表之后
 */
function buildMergedParts(courses) {
    const category = getMergeCategory(getScheduleTypeLabel(courses[0]));
    const withMeta = courses.map(course => {
        const label = getScheduleTypeLabel(course);
        return { course, label, isRecord: isRecordType(label) };
    });
    // 稳定排序：记录类放最后
    withMeta.sort((a, b) => (a.isRecord === b.isRecord ? 0 : a.isRecord ? 1 : -1));

    const parts = withMeta.map(({ course, label, isRecord }) => {
        const name = course.teacher_name || '未分配教师';
        const annotations = [];
        const courseCat = course.status_category
            || (course.status_code ? String(course.status_code).split('.')[0] : '');
        if (courseCat === 'temp') annotations.push('临时加课');
        return {
            text: annotations.length ? `${name}（${annotations.join('，')}）` : name,
            className: '',
            badge: isRecord ? {
                label,
                typeClass: label.includes('咨询') ? 'type-counseling' : 'type-review'
            } : null
        };
    });

    return {
        parts,
        badge: category ? {
            label: category,
            typeClass: category === '评审' ? 'type-review' : 'type-counseling'
        } : null
    };
}

// 合并行状态徽章：全部同状态用该状态；混合时取第一节课的状态
function getMergedStatus(courses) {
    const statuses = [...new Set(courses.map(c => String(c.status || 'pending').toLowerCase()))];
    return statuses.length === 1 ? statuses[0] : String(courses[0].status || 'pending').toLowerCase();
}

/**
 * 按人员分组渲染「今日排课」（管理端/教师端/学生端共用）：
 * - 同一人员多节课只在首行显示姓名；续行姓名隐藏但占位，保持列对齐
 * - 行内顺序：姓名 → （日期）→ 时段 → 时间 → 教师姓名 → 课程类型 → 地点 → 状态
 * - 评审/咨询类：同日期同时间段同地址的合并为一行（类型徽章 + 教师列表）
 * - 不同人员之间用分割线区分，按最早一节课的时间顺序排列（样式见 .today-schedule-table.grouped）
 *
 * @param {HTMLElement} container 目标容器（#todayScheduleList）
 * @param {Array<Object>} schedules 排课记录
 * @param {Object} [options] 同 buildTodayScheduleRow 的选项，另支持：
 * @param {Object} [options.groupFields] 分组依据字段 { id, name }（默认按学生）
 */
export function renderGroupedTodayScheduleList(container, schedules, options = {}) {
    const opts = {
        dateText: '',
        emptyText: '今日暂无排课安排',
        groupFields: { id: 'student_id', name: 'student_name' },
        nameField: 'student_name',
        fallbackName: '未指定学生',
        secondaryNameField: null,
        secondaryFallback: '',
        nameFirst: true,
        ...options
    };

    // 拆分：评审/咨询类进入合并池；其余保持原可见规则（已取消/已调整不显示）
    const mergePool = [];
    const plainItems = [];
    (Array.isArray(schedules) ? schedules : []).forEach(item => {
        const status = String(item.status || 'pending').toLowerCase();
        if (status === 'modified_away') return;
        if (getMergeCategory(getScheduleTypeLabel(item))) {
            if (status !== 'cancelled') mergePool.push(item);
            return;
        }
        if (status !== 'cancelled') plainItems.push(item);
    });

    const visible = plainItems
        .concat(mergeReviewCounseling(mergePool, opts.groupFields))
        .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));

    if (visible.length === 0) {
        // 复用共享渲染器的空状态展示
        renderTodayScheduleList(container, [], { emptyText: opts.emptyText });
        return;
    }

    // 按人员分组（id 缺失时退化为按姓名）
    const groups = new Map();
    visible.forEach(schedule => {
        const idValue = schedule[opts.groupFields.id];
        const key = idValue != null ? `id:${idValue}` : `name:${schedule[opts.groupFields.name] || ''}`;
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key).push(schedule);
    });

    // 人员顺序：按其最早一节课的开始时间
    const sortedGroups = Array.from(groups.values())
        .map(items => {
            const sorted = items.slice().sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
            return { items: sorted, firstTime: sorted[0].start_time || '' };
        })
        .sort((a, b) => a.firstTime.localeCompare(b.firstTime));

    const table = createElement('table', 'today-schedule-table grouped');

    const tbody = createElement('tbody');
    const fragment = document.createDocumentFragment();

    sortedGroups.forEach((group, groupIndex) => {
        group.items.forEach((schedule, itemIndex) => {
            // 组内首行显示姓名；其余行不重复显示（占位对齐）
            const rowOptions = {
                nameField: opts.nameField,
                fallbackName: opts.fallbackName,
                secondaryNameField: opts.secondaryNameField,
                secondaryFallback: opts.secondaryFallback,
                nameFirst: opts.nameFirst,
                hidePerson: itemIndex > 0,
                dateText: opts.dateText
            };
            if (schedule.__merged) {
                const merged = buildMergedParts(schedule.courses);
                rowOptions.mergedParts = merged.parts;
                rowOptions.mergedBadge = merged.badge;
                rowOptions.statusOverride = getMergedStatus(schedule.courses);
            }
            const row = buildTodayScheduleRow(schedule, rowOptions);
            // 不同人员之间加分割线
            if (groupIndex > 0 && itemIndex === 0) {
                row.classList.add('today-schedule-group-start');
            }
            fragment.appendChild(row);
        });
    });

    tbody.appendChild(fragment);
    table.appendChild(tbody);

    container.replaceChildren(table);
}
