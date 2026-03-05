window.authUtils = {
    checkAuth: function () {
        const authToken = window.apiUtils ? window.apiUtils.getAuthToken() : localStorage.getItem('token');
        if (!authToken) {
            window.location.href = '/index.html';
        }
    },
    logout: function () {
        // Clear Schedule Cache
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith('schedule_widget_admin_')) {
                localStorage.removeItem(key);
            }
        });

        localStorage.removeItem('token');
        localStorage.removeItem('userType');
        localStorage.removeItem('userData');
        window.location.href = '/index.html';
    }
};

// Expose globally for backward compatibility
window.checkAuth = window.authUtils.checkAuth;
window.logout = window.authUtils.logout;
