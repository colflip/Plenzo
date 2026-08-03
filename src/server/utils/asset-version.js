/**
 * 静态资源版本化工具。
 *
 * 部署后通过给 HTML 中的本地 /js、/css 引用注入 ?v=<version> 参数，
 * 配合静态资源长缓存（maxAge:1d + ETag）确保浏览器在版本变化时立即拉取新模块，
 * 避免"改了代码但用户仍跑旧脚本"以及新旧模块混用破坏 EventBus / 全局约定。
 */

// 匹配本地资源引用：src="/js/..." 或 href="/css/..."（含已带 ?v= 的情况）。
// 不匹配：协议绝对路径（http://、https://、//）、data: URI、外链 CDN。
const ASSET_REF_RE = /(src|href)="(\/(?:js|css|assets)\/[^"?#]+?)(\?[^"#]*)?"/g;

/**
 * 给 HTML 中所有本地 /js、/css、/assets 引用注入或替换版本参数。
 * @param {string} html 原始 HTML
 * @param {string} version 版本号（通常取 git shortSha）
 * @returns {string} 注入版本后的 HTML
 */
function injectAssetVersion(html, version) {
    if (!html || typeof html !== 'string') return html || '';
    const safeVersion = String(version == null ? '' : version).trim();
    if (!safeVersion) return html;

    return html.replace(ASSET_REF_RE, (_match, attr, path, existingQuery) => {
        // 已带版本参数则替换为新版本（幂等，重复注入不叠加）。
        if (existingQuery) {
            const replaced = existingQuery.replace(/([?&]v=)[^&]*/, `$1${safeVersion}`);
            if (replaced !== existingQuery) return `${attr}="${path}${replaced}"`;
            return `${attr}="${path}${existingQuery}&v=${safeVersion}"`;
        }
        return `${attr}="${path}?v=${safeVersion}"`;
    });
}

module.exports = {
    injectAssetVersion,
    ASSET_REF_RE
};
