/**
 * 安全工具函数
 * @description 提供XSS防护和HTML净化功能
 * @module utils/security
 */

/**
 * HTML实体编码映射
 */
const HTML_ENTITIES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
    '`': '&#x60;',
    '=': '&#x3D;'
};

/**
 * 转义HTML特殊字符
 * @param {string} str - 需要转义的字符串
 * @returns {string} 转义后的字符串
 */
function escapeHtml(str) {
    if (str == null) return '';
    if (typeof str !== 'string') str = String(str);
    return str.replace(/[&<>"'`=/]/g, char => HTML_ENTITIES[char]);
}

/**
 * 安全地设置元素的文本内容
 * @param {HTMLElement} element - 目标元素
 * @param {string} text - 文本内容
 */
function safeSetText(element, text) {
    if (!element) return;
    element.textContent = text || '';
}

/**
 * 安全地设置元素的HTML内容（带净化）
 * @param {HTMLElement} element - 目标元素
 * @param {string} html - HTML内容
 * @param {Object} options - 配置选项
 */
function safeSetHTML(element, html, options = {}) {
    if (!element) return;

    if (typeof html !== 'string') {
        element.innerHTML = '';
        return;
    }

    const sanitized = sanitizeHtml(html, options);
    element.innerHTML = sanitized;
}

/**
 * HTML净化器（基于 DOMParser 解析 + 白名单过滤）
 *
 * 设计目标：彻底消除旧版正则净化器对「未加引号的事件处理器」(如 onerror=alert(1))
 * 的绕过，以及原始标签碎片残留的问题。采用浏览器原生 DOMParser 构造 DOM 后遍历，
 * 所有不在白名单内的标签被移除内容、所有 on* 属性无条件剥离、href/src 仅允许安全协议。
 *
 * @param {string} html - 原始HTML
 * @param {Object} options - 配置选项
 * @returns {string} 净化后的HTML
 */
function sanitizeHtml(html, options = {}) {
    if (typeof html !== 'string') {
        return '';
    }

    const {
        allowedTags = ['b', 'i', 'u', 'strong', 'em', 'span', 'br', 'div', 'p', 'button', 'a', 'img', 'svg', 'path', 'g', 'circle', 'line', 'thead', 'tbody', 'tr', 'th', 'td', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'hr', 'label', 'input', 'select', 'option'],
        allowedAttributes = ['class', 'style', 'id', 'href', 'src', 'alt', 'title', 'target', 'viewbox', 'fill', 'xmlns', 'd', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'value', 'name', 'type', 'placeholder', 'disabled', 'readonly', 'checked', 'selected', 'colspan', 'rowspan', 'for', 'role', 'scope', 'headers', 'datetime', 'lang', 'align', 'valign', 'width', 'height', 'min', 'max', 'step', 'pattern', 'required', 'multiple', 'accept', 'autocomplete', 'rows', 'cols', 'maxlength', 'minlength', 'wrap', 'controls', 'autoplay', 'muted', 'loop', 'poster', 'open', 'hidden', 'span'],
        allowedProtocols = ['http', 'https', 'mailto']
    } = options;

    // 非浏览器环境（如 node 测试且未提供 jsdom）回退到保守的正则净化，避免崩溃。
    if (typeof DOMParser === 'undefined') {
        return sanitizeHtmlFallback(html, { allowedTags, allowedAttributes, allowedProtocols });
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html');
    const body = doc.body;

    // 递归清洗：移除不允许的标签（含其内容），剥离危险属性。
    const cleanNode = (node) => {
        // 从后往前遍历子元素，避免遍历中改动影响索引。
        const children = Array.from(node.children);
        for (const el of children) {
            const tag = el.tagName.toLowerCase();
            if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
                // 危险容器：整体移除，不保留内容。
                el.remove();
                continue;
            }
            if (!allowedTags.includes(tag)) {
                // 普通非白名单标签：移除标签本身但保留其已清洗的子节点（unwrap）。
                cleanNode(el);
                while (el.firstChild) {
                    node.insertBefore(el.firstChild, el);
                }
                el.remove();
                continue;
            }

            // 清洗属性
            const attrs = Array.from(el.attributes);
            for (const attr of attrs) {
                const name = attr.name.toLowerCase();
                const value = attr.value;

                // 1) 任何事件处理器（on*）一律剥离，无论是否带引号。
                if (name.startsWith('on')) {
                    el.removeAttribute(attr.name);
                    continue;
                }
                // 2) 非白名单属性（且非 data-/aria- 命名空间）剥离。
                if (!allowedAttributes.includes(name) && !name.startsWith('data-') && !name.startsWith('aria-')) {
                    el.removeAttribute(attr.name);
                    continue;
                }
                // 3) href/src 协议校验。
                if (name === 'href' || name === 'src') {
                    const v = value.trim();
                    if (/^\s*(javascript|vbscript):/i.test(v)) {
                        el.removeAttribute(attr.name);
                        continue;
                    }
                    const proto = v.split(':')[0].toLowerCase();
                    const isRelative = v.startsWith('/') || v.startsWith('#') || v.startsWith('?');
                    const isSafeData = name === 'src' && /^data:image\//i.test(v);
                    if (!allowedProtocols.includes(proto) && !isRelative && !isSafeData) {
                        el.removeAttribute(attr.name);
                        continue;
                    }
                }
                // 4) style：阻断危险 CSS（expression/JS/behavior/@import），
                //    以及任何指向远程或 data: 的 url() 引用。
                //    CSP 的 nonce 不适用于内联 style 属性，故在此输入边界兜底，
                //    关闭"借 background:url() 外带用户数据"的 CSS 注入通道。
                //    url(#id) 这类本地片段引用（SVG 渐变/滤镜）予以保留。
                if (name === 'style') {
                    const v = value.toLowerCase();
                    if (v.includes('expression') || v.includes('javascript') ||
                        v.includes('vbscript') || v.includes('behavior') || v.includes('@import') ||
                        /\burl\(\s*['"]?\s*(https?:|\/\/|data:)/i.test(v)) {
                        el.removeAttribute(attr.name);
                        continue;
                    }
                }
            }

            cleanNode(el);
        }
    };

    cleanNode(body);
    return body.innerHTML;
}

/**
 * 非 DOM 环境的保守回退净化器（仅在 node 且缺失 DOMParser 时使用）。
 */
function sanitizeHtmlFallback(html, { allowedTags, allowedAttributes, allowedProtocols }) {
    let result = html;
    result = result.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    result = result.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
    // 剥离所有事件处理器（带或不带引号）。
    result = result.replace(/\son\w+\s*=\s*("([^"]*)"|'([^']*)'|[^>\s]+)/gi, '');
    result = result.replace(/javascript:/gi, '');
    result = result.replace(/vbscript:/gi, '');
    result = result.replace(/data:text\/html/gi, '');

    result = result.replace(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi, (match, tagName, attributes) => {
        const lowerTagName = tagName.toLowerCase();
        if (!allowedTags.includes(lowerTagName)) return '';

        let safeAttributes = attributes;
        safeAttributes = safeAttributes.replace(/\s+on\w+\s*=\s*("([^"]*)"|'([^']*)'|[^>\s]+)/gi, '');
        safeAttributes = safeAttributes.replace(/([\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/gi,
            (attrMatch, attrName, _q1, attrValue) => {
                const lowerAttrName = attrName.toLowerCase();
                if (!allowedAttributes.includes(lowerAttrName) && !lowerAttrName.startsWith('data-') && !lowerAttrName.startsWith('aria-')) {
                    return '';
                }
                if (lowerAttrName === 'href' || lowerAttrName === 'src') {
                    const v = (attrValue || '').trim();
                    if (/^\s*(javascript|vbscript):/i.test(v)) return '';
                    const proto = v.split(':')[0].toLowerCase();
                    if (!allowedProtocols.includes(proto) && !v.startsWith('/') && !v.startsWith('#')) return '';
                }
                if (lowerAttrName === 'style') {
                    const v = (attrValue || '').toLowerCase();
                    if (v.includes('expression') || v.includes('javascript') || v.includes('behavior') || v.includes('@import') ||
                        /\burl\(\s*['"]?\s*(https?:|\/\/|data:)/i.test(v)) return '';
                }
                return `${attrName}="${escapeHtml(attrValue)}"`;
            }
        );
        return `<${lowerTagName}${safeAttributes}>`;
    });

    return result;
}

/**
 * 安全地创建元素
 * @param {string} tag - 标签名
 * @param {string} className - CSS类名
 * @param {Object} options - 配置选项
 * @returns {HTMLElement} 创建的元素
 */
function safeCreateElement(tag, className = '', options = {}) {
    const element = document.createElement(tag);

    if (className) {
        element.className = className;
    }

    if (options.textContent !== undefined) {
        safeSetText(element, options.textContent);
    } else if (options.innerHTML !== undefined) {
        safeSetHTML(element, options.innerHTML, options.sanitizeOptions);
    }

    if (options.style && typeof options.style === 'object') {
        Object.assign(element.style, options.style);
    }

    if (options.attributes && typeof options.attributes === 'object') {
        for (const [key, value] of Object.entries(options.attributes)) {
            element.setAttribute(key, value);
        }
    }

    return element;
}

/**
 * 验证URL是否安全
 * @param {string} url - 需要验证的URL
 * @returns {boolean} 是否安全
 */
function isSafeUrl(url) {
    if (typeof url !== 'string') {
        return false;
    }

    const safeProtocols = ['http:', 'https:', 'mailto:'];
    const dangerousPatterns = [
        /javascript:/i,
        /vbscript:/i,
        /data:/i,
        /on\w+=/i
    ];

    try {
        if (url.startsWith('/') || url.startsWith('#')) {
            return true;
        }

        const parsedUrl = new URL(url, window.location.origin);

        if (!safeProtocols.includes(parsedUrl.protocol)) {
            return false;
        }

        for (const pattern of dangerousPatterns) {
            if (pattern.test(url)) {
                return false;
            }
        }

        return true;
    } catch {
        return false;
    }
}

/**
 * 安全地设置元素属性
 * @param {HTMLElement} element - 目标元素
 * @param {string} name - 属性名
 * @param {string} value - 属性值
 */
function safeSetAttribute(element, name, value) {
    if (!element || !name) return;

    const dangerousAttrs = ['onclick', 'onerror', 'onload', 'onmouseover', 'onfocus', 'onblur'];
    const lowerName = name.toLowerCase();

    if (dangerousAttrs.includes(lowerName)) {
        
        return;
    }

    if (lowerName === 'href' || lowerName === 'src') {
        if (!isSafeUrl(value)) {
            
            return;
        }
    }

    element.setAttribute(name, value);
}

/**
 * 安全地追加HTML内容
 * @param {HTMLElement} parent - 父元素
 * @param {string} html - HTML内容
 * @param {Object} options - 净化选项
 */
function safeAppendHTML(parent, html, options = {}) {
    if (!parent) return;

    const template = document.createElement('template');
    safeSetHTML(template.content, html, options);
    parent.appendChild(template.content.cloneNode(true));
}

window.SecurityUtils = {
    escapeHtml,
    safeSetText,
    safeSetHTML,
    sanitizeHtml,
    safeCreateElement,
    isSafeUrl,
    safeSetAttribute,
    safeAppendHTML
};
