/**
 * 全站弹窗遮罩统一处理
 *
 * 目标：系统里所有弹窗（Modal 组件、页面级 .modal、导出对话框、动作面板、
 * 各类动态创建的遮罩层）共用同一套视觉与交互规则：
 *   1. 统一模糊背景：遮罩统一使用 --overlay-bg 底色 + --overlay-blur 模糊强度；
 *   2. 点击弹窗内容之外的区域自动关闭最上层弹窗。
 *
 * 设计要点：
 *   - 采用"运行时识别 + 事件委托"，无需逐个改造已有弹窗，新增弹窗自动生效；
 *   - 关闭优先走各弹窗自己的关闭按钮/注册回调，保证业务侧状态被正确清理；
 *   - 嵌套遮罩（.modal > .modal-overlay）只在外层加模糊，避免二次模糊；
 *   - 加载态、吐司、彩带等非交互层明确排除。
 *
 * @module core/modal-backdrop
 */
(function (global) {
    'use strict';

    var doc = global.document;
    if (!doc) return;

    var STYLE_ID = 'plenzo-backdrop-styles';
    var SCRIM_CLASS = 'pz-scrim';

    /** 疑似遮罩层的廉价筛选器（先字符串匹配，再做样式判定，避免全量 getComputedStyle） */
    var HINT_SELECTOR = [
        '[class*="modal" i]',
        '[class*="overlay" i]',
        '[class*="backdrop" i]',
        '[class*="scrim" i]',
        '[class*="drawer" i]',
        '[id*="modal" i]',
        '[id*="overlay" i]',
        '[data-pz-scrim]'
    ].join(',');

    /** 明确排除：加载态 / 吐司 / 彩带等不该被点击关闭的层 */
    var EXCLUDE_SELECTOR = [
        '[class*="loading" i]',
        '[class*="spinner" i]',
        '[class*="toast" i]',
        '[class*="confetti" i]',
        '[id*="loading" i]'
    ].join(',');

    /** 关闭按钮候选（按优先级） */
    var CLOSE_SELECTORS = [
        '[data-pz-close]',
        '.modal-close',
        '.modal-header .close',
        '[aria-label="关闭"]',
        '[aria-label="Close"]',
        '[title="关闭"]',
        '.btn-cancel',
        '.cancel-btn',
        '.close-btn'
    ];

    /** 通过 class 控制显隐的遮罩层常用类名 */
    var VISIBLE_CLASSES = ['active', 'visible', 'show', 'open', 'is-open'];

    /** 元素 -> 自定义关闭回调 */
    var handlers = typeof WeakMap === 'function' ? new WeakMap() : null;

    /** 最近一次 mousedown 的命中元素，用于避免"拖拽选中文字后松手"误关 */
    var downTarget = null;

    var observer = null;

    // ---------------------------------------------------------------- 样式

    function injectStyles() {
        if (doc.getElementById(STYLE_ID)) return;
        var style = doc.createElement('style');
        style.id = STYLE_ID;
        style.textContent =
            '.' + SCRIM_CLASS + ' {\n' +
            '  background-color: var(--overlay-bg, rgba(15, 23, 42, 0.45)) !important;\n' +
            '  -webkit-backdrop-filter: blur(var(--overlay-blur, 4px)) !important;\n' +
            '  backdrop-filter: blur(var(--overlay-blur, 4px)) !important;\n' +
            '}\n';
        doc.head.appendChild(style);
    }

    // ---------------------------------------------------------------- 判定

    /**
     * 解析颜色字符串的 alpha 通道
     * @param {string} color
     * @returns {number} 0~1，无法解析时返回 1（按不透明处理）
     */
    function parseAlpha(color) {
        if (!color || color === 'transparent') return 0;
        var m = String(color).match(/rgba?\(([^)]+)\)/i);
        if (!m) return 1;
        var parts = m[1].split(',').map(function (s) { return parseFloat(s); });
        return parts.length >= 4 && !isNaN(parts[3]) ? parts[3] : 1;
    }

    /**
     * 判断元素是否为"遮罩层"（铺满视口、半透明、可交互）
     * @param {Element} el
     * @returns {boolean}
     */
    function isScrim(el) {
        if (!el || el.nodeType !== 1 || typeof el.matches !== 'function') return false;
        if (el.dataset && el.dataset.pzScrim === 'false') return false;
        if (el.matches(EXCLUDE_SELECTOR)) return false;

        var cs = global.getComputedStyle(el);
        if (!cs) return false;
        if (cs.pointerEvents === 'none') return false;
        if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;

        var hidden = cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0;
        if (!hidden) {
            var rect = el.getBoundingClientRect();
            // 小于视口一半的浮层（如 AI 助手面板）不算遮罩
            if (rect.width < global.innerWidth * 0.5 || rect.height < global.innerHeight * 0.5) return false;
        }

        var alpha = parseAlpha(cs.backgroundColor);
        var hasBlur = !!cs.backdropFilter && cs.backdropFilter !== 'none';
        var forced = !!(el.dataset && el.dataset.pzScrim);
        if (!(alpha > 0 && alpha < 1) && !hasBlur && !forced) return false;
        return true;
    }

    // ---------------------------------------------------------------- 关闭

    function findCloseButton(scrim) {
        for (var i = 0; i < CLOSE_SELECTORS.length; i++) {
            var btn = scrim.querySelector(CLOSE_SELECTORS[i]);
            if (btn && btn.getClientRects && btn.getClientRects().length) return btn;
        }
        return null;
    }

    /**
     * 管理端共享遮罩 #modalOverlay：弹窗主体是它的兄弟节点（.form-container），
     * 因此关闭时需要一起收起。
     */
    function closeSharedOverlay(overlay) {
        overlay.style.display = 'none';
        var containers = doc.querySelectorAll('.form-container');
        for (var i = 0; i < containers.length; i++) {
            if (global.getComputedStyle(containers[i]).display !== 'none') {
                containers[i].style.display = 'none';
            }
        }
    }

    /**
     * 关闭指定遮罩层：优先自定义回调 -> 关闭按钮 -> 兜底隐藏
     * @param {Element} scrim
     */
    function closeScrim(scrim) {
        if (!scrim || !scrim.isConnected) return;
        // 业务侧显式声明"不允许点击外部关闭"（如 Modal 组件的 closable:false）
        if (scrim.dataset && scrim.dataset.pzNoClose === 'true') return;

        var cs = global.getComputedStyle(scrim);
        // 业务代码可能已经在本次点击中把它关掉了（先于 document 上的委托执行）
        if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;

        if (handlers && handlers.has(scrim)) {
            handlers.get(scrim)(scrim);
            return;
        }

        var btn = findCloseButton(scrim);
        if (btn) {
            btn.click();
            return;
        }

        // 兜底：按该弹窗自身的显隐方式收起，不做超出其设计的操作
        if (scrim.style && scrim.style.display) {
            scrim.style.display = 'none';
            return;
        }
        for (var i = 0; i < VISIBLE_CLASSES.length; i++) {
            if (scrim.classList.contains(VISIBLE_CLASSES[i])) {
                scrim.classList.remove(VISIBLE_CLASSES[i]);
                return;
            }
        }
    }

    // ---------------------------------------------------------------- 事件

    function onMouseDown(e) {
        downTarget = e.target;
    }

    function onClick(e) {
        var target = e.target;
        if (downTarget !== target) return;   // 拖拽/跨越元素的点击不视为"点击空白处"
        if (!target || !target.isConnected) return;
        if (!isScrim(target)) return;
        // 嵌套遮罩（.modal > .modal-overlay）交给最外层统一管理
        var scrim = target.closest('.' + SCRIM_CLASS) || target;
        closeScrim(scrim);
    }

    function bindEvents() {
        doc.addEventListener('mousedown', onMouseDown, true);
        doc.addEventListener('click', onClick, false);
    }

    // ---------------------------------------------------------------- 标记

    /**
     * 检查并标记一个元素为统一遮罩层
     * @param {Element} el
     */
    function consider(el) {
        if (!el || el.nodeType !== 1 || typeof el.matches !== 'function') return;
        if (el.classList.contains(SCRIM_CLASS)) return;

        var isBodyChild = el.parentElement === doc.body;
        if (!isBodyChild && !el.matches(HINT_SELECTOR)) return;

        // 嵌套遮罩不重复加模糊（父级已经模糊过），点击关闭仍由外层负责
        if (el.parentElement && el.parentElement.closest &&
            el.parentElement.closest('.pz-scrim, .modal, .modal-overlay')) {
            return;
        }

        if (!isScrim(el)) return;

        el.classList.add(SCRIM_CLASS);
        if (el.id === 'modalOverlay' && handlers) {
            handlers.set(el, closeSharedOverlay);
        }
    }

    /** 全量扫描（页面加载 / 手动刷新时调用） */
    function sweep() {
        var list = doc.querySelectorAll(HINT_SELECTOR + ', body > *');
        for (var i = 0; i < list.length; i++) consider(list[i]);
    }

    function startObserver() {
        if (observer || typeof global.MutationObserver !== 'function' || !doc.body) return;
        observer = new global.MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var added = mutations[i].addedNodes;
                for (var j = 0; j < added.length; j++) consider(added[j]);
            }
        });
        observer.observe(doc.body, { childList: true, subtree: true });
    }

    function init() {
        injectStyles();
        bindEvents();
        sweep();
        startObserver();
        global.addEventListener('load', function () {
            sweep();
            startObserver();
        });
    }

    if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    /**
     * 对外接口
     * - register(el, fn)：为遮罩层指定关闭回调（优先级最高）
     * - unregister(el)
     * - refresh()：新弹窗若未被自动识别，可手动触发一次扫描
     */
    global.ModalBackdrop = {
        register: function (el, fn) {
            if (el && handlers && typeof fn === 'function') handlers.set(el, fn);
        },
        unregister: function (el) {
            if (el && handlers) handlers.delete(el);
        },
        refresh: sweep
    };
})(typeof window !== 'undefined' ? window : this);
