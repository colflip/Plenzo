/**
 * Toast提示组件
 * @description 轻量级消息提示，支持多种类型和自动消失
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
            z-index: 10000;
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
     * 注入CSS样式
     */
    injectStyles() {
        if (document.getElementById('toast-styles')) return;

        const style = document.createElement('style');
        style.id = 'toast-styles';
        style.textContent = `
            .toast {
                padding: 12px 20px;
                border-radius: 8px;
                color: #fff;
                font-size: 14px;
                display: flex;
                align-items: center;
                gap: 10px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                pointer-events: auto;
                animation: toastSlideIn 0.3s ease;
                max-width: 400px;
                word-break: break-word;
            }

            .toast.hiding {
                animation: toastSlideOut 0.3s ease forwards;
            }

            .toast-success { background: linear-gradient(135deg, #28a745 0%, #20c997 100%); }
            .toast-error { background: linear-gradient(135deg, #dc3545 0%, #e74c3c 100%); }
            .toast-warning { background: linear-gradient(135deg, #ffc107 0%, #ffb300 100%); color: #333; }
            .toast-info { background: linear-gradient(135deg, #17a2b8 0%, #20c997 100%); }

            .toast-icon {
                font-size: 18px;
                flex-shrink: 0;
            }

            .toast-close {
                margin-left: auto;
                cursor: pointer;
                opacity: 0.7;
                transition: opacity 0.2s;
                padding: 0 4px;
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
     */
    show(message, options = {}) {
        const {
            type = 'info',
            duration = 3000,
            closable = true
        } = options;

        if (!this.container) {
            this.createContainer();
        }

        const icons = {
            success: '✓',
            error: '✕',
            warning: '⚠',
            info: 'ℹ'
        };

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            <span class="toast-icon">${icons[type] || icons.info}</span>
            <span class="toast-message">${message}</span>
            ${closable ? '<span class="toast-close">×</span>' : ''}
        `;

        // 关闭按钮事件
        if (closable) {
            toast.querySelector('.toast-close').addEventListener('click', () => {
                this.hide(toast);
            });
        }

        this.container.appendChild(toast);
        this.toasts.push(toast);

        // 自动消失
        if (duration > 0) {
            setTimeout(() => this.hide(toast), duration);
        }

        return toast;
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
    success(message, duration = 3000) {
        return this.show(message, { type: 'success', duration });
    }

    error(message, duration = 4000) {
        return this.show(message, { type: 'error', duration });
    }

    warning(message, duration = 3500) {
        return this.show(message, { type: 'warning', duration });
    }

    info(message, duration = 3000) {
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
