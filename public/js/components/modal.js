/**
 * Modal弹窗组件
 * @description 通用弹窗组件，使用 theme.css 设计令牌，支持确认框/提示框/输入框/自定义内容
 * @module components/modal
 */

/**
 * 背景滚动锁
 * @description 弹窗打开时锁住背景滚动，移动端尤其重要：iOS 上背景可滚会让
 *   fixed 遮罩随滚动抖动/露底，关闭后滚动位置也容易丢。
 *   仪表盘页面的滚动容器不是 body 而是 .main-content（body 本身不滚），
 *   所以两者都要锁。用引用计数支持多层弹窗叠加时正确解锁。
 */
const scrollLockState = { count: 0, saved: new Map() };

function lockBackgroundScroll() {
    const targets = [document.body];
    const main = document.querySelector('.main-content');
    if (main) targets.push(main);

    targets.forEach((el) => {
        if (!scrollLockState.saved.has(el)) {
            scrollLockState.saved.set(el, el.style.overflow);
            el.style.overflow = 'hidden';
        }
    });
    scrollLockState.count++;
}

function unlockBackgroundScroll() {
    if (scrollLockState.count === 0) return;
    scrollLockState.count--;
    if (scrollLockState.count > 0) return;
    scrollLockState.saved.forEach((prev, el) => { el.style.overflow = prev; });
    scrollLockState.saved.clear();
}

/**
 * Modal管理器
 */
class ModalManager {
    constructor() {
        this.modals = new Map();
        // 必须高于页面级弹窗层（dashboard.css 中 .modal-overlay=100000、
        // .form-container/#scheduleFormContainer/.modal=100001、export-dialog=100001），
        // 否则 confirm/alert/prompt 会被打开中的编辑窗口遮挡（如排课删除确认）
        this.zIndex = 200000;
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
     * 注入CSS样式（使用 theme.css 设计令牌，带 fallback）
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
                background-color: rgba(0, 0, 0, 0.45);
                backdrop-filter: blur(var(--overlay-blur, 4px));
                -webkit-backdrop-filter: blur(var(--overlay-blur, 4px));
                display: flex;
                align-items: center;
                justify-content: center;
                opacity: 0;
                transition: opacity 0.2s ease;
                pointer-events: auto;
                user-select: none;
                -webkit-user-select: none;
            }
            .modal-overlay.visible { opacity: 1; }
            .modal-container {
                background: #fff;
                border-radius: var(--radius-xl, 12px);
                box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
                max-width: 90vw;
                /* 动态视口：iOS 软键盘弹起时 vh 不收缩，输入框会被键盘盖住 */
                max-height: 90vh;
                max-height: 90dvh;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                transform: translateY(-10px);
                transition: transform 0.2s ease;
                pointer-events: auto;
                user-select: text;
                -webkit-user-select: text;
                font-family: var(--font-family-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
            }
            .modal-overlay.visible .modal-container {
                transform: translateY(0);
            }
            /* 以下 4 个类名与 dashboard.css 里页面级弹窗的同名规则冲突。本注入 <style> 在
               所有 <link> 之后进入 <head>，同特异性下后来者胜，会把 5 个静态弹窗
               （teacher 的 studentEditModal/passwordChangeModal/feeManagementModal、
               admin 的 scheduleModal、student 的 passwordChangeModal）的内边距一起改掉
               （实测 20px 24px → 16px 20px、24px → 20px）。加 .modal-container 前缀限定作用域。 */
            .modal-container .modal-header {
                padding: 16px 20px;
                border-bottom: 1px solid var(--color-gray-200, #e5e7eb);
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            .modal-container .modal-title {
                font-size: var(--fs-500);
                font-weight: 600;
                color: var(--color-gray-800, #1f2937);
                margin: 0;
            }
            .modal-container .modal-close {
                width: 28px;
                height: 28px;
                border: none;
                background: none;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: var(--fs-600);
                color: var(--color-gray-400, #9ca3af);
                transition: color 0.2s;
                padding: 0;
            }
            .modal-container .modal-close:hover {
                color: var(--color-gray-600, #4b5563);
            }
            .modal-container .modal-body {
                padding: 20px;
                overflow-y: auto;
                flex: 1;
                color: var(--color-gray-600, #4b5563);
                font-size: var(--fs-300);
                line-height: var(--lh-base);
            }
            .modal-container .modal-footer {
                padding: 16px 20px;
                border-top: 1px solid var(--color-gray-200, #e5e7eb);
                display: flex;
                gap: 10px;
                justify-content: flex-end;
            }
            .modal-btn {
                padding: 8px 20px;
                border-radius: 6px;
                font-size: var(--fs-300);
                font-weight: 500;
                cursor: pointer;
                transition: background 0.2s;
                border: 1px solid transparent;
                font-family: inherit;
            }
            .modal-btn-primary {
                background: var(--color-primary-600, #059669);
                color: #fff;
            }
            .modal-btn-primary:hover {
                background: var(--color-primary-700, #047857);
            }
            .modal-btn-secondary {
                background: #fff;
                color: var(--color-gray-600, #4b5563);
                border-color: var(--color-gray-300, #d1d5db);
            }
            .modal-btn-secondary:hover {
                background: var(--color-gray-50, #f9fafb);
            }
            .modal-btn-danger {
                background: var(--color-error, #ef4444);
                color: #fff;
            }
            .modal-btn-danger:hover {
                background: #dc2626;
            }

            /* 尺寸 */
            .modal-sm .modal-container { width: 400px; }
            .modal-md .modal-container { width: 560px; }
            .modal-lg .modal-container { width: 800px; }
            .modal-xl .modal-container { width: 1000px; }

            .modal-input {
                width: 100%;
                padding: 8px 12px;
                border: 1px solid var(--color-gray-300, #d1d5db);
                border-radius: 6px;
                font-size: var(--fs-300);
                font-family: inherit;
                color: var(--color-gray-800, #1f2937);
                background: #fff;
                transition: border-color 0.2s;
                box-sizing: border-box;
                margin-top: 12px;
            }
            .modal-input:focus {
                outline: none;
                border-color: var(--color-primary-500, #10b981);
            }
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
            confirmStyle = 'primary',
            onConfirm = null,
            onCancel = null,
            onClose = null
        } = options;

        // 创建DOM结构
        const overlay = document.createElement('div');
        overlay.className = `modal-overlay modal-${size}`;
        overlay.style.zIndex = ++this.zIndex;
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        if (title) overlay.setAttribute('aria-label', title);
        // 不可关闭的弹窗（如强制选择）不参与"点击外部关闭"，由 core/modal-backdrop.js 识别
        if (!closable) overlay.dataset.pzNoClose = 'true';

        // 安全构建 DOM，防止 XSS
        const container = document.createElement('div');
        container.className = 'modal-container';

        if (title) {
            const header = document.createElement('div');
            header.className = 'modal-header';
            const titleEl = document.createElement('h3');
            titleEl.className = 'modal-title';
            titleEl.textContent = title;
            header.appendChild(titleEl);
            if (closable) {
                const closeBtn = document.createElement('button');
                closeBtn.className = 'modal-close';
                closeBtn.textContent = '×';
                closeBtn.setAttribute('aria-label', '关闭');
                header.appendChild(closeBtn);
            }
            container.appendChild(header);
        }

        const body = document.createElement('div');
        body.className = 'modal-body';
        if (typeof content === 'string') {
            body.innerHTML = content; // content 是开发者控制的 HTML 模板
        } else if (content instanceof HTMLElement) {
            body.appendChild(content);
        }
        container.appendChild(body);

        if (showFooter) {
            const footer = document.createElement('div');
            footer.className = 'modal-footer';
            if (cancelText) {
                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'modal-btn modal-btn-secondary modal-cancel';
                cancelBtn.textContent = cancelText;
                footer.appendChild(cancelBtn);
            }
            if (confirmText) {
                const confirmBtn = document.createElement('button');
                confirmBtn.className = `modal-btn modal-btn-${confirmStyle} modal-confirm`;
                confirmBtn.textContent = confirmText;
                footer.appendChild(confirmBtn);
            }
            container.appendChild(footer);
        }

        overlay.innerHTML = '';
        overlay.appendChild(container);

        // 绑定事件
        const closeBtn = overlay.querySelector('.modal-close');
        const confirmBtn = overlay.querySelector('.modal-confirm');
        const cancelBtn = overlay.querySelector('.modal-cancel');

        // 焦点管理：打开时记住触发元素并把焦点移入弹窗，关闭时归还。
        // 否则键盘/读屏用户的焦点仍留在弹窗背后，可以「穿透」遮罩操作背景。
        const previouslyFocused = document.activeElement;
        const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

        const focusableIn = () => Array.from(container.querySelectorAll(FOCUSABLE))
            .filter(el => el.offsetParent !== null || el === document.activeElement);

        const onKeydown = (e) => {
            if (e.key !== 'Tab') return;
            const items = focusableIn();
            if (items.length === 0) { e.preventDefault(); return; }
            const first = items[0];
            const last = items[items.length - 1];
            const active = document.activeElement;
            if (e.shiftKey && (active === first || !container.contains(active))) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && active === last) {
                e.preventDefault();
                first.focus();
            }
        };
        overlay.addEventListener('keydown', onKeydown);

        const closeModal = () => this.close(id);

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
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
                    closeModal();
                }
            });
        }

        document.body.appendChild(overlay);
        lockBackgroundScroll();

        // 触发动画
        requestAnimationFrame(() => overlay.classList.add('visible'));

        // 焦点移入弹窗（首个可聚焦元素优先；没有则聚焦弹窗容器本身）
        requestAnimationFrame(() => {
            const items = focusableIn();
            const target = items.find(el => el !== closeBtn) || items[0];
            if (target) {
                target.focus();
            } else {
                container.setAttribute('tabindex', '-1');
                container.focus();
            }
        });

        // onClose 只结算一次：关闭按钮、蒙层点击、Esc（经 closeTop）与代码调 close() 统一走这里，
        // 避免 confirm/alert/prompt 的 Promise 因 Esc 关闭而永久 pending。
        let closeSettled = false;
        const settleClose = () => {
            if (closeSettled) return;
            closeSettled = true;
            onClose?.();
        };

        const modal = {
            id,
            overlay,
            body: overlay.querySelector('.modal-body'),
            close: closeModal,
            settleClose,
            previouslyFocused
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

        // 幂等：同一弹窗可能被 close 按钮、Esc、外部代码几乎同时关闭。
        // 若不做守卫，300ms 后的回调会执行两次，滚动锁引用计数被多减，
        // 结果是其它仍打开的弹窗背景却已解锁。
        if (modal.closing) return;
        modal.closing = true;

        // 无论从哪条路径关闭（按钮/蒙层/Esc/代码），都先结算 onClose 一次
        modal.settleClose?.();

        // 焦点归还给打开弹窗前的元素（若它还在文档中且可聚焦）
        const prev = modal.previouslyFocused;
        if (prev && prev.isConnected && typeof prev.focus === 'function') {
            try { prev.focus({ preventScroll: true }); } catch (e) { prev.focus(); }
        }

        modal.overlay.classList.remove('visible');
        setTimeout(() => {
            if (modal.overlay.parentNode) {
                modal.overlay.parentNode.removeChild(modal.overlay);
            }
            this.modals.delete(id);
            unlockBackgroundScroll();
        }, 300);
    }

    /**
     * 关闭最上层弹窗（按实际 z-index 取最高者，而非插入顺序）
     */
    closeTop() {
        let topId = null;
        let topZ = -Infinity;
        this.modals.forEach((modal, id) => {
            const z = parseInt(modal.overlay.style.zIndex, 10) || 0;
            if (z > topZ) {
                topZ = z;
                topId = id;
            }
        });
        if (topId !== null) {
            this.close(topId);
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
            const p = document.createElement('p');
            p.style.cssText = 'margin: 0;';
            p.textContent = message;
            this.create({
                title: options.title || '确认',
                content: p,
                size: options.size || 'sm',
                confirmText: options.confirmText || '确定',
                cancelText: options.cancelText || '取消',
                confirmStyle: options.confirmStyle || 'primary',
                onConfirm: () => resolve(true),
                onCancel: () => resolve(false),
                onClose: () => resolve(false)
            });
        });
    }

    /**
     * 提示框（单按钮）
     * @param {string} message - 提示消息
     * @param {Object} options - 配置选项
     * @returns {Promise<void>}
     */
    alert(message, options = {}) {
        return new Promise((resolve) => {
            const p = document.createElement('p');
            p.style.cssText = 'margin: 0;';
            p.textContent = message;
            this.create({
                title: options.title || '提示',
                content: p,
                size: options.size || 'sm',
                showFooter: true,
                confirmText: options.confirmText || '确定',
                cancelText: '',
                onConfirm: () => resolve(),
                onClose: () => resolve()
            });
        });
    }

    /**
     * 输入框弹窗
     * @param {string} message - 提示消息
     * @param {Object} options - 配置选项
     * @returns {Promise<string|null>} 用户输入的文本，取消返回 null
     */
    prompt(message, options = {}) {
        return new Promise((resolve) => {
            const wrapper = document.createElement('div');
            const p = document.createElement('p');
            p.style.cssText = 'margin: 0;';
            p.textContent = message;

            const input = document.createElement(options.multiline ? 'textarea' : 'input');
            if (!options.multiline) {
                input.type = 'text';
            }
            input.className = 'modal-input';
            if (options.placeholder) input.placeholder = options.placeholder;
            if (options.defaultValue) input.value = options.defaultValue;
            if (options.multiline) {
                input.rows = options.rows || 3;
            }

            wrapper.appendChild(p);
            wrapper.appendChild(input);

            const modal = this.create({
                title: options.title || '请输入',
                content: wrapper,
                size: options.size || 'sm',
                confirmText: options.confirmText || '确定',
                cancelText: options.cancelText || '取消',
                onConfirm: () => {
                    const value = input.value.trim();
                    if (options.required && !value) {
                        input.style.borderColor = 'var(--color-error, #ef4444)';
                        input.focus();
                        return false; // 阻止关闭
                    }
                    resolve(value);
                },
                onCancel: () => resolve(null),
                onClose: () => resolve(null)
            });

            // 自动聚焦输入框
            requestAnimationFrame(() => {
                input.focus();
                if (!options.multiline) input.select();
            });

            // 回车确认（非 textarea 时）
            if (!options.multiline) {
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        modal.overlay.querySelector('.modal-confirm')?.click();
                    }
                });
            }
        });
    }
}

// 创建全局实例
const Modal = new ModalManager();

// 挂载到全局
if (typeof window !== 'undefined') {
    window.Modal = Modal;
}
