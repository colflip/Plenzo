/**
 * AI 助手面板（共享模块）
 * @module modules/shared/ai-assistant-redesign
 */

const PANEL_ID = 'ai-assistant-panel';

/**
 * 展示层品牌名（用户可见文案统一取自这里；代码内标识符不受影响）
 */
const ASSISTANT_NAME = 'AI-assistant';
const STORAGE_KEY = 'plenzo_ai_chat_v3';
const MAX_HISTORY = 30;
/**
 * 随请求回传后端的对话历史条数上限。
 * 必须与后端 ai-controller 的硬校验（history.length > 20 → 400）一致：
 * 以前前端发 30 条，后端只收 20 条，长会话整轮 400 且用户看不出原因。
 * 后端是权威；这里内联同一数字并留注释指路。
 */
const MAX_REQUEST_HISTORY = 20;

/**
 * 品牌 logo 的唯一实现：描边双气泡 + 星芒。
 * 浮标 / 窗口标题 / 消息头像 / 模型触发器 / 输入区模型行全部复用这里，
 * 改样式只改这一处（此前 6 处各存一份 SVG，stroke-width 都不一致）。
 * stroke-width 用 1.6：14px 小图标与 26px 浮标下粗细都合适。
 */
const LOGO_PATHS = (() => {
    // 与 assistant-ui 官网 logo 一致：两个「只描边、内部留空」的圆角对话气泡。
    // 左上大气泡的尾巴朝左下，右下小气泡的尾巴朝右下；两者轻微重叠但不合并轮廓。
    // 关键：每条 path 显式 fill="none"，保证小尺寸下也不会糊成实心块。
    const bubbleBack = '<path d="M7 3h4.5A2.5 2.5 0 0 1 14 5.5v5A2.5 2.5 0 0 1 11.5 13H7.5L4.5 15.5V5.5A2.5 2.5 0 0 1 7 3Z" '
        + 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>';
    const bubbleFront = '<path d="M11.5 9H18a2.5 2.5 0 0 1 2.5 2.5v7.5l-2.5-2.5h-6.5A2.5 2.5 0 0 1 9 14v-2.5A2.5 2.5 0 0 1 11.5 9Z" '
        + 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>';
    // 星芒：右上角，实心（星形填充才看得清）
    const sparkle = '<path d="M17.6 0.6l0.55 1.75a1 1 0 0 0 0.7 0.7l1.75 0.55-1.75 0.55a1 1 0 0 0-0.7 0.7L17.6 6.6l-0.55-1.75a1 1 0 0 0-0.7-0.7L14.6 3.6l1.75-0.55a1 1 0 0 0 0.7-0.7L17.6 0.6z" fill="currentColor"/>';
    return bubbleBack + bubbleFront + sparkle;
})();
const LOGO_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${LOGO_PATHS}</svg>`;
/** 通用 AI 模型标识：一大一小两颗星（模型名显示不全时用它代替，与品牌双气泡 logo 区分） */
const GENERIC_AI_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M11 2.5l1.9 5.6 5.6 1.9-5.6 1.9L11 17.5 9.1 11.9 3.5 10l5.6-1.9L11 2.5z" fill="currentColor"/>
    <path d="M18 14.5l0.95 2.8 2.8 0.95-2.8 0.95L18 22l-0.95-2.8-2.8-0.95 2.8-0.95L18 14.5z" fill="currentColor"/>
</svg>`;

// 消息类型枚举
const MessageType = {
    TEXT: 'text',
    DATA_TABLE: 'data_table',
    SCHEDULE_LIST: 'schedule_list',
    CHART_DATA: 'chart_data',
    SCHEDULE_PREVIEW: 'schedule_preview',
    SCHEDULE_OPERATION_PREVIEW: 'schedule_operation_preview'
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
    sessionId: null,     // 当前服务端会话 id（loadServerHistory / 首轮问答时写入）
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
    },
    floatBtnPos: null,  // 图标拖拽后的位置 { left, top }（右上角锚定，持久化恢复用）
    floatBtnDragging: false,
    modelPicker: {       // 用户自选模型（仅本人会话生效，服务端按 userId 存）
        loaded: false,
        presetId: null,
        modelId: null,
        isDefault: true
    }
};

/**
 * 快捷操作配置。query 有对应后端 key（/api/ai/quick-query 白名单），点击直接调接口，
 * 不走 LLM —— 秒回、不耗 token；prompt 类（如批量排课输入引导）仍走完整 AI 管线。
 */
const QUICK_QUESTIONS = {
    admin: [
        { label: '本周排课总览', query: 'week_overview' },
        { label: '下周批量排课', prompt: '我想批量排课，请先告诉我输入格式' },
        { label: '待确认的排课', query: 'pending_schedules' },
        { label: '按教师统计', query: 'teacher_stats' }
    ],
    teacher: [
        { label: '我本周的课表', query: 'my_week' },
        { label: '我的排课统计', query: 'my_overview' },
        { label: '待确认的课', query: 'my_pending' }
    ],
    student: [
        { label: '我本周的课表', query: 'my_week' },
        { label: '我的课程统计', query: 'my_stats' },
        { label: '今日课程安排', query: 'my_today' }
    ]
};

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
                <svg class="ai-panel-title-mark" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${LOGO_PATHS}</svg>
                <span class="ai-panel-title-text">${ASSISTANT_NAME}</span>
                <span class="ai-status-dot" title="在线"></span>
                <span class="ai-panel-title-status"></span>
            </div>
            <div class="ai-panel-controls">
                <button id="ai-clear-btn" title="清空对话" aria-label="清空对话">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </button>
                <button id="ai-minimize-btn" title="最小化" aria-label="最小化">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
                    </svg>
                </button>
                <button id="ai-close-btn" title="关闭" aria-label="关闭">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
                    </svg>
                </button>
            </div>
        </div>
        <div id="ai-model-menu" class="ai-model-menu" role="listbox" aria-label="选择 AI 模型"></div>
        <div id="ai-panel-quick" class="ai-panel-quick"></div>
        <div id="ai-panel-messages" class="ai-panel-body"></div>
        <div class="ai-panel-footer">
            <div id="ai-image-preview" class="ai-image-preview"></div>
            <div class="ai-composer">
                <textarea
                    id="ai-panel-input"
                    class="ai-panel-input"
                    placeholder="给 ${ASSISTANT_NAME} 发消息…"
                    rows="1"
                ></textarea>
                <div class="ai-composer-bar">
                    <button id="ai-image-btn" class="ai-composer-tool" type="button" title="添加图片" aria-label="添加附件">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
                        </svg>
                    </button>
                    <button id="ai-model-trigger" class="ai-model-trigger" type="button" title="切换模型（仅对你生效）" aria-label="切换模型">
                        ${GENERIC_AI_SVG.replace('<svg ', '<svg class="ai-model-trigger-logo ai-model-trigger-generic" ')}
                        <span class="ai-model-trigger-name"></span>
                    </button>
                    <div class="ai-composer-spacer"></div>
                    <button id="ai-send-btn" class="ai-panel-send" type="button" title="发送" aria-label="发送">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 19V5m0 0l-6 6m6-6l6 6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </button>
                    <button id="ai-stop-btn" class="ai-panel-stop" type="button" title="停止" aria-label="停止" style="display: none;">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>
                        </svg>
                    </button>
                </div>
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

    // 模型切换：开关下拉。stopPropagation 避免触发 setupClickOutsideListener 直接收起整个面板。
    overlay.querySelector('#ai-model-trigger').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleModelMenu();
    });
    state.sendBtnEl.addEventListener('click', () => onSend());
    state.stopBtnEl.addEventListener('click', stopQuery);

    // 图片上传事件
    const imageBtn = overlay.querySelector('#ai-image-btn');
    const imageInput = overlay.querySelector('#ai-image-input');
    imageBtn.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', handleImageSelect);

    // 输入框事件
    // 触屏设备上没有 Shift 键，Enter 直接发送会让用户无法换行（手机上多行输入是刚需）。
    // 因此按 pointer: coarse 判定：触屏上 Enter 插入换行，发送交给发送按钮。
    const isCoarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    state.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            if (isCoarsePointer) return; // 触屏：交回默认行为＝换行
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
    // 缩放的上下限：太小没法用，太大盖满屏挡住主界面
    const MIN_W = 320, MIN_H = 280, MAX_W_RATIO = 0.9, MAX_H_RATIO = 0.92;

    handles.forEach(handle => {
        handle.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            const startX = e.clientX;
            const startY = e.clientY;
            const startWidth = panel.offsetWidth;
            const startHeight = panel.offsetHeight;
            const startRight = parseInt(getComputedStyle(panel).right, 10) || 0;
            const startBottom = parseInt(getComputedStyle(panel).bottom, 10) || 0;

            const direction = handle.className.split(' ')[1].replace('ai-resize-handle-', '');
            panel.classList.add('resizing');
            const pointerId = e.pointerId;

            const onPointerMove = (moveEvent) => {
                if (moveEvent.pointerId !== pointerId) return;
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

                // 边界限制：拖不出视口，也不缩成 0
                const maxWidth = Math.floor(window.innerWidth * MAX_W_RATIO);
                const maxHeight = Math.floor(window.innerHeight * MAX_H_RATIO);
                newWidth = Math.min(Math.max(newWidth, MIN_W), maxWidth);
                newHeight = Math.min(Math.max(newHeight, MIN_H), maxHeight);
                newRight = Math.min(Math.max(newRight, 0), window.innerWidth - MIN_W);
                newBottom = Math.min(Math.max(newBottom, 0), window.innerHeight - MIN_H);

                panel.style.width = `${newWidth}px`;
                panel.style.height = `${newHeight}px`;
                panel.style.right = `${newRight}px`;
                panel.style.bottom = `${newBottom}px`;
            };

            const onPointerUp = (upEvent) => {
                if (upEvent.pointerId !== pointerId) return;
                panel.classList.remove('resizing');
                document.removeEventListener('pointermove', onPointerMove);
                document.removeEventListener('pointerup', onPointerUp);
                document.removeEventListener('pointercancel', onPointerUp);
            };

            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            document.addEventListener('pointercancel', onPointerUp);
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
        btn.textContent = q.label;
        btn.addEventListener('click', () => {
            if (q.query) {
                sendQuickQuery(q.query, q.label);
            } else {
                // prompt 类（如批量排课引导）仍走完整 AI 管线
                state.inputEl.value = q.prompt;
                onSend();
            }
        });
        container.appendChild(btn);
    });
}

/**
 * 快捷查询直连：POST /api/ai/quick-query，后端直接执行数据工具，不过 LLM。
 * 响应形状与 /query 相同，渲染逻辑零适配。
 */
async function sendQuickQuery(key, label) {
    if (state.loading) return;

    const userMsg = { id: makeMsgId(), role: 'user', content: label };
    state.messages.push(userMsg);
    state.loading = true;
    state.sendBtnEl.disabled = true;
    state.sendBtnEl.style.display = 'none';
    state.stopBtnEl.style.display = 'none';
    updateTitle('查询中...');
    showTyping('正在查询...');
    renderMessages();
    saveHistory();

    try {
        const resp = await window.apiUtils.post('/ai/quick-query', { key });
        const data = resp;

        const assistantMsg = {
            role: 'assistant',
            type: data.type || 'text',
            answer: data.answer || '',
            content: data.answer || '',
            data: data.structuredData,
            tools: data.toolsUsed
        };
        state.messages.push(assistantMsg);
    } catch (err) {
        state.messages.push({
            role: 'assistant',
            content: `查询失败：${err.message || '请稍后重试'}`,
            isError: true,
            retry: () => sendQuickQuery(key, label)
        });
    } finally {
        hideTyping();
        state.loading = false;
        state.sendBtnEl.disabled = false;
        state.stopBtnEl.style.display = 'none';
        state.sendBtnEl.style.display = 'flex';
        updateTitle('在线');
        renderMessages();
        saveHistory();
        state.inputEl.focus();
    }
}

/**
 * 渲染消息列表（增量）：只 append 新消息，不重建已有 DOM。
 * 全量重绘只发生在 clearHistory / loadHistory / 重试移除等结构性变化时
 * （那些路径直接调 renderMessagesFull）。
 */
function renderMessages() {
    const el = state.messagesEl;
    if (!el) return;

    const renderedCount = el.querySelectorAll('.ai-msg').length;
    // 消息变少了（清空/重试移除/历史加载）→ 回退到全量重建
    if (renderedCount > state.messages.length) {
        renderMessagesFull();
        return;
    }
    // 空态教程卡片占位：有消息要显示时先清掉
    if (renderedCount === 0 && state.messages.length > 0) {
        el.innerHTML = '';
    }

    // 自动滚动到最新消息（仅当用户本来就在底部附近，上翻阅读时不去打扰）
    // 必须在 append 之前判断：先 append 再算的话，新增的一条长回复（AI 回复几乎都
    // 超过 120px）会把差值撑大，判定成「不在底部」，结果是回答出来了屏幕却停在原地。
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;

    for (let idx = renderedCount; idx < state.messages.length; idx++) {
        el.appendChild(renderMessage(state.messages[idx], idx));
    }

    // 如果正在加载中，恢复打字提示
    if (state.loading) {
        showTyping();
    }

    if (nearBottom || state.loading) {
        requestAnimationFrame(() => {
            el.scrollTop = el.scrollHeight;
        });
    }
}

/** 全量重建消息列表（结构性变化专用） */
function renderMessagesFull() {
    const el = state.messagesEl;
    if (!el) return;
    el.innerHTML = '';

    if (state.messages.length === 0) {
        el.appendChild(buildEmptyTutorial());
        return;
    }

    state.messages.forEach((msg, idx) => {
        el.appendChild(renderMessage(msg, idx));
    });
    if (state.loading) showTyping();
    requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
    });
}

/** 空态使用指南卡片（按角色展示示例） */
function buildEmptyTutorial() {
    const empty = document.createElement('div');
    empty.className = 'ai-empty';
    const isAdmin = state.userRole === 'admin';
    const isTeacher = state.userRole === 'teacher';

    let sections = [];
    if (isAdmin) {
        sections = [
            { title: '排课', content: '周四，19-22，[地点]，[学生]，[教师]，入户<br>批量排课（每行一条）：<br>周一晚上 [学生]入户（[教师]，[地点]）<br>周二晚上 [学生]入户（[教师]，[地点]）' },
            { title: '修改排课', content: '把[学生]周四的课改到周五晚上' },
            { title: '删除排课', content: '取消[学生]下周一的课' },
            { title: '查询', content: '本月排课总数 / 按教师统计 / 查[教师]的课表' }
        ];
    } else if (isTeacher) {
        sections = [
            { title: '查询课表', content: '我本周的课表 / 我下周的安排' },
            { title: '查询统计', content: '我本月排了多少课 / 我的排课统计' },
            { title: '其他问题', content: '系统使用帮助 / 课程类型有哪些' }
        ];
    } else {
        sections = [
            { title: '查询课表', content: '我本周的课表 / 今日课程安排' },
            { title: '查询统计', content: '我的课程统计 / 按月查看课程' },
            { title: '其他问题', content: '系统使用帮助 / 课程类型有哪些' }
        ];
    }

    const sectionsHtml = sections.map(s =>
        `<div class="ai-tutorial-section">
            <div class="ai-tutorial-section-title">${s.title}</div>
            <div class="ai-tutorial-section-content">${s.content}</div>
        </div>`
    ).join('');

    empty.innerHTML = `
        <div class="ai-tutorial">
            <div class="ai-tutorial-title">${ASSISTANT_NAME} 使用指南</div>
            ${sectionsHtml}
        </div>
    `;
    return empty;
}

/**
 * 助手头像标记（assistant-ui 惯例：消息左侧小头像，用品牌 logo 作 fallback 图标）
 */
const ASSISTANT_AVATAR_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${LOGO_PATHS}</svg>`;

/**
 * 给 assistant 消息包上「头像 + 内容列」结构。
 * 各渲染器只关心内容；头像与布局统一在这里加，避免每处重复。
 */
function withAssistantAvatar(wrapper) {
    const content = document.createElement('div');
    content.className = 'ai-msg-content';
    while (wrapper.firstChild) content.appendChild(wrapper.firstChild);

    const avatar = document.createElement('div');
    avatar.className = 'ai-msg-avatar';
    avatar.innerHTML = ASSISTANT_AVATAR_SVG;

    wrapper.appendChild(avatar);
    wrapper.appendChild(content);
    wrapper.classList.add('with-avatar');
    return wrapper;
}

/**
 * 消息稳定 id：localStorage / 服务端会话 / DOM 三者靠它对齐。
 * 服务端返回的消息带后端 messageId（chat_…/msg_…），本地生成的用 m_ 前缀。
 */
function makeMsgId() {
    return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 给一条助手消息挂「这条回答没用」按钮。
 * 只有带 messageId（已落库）的消息才有意义 —— quick-query 不过 LLM、不落库，
 * 没有 messageId，就不显示按钮，免得点了个无处反馈的按钮。
 * 按钮挂在 .ai-msg-content 末尾（withAssistantAvatar 会把内容搬进这一列），
 * 不能挂 wrapper 上 —— 那样会跑到头像旁边、内容列外面。
 */
function appendFeedbackButton(wrapper, msg) {
    const content = wrapper.querySelector('.ai-msg-content') || wrapper;
    if (!msg.messageId) return wrapper;

    const btn = document.createElement('button');
    btn.className = 'ai-feedback-btn';
    btn.type = 'button';
    btn.title = '这条回答没用';
    btn.setAttribute('aria-label', '这条回答没用');

    if (msg.feedback === 'unhelpful') {
        btn.textContent = '已反馈没用';
        btn.disabled = true;
    } else {
        btn.textContent = '没用';
        btn.addEventListener('click', async () => {
            if (btn.disabled) return;
            btn.disabled = true;
            btn.textContent = '反馈中…';
            try {
                await window.apiUtils.post(`/ai/chat/messages/${encodeURIComponent(msg.messageId)}/feedback`, {
                    feedback: 'unhelpful'
                });
                msg.feedback = 'unhelpful';
                btn.textContent = '已反馈没用';
                saveHistory();
            } catch (err) {
                // 反馈失败不该让按钮永久卡在「反馈中」：恢复可点并提示
                btn.disabled = false;
                btn.textContent = '没用';
                if (window.Toast && typeof window.Toast.show === 'function') {
                    window.Toast.show('反馈提交失败，请稍后再试', { type: 'error' });
                }
            }
        });
    }
    content.appendChild(btn);
    return wrapper;
}

/**
 * 渲染单条消息
 */
function renderMessage(msg, index) {
    const wrapper = document.createElement('div');
    wrapper.className = `ai-msg ${msg.role}`;
    if (msg.id) wrapper.dataset.msgId = msg.id;
    if (msg.messageId) wrapper.dataset.serverMsgId = msg.messageId;

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
                if (img.dataUrl) {
                    imgEl.src = img.dataUrl;
                    imgEl.onclick = () => window.open(img.dataUrl, '_blank');
                } else {
                    // 历史消息的图片 base64 不落 localStorage，重载后显示占位
                    imgEl.title = '图片未保留（历史消息）';
                }
                imgEl.alt = img.name;
                imgEl.style.cssText = 'max-width: 200px; max-height: 200px; border-radius: 8px; object-fit: cover;'
                    + (img.dataUrl ? ' cursor: pointer;' : ' background:#e0e0e0; min-width:80px; min-height:80px;');
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

    // Assistant 消息统一出口：包头像 + 挂反馈按钮（错误消息不挂，没意义）
    const finalizeAssistant = (w) => {
        const out = withAssistantAvatar(w);
        if (msg.id) out.dataset.msgId = msg.id;
        if (msg.messageId) out.dataset.serverMsgId = msg.messageId;
        if (!msg.isError) appendFeedbackButton(out, msg);
        return out;
    };

    // Assistant 消息
    if (msg.isError) {
        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble error';
        bubble.textContent = msg.content;
        wrapper.appendChild(bubble);
        // 可重试的错误展示一键重试（msg.retry 由 catch 埋入；「查询已停止」没有 retry）
        if (typeof msg.retry === 'function') {
            const retryBtn = document.createElement('button');
            retryBtn.className = 'ai-retry-btn';
            retryBtn.textContent = '重试';
            retryBtn.addEventListener('click', () => {
                // 移除这条报错气泡后重新发起
                state.messages.splice(index, 1);
                renderMessagesFull();
                msg.retry();
            });
            wrapper.appendChild(retryBtn);
        }
        return finalizeAssistant(wrapper);
    }

    // 根据消息类型渲染（统一包上助手头像）
    switch (msg.type) {
        case MessageType.DATA_TABLE:
            return finalizeAssistant(renderDataTableMessage(msg));
        case MessageType.SCHEDULE_LIST:
            return finalizeAssistant(renderScheduleListMessage(msg));
        case MessageType.CHART_DATA:
            return finalizeAssistant(renderChartDataMessage(msg));
        case MessageType.SCHEDULE_PREVIEW:
            return finalizeAssistant(renderSchedulePreviewMessage(msg));
        case MessageType.SCHEDULE_OPERATION_PREVIEW:
            return finalizeAssistant(renderScheduleOperationPreviewMessage(msg));
        default:
            return finalizeAssistant(renderTextMessage(msg));
    }
}

/**
 * HTML 转义（防 XSS）
 */
function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * 简单的 Markdown 渲染器（带 XSS 防护）
 */
function renderMarkdown(text) {
    if (!text || typeof text !== 'string') return escapeHtml(text);

    // 先提取代码块和行内代码，用占位符替换，避免被转义
    const codeBlocks = [];
    const inlineCodes = [];

    // 提取代码块
    let html = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
        const idx = codeBlocks.length;
        codeBlocks.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
        return `__CODE_BLOCK_${idx}__`;
    });

    // 提取行内代码
    html = html.replace(/`([^`]+)`/g, (match, code) => {
        const idx = inlineCodes.length;
        inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
        return `__INLINE_CODE_${idx}__`;
    });

    // 转义 HTML 特殊字符（防止 XSS）
    html = escapeHtml(html);

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

    // 链接（escapeHtml 已经转义了引号，需要还原链接部分）
    // 安全：仅允许 http/https/mailto 协议与相对链接，阻断 javascript:/vbscript: 等。
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
        const decoded = url.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const trimmed = decoded.trim();
        const isSafeScheme = /^(https?:|mailto:)/i.test(trimmed) ||
            trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('?');
        if (!isSafeScheme) return text; // 危险协议：仅保留可见文本，丢弃链接
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });

    // 换行
    html = html.replace(/\n/g, '<br>');

    // 还原代码块和行内代码
    codeBlocks.forEach((block, idx) => {
        html = html.replace(`__CODE_BLOCK_${idx}__`, block);
    });
    inlineCodes.forEach((code, idx) => {
        html = html.replace(`__INLINE_CODE_${idx}__`, code);
    });

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
            tdTime.textContent = `${formatClock(schedule.start_time)} - ${formatClock(schedule.end_time)}`;
            tdTime.style.fontSize = 'var(--fs-100)';
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

        // 预览头部：服务端已经按「一场课一行」合并好，这里只汇总名册
        const schedules = msg.data.schedules;
        const uniqueTeachers = [...new Set(schedules.flatMap(s => (s.teachers || []).map(t => t.teacher_name)))];
        const uniqueStudents = [...new Set(schedules.flatMap(s => (s.students || []).map(st => st.student_name)))];
        const uniqueCourses = [...new Set(schedules.flatMap(s => (s.teachers || []).map(t => t.course_type_cn)))];
        const totalCount = msg.data.totalCount;

        const previewHeader = document.createElement('div');
        previewHeader.className = 'ai-preview-header';
        previewHeader.innerHTML = `
            <div class="ai-preview-title">
                📋 排课预览方案
            </div>
            <div class="ai-preview-meta">
                <div class="ai-preview-meta-item">
                    教师：<strong>${escapeHtml(uniqueTeachers.join('、') || msg.data.teacher)}</strong>
                </div>
                <div class="ai-preview-meta-item">
                    学生：<strong>${escapeHtml(uniqueStudents.join('、') || msg.data.student)}</strong>
                </div>
                <div class="ai-preview-meta-item">
                    课程：<strong>${escapeHtml(uniqueCourses.join('、') || msg.data.courseType)}</strong>
                </div>
                <div class="ai-preview-meta-item">
                    共 <strong>${totalCount}</strong> 条记录（一场课一行，同场的多位教师合并在同一栏）
                </div>
                ${msg.data.conflictCount ? `<div class="ai-preview-meta-item" style="color:#b45309;font-weight:600;">
                    ⚠ ${msg.data.conflictCount} 处时段与现有排课重叠（鼠标移到「冲突」标记上看是谁）
                </div>` : ''}
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

        ['日期', '星期', '时间', '教师', '学生', '课程', '状态'].forEach(text => {
            const th = document.createElement('th');
            th.textContent = text;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        schedules.forEach(item => {
            const tr = document.createElement('tr');

            const tdDate = document.createElement('td');
            tdDate.textContent = formatDate(item.class_date);
            tr.appendChild(tdDate);

            const tdDay = document.createElement('td');
            tdDay.textContent = item.day_of_week || getDayOfWeekFromDate(item.class_date);
            tr.appendChild(tdDay);

            const tdTime = document.createElement('td');
            tdTime.textContent = `${formatClock(item.start_time)} - ${formatClock(item.end_time)}`;
            tr.appendChild(tdTime);

            const tdTeacher = document.createElement('td');
            // 与下面学生列同一兜底：老会话从 localStorage 恢复的预览行可能只有 teacher_name，
            // 少了这一层整列会显示成 "-"
            tdTeacher.textContent = item.teacher_display || item.teacher_name || '-';
            tr.appendChild(tdTeacher);

            const tdStudent = document.createElement('td');
            tdStudent.textContent = item.student_display || item.student_name || '-';
            tr.appendChild(tdStudent);

            const tdCourse = document.createElement('td');
            tdCourse.textContent = item.course_type_cn || '-';
            tr.appendChild(tdCourse);

            const tdStatus = document.createElement('td');
            const statusText = item.status_cn || (item.status === 'pending' ? '待确认' : '已确认');
            tdStatus.textContent = statusText;
            tdStatus.style.color = item.status === 'pending' ? 'var(--ai-warning)' : 'var(--ai-success)';
            tdStatus.style.fontWeight = '600';
            // 时段冲突不拦住创建（与管理员端一致：提示为主），但必须在确认前看得见
            if (Array.isArray(item.conflicts) && item.conflicts.length) {
                const warn = document.createElement('div');
                warn.style.cssText = 'margin-top:4px;color:#b45309;font-weight:600;font-size:12px;';
                warn.textContent = `⚠ ${item.conflicts.length} 处时段冲突`;
                warn.title = item.conflicts.join('\n');
                tdStatus.appendChild(warn);
            }
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
                onSend({ type: 'confirm_create', previewId, label: '已确认，开始创建本次排课' });
            }
        };
        actions.appendChild(confirmBtn);
        previewCard.appendChild(actions);

        wrapper.appendChild(previewCard);
    }

    return wrapper;
}

/**
 * 渲染排课预览表格（行对象统一字段：classDate/startTime/endTime/teacherName/studentName/courseTypeCn/status/statusCn/dayOfWeek）
 */
function buildScheduleTable(rows) {
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    ['日期', '星期', '时间', '教师', '学生', '课程', '状态'].forEach(text => {
        const th = document.createElement('th');
        th.textContent = text;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach(schedule => {
        const tr = document.createElement('tr');

        const tdDate = document.createElement('td');
        tdDate.textContent = formatDate(schedule.classDate);
        tr.appendChild(tdDate);

        const tdDay = document.createElement('td');
        tdDay.textContent = schedule.dayOfWeek || getDayOfWeekFromDate(schedule.classDate);
        tr.appendChild(tdDay);

        const tdTime = document.createElement('td');
        tdTime.textContent = `${formatClock(schedule.startTime)} - ${formatClock(schedule.endTime)}`;
        tr.appendChild(tdTime);

        const tdTeacher = document.createElement('td');
        tdTeacher.textContent = schedule.teacherName || '-';
        tr.appendChild(tdTeacher);

        const tdStudent = document.createElement('td');
        tdStudent.textContent = schedule.studentName || '-';
        tr.appendChild(tdStudent);

        const tdCourse = document.createElement('td');
        tdCourse.textContent = schedule.courseTypeCn || '-';
        tr.appendChild(tdCourse);

        const tdStatus = document.createElement('td');
        const statusText = schedule.statusCn || translateStatus(schedule.status) || '-';
        tdStatus.textContent = statusText;
        tdStatus.style.color = getStatusColor(schedule.status);
        tdStatus.style.fontWeight = '600';
        // 时段重叠只提示不拦（业务上允许一个人出现在重叠的两节课里），标在行上让人看得见
        if (Array.isArray(schedule.conflicts) && schedule.conflicts.length) {
            const warn = document.createElement('div');
            warn.style.cssText = 'margin-top:4px;color:#b45309;font-weight:600;font-size:12px;';
            warn.textContent = `⚠ ${schedule.conflicts.length} 处时段冲突`;
            warn.title = schedule.conflicts.join('\n');
            tdStatus.appendChild(warn);
        }
        tr.appendChild(tdStatus);

        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
}

/**
 * 渲染排课操作预览消息（修改/删除/调整预览）
 */
function renderScheduleOperationPreviewMessage(msg) {
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

    const data = msg.data;
    if (data && data.schedules && data.schedules.length > 0) {
        const previewCard = document.createElement('div');
        previewCard.className = 'ai-preview-card';

        const isDelete = data.operationType === 'delete';
        const isAdjust = data.operationType === 'adjust';
        const icon = isDelete ? '🗑️' : isAdjust ? '🔄' : '✏️';
        const title = isDelete ? '删除预览' : isAdjust ? '调整预览' : '修改预览';

        // 预览头部
        const previewHeader = document.createElement('div');
        previewHeader.className = 'ai-preview-header';
        previewHeader.innerHTML = `
            <div class="ai-preview-title">
                ${icon} ${title}
            </div>
            <div class="ai-preview-meta">
                <div class="ai-preview-meta-item">
                    影响 <strong>${data.affectedCount}</strong> 条排课
                </div>
                ${data.conflictCount ? `<div class="ai-preview-meta-item" style="color:#b45309;font-weight:600;">
                    ⚠ ${data.conflictCount} 处时段与现有排课重叠（照写，只是提示；鼠标移到行上看是谁）
                </div>` : ''}
                ${data.message ? `<div class="ai-preview-meta-item">${escapeHtml(data.message)}</div>` : ''}
                ${isDelete && data.reason ? `<div class="ai-preview-meta-item">原因：${escapeHtml(data.reason)}</div>` : ''}
            </div>
        `;
        previewCard.appendChild(previewHeader);

        // 如果是修改操作，显示变更详情
        if (!isDelete && data.changes && data.changes.length > 0) {
            const changesDiv = document.createElement('div');
            changesDiv.style.cssText = 'padding: 8px 12px; background: var(--ai-primary-light); border-radius: 8px; margin: 8px 0; font-size: 13px;';
            changesDiv.innerHTML = '<strong>变更内容：</strong><br>' +
                data.changes.map(c => `• ${escapeHtml(c.field)} → ${escapeHtml(c.newValue)}`).join('<br>');
            previewCard.appendChild(changesDiv);
        }

        // 排课列表表格（原记录）
        if (isAdjust) {
            const origLabel = document.createElement('div');
            origLabel.style.cssText = 'margin: 8px 0 4px; font-size: 13px; font-weight: 600; color: #b45309;';
            origLabel.textContent = '📦 原排课（确认后归档为已调整）';
            previewCard.appendChild(origLabel);
        }

        const originalRows = data.schedules.map(s => ({
            classDate: s.class_date,
            startTime: s.start_time,
            endTime: s.end_time,
            teacherName: s.teacher_name,
            studentName: s.student_name,
            courseTypeCn: s.course_type_cn || s.course_type,
            status: s.status,
            statusCn: s.status_cn,
            conflicts: s.conflicts || [],
            dayOfWeek: s.day_of_week
        }));
        const tableContainer = document.createElement('div');
        tableContainer.className = 'ai-data-table';
        tableContainer.style.border = 'none';
        tableContainer.style.borderRadius = '0';
        tableContainer.appendChild(buildScheduleTable(originalRows));
        previewCard.appendChild(tableContainer);

        // 调整课程：额外展示「新建课程」预览（后端 newSchedules）
        if (isAdjust && data.newSchedules && data.newSchedules.length > 0) {
            const newLabel = document.createElement('div');
            newLabel.style.cssText = 'margin: 10px 0 4px; font-size: 13px; font-weight: 600; color: var(--ai-primary, #047857);';
            // 调整 = 原记录归档 + 另建一条新记录（同学生/跨学生都一样）
            newLabel.textContent = data.newSchedules.some(n => n && n.crossStudent)
                ? '➕ 调整后（新建一条记录并在新学生名下；原记录所有字段保持不变）'
                : '➕ 调整后（新建一条记录；原记录所有字段保持不变，仅归档为已调整）';
            previewCard.appendChild(newLabel);

            const newRows = data.newSchedules.map(n => ({
                classDate: n.classDate,
                startTime: n.startTime,
                endTime: n.endTime,
                teacherName: n.teacherName,
                studentName: n.studentName,
                courseTypeCn: n.courseTypeCn,
                status: n.status || 'pending',
                statusCn: translateStatus(n.status || 'pending'),
                conflicts: n.conflicts || []
            }));
            const newTableContainer = document.createElement('div');
            newTableContainer.className = 'ai-data-table';
            newTableContainer.style.border = 'none';
            newTableContainer.style.borderRadius = '0';
            newTableContainer.appendChild(buildScheduleTable(newRows));
            previewCard.appendChild(newTableContainer);
        }

        // 确认按钮
        const actions = document.createElement('div');
        actions.className = 'ai-preview-actions';
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'ai-btn-confirm';
        if (isDelete) confirmBtn.style.cssText = 'background: var(--color-error-600, #dc2626);';
        confirmBtn.textContent = isDelete ? '✓ 确认删除' : isAdjust ? '✓ 确认调整' : '✓ 确认修改';
        confirmBtn.onclick = () => {
            const operationId = data.operationId;
            if (operationId) {
                confirmBtn.disabled = true;
                confirmBtn.textContent = isDelete ? '正在删除...' : isAdjust ? '正在调整...' : '正在修改...';
                onSend({ type: 'confirm_operation', operationId, label: isDelete ? '已确认删除' : isAdjust ? '已确认调整' : '已确认修改' });
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
    // 数值（0/1 只是普通的计数或序号）原样输出；布尔语义的列由后端翻译成 true/false
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

/**
 * DB TIME 列原样是 HH:MM:SS，展示统一截到 HH:MM（与 utils/format.js 的 formatTime 同约定）
 */
function formatClock(timeStr) {
    if (!timeStr) return '-';
    const s = String(timeStr);
    return s.length >= 5 ? s.slice(0, 5) : s;
}

function translateStatus(status) {
    const mapping = {
        'pending': '待确认',
        'confirmed': '已确认',
        'cancelled': '已取消',
        'completed': '已完成',
        'modified_away': '已改期'
    };
    return mapping[status] || status || '-';
}

function getDayOfWeekFromDate(dateStr) {
    if (!dateStr) return '-';
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const d = new Date(dateStr + 'T00:00:00+08:00');
    return days[d.getDay()];
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
            <img src="${image.dataUrl}" alt="${escapeHtml(image.name)}">
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
 * 是否停在消息区底部附近（判断依据在 append 之前取，避免长回复把差值撑大）
 */
function isNearBottom() {
    const el = state.messagesEl;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

/**
 * 显示 typing 动画（支持进度消息）
 */
function showTyping(message) {
    // 用户上翻看历史时不要把他拽回底部
    const shouldFollow = isNearBottom();
    hideTyping();
    const row = document.createElement('div');
    row.className = 'ai-typing-row';
    row.id = 'ai-typing-indicator';

    const avatar = document.createElement('div');
    avatar.className = 'ai-msg-avatar';
    avatar.innerHTML = ASSISTANT_AVATAR_SVG;
    row.appendChild(avatar);

    const bubble = document.createElement('div');
    bubble.className = 'ai-typing';
    const textSpan = document.createElement('span');
    textSpan.className = 'ai-typing-text';
    textSpan.textContent = message || '';
    bubble.appendChild(textSpan);
    bubble.appendChild(document.createElement('span'));
    bubble.appendChild(document.createElement('span'));
    bubble.appendChild(document.createElement('span'));
    row.appendChild(bubble);

    state.messagesEl.appendChild(row);
    if (shouldFollow) {
        state.messagesEl.scrollTop = state.messagesEl.scrollHeight;
    }
}

function updateTyping(message) {
    const el = document.getElementById('ai-typing-indicator');
    if (el) {
        const textEl = el.querySelector('.ai-typing-text');
        if (textEl) textEl.textContent = message;
        // 进度消息频繁刷新，每次都强滚会把正在上翻的用户反复拽回底部
        if (isNearBottom()) {
            state.messagesEl.scrollTop = state.messagesEl.scrollHeight;
        }
    }
}

function hideTyping() {
    const el = document.getElementById('ai-typing-indicator');
    if (el) el.remove();
}

/**
 * 清空对话历史
 */
async function clearHistory() {
    if (state.loading) return;

    if (state.messages.length === 0) return;

    if (!await Modal.confirm('确定要清空所有对话记录吗？', { title: '清空对话', confirmText: '清空', confirmStyle: 'danger' })) return;

    // 服务端也清：否则下次打开 loadServerHistory 会把刚清空的对话原样拉回来。
    // 失败不阻断本地清空（本地是用户立刻看到的结果），只记日志。
    try {
        await window.apiUtils.delete(`/ai/chat/sessions/${encodeURIComponent(state.sessionId || 'current')}`);
    } catch (_) { /* 服务端不可用时仅清本地 */ }
    state.sessionId = null;

    state.messages = [];
    clearSelectedImages();
    renderMessagesFull();
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
    const statusEl = state.panelEl?.querySelector('.ai-panel-title-status');
    if (!statusEl) return;
    // 「在线」是常态，由状态点表达，不再重复写字；思考中/查询中才显示文字
    statusEl.textContent = text === '在线' ? '' : text;
    statusEl.classList.toggle('visible', text !== '在线' && !!text);
}

/**
 * 发送消息
 */
async function onSend(action) {
    // action 为确认类操作（创建/修改/删除排课的二次确认），走独立字段，不依赖自然语言文本
    // 只认可白名单内的 type，避免 DOM 事件对象（其 .type='click'）被误判为 action
    const isAction = action && typeof action === 'object' &&
        (action.type === 'confirm_create' || action.type === 'confirm_operation');
    const text = isAction ? '' : state.inputEl.value.trim();
    if (state.loading) return;
    if (!isAction && !text && state.selectedImages.length === 0) return;

    // 添加到输入历史记录（仅普通文本输入）
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
    const images = isAction ? [] : [...state.selectedImages];  // 复制图片数组

    // 如果有图片，构建多模态消息
    if (images.length > 0) {
        userContent = {
            text: text || '请分析这些图片',
            images: images.map(img => img.dataUrl)
        };
    }

    // 添加用户消息气泡：普通输入显示文本/图片；确认类操作显示确认提示文本
    if (isAction) {
        state.messages.push({
            id: makeMsgId(),
            role: 'user',
            content: action.label || '已确认'
        });
    } else {
        state.messages.push({
            id: makeMsgId(),
            role: 'user',
            content: text,
            images: images.length > 0 ? images : undefined
        });
    }

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

    showTyping('正在分析...');

    try {
        // 构建对话历史：排除当前轮刚 push 的用户消息（普通问题或确认气泡），避免重复。
        // 普通轮的文本由后端 question 注入；确认轮由 requestBody.action 注入，气泡仅用于展示。
        // 报错/停止的气泡（isError）只是 UI 提示，不能作为 assistant 轮回传给模型。
        // 只回传最近 MAX_REQUEST_HISTORY 条：后端对超长 history 直接 400，
        // 本地 MAX_HISTORY(30) 只是展示上限，比请求上限大。
        const historySource = state.messages.slice(0, -1).slice(-MAX_REQUEST_HISTORY);
        const conversationHistory = historySource.map(msg => {
            if (msg.role === 'user' && msg.images && msg.images.length > 0) {
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
            }
            return {
                role: msg.role,
                content: msg.role === 'user' ? msg.content : (msg.answer || msg.content || '')
            };
        });

        const requestBody = {
            history: conversationHistory,
            stream: true
        };

        // 本机自定义模型/端点（只存在这个浏览器里）：随请求带上，服务端优先用它。
        // 地址会由服务端做出站护栏校验，被拒时请求直接失败并提示，不会静默回落到全局模型。
        const customConfig = window.AICustomModelStore
            ? window.AICustomModelStore.getQueryConfig()
            : null;
        if (customConfig) {
            requestBody.customConfig = customConfig;
        }

        if (isAction) {
            // 二次确认操作：走独立 action 字段，后端直接执行，不进 LLM
            requestBody.action = action;
        } else {
            requestBody.question = text || '请分析这些图片';
            if (images.length > 0) {
                requestBody.images = images.map(img => img.dataUrl);
            }
        }

        const resp = await fetch('/api/ai/query', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody),
            signal: state.abortController.signal
        });

        if (!resp.ok) {
            const body = await resp.text();
            let parsed = null;
            try {
                parsed = body ? JSON.parse(body) : null;
            } catch (_) { /* 由下方统一转换为协议错误 */ }

            if (window.apiUtils?.isEnvelope(parsed) && parsed.ok === false) {
                throw window.apiUtils.errorFromEnvelope(parsed, resp, '/api/ai/query');
            }
            throw new window.ApiError({
                code: 'INVALID_RESPONSE',
                message: 'AI 服务返回了无法识别的数据，请稍后重试',
                status: resp.status,
                retryable: resp.status >= 500,
                requestId: resp.headers.get('X-Request-Id'),
                endpoint: '/api/ai/query'
            });
        }

        // SSE 流式读取
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let data = null;
        let currentEvent = null;

        function processSSELine(line) {
            if (line.startsWith('event:')) {
                currentEvent = line.slice(6).trim();
                return;
            }
            if (!line.startsWith('data:')) return;
            let event;
            try {
                event = JSON.parse(line.slice(5).trim());
            } catch (parseErr) {
                console.warn('[AI] SSE 解析跳过:', line.slice(0, 100), parseErr.message);
                currentEvent = null;
                return;
            }
            if (currentEvent === 'error' || event.type === 'error') {
                const envelopeError = event.error && typeof event.error === 'object'
                    ? event.error
                    : {};
                const meta = event.meta && typeof event.meta === 'object' ? event.meta : {};
                currentEvent = null;
                throw new window.ApiError({
                    code: envelopeError.code || 'AI_UPSTREAM_UNAVAILABLE',
                    message: envelopeError.message || event.message || 'AI 查询失败，请稍后重试',
                    status: 0,
                    details: envelopeError.details,
                    retryable: envelopeError.retryable === true,
                    retryAfterSeconds: envelopeError.retryAfterSeconds,
                    requestId: meta.requestId || null,
                    endpoint: '/api/ai/query'
                });
            }
            currentEvent = null;
            if (event.type === 'progress') {
                updateTyping(event.message);
                updateTitle(event.message);
            } else if (event.type === 'result') {
                data = event.data;
            }
        }

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) processSSELine(line);
        }

        // 刷新解码器剩余字节 + 处理 buffer 中最后一行（可能无尾部换行）
        buffer += decoder.decode();
        if (buffer.trim()) processSSELine(buffer.trim());

        if (!data) throw new Error('未收到 AI 响应');

        // 确保 answer 是字符串
        let answerText = data.answer;
        if (typeof answerText !== 'string') {
            if (answerText && typeof answerText === 'object') {
                answerText = JSON.stringify(answerText, null, 2);
            } else {
                answerText = String(answerText || '');
            }
        }

        if (data.sessionId) state.sessionId = data.sessionId;

        const assistantMsg = {
            id: makeMsgId(),
            role: 'assistant',
            type: data.type || MessageType.TEXT,
            answer: answerText,
            content: answerText,
            data: data.structuredData,
            tools: data.toolsUsed,
            // 服务端落库后回传的 id：反馈按钮靠它关联这条回答
            messageId: data.messageId || null,
            sessionId: data.sessionId || null
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
                isError: true,
                // 可重试的错误给用户一键重试（渲染层读 retry 回调）
                retry: err.retryable === false ? null : () => onSend(action)
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
        // 图片 base64 不落 localStorage：体积大且只是展示用，重载后留缩略占位即可。
        const slimmed = trimmed.map(msg => {
            if (msg.role === 'user' && Array.isArray(msg.images) && msg.images.length > 0) {
                return { ...msg, images: msg.images.map(img => ({ ...img, dataUrl: null })) };
            }
            return msg;
        });
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            role: state.userRole,
            messages: slimmed
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
 * 从服务端拉回当前会话的消息，覆盖本地缓存（服务端为准）。
 * 本地缓存只用于首屏秒显；服务端才是事实来源（跨设备、跨实例、带反馈标记与 token 用量）。
 * 服务端消息是纯文本回放（不重放预览卡片/工具调用链），足够做历史回顾与反馈。
 * 失败静默：离线或接口异常时保留本地缓存，不让面板变空。
 */
async function loadServerHistory() {
    // 竞态守卫：这两个 GET 往返期间用户可能已经发了消息（SSE result 会设置
    // state.sessionId 并 push 新消息）。那种情况下绝不能用拉回的旧会话覆盖。
    const startedWithSession = state.sessionId;
    try {
        const sessionsResp = await window.apiUtils.get('/ai/chat/sessions');
        if (state.sessionId !== startedWithSession || state.loading) return;
        const sessions = (sessionsResp && sessionsResp.sessions) || [];
        if (!sessions.length) return; // 还没有落库过会话，保留本地缓存
        const sessionId = sessions[0].id;
        if (state.sessionId || state.loading) return; // 期间已确定会话/正在提问，不覆盖
        state.sessionId = sessionId;
        const msgResp = await window.apiUtils.get(`/ai/chat/sessions/${encodeURIComponent(sessionId)}/messages`);
        if (state.sessionId !== sessionId || state.loading) return; // 二次检查
        const messages = (msgResp && msgResp.messages) || [];
        if (!messages.length) return;

        const restored = messages.map(m => ({
            id: m.id,
            messageId: m.id,
            role: m.role,
            type: MessageType.TEXT,
            answer: m.content || '',
            content: m.content || '',
            tools: (() => { try { return m.tools_used ? JSON.parse(m.tools_used) : []; } catch (_) { return []; } })(),
            feedback: m.feedback || ''
        }));
        state.messages = restored.slice(-MAX_HISTORY);
        renderMessagesFull();
        saveHistory();
    } catch (_) { /* 服务端不可用时保留本地缓存 */ }
}

/**
 * 检查 AI 状态
 */
async function refreshStatus() {
    // 状态点：在线=绿点，离线=灰点（标题栏上的小圆点，不占额外文字）
    const dot = state.panelEl?.querySelector('.ai-status-dot');
    const floatBtn = state.floatBtnEl;
    const setOnline = (online) => {
        if (dot) {
            dot.classList.toggle('offline', !online);
            dot.title = online ? '在线' : '离线';
        }
        if (floatBtn) floatBtn.classList.toggle('offline', !online);
    };

    try {
        const resp = await window.apiUtils.get('/ai/status');
        const data = resp;
        setOnline(!!data.enabled);
        return !!data.enabled;
    } catch (_) {
        setOnline(false);
        return false;
    }
}

/**
 * 获取当前模型的能力信息
 */
async function fetchModelCapabilities() {
    try {
        const resp = await window.apiUtils.get('/ai/capabilities');
        const data = resp;

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
 * 加载用户的模型选择与可选清单
 * @description 可选清单按渠道分组（来自服务端 env 预设 × 模型目录），只含标识符不含密钥。
 */
async function loadModelPicker() {
    try {
        const resp = await window.apiUtils.get('/ai/selectable-models');
        const data = resp;

        state.modelPicker.presets = data.presets || [];
        state.modelPicker.defaultModel = data.defaultModel || null;
        state.modelPicker.presetId = data.current?.presetId ?? null;
        state.modelPicker.modelId = data.current?.modelId ?? null;
        state.modelPicker.isDefault = !!data.current?.isDefault;
        state.modelPicker.loaded = true;

        renderModelMenu();
        updateModelTrigger();
    } catch (error) {
        console.error('获取可选模型失败:', error);
        state.modelPicker.loaded = false;
        const trigger = document.getElementById('ai-model-trigger');
        if (trigger) trigger.style.display = 'none';
    }
}

/**
 * token 数量紧凑显示：524288 → 512K，1048576 → 1M
 */
function formatTokenAmount(n) {
    if (!n || !Number.isFinite(Number(n))) return '';
    const v = Number(n);
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1024) return Math.round(v / 1024) + 'K';
    return String(v);
}

/**
 * 模型能力摘要（用于 title 悬浮说明）
 */
function modelCapSummary(model) {
    const caps = model.capabilities || {};
    const parts = [];
    if (model.contextLength) parts.push('上下文 ' + formatTokenAmount(model.contextLength));
    if (model.maxOutput) parts.push('最大输出 ' + formatTokenAmount(model.maxOutput));
    parts.push('视觉 ' + (caps.vision ? '支持' : '不支持'));
    parts.push('函数调用 ' + (caps.tools ? '支持' : '不支持'));
    return parts.join(' · ');
}

/**
 * 模型能力徽标（上下文 / 最大输出 / 视觉 / 工具）
 */
function renderModelCapTags(model) {
    const caps = model.capabilities || {};
    const tags = [];
    const ctx = formatTokenAmount(model.contextLength);
    const out = formatTokenAmount(model.maxOutput);
    if (ctx) tags.push('<span class="ai-model-item-cap">' + ctx + ' 上下文</span>');
    if (out) tags.push('<span class="ai-model-item-cap">' + out + ' 输出</span>');
    if (caps.vision) tags.push('<span class="ai-model-item-cap vision">视觉</span>');
    if (caps.tools) tags.push('<span class="ai-model-item-cap">工具</span>');
    return tags.join('');
}

/**
 * 渲染模型下拉菜单（按渠道分组）
 */
function renderModelMenu() {
    const menu = document.getElementById('ai-model-menu');
    if (!menu) return;

    const { presets = [], presetId, modelId, isDefault } = state.modelPicker;

    // 每个模型一个图标：优先用渠道首字母小方块（与参考图一致的「一行一个模型」形态），
    // 不展示能力标签/分组标题，靠图标 + 名称 + 选中对号表达。
    const MODEL_ICON = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">${LOGO_PATHS}</svg>`;

    const itemsHtml = presets.map(group => group.models.map(model => {
        const active = !isDefault && group.presetId === presetId && model.id === modelId;
        return `
            <button class="ai-model-item${active ? ' active' : ''}" type="button"
                    data-preset-id="${group.presetId}" data-model-id="${model.id}"
                    title="${escapeHtml(modelCapSummary(model))}">
                <span class="ai-model-item-logo">${MODEL_ICON}</span>
                <span class="ai-model-item-name">${escapeHtml(model.name || model.id)}</span>
                ${active ? '<svg class="ai-model-item-check" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
            </button>
        `;
    }).join('')).join('');

    menu.innerHTML = `
        ${itemsHtml}
        <div class="ai-model-divider"></div>
        <button class="ai-model-item ai-model-reset${isDefault ? ' active' : ''}" type="button" data-reset="1">
            <span class="ai-model-item-logo">${MODEL_ICON}</span>
            <span class="ai-model-item-name">跟随系统默认</span>
            ${isDefault ? '<svg class="ai-model-item-check" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
        </button>
    `;

    menu.querySelectorAll('.ai-model-item').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (btn.dataset.reset) {
                resetUserModel();
            } else {
                selectUserModel(btn.dataset.presetId, btn.dataset.modelId);
            }
        });
    });
}

/**
 * 本机自定义模型当前生效的配置（无则 null）
 * @description 只存在于这个浏览器，服务端的 /ai/selectable-models 不知道它的存在，
 *              所以按钮文案要单独读一次，否则界面显示的和服务端实际用的会对不上。
 */
function activeCustomQueryConfig() {
    return window.AICustomModelStore ? window.AICustomModelStore.getQueryConfig() : null;
}

/**
 * 更新头部触发按钮的文案
 */
function updateModelTrigger() {
    const trigger = document.getElementById('ai-model-trigger');
    if (!trigger) return;

    const nameEl = trigger.querySelector('.ai-model-trigger-name');
    const { presets = [], presetId, modelId, isDefault } = state.modelPicker;
    const localConfig = activeCustomQueryConfig();

    let label = null;
    if (localConfig) {
        label = `${localConfig.model}（本机）`;
    } else if (!isDefault) {
        for (const group of presets) {
            const hit = group.models.find(m => m.id === modelId && group.presetId === presetId);
            if (hit) { label = hit.name || hit.id; break; }
        }
        if (!label && modelId) label = modelId;
    } else {
        // 跟随系统默认也要显示**实际在用的模型名**，而不是「默认模型」占位：
        // 后端 /ai/selectable-models 的 defaultModel.modelId 就是全局生效的模型。
        const fallbackId = state.modelPicker.defaultModel?.modelId;
        if (fallbackId) {
            for (const group of presets) {
                const hit = group.models.find(m => m.id === fallbackId);
                if (hit) { label = hit.name || hit.id; break; }
            }
            if (!label) label = fallbackId;
        }
    }
    // 兜底不用「默认模型」这种占位说法——规格要求触发器上显示的是**真实在用的模型名**。
    // 清单已加载却解析不出名字，属于「后端没给出默认模型」，如实说明状态。
    if (!label) label = '未选择模型';

    if (nameEl) {
        nameEl.textContent = label;
        // 按 composer 工具条的真实可用宽度判断「显示不全」——右侧 spacer 的空间本来就归触发器，
        // 名称放得下就显示，别用拍脑袋的固定上限把放得下的名字藏掉。
        // canvas 测文字宽度（不依赖 DOM 反馈，避免测量→缩窄→再测量的循环）。
        const cs = getComputedStyle(nameEl);
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily || 'sans-serif'}`;
        const textWidth = ctx.measureText(label).width + 12;  // 12px = 触发器自身左右 padding

        // 可用宽度 = 触发器左缘到发送按钮左缘（中间的 spacer 是弹性区，触发器可占用）
        let available = 240;   // 面板未打开时的兜底值
        const bar = trigger.closest('.ai-composer-bar');
        const send = bar?.querySelector('.ai-panel-send');
        if (trigger.offsetParent && send) {
            const triggerRect = trigger.getBoundingClientRect();
            const sendRect = send.getBoundingClientRect();
            available = Math.max(0, sendRect.left - triggerRect.left - 16);
        }
        const isTruncated = textWidth > available;
        trigger.classList.toggle('truncated', isTruncated);
        // 截断时按真实可用宽度省略名称（保留名称可见，而不是只留一个星形图标）
        if (nameEl) {
            nameEl.style.maxWidth = isTruncated ? `${Math.max(24, available)}px` : '';
        }
    }
    trigger.title = label;
    trigger.classList.toggle('custom', !!localConfig || !isDefault);
}

/**
 * 展开/收起模型下拉
 */
function toggleModelMenu() {
    const menu = document.getElementById('ai-model-menu');
    if (!menu) return;
    const trigger = document.getElementById('ai-model-trigger');

    const willOpen = !menu.classList.contains('open');
    menu.classList.toggle('open', willOpen);
    if (trigger) trigger.classList.toggle('menu-open', willOpen);

    if (willOpen) {
        // 定位到触发器正上方：底边贴触发器顶边留 6px，右缘与触发器右缘对齐；
        // 窄屏时菜单比触发器宽，右缘对齐会让左侧越界 —— 按面板左右各留 8px 钳制。
        if (trigger && state.panelEl) {
            const panelRect = state.panelEl.getBoundingClientRect();
            const triggerRect = trigger.getBoundingClientRect();
            const menuWidth = menu.offsetWidth || 280;
            const margin = 8;
            let right = Math.max(margin, panelRect.right - triggerRect.right);
            const menuLeft = panelRect.right - right - menuWidth;
            if (menuLeft < panelRect.left + margin) {
                right = Math.max(margin, panelRect.width - menuWidth - margin);
            }
            menu.style.right = `${right}px`;
            menu.style.bottom = `${panelRect.bottom - triggerRect.top + 6}px`;
        }
    }
    if (willOpen) {
        // 只在打开时挂一次：点击面板其他位置收起下拉，再点一次才收起面板
        const closeOnOutside = (ev) => {
            const trigger = document.getElementById('ai-model-trigger');
            if (menu.contains(ev.target) || (trigger && trigger.contains(ev.target))) return;
            menu.classList.remove('open');
            trigger?.classList.remove('menu-open');
            document.removeEventListener('click', closeOnOutside, true);
        };
        setTimeout(() => document.addEventListener('click', closeOnOutside, true), 0);
    }
}

/**
 * 切换为指定模型（仅本人生效）
 * @description 先验通再保存：模型不通时就别写进偏好，否则用户以为切换成功，
 *              直到下次提问才发现助手已经不可用，还不知道是自己换的模型导致的。
 */
async function selectUserModel(presetId, modelId) {
    const menu = document.getElementById('ai-model-menu');
    try {
        // 探活会真实打一次上游，慢于普通请求，先给出「验证中」反馈
        apiUtils.showToast(`正在验证 ${modelId}…`, 'info');

        const check = await window.apiUtils.post('/ai/my-model/check', { presetId, modelId });
        if (!check || check.available === false) {
            // 不动 state：菜单重新渲染后高亮仍停在原选择上；收起菜单，原因用 toast 说明
            renderModelMenu();
            document.getElementById('ai-model-menu')?.classList.remove('open');
            document.getElementById('ai-model-trigger')?.classList.remove('menu-open');
            apiUtils.showToast(check?.error || '该模型当前不可用，已保留原选择', 'error');
            return;
        }

        const resp = await window.apiUtils.put('/ai/my-model', { presetId, modelId });
        // 选服务端模型意味着放弃本机自定义模型，否则 customConfig 优先级更高、
        // 会把这次选择盖掉，用户看到「已切换」但实际没换。
        if (window.AICustomModelStore) window.AICustomModelStore.clearActive();
        state.modelPicker.presetId = resp.presetId;
        state.modelPicker.modelId = resp.modelId;
        state.modelPicker.isDefault = false;
        updateModelTrigger();
        renderModelMenu();
        menu?.classList.remove('open');
        document.getElementById('ai-model-trigger')?.classList.remove('menu-open');

        // 能力可能随模型改变（如视觉），刷新图片按钮可见性
        fetchModelCapabilities();

        apiUtils.showToast(`已切换到 ${resp.modelName || modelId}，仅对你生效`, 'success');
    } catch (error) {
        console.error('切换模型失败:', error);
        apiUtils.showToast(error?.message || '切换模型失败，请稍后重试', 'error');
    }
}

/**
 * 恢复为系统默认模型
 */
async function resetUserModel() {
    const menu = document.getElementById('ai-model-menu');
    try {
        const resp = await window.apiUtils.delete('/ai/my-model');
        if (window.AICustomModelStore) window.AICustomModelStore.clearActive();
        state.modelPicker.presetId = null;
        state.modelPicker.modelId = resp.modelId;
        state.modelPicker.isDefault = true;
        updateModelTrigger();
        renderModelMenu();
        menu?.classList.remove('open');
        document.getElementById('ai-model-trigger')?.classList.remove('menu-open');

        fetchModelCapabilities();

        apiUtils.showToast('已恢复为系统默认模型', 'success');
    } catch (error) {
        console.error('恢复默认模型失败:', error);
        apiUtils.showToast(error?.message || '恢复默认模型失败，请稍后重试', 'error');
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

    buildPanel();
    loadHistory();
    renderQuickQuestions();
    renderMessagesFull();   // 本地缓存秒显
    // 服务端为准：异步拉回会话覆盖本地（失败静默，保留缓存）
    void loadServerHistory();
    refreshStatus();
    fetchModelCapabilities();  // 获取模型能力
    loadModelPicker();         // 加载用户自选模型 + 可选清单

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
    btn.title = ASSISTANT_NAME;
    btn.innerHTML = LOGO_SVG;
    btn.addEventListener('click', () => toggle(state.userRole));

    state.floatBtnEl = btn;

    refreshStatus().then(available => {
        if (!available) btn.classList.add('offline');
    });

    document.body.appendChild(btn);

    // 恢复上次拖拽后的位置（右上角锚定值）
    restoreFloatBtnPos(btn);

    // 图标拖拽：按住鼠标左键移动图标（右上角锚定），松开后持久化位置
    setupFloatBtnDrag(btn);

}

/** 从 localStorage 恢复拖拽后的位置；无记录或已越界则保持默认（right/bottom）位置 */
function restoreFloatBtnPos(btn) {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(AI_FLOAT_POS_KEY) || 'null');
    } catch (_) { saved = null; }
    if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') return;

    const margin = 8;
    const left = Math.min(Math.max(saved.left, margin), window.innerWidth - btn.offsetWidth - margin);
    const top = Math.min(Math.max(saved.top, margin), window.innerHeight - btn.offsetHeight - margin);
    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
    state.floatBtnPos = { left, top };
}

/**
 * AI 悬浮图标的鼠标拖拽
 *
 * - 按下左键开始拖拽，移动时把图标位置改为 left/top（右上角锚定），
 *   拖拽结束把位置存 localStorage（AI_FLOAT_POS_KEY），下次 init 恢复。
 * - 只在「纯点击」（按下到松开位移 < 5px）时触发 toggle 打开面板，
 *   拖拽不误触打开。
 * - 位置限制在视口内（留 8px 边距），保证图标永远可见可点。
 */
const AI_FLOAT_POS_KEY = 'ai-float-btn-pos';
const DRAG_THRESHOLD = 5;

function setupFloatBtnDrag(btn) {
    let startX = 0, startY = 0, moved = false, dragging = false, pointerId = null;

    // Pointer Events 统一鼠标与触屏：touch-action:none 已在 CSS 声明
    btn.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return; // 仅左键
        e.preventDefault(); // 防止拖拽选中文案/图片，也阻止触屏的合成 click 滚动
        const pos = btn.getBoundingClientRect();
        startX = e.clientX - pos.left;
        startY = e.clientY - pos.top;
        moved = false;
        dragging = true;
        pointerId = e.pointerId;
        state.floatBtnDragging = true;
        btn.classList.add('dragging');
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
    });

    function onMove(e) {
        if (!dragging || e.pointerId !== pointerId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
            // 尚未超过阈值，还属于「点击」
            return;
        }
        if (!moved) {
            moved = true; // 超过阈值 → 进入拖拽模式，点击不再触发 toggle
            try { btn.setPointerCapture(pointerId); } catch (_) { /* 忽略 */ }
        }

        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const margin = 8;
        let left = e.clientX - startX;
        let top = e.clientY - startY;
        left = Math.min(Math.max(left, margin), vw - btn.offsetWidth - margin);
        top = Math.min(Math.max(top, margin), vh - btn.offsetHeight - margin);
        btn.style.left = `${left}px`;
        btn.style.top = `${top}px`;
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';
    }

    function onUp(e) {
        if (!dragging || e.pointerId !== pointerId) return;
        dragging = false;
        pointerId = null;
        state.floatBtnDragging = false;
        btn.classList.remove('dragging');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        if (moved) {
            // 拖拽结束：持久化位置；同时阻止这次 pointerdown 之后的 click 打开面板
            e.preventDefault();
            e.stopPropagation();
            const rect = btn.getBoundingClientRect();
            state.floatBtnPos = { left: rect.left, top: rect.top };
            try {
                localStorage.setItem(AI_FLOAT_POS_KEY, JSON.stringify(state.floatBtnPos));
            } catch (_) { /* 存储不可用则忽略 */ }
        }
    }
}

