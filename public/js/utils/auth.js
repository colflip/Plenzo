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

    checkAuth: function () {
        const authToken = window.apiUtils ? window.apiUtils.getAuthToken() : this.getAuthToken();
        if (!authToken) {
            window.location.href = '/index.html';
        }
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
            if (key.startsWith('classflow_admin_')) {
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
