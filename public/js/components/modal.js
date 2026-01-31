/**
 * Modal弹窗组件
 * @description 通用弹窗组件，支持确认框、表单、自定义内容
 * @module components/modal
 */

/**
 * Modal管理器
 */
class ModalManager {
    constructor() {
        this.modals = new Map();
        this.zIndex = 9000;
        this.init();
    }

    /**
     * 初始化
     */
    init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.injectStyles());
        } else {
            this.injectStyles();
        }

        // ESC键关闭
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeTop();
            }
        });
    }

    /**
     * 注入CSS样式
     */
    injectStyles() {
        if (document.getElementById('modal-styles')) return;

        const style = document.createElement('style');
        style.id = 'modal-styles';
        style.textContent = `
            .modal-overlay {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                opacity: 0;
                transition: opacity 0.3s ease;
                backdrop-filter: blur(2px);
            }
            .modal-overlay.visible { opacity: 1; }

            .modal-container {
                background: #fff;
                border-radius: 12px;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
                max-width: 90vw;
                max-height: 90vh;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                transform: scale(0.9) translateY(-20px);
                transition: transform 0.3s ease;
            }
            .modal-overlay.visible .modal-container {
                transform: scale(1) translateY(0);
            }

            .modal-header {
                padding: 16px 20px;
                border-bottom: 1px solid #eee;
                display: flex;
                align-items: center;
                justify-content: space-between;
            }

            .modal-title {
                font-size: 18px;
                font-weight: 600;
                color: #333;
                margin: 0;
            }

            .modal-close {
                width: 32px;
                height: 32px;
                border: none;
                background: #f5f5f5;
                border-radius: 50%;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 18px;
                color: #666;
                transition: all 0.2s;
            }
            .modal-close:hover {
                background: #e0e0e0;
                color: #333;
            }

            .modal-body {
                padding: 20px;
                overflow-y: auto;
                flex: 1;
            }

            .modal-footer {
                padding: 16px 20px;
                border-top: 1px solid #eee;
                display: flex;
                gap: 12px;
                justify-content: flex-end;
            }

            .modal-btn {
                padding: 10px 20px;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s;
                border: none;
            }

            .modal-btn-primary {
                background: linear-gradient(135deg, #4a90d9 0%, #357abd 100%);
                color: #fff;
            }
            .modal-btn-primary:hover {
                background: linear-gradient(135deg, #357abd 0%, #2c6aa0 100%);
            }

            .modal-btn-secondary {
                background: #f5f5f5;
                color: #666;
            }
            .modal-btn-secondary:hover {
                background: #e0e0e0;
            }

            .modal-btn-danger {
                background: linear-gradient(135deg, #dc3545 0%, #c82333 100%);
                color: #fff;
            }

            /* 尺寸 */
            .modal-sm .modal-container { width: 400px; }
            .modal-md .modal-container { width: 560px; }
            .modal-lg .modal-container { width: 800px; }
            .modal-xl .modal-container { width: 1000px; }
        `;
        document.head.appendChild(style);
    }

    /**
     * 创建弹窗
     * @param {Object} options - 配置选项
     * @returns {Object} Modal实例
     */
    create(options = {}) {
        const {
            id = `modal-${Date.now()}`,
            title = '',
            content = '',
            size = 'md',
            closable = true,
            showFooter = true,
            confirmText = '确定',
            cancelText = '取消',
            onConfirm = null,
            onCancel = null,
            onClose = null
        } = options;

        // 创建DOM结构
        const overlay = document.createElement('div');
        overlay.className = `modal-overlay modal-${size}`;
        overlay.style.zIndex = ++this.zIndex;

        overlay.innerHTML = `
            <div class="modal-container">
                ${title ? `
                    <div class="modal-header">
                        <h3 class="modal-title">${title}</h3>
                        ${closable ? '<button class="modal-close">×</button>' : ''}
                    </div>
                ` : ''}
                <div class="modal-body">${content}</div>
                ${showFooter ? `
                    <div class="modal-footer">
                        <button class="modal-btn modal-btn-secondary modal-cancel">${cancelText}</button>
                        <button class="modal-btn modal-btn-primary modal-confirm">${confirmText}</button>
                    </div>
                ` : ''}
            </div>
        `;

        // 绑定事件
        const closeBtn = overlay.querySelector('.modal-close');
        const confirmBtn = overlay.querySelector('.modal-confirm');
        const cancelBtn = overlay.querySelector('.modal-cancel');

        const closeModal = () => this.close(id);

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                onClose?.();
                closeModal();
            });
        }

        if (confirmBtn) {
            confirmBtn.addEventListener('click', async () => {
                const result = await onConfirm?.();
                if (result !== false) {
                    closeModal();
                }
            });
        }

        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                onCancel?.();
                closeModal();
            });
        }

        // 点击蒙层关闭
        if (closable) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    onClose?.();
                    closeModal();
                }
            });
        }

        document.body.appendChild(overlay);

        // 触发动画
        requestAnimationFrame(() => overlay.classList.add('visible'));

        const modal = {
            id,
            overlay,
            body: overlay.querySelector('.modal-body'),
            close: closeModal
        };

        this.modals.set(id, modal);
        return modal;
    }

    /**
     * 关闭弹窗
     * @param {string} id - 弹窗ID
     */
    close(id) {
        const modal = this.modals.get(id);
        if (!modal) return;

        modal.overlay.classList.remove('visible');
        setTimeout(() => {
            if (modal.overlay.parentNode) {
                modal.overlay.parentNode.removeChild(modal.overlay);
            }
            this.modals.delete(id);
        }, 300);
    }

    /**
     * 关闭最上层弹窗
     */
    closeTop() {
        const keys = Array.from(this.modals.keys());
        if (keys.length > 0) {
            this.close(keys[keys.length - 1]);
        }
    }

    /**
     * 关闭所有弹窗
     */
    closeAll() {
        this.modals.forEach((_, id) => this.close(id));
    }

    /**
     * 确认框
     * @param {string} message - 确认消息
     * @param {Object} options - 配置选项
     * @returns {Promise<boolean>}
     */
    confirm(message, options = {}) {
        return new Promise((resolve) => {
            this.create({
                title: options.title || '确认',
                content: `<p style="margin: 0; color: #666;">${message}</p>`,
                size: 'sm',
                confirmText: options.confirmText || '确定',
                cancelText: options.cancelText || '取消',
                onConfirm: () => resolve(true),
                onCancel: () => resolve(false),
                onClose: () => resolve(false)
            });
        });
    }

    /**
     * 警告框
     * @param {string} message - 警告消息
     * @param {Object} options - 配置选项
     * @returns {Promise<void>}
     */
    alert(message, options = {}) {
        return new Promise((resolve) => {
            this.create({
                title: options.title || '提示',
                content: `<p style="margin: 0; color: #666;">${message}</p>`,
                size: 'sm',
                showFooter: true,
                confirmText: '确定',
                cancelText: '',
                onConfirm: () => resolve(),
                onClose: () => resolve()
            });
            // 隐藏取消按钮
            document.querySelector('.modal-cancel')?.remove();
        });
    }
}

// 创建全局实例
const Modal = new ModalManager();

// 挂载到全局
if (typeof window !== 'undefined') {
    window.Modal = Modal;
}
