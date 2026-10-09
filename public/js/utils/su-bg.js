/**
 * 登录页苏堤底图注入器。
 *
 * 那 158 KB 的矢量图原来是内联在 `public/index.html` 里的（一个 158,274 字符的 `<svg>`）。
 * 登录页的 HTML 不能强缓存，于是每次打开登录页都要重传这 158 KB 装饰性字节；
 * `/assets/` 是长缓存，`/js/` 是 no-cache —— 把矢量移到 assets 就只在下一次真的改图时才重取。
 *
 * 为什么不能直接 `<img src="/assets/su-bg.svg">` 或 CSS `background-image`：
 * 图里有 5 处 `fill="var(--su-N,#hex)"`，而 SVG 作为**图片**加载时是独立文档，
 * 读不到宿主页面的 CSS 自定义属性 —— 那时它只会画成括号里内联的兜底色，
 * 三套主题（默认 / 暖沙 / 冷蓝）的覆盖全部失效。
 * 所以这里把 SVG 文本 fetch 回来注入进同一个文档，变量解析关系原样保留。
 *
 * 失败必须静默：底图拿不到时页面照常可登录，只是没有装饰层
 * （`.su-bg` 自带底色与顶部渐隐遮罩，不会露出硬边）。
 */
(function () {
    'use strict';

    function inject() {
        var host = document.querySelector('.su-bg');
        var img = host && host.querySelector('img[src]');
        if (!host || !img) return;
        if (host.querySelector('svg')) return;            // 已注入过就不重复取

        // 版本参数由服务端的 injectAssetVersion 打在 <img src> 上，这里原样沿用，
        // 所以不能用硬编码常量拼这个 URL
        var src = img.getAttribute('src');
        if (!src) return;

        fetch(src, { credentials: 'same-origin' })
            .then(function (res) { return res.ok ? res.text() : ''; })
            .then(function (text) {
                // 只接受真正的 svg 文本，避免把错误页当图塞进去。
                // 注入的源是本仓库自带的静态资产（/assets/su-bg.svg），不含任何用户数据或
                // 远端响应 —— insertAdjacentHTML 在这里的信任边界与 <img src> 等价。
                if (!text || text.indexOf('<svg') === -1) return;
                var svg = parseSvg(text);
                if (!svg) return;
                host.insertBefore(svg, img);
                img.remove();   // 载体已交接，留在 DOM 里只会多一次隐式请求语义
            })
            .catch(function () { /* 装饰层，静默失败 */ });
    }

    function parseSvg(text) {
        var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        var svg = doc.documentElement;
        if (!svg || svg.nodeName.toLowerCase() !== 'svg'
            || svg.getElementsByTagName('parsererror').length) {
            return null;
        }
        return document.importNode(svg, true);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject, { once: true });
    } else {
        inject();
    }
})();
