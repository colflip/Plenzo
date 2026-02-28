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
     */
    getAuthToken() {
        return localStorage.getItem('token');
    }

    /**
     * 设置认证token
     */
    setAuthToken(token) {
        localStorage.setItem('token', token);
    }

    /**
     * 清除认证token
     */
    clearAuthToken() {
        localStorage.removeItem('token');
    }

    /**
     * 获取请求头
     */
    getHeaders(customHeaders = {}) {
        const headers = { ...this.defaultHeaders, ...customHeaders };
        const token = this.getAuthToken();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        return headers;
    }

    /**
     * 标准化API请求
     */
    async request(url, options = {}) {
        const config = {
            method: 'GET',
            headers: this.getHeaders(options.headers),
            ...options
        };

        // 如果有body数据且不是FormData，转换为JSON
        if (config.body && !(config.body instanceof FormData)) {
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
    handleError(error, showToast = true, suppressConsole = false) {
        if (!suppressConsole) {
            console.error('API Error:', error);
        }

        // 401先提示再跳转
        if (error.status === 401) {
            if (showToast) this.showErrorToast(error);

            // 如果是登录接口，不执行清除和跳转词
            if (error.endpoint && (error.endpoint.includes('/auth/login') || error.endpoint.includes('/login'))) {
                return error;
            }

            this.clearAuthToken();
            // 如果不在首页，则跳转到首页词
            if (window.location.pathname !== '/' && window.location.pathname !== '/index.html') {
                window.location.href = '/';
            }
            return error;
        }

        if (showToast) {
            // 更友好的错误文案（附带服务器返回细节）
            const statusMsg = this.friendlyMessageFromStatus(error.status);
            let message = error.message || statusMsg || '操作失败';

            // 附带后端 validation errors 第一个错误提示
            if (error.errors && error.errors.length > 0) {
                const firstError = error.errors[0];
                const field = firstError.field ? `${firstError.field}: ` : '';
                message = `${field}${firstError.message}`;
            }

            // 附带接口路径信息（调试更方便）
            if (error.endpoint) {
                message = `${message}（接口：${error.endpoint}）`;
            }

            this.showToast(message, 'error');
        }

        return error;
    }

    /**
     * 不同状态码的友好提示
     */
    friendlyMessageFromStatus(status) {
        switch (status) {
            case 400: return '数据验证失败，请检查填写内容';
            case 401: return '认证令牌已过期，请重新登录';
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
     * 显示提示消息
     */
    showToast(message, type = 'info') {
        // 创建toast元素
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;

        // 添加样式
        Object.assign(toast.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            padding: '12px 20px',
            borderRadius: '4px',
            color: 'white',
            fontSize: '14px',
            zIndex: '10000',
            maxWidth: '380px',
            wordWrap: 'break-word',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            transform: 'translateX(100%)',
            transition: 'transform 0.3s ease-in-out'
        });

        // 设置背景色
        const colors = {
            success: '#4CAF50',
            error: '#F44336',
            warning: '#FF9800',
            info: '#89C9B8' /* 统一去蓝化，使用青绿信息色 */
        };
        toast.style.backgroundColor = colors[type] || colors.info;

        // 添加到页面
        document.body.appendChild(toast);

        // 显示动画
        setTimeout(() => {
            toast.style.transform = 'translateX(0)';
        }, 100);

        // 自动隐藏
        setTimeout(() => {
            toast.style.transform = 'translateX(100%)';
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 300);
        }, 3000);
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
