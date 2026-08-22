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
