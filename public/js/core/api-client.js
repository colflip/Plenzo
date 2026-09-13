const AUTH_ERROR_CODES = new Set([
    'AUTH_REQUIRED',
    'AUTH_INVALID',
    'AUTH_EXPIRED',
    'SESSION_EPOCH_MISMATCH'
]);

class ApiError extends Error {
    constructor(options = {}) {
        super(options.message || '请求失败，请稍后重试');
        this.name = 'ApiError';
        this.code = options.code || 'REQUEST_FAILED';
        this.status = Number.isInteger(options.status) ? options.status : 0;
        this.details = Array.isArray(options.details) ? options.details : [];
        this.errors = this.details;
        this.retryable = options.retryable === true;
        this.retryAfterSeconds = Number.isInteger(options.retryAfterSeconds)
            ? options.retryAfterSeconds
            : null;
        this.requestId = options.requestId || null;
        this.endpoint = options.endpoint || '';
    }
}

class ApiUtils {
    constructor() {
        this.baseURL = '/api';
        this.defaultHeaders = {
            'Content-Type': 'application/json'
        };
    }

    getAuthToken() {
        return null;
    }

    setAuthToken(token) {
        // no-op：凭据存于 httpOnly Cookie
    }

    clearAuthToken() {
        localStorage.removeItem('authed');
        sessionStorage.removeItem('authed');
    }

    getHeaders(customHeaders = {}) {
        return { ...this.defaultHeaders, ...customHeaders };
    }

    resolveUrl(url) {
        if (/^https?:\/\//i.test(url)) return url;
        if (url === this.baseURL || url.startsWith(`${this.baseURL}/`)) return url;
        return `${this.baseURL}${url.startsWith('/') ? url : `/${url}`}`;
    }

    isEnvelope(body) {
        if (!body || typeof body !== 'object' ||
            typeof body.ok !== 'boolean' ||
            !Object.prototype.hasOwnProperty.call(body, 'data') ||
            !Object.prototype.hasOwnProperty.call(body, 'error') ||
            !body.meta || typeof body.meta !== 'object' ||
            typeof body.meta.timestamp !== 'string' ||
            (body.meta.requestId !== null && typeof body.meta.requestId !== 'string')) {
            return false;
        }

        if (body.ok === true) {
            return body.error === null;
        }

        const error = body.error;
        return body.data === null &&
            error && typeof error === 'object' &&
            typeof error.code === 'string' && error.code.length > 0 &&
            typeof error.message === 'string' &&
            Array.isArray(error.details) &&
            typeof error.retryable === 'boolean' &&
            (error.retryAfterSeconds === null || Number.isInteger(error.retryAfterSeconds));
    }

    async readResponse(response) {
        if (response.status === 204 || response.status === 205) return null;
        const text = await response.text();
        if (!text) return null;
        try {
            return JSON.parse(text);
        } catch (_) {
            throw new ApiError({
                code: 'INVALID_RESPONSE',
                message: '服务返回了无法识别的数据，请稍后重试',
                status: response.status,
                retryable: response.status >= 500,
                endpoint: response.url || ''
            });
        }
    }

    errorFromEnvelope(body, response, endpoint) {
        const serverError = body && body.error && typeof body.error === 'object'
            ? body.error
            : {};
        const retryAfterHeader = Number.parseInt(response.headers.get('Retry-After'), 10);
        return new ApiError({
            code: serverError.code || this.codeFromStatus(response.status),
            message: serverError.message || this.friendlyMessageFromStatus(response.status),
            status: response.status,
            details: serverError.details,
            retryable: serverError.retryable === true,
            retryAfterSeconds: Number.isInteger(serverError.retryAfterSeconds)
                ? serverError.retryAfterSeconds
                : (Number.isInteger(retryAfterHeader) ? retryAfterHeader : null),
            requestId: body && body.meta ? body.meta.requestId : null,
            endpoint
        });
    }

    protocolError(response, endpoint) {
        return new ApiError({
            code: 'INVALID_RESPONSE',
            message: '服务返回了无法识别的数据，请稍后重试',
            status: response.status,
            retryable: response.status >= 500,
            requestId: response.headers.get('X-Request-Id'),
            endpoint
        });
    }

    async request(url, options = {}) {
        const {
            headers: customHeaders,
            suppressErrorToast = false,
            suppressConsole = true,
            timeoutMs = 0,
            ...requestOptions
        } = options;
        const isFormData = typeof FormData !== 'undefined' && requestOptions.body instanceof FormData;
        const controller = timeoutMs > 0 && typeof AbortController !== 'undefined'
            ? new AbortController()
            : null;
        const config = {
            method: 'GET',
            credentials: 'include',
            ...requestOptions,
            headers: this.getHeaders(customHeaders)
        };
        let timeoutId = null;

        if (controller) {
            config.signal = controller.signal;
            timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        }
        if (isFormData) {
            delete config.headers['Content-Type'];
        } else if (config.body !== undefined && config.body !== null) {
            config.body = JSON.stringify(config.body);
        }

        const endpoint = this.resolveUrl(url);
        try {
            const response = await fetch(endpoint, config);
            const body = await this.readResponse(response);

            if (!this.isEnvelope(body) || (body.ok === true && body.error !== null)) {
                throw this.protocolError(response, endpoint);
            }
            if (!response.ok || body.ok !== true) {
                throw this.errorFromEnvelope(body, response, endpoint);
            }
            return body.data;
        } catch (error) {
            let normalized = error;
            if (!(error instanceof ApiError)) {
                const timedOut = error && error.name === 'AbortError' && timeoutMs > 0;
                normalized = new ApiError({
                    code: timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
                    message: timedOut
                        ? '请求超时，请稍后重试'
                        : (typeof navigator !== 'undefined' && navigator.onLine === false
                            ? '网络已断开，请检查连接后重试'
                            : '网络连接失败，请检查网络后重试'),
                    status: 0,
                    retryable: true,
                    endpoint
                });
            }
            this.handleError(normalized, !suppressErrorToast, suppressConsole);
            this.redirectForAuthError(normalized);
            throw normalized;
        } finally {
            if (timeoutId !== null) clearTimeout(timeoutId);
        }
    }

    async requestDownload(url, options = {}) {
        const {
            headers: customHeaders,
            suppressErrorToast = false,
            suppressConsole = true,
            timeoutMs = 0,
            ...requestOptions
        } = options;
        const controller = timeoutMs > 0 && typeof AbortController !== 'undefined'
            ? new AbortController()
            : null;
        const config = {
            method: 'GET',
            credentials: 'include',
            ...requestOptions,
            headers: this.getHeaders(customHeaders)
        };
        let timeoutId = null;

        if (controller) {
            config.signal = controller.signal;
            timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        }
        if (config.body !== undefined && config.body !== null) {
            config.body = JSON.stringify(config.body);
        }

        const endpoint = this.resolveUrl(url);
        try {
            const response = await fetch(endpoint, config);
            if (!response.ok) {
                const body = await this.readResponse(response);
                if (!this.isEnvelope(body) || body.ok !== false) {
                    throw this.protocolError(response, endpoint);
                }
                throw this.errorFromEnvelope(body, response, endpoint);
            }

            const contentType = response.headers.get('Content-Type') || '';
            if (contentType.includes('application/json')) {
                await this.readResponse(response);
                throw this.protocolError(response, endpoint);
            }

            const blob = await response.blob();
            if (!blob || blob.size === 0) {
                throw new ApiError({
                    code: 'INVALID_RESPONSE',
                    message: '导出文件为空，请调整条件后重试',
                    status: response.status,
                    retryable: true,
                    requestId: response.headers.get('X-Request-Id'),
                    endpoint
                });
            }

            return {
                blob,
                filename: this.getDownloadFilename(response.headers.get('Content-Disposition')),
                contentType
            };
        } catch (error) {
            let normalized = error;
            if (!(error instanceof ApiError)) {
                const timedOut = error && error.name === 'AbortError' && timeoutMs > 0;
                normalized = new ApiError({
                    code: timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
                    message: timedOut
                        ? '请求超时，请稍后重试'
                        : (typeof navigator !== 'undefined' && navigator.onLine === false
                            ? '网络已断开，请检查连接后重试'
                            : '网络连接失败，请检查网络后重试'),
                    status: 0,
                    retryable: true,
                    endpoint
                });
            }
            this.handleError(normalized, !suppressErrorToast, suppressConsole);
            this.redirectForAuthError(normalized);
            throw normalized;
        } finally {
            if (timeoutId !== null) clearTimeout(timeoutId);
        }
    }

    getDownloadFilename(contentDisposition) {
        if (!contentDisposition) return null;
        const encoded = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
        if (encoded && encoded[1]) {
            try {
                return decodeURIComponent(encoded[1].trim());
            } catch (_) {
                return encoded[1].trim();
            }
        }
        const plain = contentDisposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
        return plain ? (plain[1] || plain[2]).trim() : null;
    }

    redirectForAuthError(error) {
        if (!AUTH_ERROR_CODES.has(error.code)) return;
        const path = window.location.pathname || '';
        const onDashboard = /\/(admin|teacher|student)(\/|$)/.test(path);
        const onLogin = path.endsWith('/index.html') || path === '/' || path === '';
        if (onDashboard && !onLogin) {
            this.clearAuthToken();
            window.location.href = '/index.html';
        }
    }

    async get(url, params = {}, opts = {}) {
        const queryString = new URLSearchParams(params).toString();
        const fullUrl = queryString ? `${url}?${queryString}` : url;
        return this.request(fullUrl, opts);
    }

    async getSilent(url, params = {}) {
        const queryString = new URLSearchParams(params).toString();
        const fullUrl = queryString ? `${url}?${queryString}` : url;
        return this.request(fullUrl, { suppressErrorToast: true });
    }

    async post(url, data = {}, opts = {}) {
        return this.request(url, { method: 'POST', body: data, ...opts });
    }

    async put(url, data = {}, opts = {}) {
        return this.request(url, { method: 'PUT', body: data, ...opts });
    }

    async patch(url, data = {}, opts = {}) {
        return this.request(url, { method: 'PATCH', body: data, ...opts });
    }

    async delete(url, opts = {}) {
        return this.request(url, { method: 'DELETE', ...opts });
    }

    handleError(error, showToast = true, suppressConsole = true) {
        if (!suppressConsole) {
            console.error(`[API Error] ${error.endpoint || ''}: ${error.message}`, error);
        }
        if (showToast) this.showErrorToast(error);
    }

    codeFromStatus(status) {
        const codes = {
            400: 'BAD_REQUEST',
            401: 'AUTH_INVALID',
            403: 'FORBIDDEN',
            404: 'RESOURCE_NOT_FOUND',
            409: 'CONFLICT',
            413: 'PAYLOAD_TOO_LARGE',
            422: 'VALIDATION_FAILED',
            429: 'RATE_LIMITED',
            500: 'INTERNAL_ERROR',
            502: 'SERVICE_UNAVAILABLE',
            503: 'SERVICE_UNAVAILABLE',
            504: 'SERVICE_UNAVAILABLE'
        };
        return codes[status] || 'REQUEST_FAILED';
    }

    friendlyMessageFromStatus(status) {
        switch (status) {
            case 400:
            case 422: return '提交的内容有误，请检查后重试';
            case 401: return '登录状态已过期，请重新登录';
            case 403: return '没有权限执行此操作';
            case 404: return '请求的资源不存在';
            case 409: return '内容冲突，请刷新后重试';
            case 413: return '提交的内容过大，请调整后重试';
            case 429: return '请求过于频繁，请稍后重试';
            case 500:
            case 502:
            case 503:
            case 504: return '服务暂时不可用，请稍后重试';
            case 0: return '网络连接失败，请检查网络后重试';
            default: return '请求失败，请稍后重试';
        }
    }

    showErrorToast(error) {
        const firstDetail = error.details && error.details[0];
        this.showToast(firstDetail && firstDetail.message ? firstDetail.message : error.message, 'error');
    }

    showSuccessToast(message) {
        this.showToast(message, 'success');
    }

    showToast(message, type = 'info') {
        if (window.Toast && typeof window.Toast.show === 'function') {
            return window.Toast.show(message, { type });
        }
        console.warn('[Toast] 组件未就绪，延迟重试:', message);
        setTimeout(() => {
            if (window.Toast && typeof window.Toast.show === 'function') {
                window.Toast.show(message, { type });
            }
        }, 200);
    }

    hideToast(toast) {
        if (!toast) return;
        if (window.Toast && typeof window.Toast.hide === 'function') {
            window.Toast.hide(toast);
        }
    }

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

class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
    }
}

window.apiUtils = new ApiUtils();
window.ApiUtils = ApiUtils;
window.ApiError = ApiError;
window.ValidationError = ValidationError;
