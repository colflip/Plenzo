window.authUtils = {
    /**
     * 获取认证token
     * @description JWT 现存储于 httpOnly Cookie（JS 不可读），故返回 null。
     * 真正的鉴权由浏览器随同源请求自动携带的 Cookie 完成。
     * @returns {null}
     */
    getAuthToken: function () {
        return null;
    },

    /**
     * 校验登录态及角色
     * @param {string} [expectedUserType] - 期望的用户类型 ('admin'|'teacher'|'student')
     * @returns {boolean} 是否通过校验（未通过时内部已跳转登录页）
     */
    checkAuth: function (expectedUserType) {
        // 凭据在 httpOnly Cookie 中，JS 不可读；此处仅以 'authed' 标志判断 UX 登录态，
        // 真实鉴权由后端基于 Cookie 强制执行（标志被篡改只会导致 API 401，不会越权）。
        const authed = localStorage.getItem('authed') || sessionStorage.getItem('authed');
        if (!authed) {
            window.location.href = '/index.html';
            return false;
        }
        if (expectedUserType) {
            const userType = localStorage.getItem('userType');
            if (userType !== expectedUserType) {
                // 身份不匹配（如非管理员打开了管理后台）：跳回登录页，避免后端 403 误报"权限错误"
                window.location.href = '/index.html';
                return false;
            }
        }
        return true;
    },

    /**
     * 清除登录态标志（真实 Cookie 由后端 /api/auth/logout 清除）
     */
    clearAuthToken: function () {
        localStorage.removeItem('authed');
        sessionStorage.removeItem('authed');
    },

    logout: function () {
        // 清除前端缓存
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith('plenzo_admin_')) {
                localStorage.removeItem(key);
            }
        });

        this.clearAuthToken();
        localStorage.removeItem('userType');
        localStorage.removeItem('userData');

        // 通知后端清除 httpOnly Cookie（同源请求自动携带 Cookie）
        try {
            fetch('/api/auth/logout', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' }
            }).catch(() => {});
        } catch (_) { /* ignore */ }

        window.location.href = '/index.html';
    }
};

// Expose globally for backward compatibility
window.checkAuth = window.authUtils.checkAuth;
window.logout = window.authUtils.logout;
