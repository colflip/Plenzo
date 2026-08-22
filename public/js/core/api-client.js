/**
 * 前端API工具类
 * 提供标准化的数据交互和错误处理
 */

class ApiUtils {
    constructor() {
        this.baseURL = '/api';
        this.defaultHeaders = {
            'Content-Type': 'application/json'
        };
    }

    /**
     * 获取认证token
     * @description JWT 现由后端写入 httpOnly Cookie（JS 不可读），
     * 同源请求由浏览器自动携带 Cookie 完成鉴权，故此处不再持有令牌。
     */
    getAuthToken() {
        return null;
    }

    /**
     * 设置认证token
     * @description 不再于前端存储 JWT；Cookie 由后端在登录/刷新时设置。
     */
    setAuthToken(token) {
        // no-op：凭据存于 httpOnly Cookie
    }

    /**
     * 清除认证token
     */
    clearAuthToken() {
        localStorage.removeItem('authed');
        sessionStorage.removeItem('authed');
    }

    /**
     * 获取请求头
     * @description 不再注入 Authorization 头；Cookie 由浏览器随同源请求自动携带。
     */
    getHeaders(customHeaders = {}) {
        return { ...this.defaultHeaders, ...customHeaders };
    }

    /**
     * 标准化API请求
     */
    async request(url, options = {}) {
        const isFormData = options.body instanceof FormData;
        const { headers: customHeaders, ...restOptions } = options;
        const config = {
            method: 'GET',
            credentials: 'include',
            ...restOptions,
            headers: this.getHeaders(customHeaders)
        };

        // FormData 不设置 Content-Type，让浏览器自动设置 boundary
        if (isFormData) {
            delete config.headers['Content-Type'];
        }

        // 如果有body数据且不是FormData，转换为JSON
        if (config.body && !isFormData) {
            config.body = JSON.stringify(config.body);
        }

        try {
            const response = await fetch(`${this.baseURL}${url}`, config);
            let data = null;
            // 优雅解析：优先尝试JSON，其次文本
            try {
                data = await response.json();
            } catch (_) {
                try {
                    const text = await response.text();
                    data = text ? { message: text } : null;
                } catch (__) {
                    data = null;
                }
            }

            // 检查响应状态（含401过期）
            if (!response.ok) {
                const status = response.status;
                const serverMsg = (data && data.message) || '';
                const defaultMsg = this.friendlyMessageFromStatus(status);

                // 优化 401 消息逻辑：有后端消息优先用后端消息，否则才是令牌过期词
                let msg = serverMsg || defaultMsg || '请求失败';
                if (status === 401 && !serverMsg) {
                    msg = '认证令牌已过期，请重新登录';
                }

                const err = new ApiError(msg, status, data && data.errors, url);
                this.handleError(err, !options.suppressErrorToast, options.suppressConsole);

                // 令牌失效且当前处于受保护页面：跳回登录页，避免用户卡在报错态
                if (status === 401) {
                    const path = window.location.pathname || '';
                    const onDashboard = /\/(admin|teacher|student)(\/|$)/.test(path);
                    const onLogin = path.endsWith('/index.html') || path === '/' || path === '';
                    if (onDashboard && !onLogin) {
                        window.location.href = '/index.html';
                        return;
                    }
                }

                throw err;
            }

            // 检查业务逻辑状态
            if (data && data.success === false) {
                const errMsg = data.message || '操作失败';
                const err = new ApiError(errMsg, response.status, data.errors, url);
                this.handleError(err, !options.suppressErrorToast, options.suppressConsole);
                throw err;
            }

            return data;
        } catch (error) {
            if (error instanceof ApiError) {
                // 已由 handleError 处理
                throw error;
            }
            // 网络错误或其他错误
            const err = new ApiError('网络连接失败，请检查网络设置', 0, null, url);
            this.handleError(err, !options.suppressErrorToast);
            throw err;
        }
    }

    /**
     * GET请求
     */
    async get(url, params = {}, opts = {}) {
        const queryString = new URLSearchParams(params).toString();
        const fullUrl = queryString ? `${url}?${queryString}` : url;
        return this.request(fullUrl, opts);
    }

    /**
     * GET请求（静默模式：发生错误时不弹出Toast）
     */
    async getSilent(url, params = {}) {
        const queryString = new URLSearchParams(params).toString();
        const fullUrl = queryString ? `${url}?${queryString}` : url;
        return this.request(fullUrl, { suppressErrorToast: true });
    }

    /**
     * POST请求
     */
    async post(url, data = {}, opts = {}) {
        return this.request(url, {
            method: 'POST',
            body: data,
            ...opts
        });
    }

    /**
     * PUT请求
     */
    async put(url, data = {}, opts = {}) {
        return this.request(url, {
            method: 'PUT',
            body: data,
            ...opts
        });
    }

    /**
     * PATCH请求
     */
    async patch(url, data = {}, opts = {}) {
        return this.request(url, {
            method: 'PATCH',
            body: data,
            ...opts
        });
    }

    /**
     * DELETE请求
     */
    async delete(url, opts = {}) {
        return this.request(url, {
            method: 'DELETE',
            ...opts
        });
    }

    /**
     * 处理API错误
     */
    handleError(error, showToast = true, suppressConsole = true) {
        if (!suppressConsole) {
            console.error(`[API Error] ${error.endpoint || ''}: ${error.message}`, error);
        }

        if (showToast) {
            this.showErrorToast(error);
        }
    }

    /**
     * 从HTTP状态码获取友好的中文错误信息
     */
    friendlyMessageFromStatus(status) {
        switch (status) {
            case 400: return '数据验证失败，请检查填写内容';
            case 401: return '认证令牌已过期，请重新登录';
            case 403: return '权限级别不足，无法执行此操作';
            case 404: return '接口不存在或资源未找到';
            case 409: return '存在冲突：已存在相同安排或时间段冲突';
            case 500: return '服务器错误，请稍后重试';
            case 0: return '网络连接失败，请检查网络设置';
            default: return '请求失败，请稍后重试';
        }
    }

    /**
     * 显示错误提示
     */
    showErrorToast(error) {
        const message = error.message || '操作失败';
        // 如果有详细错误信息，显示第一个错误
        if (error.errors && error.errors.length > 0) {
            const firstError = error.errors[0];
            const field = firstError.field ? `${firstError.field}: ` : '';
            this.showToast(`${field}${firstError.message}`, 'error');
        } else {
            this.showToast(message, 'error');
        }
    }

    /**
     * 显示成功提示
     */
    showSuccessToast(message) {
        this.showToast(message, 'success');
    }

    /**
     * 显示提示消息（委托到统一 Toast 组件，带安全防护）
     */
    showToast(message, type = 'info') {
        if (window.Toast && typeof window.Toast.show === 'function') {
            return window.Toast.show(message, { type });
        }
        // Toast 组件尚未加载时的临时兜底
        console.warn('[Toast] 组件未就绪，延迟重试:', message);
        setTimeout(() => {
            if (window.Toast && typeof window.Toast.show === 'function') {
                window.Toast.show(message, { type });
            }
        }, 200);
    }

    /**
     * 隐藏提示消息
     * @param {HTMLElement} toast - showToast 返回的 toast 元素
     */
    hideToast(toast) {
        if (!toast) return;
        if (window.Toast && typeof window.Toast.hide === 'function') {
            window.Toast.hide(toast);
        }
    }

    /**
     * 数据验证工具
     */
    validate = {
        required: (value, fieldName) => {
            if (!value || (typeof value === 'string' && value.trim() === '')) {
                throw new ValidationError(`${fieldName}是必填项`);
            }
        },

        email: (value, fieldName = '邮箱') => {
            const re = /^[\w-.]+@([\w-]+\.)+[\w-]{2,4}$/;
            if (value && !re.test(value)) {
                throw new ValidationError(`${fieldName}格式不正确`);
            }
        },

        phone: (value, fieldName = '手机号') => {
            const re = /^(\+?\d{1,3})?1[3-9]\d{9}$/;
            if (value && !re.test(value)) {
                throw new ValidationError(`${fieldName}格式不正确`);
            }
        },

        minLength: (value, minLen, fieldName) => {
            if (value && value.length < minLen) {
                throw new ValidationError(`${fieldName}至少${minLen}个字符`);
            }
        },

        maxLength: (value, maxLen, fieldName) => {
            if (value && value.length > maxLen) {
                throw new ValidationError(`${fieldName}最多${maxLen}个字符`);
            }
        },

        time: (value, fieldName = '时间') => {
            const re = /^\d{2}:\d{2}$/;
            if (value && !re.test(value)) {
                throw new ValidationError(`${fieldName}格式不正确`);
            }
        },

        date: (value, fieldName = '日期') => {
            const re = /^\d{4}-\d{2}-\d{2}$/;
            if (value && !re.test(value)) {
                throw new ValidationError(`${fieldName}格式不正确`);
            }
        }
    };
}

class ApiError extends Error {
    constructor(message, status = 0, errors = null, endpoint = '') {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.errors = errors || null;
        this.endpoint = endpoint || '';
    }
}

class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
    }
}

window.apiUtils = new ApiUtils();
window.ApiError = ApiError;
window.ValidationError = ValidationError;
