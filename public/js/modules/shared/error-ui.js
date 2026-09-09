/**
 * error-ui.js —— 全站统一错误提示组件（L3 区域错误态 / L4 页面级错误屏）
 *
 * 设计规范见 docs/error-message-spec.md。要点：
 * - 四层体系：L1 Toast（操作反馈）/ L2 内联反馈条 / L3 区域错误态 / L4 页面级错误屏
 * - 本模块负责 L3/L4：图标 + 标题 + 详情 + 重试/返回动作；L1/L2 见 toast.js 与
 *   view-utils.showInlineFeedback
 * - 颜色一律取 theme.css 的 --color-error-* 令牌（样式在 css/core/global.css），
 *   禁止调用方再写内联色值
 * - 所有文案经 textContent 写入，服务端返回的 message 不允许拼进 innerHTML
 * - 同时暴露 window.ErrorUI，供 components/*.js 等非模块脚本使用
 */

// —— 标准文案库（L3/L4 默认文案；L1 的文案库在 api-client.friendlyMessageFromStatus）——

export const ERROR_COPY = Object.freeze({
    NETWORK: {
        icon: 'offline',
        title: '网络连接失败',
        detail: '请检查网络连接后重试；若使用校园网或公司网，请确认未拦截本站。'
    },
    SERVER: {
        icon: 'server',
        title: '服务暂时不可用',
        detail: '服务器暂时无法处理请求，请稍后重试。'
    },
    LOAD: {
        icon: 'alert',
        title: '数据加载失败',
        detail: '请点击重试；若多次失败请联系管理员。'
    },
    NOT_FOUND: {
        icon: 'search',
        title: '请求的资源不存在',
        detail: '内容可能已被删除或移动，请刷新页面后重试。'
    },
    PERMISSION: {
        icon: 'lock',
        title: '没有操作权限',
        detail: '当前账号权限不足，请联系管理员开通。'
    },
    CONFLICT: {
        icon: 'alert',
        title: '内容冲突',
        detail: '数据可能已被他人修改，请刷新后重试。'
    },
    VALIDATION: {
        icon: 'alert',
        title: '提交的内容有误',
        detail: '请检查填写内容后重新提交。'
    },
    UNKNOWN: {
        icon: 'alert',
        title: '操作未能完成',
        detail: '发生未知错误，请稍后重试。'
    }
});

// —— SVG 图标（lucide 风格 stroke 图形，统一 24 viewBox、stroke=currentColor）——

const ICON_PATHS = {
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    offline: '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
    server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="9" y1="9" x2="13" y2="13"/><line x1="13" y1="9" x2="9" y2="13"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    retry: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
    back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'
};

/**
 * 创建内联 SVG 图标（template 解析天然产生 SVG 命名空间节点，免 createElementNS 手拼）
 * @param {string} name - ICON_PATHS 的键
 * @param {string} [cssClass] - 附加 class
 * @returns {SVGSVGElement}
 */
export function createErrorIcon(name, cssClass) {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const template = document.createElement('template');
    template.innerHTML =
        `<svg xmlns="${SVG_NS}" viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
        ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        (ICON_PATHS[name] || ICON_PATHS.alert) +
        '</svg>';
    const svg = template.content.firstElementChild;
    if (cssClass) svg.setAttribute('class', cssClass);
    return svg;
}

/**
 * 根据错误对象推断标准文案（ApiError / Error / 原始字符串均可）
 * @param {Error|ApiError|string|null} error
 * @param {string} [fallbackDetail] - 用服务端 message 作为详情时的兜底
 * @returns {{ key: string, icon: string, title: string, detail: string }}
 */
export function describeError(error, fallbackDetail = '') {
    const status = error && typeof error === 'object' ? error.status : undefined;
    let key = 'UNKNOWN';
    if (typeof error === 'string' && /网络|offline/i.test(error)) key = 'NETWORK';
    else if (status === 0 || (typeof navigator !== 'undefined' && navigator.onLine === false)) key = 'NETWORK';
    else if (status === 503 || status === 500 || status === 502 || status === 504) key = 'SERVER';
    else if (status === 404) key = 'NOT_FOUND';
    else if (status === 403) key = 'PERMISSION';
    else if (status === 409) key = 'CONFLICT';
    else if (status === 400 || status === 422) key = 'VALIDATION';

    const copy = ERROR_COPY[key];
    // 服务端 message 只作为详情补充，不覆盖标准标题，保证全站文案一致
    const serverMsg = error && typeof error === 'object' ? String(error.message || '').trim() : '';
    const detail = serverMsg && serverMsg !== copy.title ? serverMsg : (fallbackDetail || copy.detail);
    return { key, icon: copy.icon, title: copy.title, detail };
}

/**
 * 构建错误态卡片 DOM（L3/L4 共用）
 * @param {Object} [options]
 * @param {string}   [options.title]        - 标题（默认走标准文案）
 * @param {string}   [options.detail]       - 详情说明
 * @param {Error}    [options.error]        - 原始错误，用于推断标准文案与详情
 * @param {Function} [options.onRetry]      - 重试回调；提供时显示「重试」主按钮
 * @param {string}   [options.retryText='重试']
 * @param {Function} [options.onSecondary]  - 次操作回调（如返回）
 * @param {string}   [options.secondaryText='返回']
 * @param {boolean}  [options.page=false]   - true 时渲染为页面级错误屏（L4）
 * @param {boolean}  [options.compact=false] - true 时渲染为紧凑版（弹窗/小容器内使用）
 * @returns {HTMLElement}
 */
export function createErrorState(options = {}) {
    const {
        title,
        detail,
        error,
        onRetry,
        retryText = '重试',
        onSecondary,
        secondaryText = '返回',
        page = false,
        compact = false
    } = options;

    const described = describeError(error);

    const root = document.createElement('div');
    let rootClass = 'error-state';
    if (page) rootClass += ' error-state--page';
    if (compact) rootClass += ' error-state--compact';
    root.className = rootClass;
    root.setAttribute('role', 'alert');

    const iconWrap = document.createElement('div');
    iconWrap.className = 'error-state-icon';
    iconWrap.appendChild(createErrorIcon(described.icon));
    root.appendChild(iconWrap);

    const titleEl = document.createElement('p');
    titleEl.className = 'error-state-title';
    titleEl.textContent = title || described.title;
    root.appendChild(titleEl);

    const detailText = detail !== undefined ? detail : described.detail;
    if (detailText) {
        const detailEl = document.createElement('p');
        detailEl.className = 'error-state-detail';
        detailEl.textContent = detailText;
        root.appendChild(detailEl);
    }

    if (onRetry || onSecondary) {
        const actions = document.createElement('div');
        actions.className = 'error-state-actions';

        if (onRetry) {
            const retryBtn = document.createElement('button');
            retryBtn.type = 'button';
            retryBtn.className = 'error-state-btn';
            retryBtn.appendChild(createErrorIcon('retry'));
            retryBtn.appendChild(document.createTextNode(retryText));
            retryBtn.addEventListener('click', () => onRetry());
            actions.appendChild(retryBtn);
        }

        if (onSecondary) {
            const secondaryBtn = document.createElement('button');
            secondaryBtn.type = 'button';
            secondaryBtn.className = 'error-state-btn error-state-btn--ghost';
            secondaryBtn.appendChild(createErrorIcon('back'));
            secondaryBtn.appendChild(document.createTextNode(secondaryText));
            secondaryBtn.addEventListener('click', () => onSecondary());
            actions.appendChild(secondaryBtn);
        }

        root.appendChild(actions);
    }

    return root;
}

/**
 * 用错误态卡片替换容器内容
 * @param {HTMLElement|null} container
 * @param {Object} [options] - 同 createErrorState
 * @returns {HTMLElement|null} 渲染出的卡片
 */
export function renderErrorState(container, options = {}) {
    if (!container) return null;
    const card = createErrorState(options);
    container.replaceChildren(card);
    return card;
}

/**
 * 构建表格内错误行（colspan 占满，compact 布局）
 * @param {Object} [options]
 * @param {number}   [options.colspan=7]
 * @param {string}   [options.title]
 * @param {string}   [options.detail]     - 默认 null：表格内不显示详情，只保留标题+重试
 * @param {Error}    [options.error]
 * @param {Function} [options.onRetry]
 * @param {string}   [options.retryText='重试']
 * @returns {HTMLTableRowElement}
 */
export function createTableErrorRow(options = {}) {
    const {
        colspan = 7,
        title,
        detail = null,
        error,
        onRetry,
        retryText = '重试'
    } = options;

    const row = document.createElement('tr');
    row.className = 'table-error-row';

    const cell = document.createElement('td');
    cell.colSpan = Math.max(1, Number(colspan) || 1);

    const described = describeError(error);
    const card = createErrorState({
        title: title || described.title,
        detail,
        onRetry,
        retryText
    });
    // 表格行内去掉卡片默认竖排大间距，由 .table-error-row 的 CSS 接管
    card.classList.add('error-state--inline');

    cell.appendChild(card);
    row.appendChild(cell);
    return row;
}

/**
 * 渲染表格错误行到指定 tbody（替换已有内容）
 * @param {HTMLElement|null} tbody
 * @param {Object} [options] - 同 createTableErrorRow
 */
export function renderTableErrorRow(tbody, options = {}) {
    if (!tbody) return null;
    const row = createTableErrorRow(options);
    tbody.replaceChildren(row);
    return row;
}

// —— 暴露给非模块脚本（components/*.js、legacy-adapter.js）——
if (typeof window !== 'undefined') {
    window.ErrorUI = {
        ERROR_COPY,
        createErrorIcon,
        describeError,
        createErrorState,
        renderErrorState,
        createTableErrorRow,
        renderTableErrorRow
    };
}
