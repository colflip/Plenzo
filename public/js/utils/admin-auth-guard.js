/**
 * 管理端页面守卫（经典脚本，最先加载）
 * @description 未登录或当前用户不是管理员时立即跳转登录页，避免受保护页面闪现。
 */
(function () {
    'use strict';
    try {
        var authed = localStorage.getItem('authed') || sessionStorage.getItem('authed');
        var userType = localStorage.getItem('userType');
        if (!authed || userType !== 'admin') {
            window.location.replace('/index.html');
        }
    } catch (e) { /* 解析异常时交由后续逻辑处理 */ }
})();
