/**
 * Toast提示组件
 * @description 统一消息提示，使用 theme.css 设计令牌，支持类型/优先级/自动消失
 * @module components/toast
 */

/**
 * Toast管理器
 */
class ToastManager {
    constructor() {
        this.container = null;
        this.toasts = [];
        this.init();
    }

    /**
     * 初始化容器
     */
    init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.createContainer());
        } else {
            this.createContainer();
        }
    }

    /**
     * 创建Toast容器
     */
    createContainer() {
        if (this.container) return;

        this.container = document.createElement('div');
        this.container.className = 'toast-container';
        this.container.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 300000;
            display: flex;
            flex-direction: column;
            gap: 10px;
            pointer-events: none;
        `;

        // 注入样式
        this.injectStyles();
        document.body.appendChild(this.container);
    }

    /**
     * 注入CSS样式（使用 theme.css 设计令牌，带 fallback）
     */
    injectStyles() {
        if (document.getElementById('toast-styles')) return;

        const style = document.createElement('style');
        style.id = 'toast-styles';
        style.textContent = `
            .toast {
                padding: 14px 20px;
                border-radius: var(--radius-lg, 8px);
                font-size: var(--fs-300);
                line-height: 1.5;
                font-family: var(--font-family-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
                display: flex;
                align-items: center;
                gap: 10px;
                box-shadow: var(--shadow-md, 0 4px 6px -1px rgba(0,0,0,0.1));
                pointer-events: auto;
                animation: toastSlideIn 0.3s ease;
                max-width: 400px;
                word-break: break-word;
            }
            .toast.hiding {
                animation: toastSlideOut 0.3s ease forwards;
            }
            .toast-success {
                background: var(--color-primary-50, #ecfdf5);
                color: var(--color-primary-800, #065f46);
            }
            .toast-error {
                background: var(--color-error-50, #fef2f2);
                color: var(--color-error-800, #991b1b);
            }
            .toast-warning {
                background: #fffbeb;
                color: #92400e;
            }
            .toast-info {
                background: #eff6ff;
                color: #1e40af;
            }
            .toast-icon {
                display: flex;
                align-items: center;
                flex-shrink: 0;
            }
            .toast-icon svg {
                width: 18px;
                height: 18px;
            }
            .toast-message {
                flex: 1;
            }
            .toast-actions {
                display: flex;
                gap: 8px;
                margin-left: 4px;
            }
            .toast-action-btn {
                border: 1px solid currentColor;
                background: transparent;
                color: inherit;
                font-family: inherit;
                font-size: var(--fs-200, 0.8125rem);
                font-weight: 600;
                padding: 3px 12px;
                border-radius: var(--radius-md, 6px);
                cursor: pointer;
                opacity: 0.9;
                transition: opacity 0.2s;
                white-space: nowrap;
            }
            .toast-action-btn:hover { opacity: 1; }
            .toast-close {
                margin-left: auto;
                cursor: pointer;
                opacity: 0.5;
                font-size: var(--fs-500);
                padding: 0 2px;
                transition: opacity 0.2s;
            }
            .toast-close:hover { opacity: 1; }
            @keyframes toastSlideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes toastSlideOut {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * 显示Toast
     * @param {string} message - 消息内容
     * @param {Object} options - 配置选项
     * @param {string} [options.type='info'] - 类型: success|error|warning|info
     * @param {string} [options.priority='normal'] - 优先级: low|normal|high
     * @param {number} [options.duration] - 持续时间(ms)，0=不自动消失，默认按类型/优先级决定
     * @param {boolean} [options.closable=true] - 是否可手动关闭
     * @param {Array<{label:string, onClick:Function}>} [options.actions] - 动作按钮（如「重试」）；
     *   提供时默认停留 8s（可通过 duration 覆盖）
     */
    show(message, options = {}) {
        const {
            type = 'info',
            priority = 'normal',
            duration,
            closable = true,
            actions = null
        } = options;

        if (!this.container) {
            this.createContainer();
        }

        const normalizedMessage = String(message || '');
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            const duplicate = this.toasts.find(item =>
                !item.classList.contains('hiding') &&
                item.dataset.type === type &&
                item.dataset.message === normalizedMessage
            );
            if (duplicate) return duplicate;
        }

        // 按类型和优先级决定默认持续时间；带动作按钮的 Toast 停留更久，保证用户能看到并操作
        const defaultDuration = this._getDefaultDuration(type, priority);
        const actualDuration = duration !== undefined
            ? duration
            : (actions && actions.length ? Math.max(defaultDuration, 8000) : defaultDuration);

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.dataset.type = type;
        toast.dataset.message = normalizedMessage;
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
        toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
        toast.setAttribute('aria-atomic', 'true');

        // 图标：内联 SVG（stroke=currentColor，颜色随类型），解析自 template 获得 SVG 命名空间
        const iconSpan = document.createElement('span');
        iconSpan.className = 'toast-icon';
        iconSpan.appendChild(this._createIcon(type));

        const msgSpan = document.createElement('span');
        msgSpan.className = 'toast-message';
        msgSpan.textContent = normalizedMessage; // textContent 防 XSS

        toast.appendChild(iconSpan);
        toast.appendChild(msgSpan);

        // 动作按钮（如重试）
        if (Array.isArray(actions) && actions.length > 0) {
            const actionsWrap = document.createElement('span');
            actionsWrap.className = 'toast-actions';
            actions.forEach(({ label, onClick }) => {
                if (!label || typeof onClick !== 'function') return;
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'toast-action-btn';
                btn.textContent = label;
                btn.addEventListener('click', () => {
                    onClick();
                    this.hide(toast);
                });
                actionsWrap.appendChild(btn);
            });
            if (actionsWrap.childElementCount > 0) {
                toast.appendChild(actionsWrap);
            }
        }

        if (closable) {
            const closeButton = document.createElement('button');
            closeButton.type = 'button';
            closeButton.className = 'toast-close';
            closeButton.textContent = '×';
            closeButton.setAttribute('aria-label', '关闭通知');
            closeButton.addEventListener('click', () => this.hide(toast));
            toast.appendChild(closeButton);
        }

        this.container.appendChild(toast);
        this.toasts.push(toast);

        // 自动消失
        if (actualDuration > 0) {
            setTimeout(() => this.hide(toast), actualDuration);
        }

        return toast;
    }

    /**
     * 创建类型图标（lucide 风格 24 viewBox stroke 图形）
     * @private
     */
    _createIcon(type) {
        const paths = {
            success: '<polyline points="20 6 9 17 4 12"/>',
            error: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
            warning: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
            info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'
        };
        const template = document.createElement('template');
        template.innerHTML =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
            ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            (paths[type] || paths.info) +
            '</svg>';
        return template.content.firstElementChild;
    }

    /**
     * 根据类型和优先级计算默认持续时间
     * @private
     */
    _getDefaultDuration(type, priority) {
        const base = {
            success: 3000,
            error: 5000,
            warning: 4000,
            info: 3000
        };
        const multiplier = {
            low: 0.7,
            normal: 1,
            high: 1.5
        };
        return (base[type] || 3000) * (multiplier[priority] || 1);
    }

    /**
     * 隐藏Toast
     * @param {HTMLElement} toast - Toast元素
     */
    hide(toast) {
        if (!toast || toast.classList.contains('hiding')) return;

        toast.classList.add('hiding');
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
            const index = this.toasts.indexOf(toast);
            if (index > -1) {
                this.toasts.splice(index, 1);
            }
        }, 300);
    }

    /**
     * 快捷方法
     */
    success(message, duration) {
        return this.show(message, { type: 'success', duration });
    }

    error(message, duration) {
        return this.show(message, { type: 'error', duration });
    }

    warning(message, duration) {
        return this.show(message, { type: 'warning', duration });
    }

    info(message, duration) {
        return this.show(message, { type: 'info', duration });
    }

    /**
     * 清除所有Toast
     */
    clear() {
        this.toasts.forEach(toast => this.hide(toast));
    }
}

// 创建全局实例
const Toast = new ToastManager();

// 挂载到全局
if (typeof window !== 'undefined') {
    window.Toast = Toast;
}
