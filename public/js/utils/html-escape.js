/**
 * HTML 文本/属性转义（ESM 版，供 modules/** 直接 import）。
 *
 * core/security.js 里已有同名实现，但那是挂 window.SecurityUtils 的经典脚本；
 * ESM 模块在 `import` 图里拿不到它的局部函数，过去各渲染点于是要么不转义、
 * 要么就地再抄一遍（审查报告 P1-11 的 6 个注入点都是这么漏掉的）。
 * 规则与 core/security.js 一致，覆盖文本节点与带引号属性两种上下文。
 */
const HTML_ENTITIES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#96;',
    '=': '&#61;',
    '/': '&#47;'
};

/**
 * @param {*} value 任意值；null/undefined 转空串
 * @returns {string} 可安全插入 innerHTML 模板的文本
 */
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    const str = typeof value === 'string' ? value : String(value);
    return str.replace(/[&<>"'`=/]/g, (char) => HTML_ENTITIES[char]);
}

export default escapeHtml;
