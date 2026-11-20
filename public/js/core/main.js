/**
 * Main Application Entry Point (Login Page)
 */

const REMEMBERED_USERNAME_KEY = 'rememberedUsername';
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
    document.querySelectorAll('.custom-option').forEach(opt => {
        opt.classList.remove('selected');
        opt.setAttribute('aria-selected', 'false');
    });
    option.classList.add('selected');
    option.setAttribute('aria-selected', 'true');

    const triggerText = document.getElementById('customSelectText');
    if (triggerText) triggerText.textContent = option.textContent;
}

/**
 * Initialize Custom Select Dropdown
 *
 * 原生 select 被 display:none 藏起，只做表单值载体；可访问性靠自定义 trigger 的
 * combobox 语义 + 完整键盘操作（Enter/Space 展开、上下键移动、Enter 选中、Esc 关闭）。
 * 焦点始终留在 trigger 上，用 aria-activedescendant 指向当前高亮项。
 */
function initCustomSelect() {
    const wrapper = document.querySelector('.custom-select-wrapper');
    if (!wrapper) return;

    const trigger = wrapper.querySelector('.custom-select-trigger');
    const options = wrapper.querySelectorAll('.custom-option');
    const hiddenSelect = document.getElementById('userType');
    const triggerText = document.querySelector('#customSelectText');
    if (!trigger) return;

    // Restore last selected user type from localStorage
    try {
        const saved = localStorage.getItem(LAST_USER_TYPE_KEY);
        if (saved && document.querySelector(`.custom-option[data-value="${saved}"]`)) {
            applyUserType(saved);
        }
    } catch (e) { /* ignore storage errors */ }

    let activeIndex = 0;

    const isOpen = () => wrapper.classList.contains('open');

    const setActive = (index) => {
        const list = Array.from(options);
        if (list.length === 0) return;
        activeIndex = (index + list.length) % list.length;
        list.forEach((opt, i) => {
            if (i === activeIndex) {
                opt.classList.add('active');
                trigger.setAttribute('aria-activedescendant', opt.id || '');
            } else {
                opt.classList.remove('active');
            }
        });
    };

    const open = () => {
        wrapper.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
        const selected = Array.from(options).findIndex(o => o.classList.contains('selected'));
        setActive(selected >= 0 ? selected : 0);
    };

    const close = () => {
        wrapper.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.removeAttribute('aria-activedescendant');
    };

    const selectOption = (option) => {
        if (!option) return;
        const value = option.dataset.value;
        const text = option.textContent;

        // Update UI
        triggerText.textContent = text;
        close();

        // Update active state
        options.forEach(opt => {
            opt.classList.remove('selected');
            opt.setAttribute('aria-selected', 'false');
        });
        option.classList.add('selected');
        option.setAttribute('aria-selected', 'true');

        // Update hidden select
        if (hiddenSelect) {
            hiddenSelect.value = value;
            // Trigger change event if needed
            hiddenSelect.dispatchEvent(new Event('change'));
        }
    };

    // Toggle dropdown
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isOpen()) {
            close();
        } else {
            open();
        }
    });

    // Keyboard operation（外接键盘 / 读屏 / 开关控制）
    trigger.addEventListener('keydown', (e) => {
        switch (e.key) {
            case 'Enter':
            case ' ':
            case 'Spacebar':
                e.preventDefault();
                if (isOpen()) {
                    selectOption(options[activeIndex]);
                } else {
                    open();
                }
                break;
            case 'ArrowDown':
                e.preventDefault();
                if (!isOpen()) open(); else setActive(activeIndex + 1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                if (!isOpen()) open(); else setActive(activeIndex - 1);
                break;
            case 'Escape':
                if (isOpen()) {
                    e.preventDefault();
                    close();
                }
                break;
            case 'Tab':
                // Tab 离开时收起，焦点不留在浮层里
                close();
                break;
            default:
                break;
        }
    });

    // Handle option selection
    options.forEach(option => {
        option.addEventListener('click', () => {
            selectOption(option);
            trigger.focus();
        });
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
        if (!wrapper.contains(e.target)) {
            close();
        }
    });
}

/**
 * Initialize "Remember Me" checkbox
 */
function initRememberMe() {
    const checkbox = document.getElementById('rememberMe');
    if (!checkbox) return;
    const usernameInput = document.getElementById('username');

    // Restore remembered username from localStorage
    try {
        const rememberedUsername = localStorage.getItem(REMEMBERED_USERNAME_KEY);
        if (rememberedUsername) {
            usernameInput.value = rememberedUsername;
            checkbox.checked = true;
        }
    } catch (e) { /* ignore storage errors */ }

    // Sync checkbox state on change
    checkbox.addEventListener('change', () => {
        try {
            if (!checkbox.checked) {
                // Unchecked: clear remembered username
                localStorage.removeItem(REMEMBERED_USERNAME_KEY);
            }
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

        if (!window.apiUtils) {
            showError('登录服务尚未加载，请刷新页面重试');
            return;
        }

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
            const data = await window.apiUtils.post('/auth/login', {
                username,
                password,
                userType,
                rememberMe
            });

            // Success
            if (data.token || data.user) {
                // P1-5：JWT 由后端写入 httpOnly Cookie，前端不再将令牌存入 localStorage。
                // 'authed' 仅作 JS 侧登录态标志（UX 判断），真实凭据不可被 JS 读取。
                if (rememberMe) {
                    localStorage.setItem('authed', '1');
                } else {
                    sessionStorage.setItem('authed', '1');
                }

                localStorage.setItem('userType', userType);
                localStorage.setItem(LAST_USER_TYPE_KEY, userType);
                if (data.user) {
                    localStorage.setItem('userData', JSON.stringify(data.user));
                }

                // Save remembered username on successful login
                if (rememberMe) {
                    localStorage.setItem(REMEMBERED_USERNAME_KEY, username);
                }

                // Redirect based on role
                const redirectMap = {
                    admin: '/admin/dashboard',
                    teacher: '/teacher/dashboard',
                    student: '/student/dashboard'
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
            const textEl = errorMessage.querySelector('#errorMessageText');
            if (textEl) textEl.textContent = msg;
            else errorMessage.textContent = msg;
            errorMessage.style.display = 'flex';
            // Slight shake animation
            const card = document.querySelector('.login-card');
            if (card) {
                card.classList.add('shake');
                setTimeout(() => card.classList.remove('shake'), 500);
            }
        } else if (window.Toast) {
            window.Toast.error(msg);
        }
    }

    function hideError() {
        if (errorMessage) {
            errorMessage.style.display = 'none';
        }
    }
}
