/**
 * AI 助手 - 专业重构版
 * @description 基于现代设计系统标准的全新 AI 助手界面
 * @module modules/shared/ai-assistant
 */

const PANEL_ID = 'ai-assistant-panel';
const STORAGE_KEY = 'plenzo_ai_chat_v3';
const MAX_HISTORY = 30;

// 消息类型枚举
const MessageType = {
    TEXT: 'text',
    DATA_TABLE: 'data_table',
    SCHEDULE_LIST: 'schedule_list',
    CHART_DATA: 'chart_data',
    SCHEDULE_PREVIEW: 'schedule_preview'
};

// 状态管理
const state = {
    panelEl: null,
    messagesEl: null,
    inputEl: null,
    sendBtnEl: null,
    floatBtnEl: null,
    stopBtnEl: null,
    messages: [],
    loading: false,
    userRole: 'admin',
    isHidden: false,
    abortController: null,
    inputHistory: [],
    historyIndex: -1,
    clickOutsideHandler: null,
    selectedImages: [],  // 存储选中的图片
    modelCapabilities: {  // 新增：当前模型能力
        vision: false,
        tools: false,
        reasoning: false
    }
};

/**
 * 快捷问题配置
 */
const QUICK_QUESTIONS = {
    admin: [
        '系统总览数据',
        '本月排课总数',
        '待确认的排课',
        '按课程类型统计'
    ],
    teacher: [
        '我的总览数据',
        '我本周的课表',
        '我本月排了多少课'
    ]
};

/**
 * 注入现代化样式
 */
function injectStyles() {
    if (document.getElementById('ai-assistant-styles')) {
        document.getElementById('ai-assistant-styles').remove();
    }
    const style = document.createElement('style');
    style.id = 'ai-assistant-styles';
    style.textContent = `
    /* ========================================
       Design System Variables
       ======================================== */
    :root {
        --ai-primary: #3b82f6;
        --ai-primary-hover: #2563eb;
        --ai-primary-light: #dbeafe;
        --ai-surface: #ffffff;
        --ai-background: #f8fafc;
        --ai-border: #e2e8f0;
        --ai-border-hover: #cbd5e1;
        --ai-text-primary: #1e293b;
        --ai-text-secondary: #64748b;
        --ai-text-tertiary: #94a3b8;
        --ai-success: #10b981;
        --ai-danger: #ef4444;
        --ai-warning: #f59e0b;
        --ai-radius-sm: 8px;
        --ai-radius-md: 12px;
        --ai-radius-lg: 16px;
        --ai-radius-xl: 20px;
        --ai-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
        --ai-shadow-md: 0 4px 6px rgba(0, 0, 0, 0.07), 0 2px 4px rgba(0, 0, 0, 0.05);
        --ai-shadow-lg: 0 10px 15px rgba(0, 0, 0, 0.1), 0 4px 6px rgba(0, 0, 0, 0.05);
        --ai-shadow-xl: 0 20px 25px rgba(0, 0, 0, 0.1), 0 10px 10px rgba(0, 0, 0, 0.04);
    }

    /* ========================================
       Floating Action Button
       ======================================== */
    .ai-float-btn {
        position: fixed;
        right: 6%;
        bottom: 6%;
        width: 54px;
        height: 54px;
        border-radius: 50%;
        background: linear-gradient(135deg, var(--ai-primary) 0%, #1d4ed8 100%);
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100000;
        box-shadow: var(--ai-shadow-lg);
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        overflow: hidden;
    }

    .ai-float-btn::before {
        content: '';
        position: absolute;
        width: 100%;
        height: 100%;
        background: radial-gradient(circle, rgba(255, 255, 255, 0.3) 0%, transparent 70%);
        opacity: 0;
        transition: opacity 0.3s;
    }

    .ai-float-btn:hover {
        transform: translateY(-4px) scale(1.05);
        box-shadow: 0 20px 30px rgba(59, 130, 246, 0.3), 0 10px 15px rgba(0, 0, 0, 0.1);
    }

    .ai-float-btn:hover::before {
        opacity: 1;
    }

    .ai-float-btn:active {
        transform: translateY(-2px) scale(1.02);
    }

    .ai-float-btn svg {
        width: 28px;
        height: 28px;
        color: white;
        position: relative;
        z-index: 1;
        filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.1));
    }

    /* Pulse animation for status indicator */
    @keyframes ai-pulse {
        0%, 100% {
            transform: scale(1);
            opacity: 1;
        }
        50% {
            transform: scale(1.1);
            opacity: 0.8;
        }
    }

    .ai-float-btn.offline {
        background: linear-gradient(135deg, #64748b 0%, #475569 100%);
    }

    /* ========================================
       Panel Container
       ======================================== */
    .ai-panel-overlay {
        position: fixed;
        right: 6%;
        bottom: calc(6% + 70px);
        width: calc(100vw * 3 / 7 * 1.25);
        height: calc(50vh * 1.2);
        background: var(--ai-surface);
        border-radius: 16px;
        box-shadow: var(--ai-shadow-xl);
        z-index: 100001;
        display: none;
        flex-direction: column;
        opacity: 0;
        transform: translateY(20px) scale(0.95);
        transition: opacity 0.3s, transform 0.3s;
        overflow: hidden;
        border: 1px solid var(--ai-border);
    }

    .ai-panel-overlay.resizing {
        transition: none;
    }

    .ai-panel-overlay.open {
        display: flex;
        opacity: 1;
        transform: translateY(0) scale(1);
    }

    .ai-panel-overlay.hidden {
        display: none !important;
    }

    /* 拖拽调节手柄 */
    .ai-resize-handle {
        position: absolute;
        z-index: 10;
    }

    .ai-resize-handle-top {
        top: 0;
        left: 0;
        right: 0;
        height: 8px;
        cursor: ns-resize;
    }

    .ai-resize-handle-right {
        top: 0;
        right: 0;
        bottom: 0;
        width: 8px;
        cursor: ew-resize;
    }

    .ai-resize-handle-bottom {
        bottom: 0;
        left: 0;
        right: 0;
        height: 8px;
        cursor: ns-resize;
    }

    .ai-resize-handle-left {
        top: 0;
        left: 0;
        bottom: 0;
        width: 8px;
        cursor: ew-resize;
    }

    .ai-resize-handle-top-left {
        top: 0;
        left: 0;
        width: 16px;
        height: 16px;
        cursor: nwse-resize;
    }

    .ai-resize-handle-top-right {
        top: 0;
        right: 0;
        width: 16px;
        height: 16px;
        cursor: nesw-resize;
    }

    .ai-resize-handle-bottom-left {
        bottom: 0;
        left: 0;
        width: 16px;
        height: 16px;
        cursor: nesw-resize;
    }

    .ai-resize-handle-bottom-right {
        bottom: 0;
        right: 0;
        width: 16px;
        height: 16px;
        cursor: nwse-resize;
    }

    /* ========================================
       Header
       ======================================== */
    .ai-panel-header {
        padding: 9px 20px;
        border-bottom: 1px solid var(--ai-border);
        background: linear-gradient(180deg, var(--ai-background) 0%, var(--ai-surface) 100%);
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-shrink: 0;
        border-radius: 16px 16px 0 0;
    }

    .ai-panel-title {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 14px;
        font-weight: 600;
        color: var(--ai-text-primary);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }

    .ai-panel-title > div:first-child {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .ai-panel-title-icon {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        background: linear-gradient(135deg, var(--ai-primary) 0%, #1d4ed8 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: var(--ai-shadow-sm);
    }

    .ai-panel-title-icon svg {
        width: 18px;
        height: 18px;
        color: white;
    }

    .ai-status-badge {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 3px 8px;
        background: var(--ai-primary-light);
        color: var(--ai-primary);
        border-radius: 9px;
        font-size: 10px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.3px;
    }

    .ai-status-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--ai-success);
        animation: ai-pulse 2s ease-in-out infinite;
    }

    .ai-status-badge.offline .ai-status-dot {
        background: var(--ai-text-tertiary);
        animation: none;
    }

    .ai-panel-controls {
        display: flex;
        gap: 6px;
    }

    .ai-panel-controls button {
        width: 48px;
        height: 48px;
        border-radius: 10px;
        border: none;
        background: transparent;
        color: var(--ai-text-secondary);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        position: relative;
    }

    .ai-panel-controls button svg {
        width: 26px;
        height: 26px;
        transition: all 0.2s;
    }

    .ai-panel-controls button:hover {
        background: var(--ai-background);
        color: var(--ai-text-primary);
        transform: translateY(-1px);
    }

    .ai-panel-controls button:active {
        transform: translateY(0) scale(0.95);
    }

    #ai-clear-btn:hover {
        color: var(--ai-danger);
        background: #fef2f2;
    }

    #ai-minimize-btn:hover {
        color: var(--ai-warning);
        background: #fffbeb;
    }

    #ai-close-btn:hover {
        color: var(--ai-danger);
        background: #fef2f2;
    }

    /* ========================================
       Quick Actions
       ======================================== */
    .ai-panel-quick {
        padding: 13px 16px;
        background: transparent;
        border-bottom: none;
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        flex-shrink: 0;
        position: relative;
        z-index: 1;
    }

    .ai-quick-btn {
        padding: 5px 12px;
        background: transparent;
        border: 1px solid var(--ai-border);
        border-radius: 16px;
        font-size: 13px;
        color: var(--ai-text-secondary);
        cursor: pointer;
        transition: all 0.2s;
        white-space: nowrap;
        font-weight: 500;
    }

    .ai-quick-btn:hover {
        background: transparent;
        color: var(--ai-primary);
        border-color: var(--ai-primary);
        transform: translateY(-1px);
        box-shadow: none;
    }

    /* ========================================
       Messages Area
       ======================================== */
    .ai-panel-body {
        flex: 1;
        overflow-y: auto;
        padding: 14px;
        background: var(--ai-background);
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .ai-panel-body::-webkit-scrollbar {
        width: 6px;
    }

    .ai-panel-body::-webkit-scrollbar-track {
        background: transparent;
    }

    .ai-panel-body::-webkit-scrollbar-thumb {
        background: var(--ai-border);
        border-radius: 3px;
    }

    .ai-panel-body::-webkit-scrollbar-thumb:hover {
        background: var(--ai-border-hover);
    }

    /* ========================================
       Message Bubbles
       ======================================== */
    .ai-msg {
        display: flex;
        flex-direction: column;
        max-width: 85%;
        animation: slideIn 0.3s ease-out;
    }

    @keyframes slideIn {
        from {
            opacity: 0;
            transform: translateY(8px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    .ai-msg.user {
        align-self: flex-end;
        align-items: flex-end;
        max-width: 85%;
    }

    .ai-msg.assistant {
        align-self: flex-start;
        max-width: 95%;
    }

    .ai-msg-bubble {
        padding: 12px 16px;
        border-radius: 16px;
        font-size: 14px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }

    .ai-msg.user .ai-msg-bubble {
        background: linear-gradient(135deg, var(--ai-primary) 0%, #2563eb 100%);
        color: white;
        border-bottom-right-radius: 6px;
        box-shadow: 0 2px 8px rgba(59, 130, 246, 0.25);
        border: none;
    }

    .ai-msg.assistant .ai-msg-bubble {
        background: var(--ai-surface);
        border: 1px solid var(--ai-border);
        color: var(--ai-text-primary);
        border-bottom-left-radius: 6px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
    }

    .ai-msg-bubble.error {
        background: #fef2f2;
        border-color: #fecaca;
        color: #991b1b;
    }

    /* Markdown 渲染样式 */
    .ai-msg-bubble h1,
    .ai-msg-bubble h2,
    .ai-msg-bubble h3 {
        font-weight: 600;
        margin: 8px 0 4px 0;
        color: var(--ai-text-primary);
        line-height: 1.3;
    }

    .ai-msg-bubble h1 { font-size: 13px; }
    .ai-msg-bubble h2 { font-size: 12px; }
    .ai-msg-bubble h3 { font-size: 12px; }

    .ai-msg-bubble code {
        background: var(--ai-background);
        padding: 2px 5px;
        border-radius: 3px;
        font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
        font-size: 13px;
        color: var(--ai-primary);
        border: 1px solid var(--ai-border);
    }

    .ai-msg-bubble pre {
        background: var(--ai-background);
        padding: 8px;
        border-radius: 6px;
        overflow-x: auto;
        margin: 6px 0;
        border: 1px solid var(--ai-border);
    }

    .ai-msg-bubble pre code {
        background: none;
        padding: 0;
        border: none;
        font-size: 12px;
        color: var(--ai-text-primary);
    }

    .ai-msg-bubble ul,
    .ai-msg-bubble ol {
        margin: 6px 0;
        padding-left: 18px;
    }

    .ai-msg-bubble li {
        margin: 3px 0;
        font-size: 14px;
    }

    .ai-msg-bubble strong {
        font-weight: 600;
        color: var(--ai-text-primary);
    }

    .ai-msg-bubble em {
        font-style: italic;
    }

    .ai-msg-bubble a {
        color: var(--ai-primary);
        text-decoration: none;
        border-bottom: 1px solid var(--ai-primary);
    }

    .ai-msg-bubble a:hover {
        color: var(--ai-primary-hover);
        border-bottom-color: var(--ai-primary-hover);
    }

    /* Empty state */
    .ai-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 35px 17px;
        color: var(--ai-text-secondary);
        font-size: 14px;
        line-height: 1.5;
    }

    .ai-empty .icon {
        font-size: 41px;
        margin-bottom: 10px;
        opacity: 0.5;
    }

    /* ========================================
       Data Tables
       ======================================== */
    .ai-data-table {
        margin-top: 7px;
        background: transparent;
        border: 1px solid var(--ai-border);
        border-radius: 10px;
        overflow: hidden;
        box-shadow: none;
    }

    .ai-data-table table {
        width: 100%;
        border-collapse: collapse;
        font-size: 14px;
    }

    .ai-data-table th {
        background: var(--ai-background);
        padding: 8px 10px;
        text-align: left;
        font-weight: 600;
        color: var(--ai-text-secondary);
        border-bottom: 1px solid var(--ai-border);
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.3px;
    }

    .ai-data-table td {
        padding: 8px 10px;
        border-bottom: 1px solid var(--ai-border);
        color: var(--ai-text-primary);
        font-size: 14px;
    }

    .ai-data-table tr:last-child td {
        border-bottom: none;
    }

    .ai-data-table tbody tr:hover {
        background: var(--ai-background);
    }

    /* ========================================
       Typing Indicator
       ======================================== */
    .ai-typing {
        display: flex;
        gap: 4px;
        padding: 10px 14px;
        align-self: flex-start;
        background: var(--ai-surface);
        border: 1px solid var(--ai-border);
        border-radius: 10px;
        border-bottom-left-radius: 4px;
    }

    .ai-typing span {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--ai-text-tertiary);
        animation: typing 1.4s infinite;
    }

    .ai-typing span:nth-child(2) {
        animation-delay: 0.2s;
    }

    .ai-typing span:nth-child(3) {
        animation-delay: 0.4s;
    }

    @keyframes typing {
        0%, 60%, 100% {
            transform: translateY(0);
            opacity: 0.7;
        }
        30% {
            transform: translateY(-7px);
            opacity: 1;
        }
    }

    /* ========================================
       Input Area
       ======================================== */
    .ai-panel-footer {
        padding: 16px 20px;
        border-top: 1px solid var(--ai-border);
        background: linear-gradient(180deg, var(--ai-surface) 0%, var(--ai-background) 100%);
        display: flex;
        flex-direction: column;
        gap: 12px;
        flex-shrink: 0;
        border-radius: 0 0 16px 16px;
    }

    .ai-image-preview {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        padding: 0;
        max-height: 120px;
        overflow-y: auto;
    }

    .ai-image-preview:empty {
        display: none;
    }

    .ai-image-preview-item {
        position: relative;
        width: 80px;
        height: 80px;
        border-radius: 8px;
        overflow: hidden;
        border: 2px solid var(--ai-border);
        background: var(--ai-surface);
    }

    .ai-image-preview-item img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }

    .ai-image-preview-item .remove-image {
        position: absolute;
        top: 4px;
        right: 4px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.6);
        color: white;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        transition: all 0.2s;
    }

    .ai-image-preview-item .remove-image:hover {
        background: rgba(239, 68, 68, 0.9);
        transform: scale(1.1);
    }

    .ai-input-row {
        display: flex;
        gap: 12px;
        align-items: flex-end;
    }

    .ai-image-btn {
        width: 40px;
        height: 40px;
        border-radius: 12px;
        border: 2px solid var(--ai-border);
        background: var(--ai-surface);
        color: var(--ai-text-secondary);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
        flex-shrink: 0;
    }

    .ai-image-btn:hover {
        border-color: var(--ai-primary);
        color: var(--ai-primary);
        background: rgba(59, 130, 246, 0.05);
    }

    .ai-image-btn svg {
        width: 20px;
        height: 20px;
    }

    .ai-panel-input {
        flex: 1;
        background: var(--ai-surface);
        border: 2px solid var(--ai-border);
        border-radius: 16px;
        padding: 12px 16px;
        color: var(--ai-text-primary);
        font-size: 14px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        resize: none;
        min-height: 44px;
        max-height: none;
        outline: none;
        transition: all 0.2s ease;
        line-height: 1.5;
    }

    .ai-panel-input:focus {
        border-color: var(--ai-primary);
        background: var(--ai-surface);
        box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.08);
    }

    .ai-panel-input::placeholder {
        color: var(--ai-text-tertiary);
    }

    .ai-panel-send,
    .ai-panel-stop {
        width: 40px;
        height: 40px;
        border-radius: 12px;
        border: none;
        background: linear-gradient(135deg, var(--ai-primary) 0%, #2563eb 100%);
        color: white;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        box-shadow: 0 2px 8px rgba(59, 130, 246, 0.3);
        flex-shrink: 0;
        position: relative;
        overflow: hidden;
    }

    .ai-panel-send svg,
    .ai-panel-stop svg {
        width: 22px;
        height: 22px;
        position: relative;
        z-index: 1;
        transition: all 0.25s;
    }

    .ai-panel-send::before,
    .ai-panel-stop::before {
        content: '';
        position: absolute;
        top: 50%;
        left: 50%;
        width: 0;
        height: 0;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.3);
        transform: translate(-50%, -50%);
        transition: width 0.6s, height 0.6s;
    }

    .ai-panel-send:hover,
    .ai-panel-stop:hover {
        transform: translateY(-2px) scale(1.05);
        box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
    }

    .ai-panel-send:hover::before,
    .ai-panel-stop:hover::before {
        width: 100%;
        height: 100%;
    }

    .ai-panel-send:hover svg {
        transform: translateX(2px);
    }

    .ai-panel-send:active,
    .ai-panel-stop:active {
        transform: translateY(0) scale(0.98);
        box-shadow: 0 1px 4px rgba(59, 130, 246, 0.3);
    }

    .ai-panel-send:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none;
        box-shadow: 0 2px 4px rgba(59, 130, 246, 0.2);
    }

    .ai-panel-send:disabled:hover {
        transform: none;
    }

    .ai-panel-stop {
        background: linear-gradient(135deg, var(--ai-danger) 0%, #dc2626 100%);
        box-shadow: 0 2px 8px rgba(239, 68, 68, 0.3);
    }

    .ai-panel-stop:hover {
        box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4);
    }

    .ai-panel-stop:active {
        box-shadow: 0 1px 4px rgba(239, 68, 68, 0.3);
    }

    /* ========================================
       Preview Cards
       ======================================== */
    .ai-preview-card {
        margin-top: 7px;
        background: var(--ai-surface);
        border: 2px solid var(--ai-primary);
        border-radius: 10px;
        overflow: hidden;
        box-shadow: var(--ai-shadow-md);
    }

    .ai-preview-header {
        padding: 14px;
        background: var(--ai-primary-light);
        border-bottom: 2px solid var(--ai-primary);
    }

    .ai-preview-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--ai-primary);
        margin-bottom: 7px;
        display: flex;
        align-items: center;
        gap: 7px;
    }

    .ai-preview-meta {
        font-size: 10px;
        color: var(--ai-text-secondary);
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
    }

    .ai-preview-meta-item {
        display: flex;
        align-items: center;
        gap: 4px;
    }

    .ai-preview-meta-item strong {
        color: var(--ai-text-primary);
        font-weight: 600;
    }

    .ai-preview-actions {
        padding: 14px;
        background: var(--ai-background);
        border-top: 1px solid var(--ai-border);
        display: flex;
        gap: 7px;
    }

    .ai-btn-confirm {
        flex: 1;
        padding: 8px 14px;
        background: linear-gradient(135deg, var(--ai-success) 0%, #059669 100%);
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
        box-shadow: var(--ai-shadow-sm);
    }

    .ai-btn-confirm:hover {
        transform: translateY(-1px);
        box-shadow: var(--ai-shadow-md);
    }

    .ai-btn-confirm:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none;
    }

    /* ========================================
       Responsive Design
       ======================================== */
    @media (max-width: 768px) {
        .ai-panel-overlay {
            right: 12px;
            bottom: 80px;
            width: calc(100vw - 24px);
            max-width: 420px;
        }

        .ai-float-btn {
            right: 12px;
            bottom: 12px;
        }
    }
    `;
    document.head.appendChild(style);
}

/**
 * 构建面板 DOM
 */
function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const overlay = document.createElement('div');
    overlay.id = PANEL_ID;
    overlay.className = 'ai-panel-overlay';
    overlay.innerHTML = `
        <div class="ai-resize-handle ai-resize-handle-top"></div>
        <div class="ai-resize-handle ai-resize-handle-right"></div>
        <div class="ai-resize-handle ai-resize-handle-bottom"></div>
        <div class="ai-resize-handle ai-resize-handle-left"></div>
        <div class="ai-resize-handle ai-resize-handle-top-left"></div>
        <div class="ai-resize-handle ai-resize-handle-top-right"></div>
        <div class="ai-resize-handle ai-resize-handle-bottom-left"></div>
        <div class="ai-resize-handle ai-resize-handle-bottom-right"></div>
        <div class="ai-panel-header">
            <div class="ai-panel-title">
                <div class="ai-panel-title-icon">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 22.5l-.394-1.933a2.25 2.25 0 00-1.423-1.423L12.75 18.75l1.933-.394a2.25 2.25 0 001.423-1.423l.394-1.933.394 1.933a2.25 2.25 0 001.423 1.423l1.933.394-1.933.394a2.25 2.25 0 00-1.423 1.423z" fill="currentColor"/>
                    </svg>
                </div>
                <div style="font-size: 14px; font-weight: 600;">AI 助手</div>
                <div class="ai-status-badge">
                    <span class="ai-status-dot"></span>
                    <span>在线</span>
                </div>
            </div>
            <div class="ai-panel-controls">
                <button id="ai-clear-btn" title="清空对话">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </button>
                <button id="ai-minimize-btn" title="最小化">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
                    </svg>
                </button>
                <button id="ai-close-btn" title="关闭">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
                    </svg>
                </button>
            </div>
        </div>
        <div id="ai-panel-quick" class="ai-panel-quick"></div>
        <div id="ai-panel-messages" class="ai-panel-body"></div>
        <div class="ai-panel-footer">
            <div id="ai-image-preview" class="ai-image-preview"></div>
            <div class="ai-input-row">
                <button id="ai-image-btn" class="ai-image-btn" title="上传图片">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/>
                        <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/>
                        <path d="M21 15l-5-5L5 21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </button>
                <textarea
                    id="ai-panel-input"
                    class="ai-panel-input"
                    placeholder="输入问题，按 Enter 发送..."
                    rows="1"
                ></textarea>
                <button id="ai-send-btn" class="ai-panel-send">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M5 12h14m0 0l-6-6m6 6l-6 6" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </button>
                <button id="ai-stop-btn" class="ai-panel-stop" style="display: none;">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>
                    </svg>
                </button>
            </div>
            <input type="file" id="ai-image-input" accept="image/*" multiple style="display: none;">
        </div>
    `;

    document.body.appendChild(overlay);

    state.panelEl = overlay;
    state.messagesEl = overlay.querySelector('#ai-panel-messages');
    state.inputEl = overlay.querySelector('#ai-panel-input');
    state.sendBtnEl = overlay.querySelector('#ai-send-btn');
    state.stopBtnEl = overlay.querySelector('#ai-stop-btn');

    // 绑定事件
    overlay.querySelector('#ai-clear-btn').addEventListener('click', clearHistory);
    overlay.querySelector('#ai-minimize-btn').addEventListener('click', minimize);
    overlay.querySelector('#ai-close-btn').addEventListener('click', closeCompletely);
    state.sendBtnEl.addEventListener('click', onSend);
    state.stopBtnEl.addEventListener('click', stopQuery);

    // 图片上传事件
    const imageBtn = overlay.querySelector('#ai-image-btn');
    const imageInput = overlay.querySelector('#ai-image-input');
    imageBtn.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', handleImageSelect);

    // 输入框事件
    state.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSend();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            navigateHistory('up');
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            navigateHistory('down');
        }
    });

    // 自动调整输入框高度
    state.inputEl.addEventListener('input', () => {
        state.inputEl.style.height = 'auto';
        state.inputEl.style.height = state.inputEl.scrollHeight + 'px';
    });

    // 绑定调节手柄
    setupResizeHandles(overlay);
}

/**
 * 设置拖拽调节功能
 */
function setupResizeHandles(panel) {
    const handles = panel.querySelectorAll('.ai-resize-handle');

    handles.forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const startX = e.clientX;
            const startY = e.clientY;
            const startWidth = panel.offsetWidth;
            const startHeight = panel.offsetHeight;
            const startRight = parseInt(getComputedStyle(panel).right);
            const startBottom = parseInt(getComputedStyle(panel).bottom);

            const direction = handle.className.split(' ')[1].replace('ai-resize-handle-', '');
            panel.classList.add('resizing');

            const onMouseMove = (moveEvent) => {
                const deltaX = moveEvent.clientX - startX;
                const deltaY = moveEvent.clientY - startY;

                let newWidth = startWidth;
                let newHeight = startHeight;
                let newRight = startRight;
                let newBottom = startBottom;

                // 根据方向调整尺寸
                if (direction.includes('left')) {
                    // 左边：向左拖拽增加宽度，不改变右侧位置
                    newWidth = startWidth - deltaX;
                }
                if (direction.includes('right')) {
                    // 右边：向右拖拽减小宽度，同时调整右侧位置
                    newWidth = startWidth - deltaX;
                    newRight = startRight + deltaX;
                }
                if (direction.includes('top')) {
                    // 顶部：向上拖拽增加高度，不改变底部位置
                    newHeight = startHeight - deltaY;
                }
                if (direction.includes('bottom')) {
                    // 底部：向下拖拽减小高度，同时调整底部位置
                    newHeight = startHeight - deltaY;
                    newBottom = startBottom + deltaY;
                }

                // 应用新尺寸（不限制边界）
                panel.style.width = `${newWidth}px`;
                panel.style.height = `${newHeight}px`;
                panel.style.right = `${newRight}px`;
                panel.style.bottom = `${newBottom}px`;
            };

            const onMouseUp = () => {
                panel.classList.remove('resizing');
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    });
}

/**
 * 渲染快捷问题
 */
function renderQuickQuestions() {
    const container = state.panelEl?.querySelector('#ai-panel-quick');
    if (!container) return;

    container.innerHTML = '';
    const questions = QUICK_QUESTIONS[state.userRole] || QUICK_QUESTIONS.admin;

    questions.forEach(q => {
        const btn = document.createElement('button');
        btn.className = 'ai-quick-btn';
        btn.textContent = q;
        btn.addEventListener('click', () => {
            state.inputEl.value = q;
            onSend();
        });
        container.appendChild(btn);
    });
}

/**
 * 渲染消息列表
 */
function renderMessages() {
    const el = state.messagesEl;
    if (!el) return;

    el.innerHTML = '';

    if (state.messages.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ai-empty';
        const isAdmin = state.userRole === 'admin';
        const examples = isAdmin
            ? '试试：「系统总览数据」「本月排课总数」「按课程类型统计」'
            : '试试：「我的总览数据」「我本周的课表」';
        empty.innerHTML = `
            <span class="icon">💬</span>
            <div>我是你的 AI 助手，可以帮你查询和分析排课数据。</div>
            <div style="margin-top: 8px; font-size: 13px;">${examples}</div>
        `;
        el.appendChild(empty);
        return;
    }

    state.messages.forEach((msg, idx) => {
        el.appendChild(renderMessage(msg, idx));
    });

    // 如果正在加载中，恢复打字提示
    if (state.loading) {
        showTyping();
    }

    // 自动滚动到最新消息
    setTimeout(() => {
        el.scrollTop = el.scrollHeight;
    }, 50);
}

/**
 * 渲染单条消息
 */
function renderMessage(msg, index) {
    const wrapper = document.createElement('div');
    wrapper.className = `ai-msg ${msg.role}`;

    if (msg.role === 'user') {
        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble';

        // 如果有图片，先显示图片
        if (msg.images && msg.images.length > 0) {
            const imagesContainer = document.createElement('div');
            imagesContainer.className = 'ai-msg-images';
            imagesContainer.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px;';

            msg.images.forEach(img => {
                const imgEl = document.createElement('img');
                imgEl.src = img.dataUrl;
                imgEl.alt = img.name;
                imgEl.style.cssText = 'max-width: 200px; max-height: 200px; border-radius: 8px; cursor: pointer; object-fit: cover;';
                imgEl.onclick = () => window.open(img.dataUrl, '_blank');
                imagesContainer.appendChild(imgEl);
            });

            bubble.appendChild(imagesContainer);
        }

        // 显示文本内容
        if (msg.content) {
            const textEl = document.createElement('div');
            textEl.textContent = msg.content;
            bubble.appendChild(textEl);
        }

        wrapper.appendChild(bubble);
        return wrapper;
    }

    // Assistant 消息
    if (msg.isError) {
        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble error';
        bubble.textContent = msg.content;
        wrapper.appendChild(bubble);
        return wrapper;
    }

    // 根据消息类型渲染
    switch (msg.type) {
        case MessageType.DATA_TABLE:
            return renderDataTableMessage(msg);
        case MessageType.SCHEDULE_LIST:
            return renderScheduleListMessage(msg);
        case MessageType.CHART_DATA:
            return renderChartDataMessage(msg);
        case MessageType.SCHEDULE_PREVIEW:
            return renderSchedulePreviewMessage(msg);
        default:
            return renderTextMessage(msg);
    }
}

/**
 * 简单的 Markdown 渲染器
 */
function renderMarkdown(text) {
    if (!text || typeof text !== 'string') return text;

    let html = text;

    // 代码块
    html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');

    // 行内代码
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // 标题
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

    // 粗体
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // 斜体
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // 无序列表
    html = html.replace(/^\* (.*$)/gim, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

    // 有序列表
    html = html.replace(/^\d+\. (.*$)/gim, '<li>$1</li>');

    // 链接
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    // 换行
    html = html.replace(/\n/g, '<br>');

    return html;
}

/**
 * 渲染文本消息
 */
function renderTextMessage(msg) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-msg assistant';

    let textContent = msg.answer || msg.content;

    // 如果 content 是对象，尝试提取文本
    if (typeof textContent === 'object') {
        if (textContent && textContent.answer) {
            textContent = textContent.answer;
        } else if (textContent && textContent.content) {
            textContent = textContent.content;
        } else {
            textContent = JSON.stringify(textContent);
        }
    }

    if (textContent) {
        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble';
        bubble.innerHTML = renderMarkdown(textContent);
        wrapper.appendChild(bubble);
    }

    return wrapper;
}

/**
 * 渲染数据表格消息
 */
function renderDataTableMessage(msg) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-msg assistant';

    let textContent = msg.answer;
    if (typeof textContent === 'object') {
        if (textContent && textContent.answer) {
            textContent = textContent.answer;
        } else if (textContent && textContent.content) {
            textContent = textContent.content;
        } else {
            textContent = null;
        }
    }

    if (textContent) {
        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble';
        bubble.innerHTML = renderMarkdown(textContent);
        wrapper.appendChild(bubble);
    }

    if (msg.data && typeof msg.data === 'object') {
        const tableContainer = document.createElement('div');
        tableContainer.className = 'ai-data-table';

        const table = document.createElement('table');
        const tbody = document.createElement('tbody');

        Object.entries(msg.data).forEach(([key, value]) => {
            if (key === 'slots' && Array.isArray(value)) return;

            const tr = document.createElement('tr');
            const tdKey = document.createElement('td');
            tdKey.textContent = formatColumnName(key);
            tdKey.style.fontWeight = '600';

            const tdValue = document.createElement('td');
            tdValue.textContent = formatCellValue(value);

            tr.appendChild(tdKey);
            tr.appendChild(tdValue);
            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        tableContainer.appendChild(table);
        wrapper.appendChild(tableContainer);
    }

    return wrapper;
}

/**
 * 渲染排课列表消息
 */
function renderScheduleListMessage(msg) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-msg assistant';

    let textContent = msg.answer;
    if (typeof textContent === 'object') {
        if (textContent && textContent.answer) {
            textContent = textContent.answer;
        } else if (textContent && textContent.content) {
            textContent = textContent.content;
        } else {
            textContent = null;
        }
    }

    if (textContent) {
        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble';
        bubble.innerHTML = renderMarkdown(textContent);
        wrapper.appendChild(bubble);
    }

    if (msg.data && Array.isArray(msg.data)) {
        const tableContainer = document.createElement('div');
        tableContainer.className = 'ai-data-table';

        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        ['日期', '时间', '教师', '学生', '课程', '状态'].forEach(text => {
            const th = document.createElement('th');
            th.textContent = text;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        msg.data.forEach(schedule => {
            const tr = document.createElement('tr');

            const tdDate = document.createElement('td');
            tdDate.textContent = formatDate(schedule.class_date);
            tr.appendChild(tdDate);

            const tdTime = document.createElement('td');
            tdTime.textContent = `${schedule.start_time || '-'} - ${schedule.end_time || '-'}`;
            tdTime.style.fontSize = '11px';
            tr.appendChild(tdTime);

            const tdTeacher = document.createElement('td');
            tdTeacher.textContent = schedule.teacher_name || '-';
            tr.appendChild(tdTeacher);

            const tdStudent = document.createElement('td');
            tdStudent.textContent = schedule.student_name || '-';
            tr.appendChild(tdStudent);

            const tdCourse = document.createElement('td');
            tdCourse.textContent = schedule.course_type_cn || schedule.course_type || '-';
            tr.appendChild(tdCourse);

            const tdStatus = document.createElement('td');
            tdStatus.textContent = schedule.status_cn || schedule.status || '-';
            tdStatus.style.color = getStatusColor(schedule.status);
            tdStatus.style.fontWeight = '600';
            tr.appendChild(tdStatus);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        tableContainer.appendChild(table);
        wrapper.appendChild(tableContainer);
    }

    return wrapper;
}

/**
 * 渲染图表数据消息
 */
function renderChartDataMessage(msg) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-msg assistant';

    let textContent = msg.answer;
    if (typeof textContent === 'object') {
        if (textContent && textContent.answer) {
            textContent = textContent.answer;
        } else if (textContent && textContent.content) {
            textContent = textContent.content;
        } else {
            textContent = null;
        }
    }

    if (textContent) {
        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble';
        bubble.innerHTML = renderMarkdown(textContent);
        wrapper.appendChild(bubble);
    }

    if (msg.data && Array.isArray(msg.data)) {
        const tableContainer = document.createElement('div');
        tableContainer.className = 'ai-data-table';

        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        const th1 = document.createElement('th');
        th1.textContent = '类别';
        const th2 = document.createElement('th');
        th2.textContent = '数量';
        headerRow.appendChild(th1);
        headerRow.appendChild(th2);
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        msg.data.forEach(item => {
            const tr = document.createElement('tr');

            const tdCategory = document.createElement('td');
            tdCategory.textContent = item.category;
            const tdCount = document.createElement('td');
            tdCount.textContent = item.count;
            tdCount.style.fontWeight = '600';
            tr.appendChild(tdCategory);
            tr.appendChild(tdCount);
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        tableContainer.appendChild(table);
        wrapper.appendChild(tableContainer);
    }

    return wrapper;
}

/**
 * 渲染排课预览消息
 */
function renderSchedulePreviewMessage(msg) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-msg assistant';

    let textContent = msg.answer;
    if (typeof textContent === 'object') {
        if (textContent && textContent.answer) {
            textContent = textContent.answer;
        } else if (textContent && textContent.content) {
            textContent = textContent.content;
        } else {
            textContent = null;
        }
    }

    if (textContent) {
        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble';
        bubble.innerHTML = renderMarkdown(textContent);
        wrapper.appendChild(bubble);
    }

    if (msg.data && msg.data.schedules && msg.data.schedules.length > 0) {
        const previewCard = document.createElement('div');
        previewCard.className = 'ai-preview-card';

        // 预览头部
        const previewHeader = document.createElement('div');
        previewHeader.className = 'ai-preview-header';
        previewHeader.innerHTML = `
            <div class="ai-preview-title">
                📋 排课预览方案
            </div>
            <div class="ai-preview-meta">
                <div class="ai-preview-meta-item">
                    教师：<strong>${msg.data.teacher}</strong>
                </div>
                <div class="ai-preview-meta-item">
                    学生：<strong>${msg.data.student}</strong>
                </div>
                <div class="ai-preview-meta-item">
                    课程：<strong>${msg.data.courseType}</strong>
                </div>
                <div class="ai-preview-meta-item">
                    共 <strong>${msg.data.totalCount}</strong> 节课
                </div>
            </div>
        `;
        previewCard.appendChild(previewHeader);

        // 排课列表表格
        const tableContainer = document.createElement('div');
        tableContainer.className = 'ai-data-table';
        tableContainer.style.border = 'none';
        tableContainer.style.borderRadius = '0';

        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        ['日期', '时间', '课程', '状态'].forEach(text => {
            const th = document.createElement('th');
            th.textContent = text;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        msg.data.schedules.forEach(schedule => {
            const tr = document.createElement('tr');

            const tdDate = document.createElement('td');
            tdDate.textContent = formatDate(schedule.class_date);
            tr.appendChild(tdDate);

            const tdTime = document.createElement('td');
            tdTime.textContent = `${schedule.start_time || '-'} - ${schedule.end_time || '-'}`;
            tr.appendChild(tdTime);

            const tdCourse = document.createElement('td');
            tdCourse.textContent = schedule.course_type_cn || schedule.course_type || '-';
            tr.appendChild(tdCourse);

            const tdStatus = document.createElement('td');
            tdStatus.textContent = '预览';
            tdStatus.style.color = 'var(--ai-primary)';
            tdStatus.style.fontWeight = '600';
            tr.appendChild(tdStatus);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        tableContainer.appendChild(table);
        previewCard.appendChild(tableContainer);

        // 确认按钮
        const actions = document.createElement('div');
        actions.className = 'ai-preview-actions';
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'ai-btn-confirm';
        confirmBtn.textContent = '✓ 确认创建排课';
        confirmBtn.onclick = () => {
            const previewId = msg.data.previewId;
            if (previewId) {
                confirmBtn.disabled = true;
                confirmBtn.textContent = '正在创建...';
                state.inputEl.value = `确认创建排课，previewId: ${previewId}`;
                onSend();
            }
        };
        actions.appendChild(confirmBtn);
        previewCard.appendChild(actions);

        wrapper.appendChild(previewCard);
    }

    return wrapper;
}

// 格式化工具函数
function formatColumnName(key) {
    const mapping = {
        id: 'ID',
        name: '姓名',
        profession: '专业',
        status: '状态',
        teacherCount: '教师总数',
        studentCount: '学生总数',
        monthSchedules: '本月排课',
        pendingSchedules: '待确认',
        weekSchedules: '本周排课',
        yearSchedules: '本年排课',
        teacher: '教师',
        student: '学生',
        totalSlots: '可用时段',
        totalCount: '总数'
    };
    return mapping[key] || key;
}

function formatCellValue(value) {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'boolean') return value ? '是' : '否';
    if (value === 0) return '禁用';
    if (value === 1 && typeof value === 'number') return '启用';
    return String(value);
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '-';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getStatusColor(status) {
    const colors = {
        pending: '#f59e0b',
        confirmed: '#10b981',
        cancelled: '#ef4444',
        completed: '#10b981',
        modified_away: '#f59e0b'
    };
    return colors[status] || '#64748b';
}

/**
 * 处理图片选择
 */
async function handleImageSelect(e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    // 限制最多5张图片
    if (state.selectedImages.length + files.length > 5) {
        apiUtils.showToast('最多上传5张图片', 'warning');
        return;
    }

    for (const file of files) {
        // 检查文件大小（限制5MB）
        if (file.size > 5 * 1024 * 1024) {
            apiUtils.showToast(`图片 ${file.name} 超过5MB`, 'warning');
            continue;
        }

        // 检查文件类型
        if (!file.type.startsWith('image/')) {
            apiUtils.showToast(`文件 ${file.name} 不是图片`, 'warning');
            continue;
        }

        // 读取图片为 base64
        const reader = new FileReader();
        reader.onload = (event) => {
            state.selectedImages.push({
                file: file,
                dataUrl: event.target.result,
                name: file.name
            });
            renderImagePreview();
        };
        reader.readAsDataURL(file);
    }

    // 清空 input
    e.target.value = '';
}

/**
 * 渲染图片预览
 */
function renderImagePreview() {
    const container = document.getElementById('ai-image-preview');
    if (!container) return;

    container.innerHTML = '';

    state.selectedImages.forEach((image, index) => {
        const item = document.createElement('div');
        item.className = 'ai-image-preview-item';
        item.innerHTML = `
            <img src="${image.dataUrl}" alt="${image.name}">
            <button class="remove-image" data-index="${index}">×</button>
        `;
        container.appendChild(item);

        // 绑定删除事件
        item.querySelector('.remove-image').addEventListener('click', () => {
            removeImage(index);
        });
    });
}

/**
 * 删除图片
 */
function removeImage(index) {
    state.selectedImages.splice(index, 1);
    renderImagePreview();
}

/**
 * 清空选中的图片
 */
function clearSelectedImages() {
    state.selectedImages = [];
    renderImagePreview();
}

/**
 * 显示 typing 动画
 */
function showTyping() {
    const el = document.createElement('div');
    el.className = 'ai-typing';
    el.id = 'ai-typing-indicator';
    el.innerHTML = '<span></span><span></span><span></span>';
    state.messagesEl.appendChild(el);
    state.messagesEl.scrollTop = state.messagesEl.scrollHeight;
}

function hideTyping() {
    const el = document.getElementById('ai-typing-indicator');
    if (el) el.remove();
}

/**
 * 清空对话历史
 */
function clearHistory() {
    if (state.loading) return;

    if (state.messages.length === 0) return;

    if (!confirm('确定要清空所有对话记录吗？')) return;

    state.messages = [];
    clearSelectedImages();
    renderMessages();
    saveHistory();
}

/**
 * 浏览输入历史记录
 */
function navigateHistory(direction) {
    if (state.inputHistory.length === 0) return;

    if (direction === 'up') {
        if (state.historyIndex === -1) {
            // 第一次按上箭头，保存当前输入
            state.currentInput = state.inputEl.value;
            state.historyIndex = state.inputHistory.length - 1;
        } else if (state.historyIndex > 0) {
            state.historyIndex--;
        }
        state.inputEl.value = state.inputHistory[state.historyIndex];
    } else if (direction === 'down') {
        if (state.historyIndex === -1) {
            return; // 已经在最新位置
        } else if (state.historyIndex < state.inputHistory.length - 1) {
            state.historyIndex++;
            state.inputEl.value = state.inputHistory[state.historyIndex];
        } else {
            // 回到最新位置，恢复之前的输入
            state.historyIndex = -1;
            state.inputEl.value = state.currentInput || '';
        }
    }

    // 调整输入框高度
    state.inputEl.style.height = 'auto';
    state.inputEl.style.height = state.inputEl.scrollHeight + 'px';
}

/**
 * 更新窗口标题
 */
function updateTitle(text) {
    const badge = state.panelEl?.querySelector('.ai-status-badge span:last-child');
    if (badge) badge.textContent = text;
}

/**
 * 发送消息
 */
async function onSend() {
    const text = state.inputEl.value.trim();
    if ((!text && state.selectedImages.length === 0) || state.loading) return;

    // 添加到输入历史记录
    if (text && state.inputHistory[state.inputHistory.length - 1] !== text) {
        state.inputHistory.push(text);
        // 限制历史记录数量为50条
        if (state.inputHistory.length > 50) {
            state.inputHistory.shift();
        }
    }
    // 重置历史索引
    state.historyIndex = -1;
    state.currentInput = '';

    // 构建用户消息内容
    let userContent = text;
    const images = [...state.selectedImages];  // 复制图片数组

    // 如果有图片，构建多模态消息
    if (images.length > 0) {
        userContent = {
            text: text || '请分析这些图片',
            images: images.map(img => img.dataUrl)
        };
    }

    // 添加用户消息
    state.messages.push({
        role: 'user',
        content: text,
        images: images.length > 0 ? images : undefined
    });

    state.inputEl.value = '';
    state.inputEl.style.height = 'auto';
    clearSelectedImages();  // 清空选中的图片
    renderMessages();
    saveHistory();

    state.loading = true;
    state.sendBtnEl.disabled = true;
    state.sendBtnEl.style.display = 'none';
    state.stopBtnEl.style.display = 'flex';

    // 更新标题为加载状态
    updateTitle('思考中...');

    // 创建 abort controller
    state.abortController = new AbortController();

    showTyping();

    try {
        // 构建对话历史（支持图片）
        const conversationHistory = state.messages
            .slice(-10)  // 只保留最近10轮对话
            .map(msg => {
                if (msg.role === 'user' && msg.images && msg.images.length > 0) {
                    // 多模态消息
                    return {
                        role: msg.role,
                        content: [
                            { type: 'text', text: msg.content || '请分析这些图片' },
                            ...msg.images.map(img => ({
                                type: 'image_url',
                                image_url: { url: img.dataUrl }
                            }))
                        ]
                    };
                } else {
                    // 纯文本消息
                    return {
                        role: msg.role,
                        content: msg.role === 'user' ? msg.content : (msg.answer || msg.content || '')
                    };
                }
            });

        const resp = await fetch('/api/ai/query', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify({
                question: text || '请分析这些图片',
                history: conversationHistory,
                images: images.length > 0 ? images.map(img => img.dataUrl) : undefined
            }),
            signal: state.abortController.signal
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ message: '未知错误' }));
            throw new Error(err.message || `HTTP ${resp.status}`);
        }

        const result = await resp.json();
        if (!result.success) throw new Error(result.message);

        const data = result.data;

        // 确保 answer 是字符串
        let answerText = data.answer;
        if (typeof answerText !== 'string') {
            if (answerText && typeof answerText === 'object') {
                answerText = JSON.stringify(answerText, null, 2);
            } else {
                answerText = String(answerText || '');
            }
        }

        // 构建 assistant 消息
        const assistantMsg = {
            role: 'assistant',
            type: data.type || MessageType.TEXT,
            answer: answerText,
            content: answerText,
            data: data.data,
            tools: data.tools
        };

        state.messages.push(assistantMsg);
    } catch (err) {
        if (err.name === 'AbortError') {
            state.messages.push({
                role: 'assistant',
                content: '查询已停止',
                isError: true
            });
        } else {
            state.messages.push({
                role: 'assistant',
                content: `查询失败：${err.message || '请稍后重试'}`,
                isError: true
            });
        }
    } finally {
        hideTyping();
        state.loading = false;
        state.sendBtnEl.disabled = false;
        state.stopBtnEl.style.display = 'none';
        state.sendBtnEl.style.display = 'flex';
        state.abortController = null;

        // 恢复标题
        updateTitle('在线');

        renderMessages();
        saveHistory();
        state.inputEl.focus();
    }
}

/**
 * 停止查询
 */
function stopQuery() {
    if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
    }
    state.loading = false;
    state.sendBtnEl.disabled = false;
    state.stopBtnEl.style.display = 'none';
    state.sendBtnEl.style.display = 'flex';
}

/**
 * 最小化到图标
 */
function minimize() {
    if (!state.panelEl) return;
    state.panelEl.classList.remove('open');

    // 移除点击外部关闭的监听器
    if (state.clickOutsideHandler) {
        document.removeEventListener('click', state.clickOutsideHandler);
        state.clickOutsideHandler = null;
    }
}

/**
 * 完全关闭
 */
function closeCompletely() {
    state.isHidden = true;

    if (state.panelEl) {
        state.panelEl.classList.remove('open');
        state.panelEl.classList.add('hidden');
    }

    if (state.floatBtnEl) {
        state.floatBtnEl.style.display = 'none';
    }
}

/**
 * 持久化历史
 */
function saveHistory() {
    try {
        const trimmed = state.messages.slice(-MAX_HISTORY);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            role: state.userRole,
            messages: trimmed
        }));
    } catch (_) { /* 容量满则忽略 */ }
}

function loadHistory() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed.role && parsed.role !== state.userRole) return;
        if (Array.isArray(parsed.messages)) {
            state.messages = parsed.messages;
        }
    } catch (_) { /* 忽略损坏数据 */ }
}

/**
 * 检查 AI 状态
 */
async function refreshStatus() {
    const badge = state.panelEl?.querySelector('.ai-status-badge');
    const floatBtn = state.floatBtnEl;

    try {
        const resp = await window.apiUtils.get('/ai/status');
        const data = resp.data || resp;

        if (data.enabled) {
            if (badge) {
                badge.classList.remove('offline');
                badge.querySelector('span:last-child').textContent = '在线';
            }
            if (floatBtn) floatBtn.classList.remove('offline');
            return true;
        } else {
            if (badge) {
                badge.classList.add('offline');
                badge.querySelector('span:last-child').textContent = '离线';
            }
            if (floatBtn) floatBtn.classList.add('offline');
            return false;
        }
    } catch (_) {
        if (badge) {
            badge.classList.add('offline');
            badge.querySelector('span:last-child').textContent = '离线';
        }
        if (floatBtn) floatBtn.classList.add('offline');
        return false;
    }
}

/**
 * 获取当前模型的能力信息
 */
async function fetchModelCapabilities() {
    try {
        const resp = await window.apiUtils.get('/ai/capabilities');
        const data = resp.data || resp;

        if (data.capabilities) {
            state.modelCapabilities = data.capabilities;
            updateImageButtonVisibility();
        }
    } catch (error) {
        console.error('获取模型能力失败:', error);
        // 默认隐藏图片按钮
        state.modelCapabilities = {
            vision: false,
            tools: false,
            reasoning: false
        };
        updateImageButtonVisibility();
    }
}

/**
 * 更新图片按钮的显示/隐藏
 */
function updateImageButtonVisibility() {
    const imageBtn = document.getElementById('ai-image-btn');
    if (imageBtn) {
        if (state.modelCapabilities.vision) {
            imageBtn.style.display = 'flex';
        } else {
            imageBtn.style.display = 'none';
            // 如果当前有选中的图片，清空它们
            if (state.selectedImages.length > 0) {
                clearSelectedImages();
            }
        }
    }
}

/**
 * 打开面板
 */
export function open(role) {
    if (role) state.userRole = role;

    // 如果之前被完全关闭，恢复显示
    if (state.isHidden) {
        state.isHidden = false;
        if (state.floatBtnEl) {
            state.floatBtnEl.style.display = 'flex';
        }
    }

    injectStyles();
    buildPanel();
    loadHistory();
    renderQuickQuestions();
    renderMessages();
    refreshStatus();
    fetchModelCapabilities();  // 获取模型能力

    if (state.panelEl) {
        state.panelEl.classList.remove('hidden');
        state.panelEl.classList.add('open');
        state.inputEl?.focus();

        // 恢复加载状态（如果正在加载）
        if (state.loading) {
            updateTitle('思考中...');
            if (state.sendBtnEl) {
                state.sendBtnEl.disabled = true;
                state.sendBtnEl.style.display = 'none';
            }
            if (state.stopBtnEl) {
                state.stopBtnEl.style.display = 'flex';
            }
        }

        // 添加点击外部关闭的监听器
        setupClickOutsideListener();
    }
}

/**
 * 设置点击外部关闭的监听器
 */
function setupClickOutsideListener() {
    // 移除旧的监听器（如果存在）
    if (state.clickOutsideHandler) {
        document.removeEventListener('click', state.clickOutsideHandler);
    }

    // 创建新的监听器
    state.clickOutsideHandler = (e) => {
        // 如果面板未打开，不处理
        if (!state.panelEl || !state.panelEl.classList.contains('open')) {
            return;
        }

        // 检查点击是否在面板内部或悬浮按钮上
        const clickedInsidePanel = state.panelEl.contains(e.target);
        const clickedFloatBtn = state.floatBtnEl && state.floatBtnEl.contains(e.target);

        // 如果点击在外部，关闭面板
        if (!clickedInsidePanel && !clickedFloatBtn) {
            minimize();
        }
    };

    // 添加监听器（延迟添加，避免立即触发）
    setTimeout(() => {
        document.addEventListener('click', state.clickOutsideHandler);
    }, 100);
}

/**
 * 切换打开/关闭
 */
export function toggle(role) {
    if (state.panelEl && state.panelEl.classList.contains('open')) {
        minimize();
    } else {
        open(role);
    }
}

/**
 * 初始化：创建右下角悬浮按钮
 */
export function init(opts = {}) {
    state.userRole = opts.role || 'admin';

    if (document.getElementById('ai-assistant-trigger')) return;

    const btn = document.createElement('button');
    btn.id = 'ai-assistant-trigger';
    btn.className = 'ai-float-btn';
    btn.title = 'AI 助手';
    btn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 22.5l-.394-1.933a2.25 2.25 0 00-1.423-1.423L12.75 18.75l1.933-.394a2.25 2.25 0 001.423-1.423l.394-1.933.394 1.933a2.25 2.25 0 001.423 1.423l1.933.394-1.933.394a2.25 2.25 0 00-1.423 1.423z" fill="currentColor"/>
        </svg>
    `;
    btn.addEventListener('click', () => toggle(state.userRole));

    state.floatBtnEl = btn;

    refreshStatus().then(available => {
        if (!available) btn.classList.add('offline');
    });

    document.body.appendChild(btn);

    injectStyles();
}

