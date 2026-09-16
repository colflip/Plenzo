/**
 * 404 页的「返回上页」按钮。
 * @description 原实现是 href="javascript:history.back()"，在 CSP 强制（script-src 'self'、
 *              无 'unsafe-inline'）后会被拦截，所以改成外链脚本绑定。
 *              脚本未加载时该链接退化为返回首页（href="/"），不会成为死链。
 */
(function () {
    'use strict';
    document.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-action="go-back"]') : null;
        if (!btn) return;
        e.preventDefault();
        history.back();
    });
})();
