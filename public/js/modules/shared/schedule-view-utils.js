/**
 * 周视图排课卡片的共享渲染辅助。
 *
 * 收拢 student/schedules.js、teacher/schedules.js、teacher/student-schedules.js
 * 三处逐字相同的实现；依赖角色本地 elements / currentWeekStart 的逻辑
 * （bindNavigation 的取钮与翻页回调、updateWeekRangeLabel 的文案格式化）由调用方传入。
 */

import { toISODate, normalizeDateKey } from './date-format.js';
import { createElement } from './view-utils.js';
import { getCardTypeKey } from './schedule-helpers.js';

function richText() {
    return (typeof window !== 'undefined' && window.ScheduleCalendarCore)
        ? window.ScheduleCalendarCore.RichText
        : null;
}

/** 是否「记录」类（评审记录 / 咨询记录），复用 RichText 的判定；无全局组件时按文案兜底 */
export function isRecordTypeOf(schedule) {
    const rt = richText();
    if (rt && typeof rt.isRecordType === 'function') return !!rt.isRecordType(schedule);
    return /记录/.test(String(schedule.schedule_type_cn || schedule.schedule_type || ''));
}

/**
 * 组内老师排序（PC 卡片与移动端视图统一口径）：
 * 记录类老师沉底，其余按 teacher_id 升序；同优先级内也按 teacher_id 升序。
 * @param {Array} group 同一课程（同时间/地点/类型）的排课记录组
 */
export function sortMergedGroup(group) {
    group.sort((a, b) => {
        const aRecord = isRecordTypeOf(a) ? 1 : 0;
        const bRecord = isRecordTypeOf(b) ? 1 : 0;
        if (aRecord !== bRecord) return aRecord - bRecord;
        return (Number(a.teacher_id) || 0) - (Number(b.teacher_id) || 0);
    });
    return group;
}

/**
 * 周视图卡片的「人员区」构建器（PC 页内四端 + 移动端导出视图共用）。
 *
 * 卡片基本结构（配色、底部时间地点）由调用方负责，这里只负责人员区三版式：
 * - 单人课程（不限类型）：一行「姓名 授课类型 状态」，无分隔符；
 * - 多人课程：
 *   · 组内含评审/咨询族或集体活动（TypeConversion.getColorKind 红/蓝）：类型名在前，
 *     「姓名 状态」依次内联显示，放不下自动换行；记录类老师名字带（记录）并沉底。
 *     整行着色：集体活动全蓝、评审/咨询全红（状态 chip 自带配色不受影响）；
 *   · 其它类型：每行一位老师「姓名 授课类型 状态」，行与行之间无分隔符。
 *
 * 状态由 options.buildStatusNode(rec) 提供（PC 管理端/教师端/班主任端返回可交互
 * 下拉，学生端与移动端返回只读标签），返回 null 则该人不显示状态。
 * 类名前缀可注入：PC 用默认 ct-*（CSS 在 dashboard.css 的 .card-teachers 家族），
 * 移动端传 cls 适配对象改挂 msv-*（CSS 在 schedule-mobile-view.css）。
 *
 * @param {Array} group 同一课程（session_id 一条记录）的排课记录组，可含多种类型
 * @param {object} options { personName(rec), typeLabelOf(rec), buildStatusNode(rec),
 *                           className, cls: {area, row, left, right, person, type,
 *                           inline, head, colorRed, colorBlue} }
 * @returns {HTMLElement}
 */
export function buildCardTeacherArea(group, options) {
    const opts = {
        personName: (rec) => rec.teacher_name || '未指定',
        typeLabelOf: (rec) => String(rec.schedule_type_cn || rec.schedule_types || rec.schedule_type || '课程').trim(),
        buildStatusNode: null,
        className: 'card-teachers',
        // 其它类型多人时的版式：'rows'（PC，每行一位）| 'inline'（移动端，内联流式换行）
        nonFamilyLayout: 'rows',
        // PC 端默认类名；移动端经 cls 对象整体替换
        cls: {
            area: 'card-teachers',
            row: 'ct-row',
            left: 'ct-left',
            right: 'ct-right',
            person: 'ct-person',
            type: 'ct-type',
            inline: 'ct-inline',
            head: 'ct-head',
            unit: 'ct-unit',
            colorRed: 'ct-color-red',
            colorBlue: 'ct-color-blue'
        },
        ...options
    };
    const cls = { ...opts.cls };
    if (opts.className && opts.className !== 'card-teachers') cls.area = opts.className;
    const ordered = sortMergedGroup(group.slice());
    const wrap = createElement('div', cls.area);

    if (ordered.length === 1) {
        wrap.appendChild(buildTeacherRow(ordered[0], opts, cls));
        return wrap;
    }

    // 组内可能混类型（一条记录多位老师不同类型）：取组内主类型定颜色。
    // 排序后记录类沉底，主类型取首位普通老师的折叠类型。
    const primary = ordered.find(rec => !isRecordTypeOf(rec)) || ordered[0];
    const category = getCardTypeKey(primary);
    const tc = (typeof window !== 'undefined' && window.TypeConversion) || null;
    const colorKind = tc && typeof tc.getColorKind === 'function'
        ? tc.getColorKind(category)
        : 'black';

    if (colorKind === 'red' || colorKind === 'blue') {
        wrap.appendChild(buildFamilyInline(ordered, opts, cls, category, colorKind));
    } else if (opts.nonFamilyLayout === 'inline') {
        wrap.appendChild(buildTeacherFlow(ordered, opts, cls));
    } else {
        ordered.forEach(rec => wrap.appendChild(buildTeacherRow(rec, opts, cls)));
    }
    return wrap;
}

/** 单行版式：「姓名 授课类型」+ 右侧状态（其它类型与单人课程共用），无分隔符 */
function buildTeacherRow(rec, opts, cls) {
    const row = createElement('div', cls.row);
    const left = createElement('div', cls.left);
    left.appendChild(createElement('span', cls.person, { textContent: opts.personName(rec) }));
    left.appendChild(createElement('span', cls.type, { textContent: opts.typeLabelOf(rec) || '课程' }));
    row.appendChild(left);

    if (opts.buildStatusNode) {
        const statusNode = opts.buildStatusNode(rec);
        if (statusNode) {
            const right = createElement('div', cls.right);
            right.appendChild(statusNode);
            row.appendChild(right);
        }
    }
    return row;
}

/**
 * 内联流式版式（移动端其它类型多人）：每位老师的「姓名 授课类型 状态」是一个
 * nowrap 原子单元，依次顺序排列，放不下整组换行。老师之间用「，」分隔。
 */
function buildTeacherFlow(ordered, opts, cls) {
    const flow = createElement('div', cls.inline);
    ordered.forEach((rec, index) => {
        const unit = createElement('span', cls.unit);
        unit.appendChild(createElement('span', cls.person, { textContent: opts.personName(rec) }));
        unit.appendChild(createElement('span', cls.type, { textContent: opts.typeLabelOf(rec) || '课程' }));
        if (opts.buildStatusNode) {
            const statusNode = opts.buildStatusNode(rec);
            if (statusNode) unit.appendChild(statusNode);
        }
        flow.appendChild(unit);
        if (index < ordered.length - 1) flow.appendChild(document.createTextNode('，'));
    });
    return flow;
}

/**
 * 红蓝色族多人内联版式：「评审：张三 状态，李四 状态」。
 * 整行着色（集体活动蓝 / 评审咨询红）；状态节点若自带配色（chip/下拉）则不受行色影响，
 * 行内人名之间的「，」分隔符保留（这是用户指定的族内格式）。
 */
function buildFamilyInline(ordered, opts, cls, category, colorKind) {
    const inline = createElement('div', `${cls.inline} ${colorKind === 'red' ? cls.colorRed : cls.colorBlue}`);
    const head = createElement('span', cls.head, {
        textContent: `${category}：`
    });
    inline.appendChild(head);

    ordered.forEach((rec, index) => {
        inline.appendChild(createElement('span', cls.person, {
            textContent: opts.personName(rec) + (isRecordTypeOf(rec) ? '（记录）' : '')
        }));
        if (opts.buildStatusNode) {
            const statusNode = opts.buildStatusNode(rec);
            if (statusNode) inline.appendChild(statusNode);
        }
        if (index < ordered.length - 1) inline.appendChild(document.createTextNode('，'));
    });
    return inline;
}

/**
 * 「导出本周视图」按钮：绑定 + 窄屏显隐。三个角色页以前各抄一份 bind/sync，
 * 已经抄出行为差异（admin 只在网格重画时绑 → 网格加载失败就静默没有反应；
 * admin 也没有窄屏收起）。这里是一份实现，差异靠参数说明。
 *
 * 网格每次重画都会再走到这里，用标记保证只绑一次；窄屏走移动端卡表，
 * 桌面那张要么被隐藏、要么留着上一周的残留内容，截它没有意义。
 */
export function setupWeekViewExportButton({ buttonId, onClick, hideOnMobile = false }) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    if (!btn.__weekViewExportBound) {
        btn.addEventListener('click', onClick);
        btn.__weekViewExportBound = true;
    }
    // 移动端视图现在作为默认、且移动端也能导出，故不再按窄屏隐藏按钮。
}

/** 临时课 / 调整课卡片右下角的手写体水印 */
export function appendScheduleWatermark(card, watermarkText) {
    if (!watermarkText) return;
    card.classList.add('is-temp-card');
    card.style.position = 'relative';
    card.style.overflow = 'hidden';
    const watermark = createElement('span', '');
    watermark.setAttribute('aria-hidden', 'true');
    const wmFontSize = watermarkText.length > 1 ? '66px' : '99px';
    watermark.style.cssText = [
        'position: absolute', 'bottom: -10px', 'right: 5px',
        `font-size: ${wmFontSize}`,
        'font-family: "Ma Shan Zheng","Kaiti SC","STXingkai","KaiTi",cursive,serif',
        'color: rgba(0,102,204,0.1)', 'pointer-events: none',
        'z-index: 0', 'transform: rotate(-15deg)', 'line-height: 1', 'user-select: none'
    ].join(';');
    watermark.textContent = watermarkText;
    card.appendChild(watermark);
}

/** 按本周日期建立分组骨架，再把记录归位（记录的日期键可能是多种形态） */
export function groupSchedulesByDate(weekDates, schedules) {
    const grouped = new Map();
    weekDates.forEach(date => grouped.set(toISODate(date), []));

    schedules.forEach(item => {
        const keyCandidates = [
            item.date,
            item.start_date,
            item.lesson_date,
            item.schedule_date
        ];
        const key = keyCandidates
            .map(normalizeDateKey)
            .find(Boolean);
        if (!key) return;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(item);
    });

    grouped.forEach(list => list.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || '')));
    return grouped;
}

/**
 * 按数据库记录（session_id）聚组：一条记录 = 一节课，一条记录可含多位老师、
 * 多种授课类型，全部渲染进同一张卡片。
 *
 * 不再用时间/地点/类型拼判定键 —— 那是基于「一场课只有一种类型」的旧假设。
 * 课程保存方式已改为单条记录多老师多类型，判定标准就是记录本身。
 * session_id 缺失时按 (时间+地点) 兜底，避免旧数据丢组。
 */
export function groupSchedulesBySlot(schedules) {
    const slots = new Map();
    schedules.forEach(s => {
        const key = s.session_id != null
            ? `session:${s.session_id}`
            : `fallback:${s.start_time}-${s.end_time}-${s.location || ''}`;
        if (!slots.has(key)) slots.set(key, []);
        slots.get(key).push(s);
    });
    return Array.from(slots.values());
}

/**
 * 绑定上一周 / 下一周翻页按钮（幂等：__scheduleNavBound 防重复绑定）。
 * 翻页动作（改 currentWeekStart + 重新拉数据）由调用方以回调注入。
 */
export function bindWeekNavigation({ prevBtn, nextBtn, onPrev, onNext }) {
    if (prevBtn && !prevBtn.__scheduleNavBound) {
        prevBtn.addEventListener('click', onPrev);
        prevBtn.__scheduleNavBound = true;
    }
    if (nextBtn && !nextBtn.__scheduleNavBound) {
        nextBtn.addEventListener('click', onNext);
        nextBtn.__scheduleNavBound = true;
    }
}

/**
 * 教师维度更新课程状态：教师端两个排课视图共用同一条端点与事件。
 *
 * 状态挂在教师 pair 上，定位一行需要 (session_id, teacher_uid) 两个键 —— 班主任视图里
 * 一场课的老师不是自己，只给场次 id 服务层找不到 pair，会误报「排课不存在」。
 * 所以有 uid 就走 pair 级端点；两个列表接口都已透出 teacher_uid。
 * 无 uid 时退回旧的按场次端点（服务层再按本人在场中的 pair 兜底）。
 */
export async function updateTeacherScheduleStatus(id, newStatus, teacherUid) {
    if (!window.apiUtils) {
        throw new Error('apiUtils 未就绪');
    }
    const response = teacherUid
        ? await window.apiUtils.patch(
            `/teacher/sessions/${id}/teachers/${encodeURIComponent(teacherUid)}/status`,
            { lifecycle: newStatus }
        )
        : await window.apiUtils.put(`/teacher/schedules/${id}/status`, {
            status: newStatus
        });

    window.eventBus?.emit(window.EVENTS?.SCHEDULE_STATUS_CHANGED || 'schedule:statusChanged', {
        id,
        teacher_uid: teacherUid || null,
        status: newStatus,
        role: 'teacher'
    });
    return response;
}
