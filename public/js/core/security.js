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
export function escapeHtml(str) {
    if (typeof str !== 'string') {
        return '';
    }
    return str.replace(/[&<>"'`=/]/g, char => HTML_ENTITIES[char]);
}

/**
 * 安全地设置元素的文本内容
 * @param {HTMLElement} element - 目标元素
 * @param {string} text - 文本内容
 */
export function safeSetText(element, text) {
    if (!element) return;
    element.textContent = text || '';
}

/**
 * 安全地设置元素的HTML内容（带净化）
 * @param {HTMLElement} element - 目标元素
 * @param {string} html - HTML内容
 * @param {Object} options - 配置选项
 */
export function safeSetHTML(element, html, options = {}) {
    if (!element) return;

    if (typeof html !== 'string') {
        element.innerHTML = '';
        return;
    }

    const sanitized = sanitizeHtml(html, options);
    element.innerHTML = sanitized;
}

/**
 * 简易HTML净化器
 * @param {string} html - 原始HTML
 * @param {Object} options - 配置选项
 * @returns {string} 净化后的HTML
 */
export function sanitizeHtml(html, options = {}) {
    if (typeof html !== 'string') {
        return '';
    }

    const {
        allowedTags = ['b', 'i', 'u', 'strong', 'em', 'span', 'br', 'div', 'p', 'button', 'a', 'img', 'svg', 'path', 'g', 'circle', 'line', 'thead', 'tbody', 'tr', 'th', 'td', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'hr', 'label', 'input', 'select', 'option'],
        allowedAttributes = ['class', 'style', 'id', 'href', 'src', 'alt', 'title', 'target', 'viewbox', 'fill', 'xmlns', 'd', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'],
        allowedProtocols = ['http', 'https', 'mailto']
    } = options;

    let result = html;

    result = result.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    result = result.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
    result = result.replace(/on\w+\s*=\s*["'][^"']*["']/gi, '');
    result = result.replace(/javascript:/gi, '');
    result = result.replace(/vbscript:/gi, '');
    result = result.replace(/data:text\/html/gi, ''); // only block data:text/html but allow data:image hooks

    result = result.replace(/<([a-z][a-z0-9]*)\s*([^>]*)>/gi, (match, tagName, attributes) => {
        const lowerTagName = tagName.toLowerCase();

        if (!allowedTags.includes(lowerTagName)) {
            return '';
        }

        const safeAttributes = attributes.replace(/(\w+)\s*=\s*["']([^"']*)["']/gi,
            (attrMatch, attrName, attrValue) => {
                const lowerAttrName = attrName.toLowerCase();

                if (!allowedAttributes.includes(lowerAttrName) && !lowerAttrName.startsWith('data-') && !lowerAttrName.startsWith('aria-')) {
                    return '';
                }

                if (lowerAttrName === 'href' || lowerAttrName === 'src') {
                    const protocol = attrValue.split(':')[0].toLowerCase();
                    if (!allowedProtocols.includes(protocol) && !attrValue.startsWith('/') && !attrValue.startsWith('#')) {
                        return '';
                    }
                }

                if (lowerAttrName === 'style') {
                    if (attrValue.toLowerCase().includes('expression') ||
                        attrValue.toLowerCase().includes('javascript') ||
                        attrValue.toLowerCase().includes('url(')) {
                        return '';
                    }
                }

                return `${attrName}="${escapeHtml(attrValue)}"`;
            }
        );

        return `<${lowerTagName} ${safeAttributes}>`;
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
export function safeCreateElement(tag, className = '', options = {}) {
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
export function isSafeUrl(url) {
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
export function safeSetAttribute(element, name, value) {
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
export function safeAppendHTML(parent, html, options = {}) {
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
