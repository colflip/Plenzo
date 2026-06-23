/**
 * AI 助手 - 全新重构版本
 * @description 支持数据查询、智能排课的统一 AI 助手界面
 * @module modules/shared/ai-assistant
 */

const PANEL_ID = 'ai-assistant-panel';
const STORAGE_KEY = 'plenzo_ai_chat_v2';
const MAX_HISTORY = 30;

// 消息类型枚举
const MessageType = {
    TEXT: 'text',
    DATA_TABLE: 'data_table',
    SCHEDULE_LIST: 'schedule_list',
    CHART_DATA: 'chart_data',
    SCHEDULE_PREVIEW: 'schedule_preview'  // 新增：排课预览
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
    isHidden: false,  // 窗口是否完全隐藏（关闭按钮）
    abortController: null  // 用于中止请求
};

/**
 * 快捷问题配置
 */
const QUICK_QUESTIONS = {
    admin: [
        '系统总览数据',
        '本月排课总数',
        '待确认的排课',
        '按课程类型统计',
        '教师列表'
    ],
    teacher: [
        '我的总览数据',
        '我本周的课表',
        '我本月排了多少课',
        '我今天的课程'
    ]
};

/**
 * 注入样式
 */
function injectStyles() {
    if (document.getElementById('ai-assistant-styles')) return;
    const style = document.createElement('style');
    style.id = 'ai-assistant-styles';
    style.textContent = `
    /* 右下角悬浮按钮 */
    .ai-float-btn {
        position: fixed;
        right: 24px;
        bottom: 5.5vh;
        width: 60px;
        height: 60px;
        border-radius: 50%;
        background: linear-gradient(135deg, #3C5A78 0%, #2E4760 100%);
        box-shadow: 0 8px 24px rgba(60, 90, 120, 0.3), 0 2px 8px rgba(0, 0, 0, 0.15);
        border: 2px solid rgba(255, 255, 255, 0.15);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100000;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        color: #fff;
        font-size: 28px;
        backdrop-filter: blur(10px);
    }
    .ai-float-btn:hover {
        transform: translateY(-3px) scale(1.08);
        box-shadow: 0 12px 32px rgba(60, 90, 120, 0.4), 0 4px 12px rgba(0, 0, 0, 0.2);
        background: linear-gradient(135deg, #2E4760 0%, #1f3347 100%);
    }
    .ai-float-btn:active {
        transform: translateY(-1px) scale(1.02);
    }
    .ai-float-btn svg {
        width: 28px;
        height: 28px;
        filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.2));
    }
    .ai-float-btn.offline::before {
        background: #ef4444;
        box-shadow: 0 0 8px rgba(239, 68, 68, 0.8);
    }
    @keyframes ai-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.6; transform: scale(1.2); }
    }

    /* AI 面板容器 */
    .ai-panel-overlay {
        position: fixed;
        right: 24px;
        bottom: calc(5.5vh + 72px);
        width: 40vw;
        height: 60vh;
        min-width: 420px;
        min-height: 450px;
        max-width: 90vw;
        max-height: 90vh;
        background: #FFFFFF;
        border: 1px solid #E7E3DA;
        border-radius: 20px;
        box-shadow: 0 20px 60px rgba(30, 41, 59, 0.15), 0 8px 24px rgba(0, 0, 0, 0.08);
        z-index: 100001;
        display: none;
        flex-direction: column;
        opacity: 0;
        transform: translateY(20px) scale(0.96);
        transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        color: #1E2227;
        resize: both;
        overflow: hidden;
        backdrop-filter: blur(20px);
    }
    .ai-panel-overlay.open {
        display: flex;
        opacity: 1;
        transform: translateY(0) scale(1);
    }
    .ai-panel-overlay.minimized {
        height: 52px;
        min-height: 52px;
        overflow: hidden;
        resize: none;
    }
    .ai-panel-overlay.hidden {
        display: none !important;
    }

    /* 调整大小手柄样式优化 */
    .ai-panel-overlay::-webkit-resizer {
        background: linear-gradient(135deg, transparent 50%, #3C5A78 50%);
        border-radius: 0 0 20px 0;
        opacity: 0.4;
    }

    /* 头部 */
    .ai-panel-header {
        padding: 16px 20px;
        border-bottom: 1px solid #E7E3DA;
        background: linear-gradient(180deg, #F7F5F1 0%, #FFFFFF 100%);
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-shrink: 0;
        border-radius: 20px 20px 0 0;
    }
    .ai-panel-title {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 16px;
        font-weight: 600;
        color: #1E2227;
        letter-spacing: -0.01em;
    }
    .ai-panel-title .dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: #3C5A78;
        box-shadow: 0 0 10px rgba(60, 90, 120, 0.5);
        animation: ai-pulse 2s ease-in-out infinite;
    }
    .ai-panel-title .dot.off {
        background: #ef4444;
        box-shadow: 0 0 8px rgba(239, 68, 68, 0.6);
    }
    .ai-panel-controls {
        display: flex;
        gap: 8px;
    }
    .ai-panel-controls button {
        background: rgba(255, 255, 255, 0.5);
        border: 1px solid #E7E3DA;
        color: #6B7077;
        cursor: pointer;
        width: 32px;
        height: 32px;
        border-radius: 8px;
        font-size: 16px;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        padding: 0;
    }
    .ai-panel-controls button:hover {
        background: #FFFFFF;
        color: #1E2227;
        border-color: #3C5A78;
        transform: translateY(-1px);
    }

    /* 消息区 */
    .ai-panel-body {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        background: #F7F5F1;
        display: flex;
        flex-direction: column;
        gap: 14px;
    }
    .ai-panel-body::-webkit-scrollbar {
        width: 8px;
    }
    .ai-panel-body::-webkit-scrollbar-track {
        background: transparent;
    }
    .ai-panel-body::-webkit-scrollbar-thumb {
        background: #E7E3DA;
        border-radius: 4px;
    }
    .ai-panel-body::-webkit-scrollbar-thumb:hover {
        background: #3C5A78;
    }

    /* 消息气泡 */
    .ai-msg {
        display: flex;
        flex-direction: column;
        max-width: 85%;
    }
    .ai-msg.user {
        align-self: flex-end;
        align-items: flex-end;
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
    }
    .ai-msg.user .ai-msg-bubble {
        background: linear-gradient(135deg, #3C5A78, #2E4760);
        color: #FFFFFF;
        border-bottom-right-radius: 4px;
        box-shadow: 0 2px 8px rgba(60, 90, 120, 0.2);
    }
    .ai-msg.assistant .ai-msg-bubble {
        background: #FFFFFF;
        border: 1px solid #E7E3DA;
        color: #2C3E50;
        border-bottom-left-radius: 4px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
    }
    .ai-msg-bubble.error {
        background: #FEF2F2;
        border: 1px solid #FECACA;
        color: #991B1B;
    }

    /* 数据表格 */
    .ai-data-table {
        margin-top: 10px;
        background: #FFFFFF;
        border: 1px solid #E7E3DA;
        border-radius: 12px;
        overflow: hidden;
        max-width: 100%;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
    }
    .ai-data-table table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
    }
    .ai-data-table th {
        background: #F7F5F1;
        padding: 10px 14px;
        text-align: left;
        font-weight: 600;
        color: #6B7077;
        border-bottom: 1px solid #E7E3DA;
        font-size: 12px;
        letter-spacing: 0.02em;
    }
    .ai-data-table td {
        padding: 10px 14px;
        border-bottom: 1px solid #F7F5F1;
        color: #1E2227;
    }
    .ai-data-table tr:last-child td {
        border-bottom: none;
    }
    .ai-data-table tr:hover {
        background: #F7F5F1;
    }

    /* Typing 动画 */
    .ai-typing {
        display: flex;
        gap: 4px;
        padding: 12px 16px;
        align-self: flex-start;
        background: #FFFFFF;
        border: 1px solid #E7E3DA;
        border-radius: 12px;
        border-bottom-left-radius: 4px;
    }
    .ai-typing span {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #9CA3AF;
        animation: ai-typing-bounce 1.2s infinite;
    }
    .ai-typing span:nth-child(2) { animation-delay: 0.15s; }
    .ai-typing span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes ai-typing-bounce {
        0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
        30% { transform: translateY(-5px); opacity: 1; }
    }

    /* 快捷问题 */
    .ai-panel-quick {
        padding: 12px 16px;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        flex-shrink: 0;
        background: #FFFFFF;
        border-bottom: 1px solid #E7E3DA;
    }
    .ai-quick-btn {
        font-size: 12px;
        padding: 6px 12px;
        border-radius: 20px;
        cursor: pointer;
        background: #F7F5F1;
        border: 1px solid #E7E3DA;
        color: #6B7077;
        white-space: nowrap;
        transition: all 0.2s;
    }
    .ai-quick-btn:hover {
        background: #3C5A78;
        border-color: #3C5A78;
        color: #FFFFFF;
        transform: translateY(-1px);
        box-shadow: 0 2px 6px rgba(60, 90, 120, 0.2);
    }

    /* 输入区 */
    .ai-panel-footer {
        padding: 14px 16px;
        border-top: 1px solid #E7E3DA;
        background: #FFFFFF;
        display: flex;
        gap: 10px;
        align-items: flex-end;
        flex-shrink: 0;
        border-radius: 0 0 20px 20px;
    }
    .ai-panel-upload {
        background: transparent;
        border: none;
        color: #6B7077;
        cursor: pointer;
        width: 40px;
        height: 40px;
        border-radius: 12px;
        font-size: 27px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        flex-shrink: 0;
    }
    .ai-panel-upload:hover {
        background: #F7F5F1;
        color: #3C5A78;
    }
    .ai-panel-input {
        flex: 1;
        background: #F7F5F1;
        border: 1px solid #E7E3DA;
        border-radius: 12px;
        padding: 10px 14px;
        color: #1E2227;
        font-size: 14px;
        font-family: inherit;
        resize: none;
        max-height: 100px;
        outline: none;
        transition: all 0.2s;
    }
    .ai-panel-input:focus {
        border-color: #3C5A78;
        background: #FFFFFF;
        box-shadow: 0 0 0 3px rgba(60, 90, 120, 0.08);
    }
    .ai-panel-input::placeholder {
        color: #6B7077;
    }
    .ai-panel-send, .ai-panel-stop {
        background: linear-gradient(135deg, #3C5A78, #2E4760);
        border: none;
        color: #FFFFFF;
        cursor: pointer;
        width: 40px;
        height: 40px;
        border-radius: 12px;
        font-size: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        box-shadow: 0 2px 8px rgba(60, 90, 120, 0.2);
        flex-shrink: 0;
    }
    .ai-panel-send:hover, .ai-panel-stop:hover {
        box-shadow: 0 4px 12px rgba(60, 90, 120, 0.3);
        transform: translateY(-1px);
        background: linear-gradient(135deg, #2E4760, #1f3347);
    }
    .ai-panel-send:disabled, .ai-panel-stop:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none;
    }
    .ai-panel-stop {
        background: linear-gradient(135deg, #ef4444, #dc2626);
    }
    .ai-panel-stop:hover {
        box-shadow: 0 4px 8px rgba(239, 68, 68, 0.3);
    }

    /* 自定义 resize handles（四个方向） */
    .ai-resize-handle {
        position: absolute;
        z-index: 10;
    }
    .ai-resize-handle.top {
        top: 0;
        left: 0;
        right: 0;
        height: 5px;
        cursor: ns-resize;
    }
    .ai-resize-handle.right {
        top: 0;
        right: 0;
        bottom: 0;
        width: 5px;
        cursor: ew-resize;
    }
    .ai-resize-handle.bottom {
        bottom: 0;
        left: 0;
        right: 0;
        height: 5px;
        cursor: ns-resize;
    }
    .ai-resize-handle.left {
        top: 0;
        left: 0;
        bottom: 0;
        width: 5px;
        cursor: ew-resize;
    }

    /* 空状态 */
    .ai-empty {
        text-align: center;
        color: #9CA3AF;
        font-size: 12px;
        padding: 40px 20px;
        align-self: center;
        line-height: 1.8;
    }
    .ai-empty .icon {
        font-size: 42px;
        display: block;
        margin-bottom: 14px;
        opacity: 0.3;
    }

    @media (max-width: 768px) {
        .ai-panel-overlay {
            right: 12px;
            width: calc(100vw - 24px);
            max-width: none;
        }
        .ai-float-btn {
            right: 12px;
        }
    }
    `;
    document.head.appendChild(style);
}

/**
 * 消息渲染器
 */
function renderMessage(msg, index) {
    const wrapper = document.createElement('div');
    wrapper.className = `ai-msg ${msg.role}`;

    if (msg.role === 'user') {
        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble';
        bubble.textContent = msg.content;
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
 * 渲染纯文本消息
 */
function renderTextMessage(msg) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-msg assistant';

    const bubble = document.createElement('div');
    bubble.className = 'ai-msg-bubble';
    bubble.textContent = msg.content || msg.answer;
    wrapper.appendChild(bubble);

    return wrapper;
}

/**
 * 渲染数据表格消息
 */
function renderDataTableMessage(msg) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-msg assistant';

    // 文字说明
    if (msg.answer) {
        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble';
        bubble.textContent = msg.answer;
        wrapper.appendChild(bubble);
    }

    // 数据表格
    if (msg.data) {
        const tableContainer = document.createElement('div');
        tableContainer.className = 'ai-data-table';

        const table = document.createElement('table');
        const data = msg.data;

        // 判断数据格式：对象 or 数组
        if (Array.isArray(data)) {
            // 数组格式（如教师列表）
            if (data.length > 0) {
                const thead = document.createElement('thead');
                const headerRow = document.createElement('tr');
                const keys = Object.keys(data[0]);

                keys.forEach(key => {
                    const th = document.createElement('th');
                    th.textContent = formatColumnName(key);
                    headerRow.appendChild(th);
                });
                thead.appendChild(headerRow);
                table.appendChild(thead);

                const tbody = document.createElement('tbody');
                data.forEach(row => {
                    const tr = document.createElement('tr');
                    keys.forEach(key => {
                        const td = document.createElement('td');
                        td.textContent = formatCellValue(row[key]);
                        tr.appendChild(td);
                    });
                    tbody.appendChild(tr);
                });
                table.appendChild(tbody);
            }
        } else {
            // 对象格式（如系统总览）
            const tbody = document.createElement('tbody');
            Object.entries(data).forEach(([key, value]) => {
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
        }

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

    if (msg.answer) {
        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble';
        bubble.textContent = msg.answer;
        wrapper.appendChild(bubble);
    }

    if (msg.data && msg.data.length > 0) {
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
            tdTime.textContent = `${schedule.start_time || '-'}-${schedule.end_time || '-'}`;
            tr.appendChild(tdTime);

            const tdTeacher = document.createElement('td');
            tdTeacher.textContent = schedule.teacher_name || '-';
            tr.appendChild(tdTeacher);

            const tdStudent = document.createElement('td');
            tdStudent.textContent = schedule.student_name || '-';
            tr.appendChild(tdStudent);

            const tdCourse = document.createElement('td');
            // 使用后端返回的中文翻译
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

    if (msg.answer) {
        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble';
        bubble.textContent = msg.answer;
        wrapper.appendChild(bubble);
    }

    if (msg.data && msg.data.length > 0) {
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

    if (msg.answer) {
        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble';
        bubble.textContent = msg.answer;
        wrapper.appendChild(bubble);
    }

    if (msg.data && msg.data.schedules && msg.data.schedules.length > 0) {
        const previewContainer = document.createElement('div');
        previewContainer.className = 'ai-data-table';

        // 预览信息头
        const infoBox = document.createElement('div');
        infoBox.style.cssText = 'padding: 12px; background: #EFF6FF; border-radius: 8px 8px 0 0; border-bottom: 2px solid #3B82F6;';
        infoBox.innerHTML = `
            <div style="font-size: 14px; font-weight: 600; color: #1E40AF; margin-bottom: 6px;">📋 排课预览方案</div>
            <div style="font-size: 13px; color: #1E40AF;">
                教师：<strong>${msg.data.teacher}</strong> |
                学生：<strong>${msg.data.student}</strong> |
                课程：<strong>${msg.data.courseType}</strong> |
                共 <strong>${msg.data.totalCount}</strong> 节课
            </div>
        `;
        previewContainer.appendChild(infoBox);

        // 排课列表
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
            tdTime.textContent = `${schedule.start_time || '-'}-${schedule.end_time || '-'}`;
            tr.appendChild(tdTime);

            const tdCourse = document.createElement('td');
            tdCourse.textContent = schedule.course_type_cn || schedule.course_type || '-';
            tr.appendChild(tdCourse);

            const tdStatus = document.createElement('td');
            tdStatus.textContent = '预览';
            tdStatus.style.color = '#3B82F6';
            tdStatus.style.fontWeight = '600';
            tr.appendChild(tdStatus);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        previewContainer.appendChild(table);

        // 确认按钮
        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = '✓ 确认创建排课';
        confirmBtn.style.cssText = `
            width: 100%;
            padding: 12px;
            background: linear-gradient(135deg, #10b981, #059669);
            color: white;
            border: none;
            border-radius: 0 0 8px 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        `;
        confirmBtn.onmouseover = () => {
            confirmBtn.style.background = 'linear-gradient(135deg, #059669, #047857)';
        };
        confirmBtn.onmouseout = () => {
            confirmBtn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
        };
        confirmBtn.onclick = () => {
            const previewId = msg.data.previewId;
            if (previewId) {
                confirmBtn.disabled = true;
                confirmBtn.textContent = '正在创建...';
                state.inputEl.value = `确认创建排课，previewId: ${previewId}`;
                onSend();
            }
        };

        previewContainer.appendChild(confirmBtn);
        wrapper.appendChild(previewContainer);
    }

    return wrapper;
}

/**
 * 格式化工具函数
 */
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
        pending: '待处理',
        confirmed: '已确认',
        cancelled: '已取消',
        category: '类别',
        count: '数量'
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

function formatStatus(status) {
    const mapping = {
        pending: '待确认',
        confirmed: '已确认',
        cancelled: '已取消',
        completed: '已完成',
        modified_away: '已改期'
    };
    return mapping[status] || status;
}

function getStatusColor(status) {
    const colors = {
        pending: '#f59e0b',
        confirmed: '#10b981',
        cancelled: '#ef4444'
    };
    return colors[status] || '#6b7280';
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
        <div class="ai-panel-header">
            <div class="ai-panel-title">
                <span class="dot" id="ai-status-dot"></span>
                <span>AI 助手</span>
            </div>
            <div class="ai-panel-controls">
                <button class="ai-panel-minimize" id="ai-panel-minimize" title="最小化">−</button>
                <button id="ai-panel-close" title="关闭">×</button>
            </div>
        </div>
        <div class="ai-panel-body" id="ai-panel-body"></div>
        <div class="ai-panel-quick" id="ai-panel-quick"></div>
        <div class="ai-resize-handle top"></div>
        <div class="ai-resize-handle right"></div>
        <div class="ai-resize-handle bottom"></div>
        <div class="ai-resize-handle left"></div>
        <div class="ai-panel-footer">
            <button class="ai-panel-upload" id="ai-panel-upload" title="上传图片">📎</button>
            <textarea class="ai-panel-input" id="ai-panel-input" rows="1"
                placeholder="问我关于排课、统计的问题..." ></textarea>
            <button class="ai-panel-stop" id="ai-panel-stop" title="停止" style="display:none;">⬛</button>
            <button class="ai-panel-send" id="ai-panel-send" title="发送 (Enter)">➤</button>
        </div>
    `;
    document.body.appendChild(overlay);

    state.panelEl = overlay;
    state.messagesEl = overlay.querySelector('#ai-panel-body');
    state.inputEl = overlay.querySelector('#ai-panel-input');
    state.sendBtnEl = overlay.querySelector('#ai-panel-send');
    state.stopBtnEl = overlay.querySelector('#ai-panel-stop');

    // 事件绑定
    overlay.querySelector('#ai-panel-close').addEventListener('click', closeCompletely);
    overlay.querySelector('#ai-panel-minimize').addEventListener('click', minimize);
    state.sendBtnEl.addEventListener('click', onSend);
    state.stopBtnEl.addEventListener('click', stopQuery);
    state.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSend();
        }
    });
    state.inputEl.addEventListener('input', () => {
        state.inputEl.style.height = 'auto';
        state.inputEl.style.height = Math.min(state.inputEl.scrollHeight, 80) + 'px';
    });

    // 四向 resize handlers
    setupResizeHandlers(overlay);

    // 点击窗口外区域最小化到图标
    document.addEventListener('click', (e) => {
        if (!state.panelEl || !state.panelEl.classList.contains('open')) return;
        if (state.panelEl.classList.contains('minimized')) return;

        const clickedInside = state.panelEl.contains(e.target) ||
                             state.floatBtnEl?.contains(e.target);
        if (!clickedInside) {
            minimize();
        }
    });

    renderQuickQuestions();
    renderMessages();
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
 * 设置四向 resize handlers
 */
function setupResizeHandlers(panel) {
    const handles = {
        top: panel.querySelector('.ai-resize-handle.top'),
        right: panel.querySelector('.ai-resize-handle.right'),
        bottom: panel.querySelector('.ai-resize-handle.bottom'),
        left: panel.querySelector('.ai-resize-handle.left')
    };

    let isResizing = false;
    let currentHandle = null;
    let startX, startY, startWidth, startHeight, startLeft, startBottom;

    Object.entries(handles).forEach(([direction, handle]) => {
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isResizing = true;
            currentHandle = direction;

            const rect = panel.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            startWidth = rect.width;
            startHeight = rect.height;
            startLeft = rect.left;
            startBottom = window.innerHeight - rect.bottom;

            document.body.style.cursor = handle.style.cursor;
            document.body.style.userSelect = 'none';
        });
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;

        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        if (currentHandle === 'right') {
            const newWidth = Math.max(420, Math.min(startWidth + deltaX, window.innerWidth * 0.9));
            panel.style.width = newWidth + 'px';
        } else if (currentHandle === 'left') {
            const newWidth = Math.max(420, Math.min(startWidth - deltaX, window.innerWidth * 0.9));
            if (newWidth > 420) {
                panel.style.width = newWidth + 'px';
                panel.style.right = (window.innerWidth - startLeft - startWidth + deltaX) + 'px';
            }
        } else if (currentHandle === 'bottom') {
            const newHeight = Math.max(450, Math.min(startHeight + deltaY, window.innerHeight * 0.9));
            panel.style.height = newHeight + 'px';
        } else if (currentHandle === 'top') {
            const newHeight = Math.max(450, Math.min(startHeight - deltaY, window.innerHeight * 0.9));
            if (newHeight > 450) {
                panel.style.height = newHeight + 'px';
                panel.style.bottom = startBottom + 'px';
            }
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            currentHandle = null;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
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
 * 更新窗口标题
 */
function updateTitle(text) {
    const titleEl = state.panelEl?.querySelector('.ai-panel-title span:last-child');
    if (titleEl) titleEl.textContent = text;
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
        empty.innerHTML = `<span class="icon">💬</span>
            我是你的 AI 助手，可以帮你查询和分析排课数据。<br>
            ${examples}`;
        el.appendChild(empty);
        return;
    }

    state.messages.forEach((msg, idx) => {
        el.appendChild(renderMessage(msg, idx));
    });

    // 自动滚动到最新消息
    setTimeout(() => {
        el.scrollTop = el.scrollHeight;
    }, 50);
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
 * 发送消息
 */
async function onSend() {
    const text = state.inputEl.value.trim();
    if (!text || state.loading) return;

    // 添加用户消息
    state.messages.push({ role: 'user', content: text });
    state.inputEl.value = '';
    state.inputEl.style.height = 'auto';
    renderMessages();
    saveHistory();

    state.loading = true;
    state.sendBtnEl.disabled = true;
    state.sendBtnEl.style.display = 'none';
    state.stopBtnEl.style.display = 'flex';

    // 更新标题为加载状态
    updateTitle('AI 助手 ···');

    // 创建 abort controller
    state.abortController = new AbortController();

    showTyping();

    try {
        const resp = await fetch('/api/ai/query', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify({ question: text }),
            signal: state.abortController.signal
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ message: '未知错误' }));
            throw new Error(err.message || `HTTP ${resp.status}`);
        }

        const result = await resp.json();
        if (!result.success) throw new Error(result.message);

        const data = result.data;

        // 构建 assistant 消息
        const assistantMsg = {
            role: 'assistant',
            type: data.type || MessageType.TEXT,
            answer: data.answer,
            content: data.answer,
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
        updateTitle('AI 助手');

        renderMessages();
        saveHistory();
        state.inputEl.focus();
    }
}

/**
 * 最小化到图标（点击最小化按钮或窗口外区域）
 */
function minimize() {
    if (!state.panelEl) return;
    state.panelEl.classList.add('minimized');
    state.panelEl.classList.remove('open');
    setTimeout(() => {
        if (state.panelEl) state.panelEl.style.display = 'none';
    }, 300);
}

/**
 * 完全关闭（点击关闭按钮，隐藏窗口和图标）
 */
function closeCompletely() {
    state.isHidden = true;

    // 隐藏面板
    if (state.panelEl) {
        state.panelEl.classList.remove('open');
        state.panelEl.classList.add('hidden');
    }

    // 隐藏悬浮按钮
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
    const dot = document.getElementById('ai-status-dot');
    const floatBtn = document.getElementById('ai-assistant-trigger');
    try {
        const resp = await window.apiUtils.get('/ai/status');
        const data = resp.data || resp;
        if (data.enabled) {
            if (dot) dot.classList.remove('off');
            if (floatBtn) floatBtn.classList.remove('offline');
            return true;
        } else {
            if (dot) dot.classList.add('off');
            if (floatBtn) floatBtn.classList.add('offline');
            return false;
        }
    } catch (_) {
        if (dot) dot.classList.add('off');
        if (floatBtn) floatBtn.classList.add('offline');
        return false;
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

    if (state.panelEl) {
        state.panelEl.classList.remove('minimized');
        state.panelEl.classList.remove('hidden');
        state.panelEl.style.display = 'flex';
        state.panelEl.classList.add('open');
    }

    setTimeout(() => state.inputEl && state.inputEl.focus(), 100);
}

/**
 * 关闭面板（兼容旧接口，实际执行最小化）
 */
export function close() {
    minimize();
}

/**
 * 切换打开/关闭
 */
export function toggle(role) {
    if (state.panelEl && state.panelEl.classList.contains('open') && !state.panelEl.classList.contains('minimized')) {
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
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2C10.9 2 10 2.9 10 4V4.5C8.5 5.15 7.15 6.15 6.15 7.5H5C3.9 7.5 3 8.4 3 9.5V11.5C3 12.6 3.9 13.5 5 13.5H6.15C7.15 14.85 8.5 15.85 10 16.5V17C10 18.1 10.9 19 12 19C13.1 19 14 18.1 14 17V16.5C15.5 15.85 16.85 14.85 17.85 13.5H19C20.1 13.5 21 12.6 21 11.5V9.5C21 8.4 20.1 7.5 19 7.5H17.85C16.85 6.15 15.5 5.15 14 4.5V4C14 2.9 13.1 2 12 2ZM9 10.5C9.55 10.5 10 10.95 10 11.5C10 12.05 9.55 12.5 9 12.5C8.45 12.5 8 12.05 8 11.5C8 10.95 8.45 10.5 9 10.5ZM15 10.5C15.55 10.5 16 10.95 16 11.5C16 12.05 15.55 12.5 15 12.5C14.45 12.5 14 12.05 14 11.5C14 10.95 14.45 10.5 15 10.5ZM12 21C12.55 21 13 21.45 13 22C13 22.55 12.55 23 12 23C11.45 23 11 22.55 11 22C11 21.45 11.45 21 12 21Z" fill="currentColor"/>
        </svg>
    `;
    btn.addEventListener('click', () => toggle(state.userRole));

    state.floatBtnEl = btn;

    refreshStatus().then(available => {
        if (!available) btn.classList.add('offline');
    });

    document.body.appendChild(btn);

    injectStyles();
    buildPanel();
}

export default { init, open, close, toggle };


