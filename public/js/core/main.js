/**
 * Main Application Entry Point (Login Page)
 */

const LAST_USER_TYPE_KEY = 'lastUserType';

document.addEventListener('DOMContentLoaded', () => {
    initCustomSelect();
    initRememberMe();
    initLogin();
});

/**
 * Apply a userType value to both the hidden select and the custom dropdown UI.
 */
function applyUserType(value) {
    const hiddenSelect = document.getElementById('userType');
    if (!hiddenSelect) return;

    const option = document.querySelector(`.custom-option[data-value="${value}"]`);
    if (!option) return;

    hiddenSelect.value = value;
    document.querySelectorAll('.custom-option').forEach(opt => opt.classList.remove('selected'));
    option.classList.add('selected');

    const triggerText = document.getElementById('customSelectText');
    if (triggerText) triggerText.textContent = option.textContent;
}

/**
 * Initialize Custom Select Dropdown
 */
function initCustomSelect() {
    const wrapper = document.querySelector('.custom-select-wrapper');
    if (!wrapper) return;

    const trigger = wrapper.querySelector('.custom-select-trigger');
    const options = wrapper.querySelectorAll('.custom-option');
    const hiddenSelect = document.getElementById('userType');
    const triggerText = document.querySelector('#customSelectText');

    // Restore last selected user type from localStorage
    try {
        const saved = localStorage.getItem(LAST_USER_TYPE_KEY);
        if (saved && document.querySelector(`.custom-option[data-value="${saved}"]`)) {
            applyUserType(saved);
        }
    } catch (e) { /* ignore storage errors */ }

    // Toggle dropdown
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        wrapper.classList.toggle('open');
    });

    // Handle option selection
    options.forEach(option => {
        option.addEventListener('click', () => {
            const value = option.dataset.value;
            const text = option.textContent;

            // Update UI
            triggerText.textContent = text;
            wrapper.classList.remove('open');

            // Update active state
            options.forEach(opt => opt.classList.remove('selected'));
            option.classList.add('selected');

            // Update hidden select
            if (hiddenSelect) {
                hiddenSelect.value = value;
                // Trigger change event if needed
                hiddenSelect.dispatchEvent(new Event('change'));
            }
        });
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
        if (!wrapper.contains(e.target)) {
            wrapper.classList.remove('open');
        }
    });
}

/**
 * Initialize "Remember Me" checkbox
 */
function initRememberMe() {
    const checkbox = document.getElementById('rememberMe');
    if (!checkbox) return;

    try {
        // If user was previously "remembered", auto-check the box
        const remembered = sessionStorage.getItem('rememberMeState');
        if (remembered === 'true') {
            checkbox.checked = true;
        }
    } catch (e) { /* ignore storage errors */ }

    // Sync icon state on change
    checkbox.addEventListener('change', () => {
        try {
            sessionStorage.setItem('rememberMeState', checkbox.checked ? 'true' : 'false');
        } catch (e) { /* ignore */ }
    });
}

/**
 * Initialize Login Logic
 */
function initLogin() {
    const loginBtn = document.getElementById('loginBtn');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const rememberMeCheckbox = document.getElementById('rememberMe');
    const userTypeSelect = document.getElementById('userType');
    const errorMessage = document.getElementById('errorMessage');

    if (!loginBtn || !usernameInput || !passwordInput) return;

    // Handle Enter key
    const handleEnter = (e) => {
        if (e.key === 'Enter') {
            loginBtn.click();
        }
    };
    usernameInput.addEventListener('keypress', handleEnter);
    passwordInput.addEventListener('keypress', handleEnter);

    loginBtn.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        const password = passwordInput.value.trim();
        const userType = userTypeSelect.value; // teacher, student, admin
        const rememberMe = rememberMeCheckbox ? rememberMeCheckbox.checked : false;

        // Simple validation
        if (!username || !password) {
            showError('请输入用户名和密码');
            return;
        }

        // Loading state
        const originalText = loginBtn.textContent;
        loginBtn.disabled = true;
        loginBtn.textContent = '登录中...';
        hideError();

        try {
            // Use apiUtils if available, otherwise fallback to fetch
            let data;

            if (window.apiUtils) {
                try {
                    data = await window.apiUtils.post('/auth/login', {
                        username,
                        password,
                        userType,
                        rememberMe
                    });
                } catch (err) {
                    throw err; // Re-throw to be caught by outer catch
                }
            } else {
                // Fallback implementation
                const response = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password, userType, rememberMe })
                });

                data = await response.json();

                if (!response.ok) {
                    throw new Error(data.message || '登录失败');
                }
            }

            // Success
            if (data.token) {
                if (rememberMe) {
                    // Use localStorage for persistent session
                    localStorage.setItem('token', data.token);
                    // Remove sessionStorage token if it exists, to avoid confusion
                    sessionStorage.removeItem('tempToken');
                } else {
                    // Use sessionStorage for session-only (clears on browser close)
                    sessionStorage.setItem('tempToken', data.token);
                    localStorage.removeItem('token');
                }

                localStorage.setItem('userType', userType);
                localStorage.setItem(LAST_USER_TYPE_KEY, userType);
                if (data.user) {
                    localStorage.setItem('userData', JSON.stringify(data.user));
                }

                // Redirect based on role
                const redirectMap = {
                    admin: '/admin/dashboard.html',
                    teacher: '/teacher/dashboard.html',
                    student: '/student/dashboard.html'
                };

                window.location.href = redirectMap[userType] || '/';
            } else {
                throw new Error('服务器未返回认证令牌');
            }

        } catch (error) {
            showError(error.message || '登录失败，请检查用户名或密码');
        } finally {
            loginBtn.disabled = false;
            loginBtn.textContent = originalText;
        }
    });

    function showError(msg) {
        if (errorMessage) {
            errorMessage.textContent = msg;
            errorMessage.style.display = 'block';
            // Slight shake animation
            const card = document.querySelector('.login-card');
            if (card) {
                card.classList.add('shake');
                setTimeout(() => card.classList.remove('shake'), 500);
            }
        } else {
            alert(msg);
        }
    }

    function hideError() {
        if (errorMessage) {
            errorMessage.style.display = 'none';
        }
    }
}
