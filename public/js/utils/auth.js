window.authUtils = {
    /**
     * 获取认证token（同时检查localStorage和sessionStorage）
     * @returns {string|null}
     */
    getAuthToken: function () {
        // 优先检查 localStorage（持久化存储）
        const token = localStorage.getItem('token');
        if (token) return token;
        // 其次检查 sessionStorage（会话存储）
        return sessionStorage.getItem('tempToken');
    },

    /**
     * 校验登录态及角色
     * @param {string} [expectedUserType] - 期望的用户类型 ('admin'|'teacher'|'student')，不传则只校验 token 存在
     * @returns {boolean} 是否通过校验（未通过时内部已跳转登录页）
     */
    checkAuth: function (expectedUserType) {
        const authToken = window.apiUtils ? window.apiUtils.getAuthToken() : this.getAuthToken();
        if (!authToken) {
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
     * 清除认证token（同时清除两种存储）
     */
    clearAuthToken: function () {
        localStorage.removeItem('token');
        sessionStorage.removeItem('tempToken');
    },

    logout: function () {
        // Clear Schedule Cache
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith('plenzo_admin_')) {
                localStorage.removeItem(key);
            }
        });

        this.clearAuthToken();
        localStorage.removeItem('userType');
        localStorage.removeItem('userData');
        window.location.href = '/index.html';
    }
};

// Expose globally for backward compatibility
window.checkAuth = window.authUtils.checkAuth;
window.logout = window.authUtils.logout;
