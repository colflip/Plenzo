/**
 * 学生端 / 教师端统计页共享的小工具（两处逐字相同）。
 */

/** 统计页日期输入框用的 YYYY-MM-DD（本地时区，配合 <input type="date">） */
export function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** 日期范围选择器默认填本月 1 号到月末（两端输入框 id 一致：teachingStartDate/EndDate） */
export function setupDateRangePickers() {
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const startDateInput = document.getElementById('teachingStartDate');
    const endDateInput = document.getElementById('teachingEndDate');

    if (startDateInput) {
        startDateInput.value = formatDate(firstDay);
    }
    if (endDateInput) {
        endDateInput.value = formatDate(lastDay);
    }
}

/**
 * 确保 Chart.js 已就绪后返回可 await 的 promise（图表库由 /js/utils/load-chart.js 按需加载）。
 *
 * 背景：6a7c232 把阻塞首屏的 Chart.js <script> 换成按需加载器后，教师/学生统计模块
 * 没有任何调用点触发 loader，`Chart` 一直是 undefined，渲染图表时同步抛错并被
 * 「授课统计/每日授课统计加载失败」错误态吞掉。此处统一预热 + 渲染前 await，
 * 图表库与接口请求并行下载，不增加可感知延迟。
 *
 * 与 admin/legacy-adapter.js 的同名实现共用 window.__chartReadyPromise，避免重复下载。
 */
export function ensureChartReady() {
    if (typeof window.Chart !== 'undefined') return Promise.resolve();
    if (typeof window.loadChart !== 'function') {
        return Promise.reject(new Error('图表组件加载失败'));
    }
    if (!window.__chartReadyPromise) {
        window.__chartReadyPromise = window.loadChart().catch(error => {
            window.__chartReadyPromise = null;
            throw error;
        });
    }
    return window.__chartReadyPromise.then(() => {
        if (typeof window.Chart === 'undefined') throw new Error('图表组件加载失败');
    });
}

/**
 * 课程类型图例配色：优先 window.ColorUtils（三端 dashboard.html 都加载），
 * 未加载时用固定调色板兜底，保证图例颜色稳定可读。
 */
export function getLegendColor(name) {
    if (window.ColorUtils && window.ColorUtils.getLegendColor) {
        return window.ColorUtils.getLegendColor(name);
    }
    // Fallback if not loaded
    const hash = Array.from(String(name || '')).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const fallbackPalette = ['#3366CC', '#FF9933', '#33CC99', '#DC3912', '#7C4DFF'];
    return fallbackPalette[hash % fallbackPalette.length];
}

/* ----------------------------------------------------------------------------
 * 折算口径卡片 / 明细（教师端「授课展示」与学生端「学习统计」共用）
 *
 * 折算规则唯一实现是 /js/utils/type-conversion.js（window.TypeConversion），
 * 这里只负责把它的结果画出来，禁止再维护第二套别名表或折算分支。
 * 卡片区展示折算后的口径桶（试教 / 入户 / 评审 / 咨询），原始类型计数与
 * 分人折算结果放在卡片下方，满足「主数据看折算、明细看原始」的业务习惯。
 * -------------------------------------------------------------------------- */

const UNCATEGORIZED_LABEL = '未归类';

// 折算后口径桶的卡片外观（与 color-utils 的类型图例同色系）
const CONVERTED_CARD_STYLES = {
    trial: { bg: 'linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%)', text: '#0369a1', icon: 'school' },
    visit: { bg: 'linear-gradient(135deg, #dcfce7 0%, #bbf7d0 100%)', text: '#15803d', icon: 'home' },
    review: { bg: 'linear-gradient(135deg, #fef08a 0%, #fde047 100%)', text: '#a16207', icon: 'fact_check' },
    consultation: { bg: 'linear-gradient(135deg, #fce7f3 0%, #fbcfe8 100%)', text: '#be185d', icon: 'psychology' },
    uncategorized: { bg: 'linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%)', text: '#475569', icon: 'help_outline' }
};

const CONVERTED_CARD_ORDER = ['trial', 'visit', 'review', 'consultation', 'uncategorized'];

function getTypeConversion() {
    const api = typeof window !== 'undefined' ? window.TypeConversion : null;
    if (!api) {
        throw new Error('TypeConversion 未加载：/js/utils/type-conversion.js 必须早于统计模块加载');
    }
    return api;
}

/**
 * 把 { 原始类型: 计数 } 折算成口径桶总计。
 * @param {Object<string, number>} typeCounts
 * @returns {{ trial:number, visit:number, review:number, consultation:number, uncategorized:number }}
 */
export function buildConvertedTotals(typeCounts) {
    const api = getTypeConversion();
    const totals = api.createConvertedTotals();
    Object.keys(typeCounts || {}).forEach(type => {
        const count = Number(typeCounts[type]);
        if (Number.isFinite(count) && count > 0) {
            api.accumulateConvertedType(totals, type, count);
        }
    });
    return totals;
}

function createConvertedCard(title, valueText, style) {
    const card = document.createElement('div');
    card.className = 'stat-card scale-hover';
    card.style.cssText = [
        `background:${style.bg}`,
        'border:none',
        'position:relative',
        'overflow:hidden',
        'display:flex',
        'flex-direction:column',
        'justify-content:center',
        'min-height:120px'
    ].join(';');

    const iconWrap = document.createElement('div');
    iconWrap.setAttribute('aria-hidden', 'true');
    iconWrap.style.cssText = 'position:absolute;right:10px;top:10px;opacity:0.15;transform:scale(3.5) translate(-15%,15%);pointer-events:none;';
    const icon = document.createElement('span');
    icon.className = 'material-icons-round';
    icon.style.color = style.text;
    icon.textContent = style.icon;
    iconWrap.appendChild(icon);

    const body = document.createElement('div');
    body.style.cssText = 'position:relative;z-index:1;';
    const titleEl = document.createElement('h3');
    titleEl.style.cssText = `color:${style.text};opacity:0.95;margin-bottom:8px;font-weight:600;font-size:var(--fs-300);`;
    titleEl.textContent = title;
    const valueEl = document.createElement('p');
    valueEl.style.cssText = `color:${style.text};margin:0;font-size:32px;font-weight:700;line-height:1;`;
    valueEl.textContent = valueText;
    body.append(titleEl, valueEl);

    card.append(iconWrap, body);
    return card;
}

/**
 * 渲染「折算后」主卡片：试教 / 入户 / 评审 / 咨询（非 0 才显示，未归类有值时追加）。
 * @param {string} gridId 卡片网格容器 id（#teachingTypeStats）
 * @param {Object<string, number>} typeStats 原始类型 → 计数（服务端统计结果）
 * @param {{ emptyTitle?: string }} [options]
 */
export function renderConvertedTypeCards(gridId, typeStats, options = {}) {
    const grid = document.getElementById(gridId);
    if (!grid) return;

    const api = getTypeConversion();
    const totals = buildConvertedTotals(typeStats || {});
    const labels = Object.assign({}, api.CONVERTED_LABELS, { uncategorized: UNCATEGORIZED_LABEL });

    grid.textContent = '';

    const buckets = CONVERTED_CARD_ORDER
        .map(key => ({ key, value: Number(totals[key]) || 0 }))
        .filter(item => item.value > 0);

    if (buckets.length === 0) {
        grid.appendChild(createConvertedCard(
            options.emptyTitle || '折算后总授课数',
            '0',
            CONVERTED_CARD_STYLES.uncategorized
        ));
        return;
    }

    buckets.forEach(({ key, value }) => {
        const style = CONVERTED_CARD_STYLES[key] || CONVERTED_CARD_STYLES.uncategorized;
        grid.appendChild(createConvertedCard(labels[key] || key, api.fmtCount(value), style));
    });
}

/**
 * 按人聚合折算结果（用于「分学生 / 分老师」明细）。
 * @param {Array<Object>} rows 明细行
 * @param {{
 *   nameOf: (row: Object) => string,
 *   typeOf: (row: Object) => string,
 *   isActive?: (row: Object) => boolean
 * }} options
 * @returns {Array<{ name: string, total: number, totals: Object }>}
 */
export function aggregatePersonStats(rows, options) {
    const api = getTypeConversion();
    const nameOf = options.nameOf;
    const typeOf = options.typeOf;
    const isActive = options.isActive || (() => true);
    const people = new Map();

    (rows || []).forEach(row => {
        if (!row || !isActive(row)) return;
        const name = String(nameOf(row) || '').trim() || '未知';
        const rawType = typeOf(row);
        if (!rawType) return;

        let person = people.get(name);
        if (!person) {
            person = { name, total: 0, totals: api.createConvertedTotals() };
            people.set(name, person);
        }
        person.total += 1;
        api.accumulateConvertedType(person.totals, rawType, 1);
    });

    return Array.from(people.values()).sort((a, b) => {
        if (b.total !== a.total) return b.total - a.total;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
}

function createBreakdownElement(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

/**
 * 渲染卡片下方的明细区：不折算的原始类型计数 + 分人折算结果 + 折算口径说明。
 * @param {string} containerId 明细容器 id（#teachingStatsBreakdown）
 * @param {{
 *   typeStats?: Object<string, number>,
 *   persons?: Array<{ name: string, total: number, totals: Object }> | null,
 *   personLabel?: string,
 *   pendingText?: string
 * }} options persons 为 null 表示分人数据仍在加载
 */
export function renderStatsBreakdown(containerId, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const api = getTypeConversion();
    const typeStats = options.typeStats || {};
    const persons = Array.isArray(options.persons) ? options.persons : null;

    const typeEntries = Object.keys(typeStats)
        .map(type => ({ type, count: Number(typeStats[type]) || 0 }))
        .filter(item => item.count > 0)
        .sort((a, b) => b.count - a.count);

    if (typeEntries.length === 0 && (!persons || persons.length === 0)) {
        container.textContent = '';
        container.hidden = true;
        return;
    }

    const rawTotal = typeEntries.reduce((sum, item) => sum + item.count, 0);

    const rawRow = createBreakdownElement('div', 'stats-breakdown-row');
    rawRow.appendChild(createBreakdownElement('span', 'stats-breakdown-label', '不折算'));
    rawRow.appendChild(createBreakdownElement('span', 'stats-breakdown-total', `共 ${api.fmtCount(rawTotal)} 节`));
    const rawList = createBreakdownElement('span', 'stats-raw-list');
    typeEntries.forEach(({ type, count }) => {
        const item = createBreakdownElement('span', 'stats-raw-item');
        const dot = createBreakdownElement('i', 'stats-raw-dot');
        dot.style.backgroundColor = getLegendColor(type);
        item.append(dot, createBreakdownElement('span', '', `${type} ${api.fmtCount(count)}`));
        rawList.appendChild(item);
    });
    rawRow.appendChild(rawList);

    const personRow = createBreakdownElement('div', 'stats-breakdown-row stats-breakdown-persons');
    personRow.appendChild(createBreakdownElement('span', 'stats-breakdown-label', options.personLabel || '分学生（折算）'));

    if (!persons) {
        personRow.appendChild(createBreakdownElement('span', 'stats-breakdown-pending', options.pendingText || '正在统计...'));
    } else if (persons.length === 0) {
        personRow.appendChild(createBreakdownElement('span', 'stats-breakdown-pending', '暂无数据'));
    } else {
        const personList = createBreakdownElement('div', 'stats-person-list');
        persons.forEach(person => {
            const item = createBreakdownElement('div', 'stats-person-item');
            const converted = api.formatConvertedText(person.totals);
            item.append(
                createBreakdownElement('span', 'stats-person-name', person.name),
                createBreakdownElement('span', 'stats-person-total', `共 ${api.fmtCount(person.total)} 节`),
                createBreakdownElement('span', 'stats-person-converted', converted || '—')
            );
            personList.appendChild(item);
        });
        personRow.appendChild(personList);
    }

    const note = createBreakdownElement(
        'p',
        'stats-breakdown-note',
        '折算口径：半次入户 = 0.5 次入户；评审记录 = 1 评审 + 0.5 入户；咨询记录 = 1 咨询 + 0.5 入户；集体活动 = 1 评审；线上等同线下。'
    );

    container.textContent = '';
    container.append(rawRow, personRow, note);
    container.hidden = false;
}
