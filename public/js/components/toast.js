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
        document.body.appendChild(this.container);

        // 注入样式
        this.injectStyles();
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
                background: #fef2f2;
                color: #991b1b;
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
                font-size: 16px;
                flex-shrink: 0;
            }
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
     */
    show(message, options = {}) {
        const {
            type = 'info',
            priority = 'normal',
            duration,
            closable = true
        } = options;

        if (!this.container) {
            this.createContainer();
        }

        // 按类型和优先级决定默认持续时间
        const defaultDuration = this._getDefaultDuration(type, priority);
        const actualDuration = duration !== undefined ? duration : defaultDuration;

        const icons = {
            success: '✓',
            error: '✗',
            warning: '△',
            info: 'ℹ'
        };

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;

        // 使用 textContent 防止 XSS
        const iconSpan = document.createElement('span');
        iconSpan.className = 'toast-icon';
        iconSpan.textContent = icons[type] || icons.info;

        const msgSpan = document.createElement('span');
        msgSpan.className = 'toast-message';
        msgSpan.textContent = message;

        toast.appendChild(iconSpan);
        toast.appendChild(msgSpan);

        if (closable) {
            const closeSpan = document.createElement('span');
            closeSpan.className = 'toast-close';
            closeSpan.textContent = '×';
            toast.appendChild(closeSpan);
        }

        // 关闭按钮事件
        if (closable) {
            toast.querySelector('.toast-close').addEventListener('click', () => {
                this.hide(toast);
            });
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
