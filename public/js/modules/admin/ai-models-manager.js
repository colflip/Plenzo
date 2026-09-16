/**
 * AI 模型管理模块
 * @description 管理预设和自定义 AI 模型，支持切换和测试
 */

let presetModels = [];
let customModels = [];
let currentConfig = null;
let modelsCapabilities = {};

// 状态检测编排：缓存 + 并发去重 + 去抖（避免每次进任意 admin 页都并发打 /api/ai/check）
const STATUS_TTL = 5 * 60 * 1000; // 5 分钟内复用检测结果，不重复打 provider
const statusCache = new Map();      // key -> { ts, available, error }
const inFlightChecks = new Map();   // key -> Promise（并发去重）
let detectTimer = null;

const apiUtils = window.apiUtils;

// 合并表格后一个渠道可能占多行（一行一个端点），但渠道级的可用性状态只会渲染在
// 「没有端点」那一行上；记下这批 id，免得对没有状态单元格的渠道白打 /api/ai/check
const presetsWithStatusCell = new Set();

const REMOTE_LOAD_KEYS = ['current', 'presets', 'capabilities'];
const loadState = {
    custom: 'loading',
    current: 'loading',
    presets: 'loading',
    capabilities: 'loading'
};
const loadErrors = {
    custom: null,
    current: null,
    presets: null,
    capabilities: null
};

function renderLoadState() {
    const tbody = document.getElementById('aiModelsTableBody');
    if (!tbody) return;

    const failed = Object.entries(loadState).filter(([, state]) => state === 'error');
    if (failed.length > 0) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 6;
        const firstError = loadErrors[failed[0][0]];
        if (window.ErrorUI && typeof window.ErrorUI.createErrorState === 'function') {
            cell.appendChild(window.ErrorUI.createErrorState({
                title: 'AI 模型配置加载失败',
                error: firstError,
                compact: true,
                onRetry: loadRemoteModelData
            }));
        } else {
            cell.setAttribute('role', 'alert');
            cell.textContent = 'AI 模型配置加载失败，请重试。';
        }
        row.appendChild(cell);
        tbody.replaceChildren(row);
        return;
    }

    if (Object.values(loadState).some(state => state === 'loading')) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 6;
        cell.className = 'ai-models-loading';
        cell.setAttribute('role', 'status');
        cell.textContent = '正在加载 AI 模型配置…';
        row.appendChild(cell);
        tbody.replaceChildren(row);
        return;
    }

    renderModelsTable();
    renderCurrentBar();
}

async function loadRemoteModelData() {
    REMOTE_LOAD_KEYS.forEach(key => {
        loadState[key] = 'loading';
        loadErrors[key] = null;
    });
    loadCustomModels();
    renderLoadState();
    await Promise.allSettled([
        loadCurrentConfig(),
        loadPresetModels(),
        loadModelsCapabilities()
    ]);
    renderLoadState();
}

/**
 * 显示确认对话框
 */
function showConfirm(message, detail = '') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.5); z-index: 10000;
            backdrop-filter: blur(var(--overlay-blur, 4px));
            -webkit-backdrop-filter: blur(var(--overlay-blur, 4px));
            display: flex; align-items: center; justify-content: center;
        `;
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: white; border-radius: 12px; padding: 24px;
            max-width: 400px; box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        `;
        dialog.innerHTML = `
            <h3 style="margin:0 0 12px 0;font-size: var(--fs-500);color:#333;">${message}</h3>
            ${detail ? `<p style="margin:0 0 20px 0;font-size: var(--fs-300);color:#666;">${detail}</p>` : '<div style="height:8px;"></div>'}
            <div style="display:flex;gap:12px;justify-content:flex-end;">
                <button id="cancelBtn" style="padding:8px 20px;border:1px solid #ddd;background:white;border-radius:6px;cursor:pointer;font-size: var(--fs-300);">取消</button>
                <button id="confirmBtn" style="padding:8px 20px;border:none;background:#2ECC71;color:white;border-radius:6px;cursor:pointer;font-size: var(--fs-300);">确定</button>
            </div>
        `;
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        const remove = () => document.body.removeChild(overlay);
        dialog.querySelector('#confirmBtn').onclick = () => { remove(); resolve(true); };
        dialog.querySelector('#cancelBtn').onclick = () => { remove(); resolve(false); };
        overlay.onclick = (e) => { if (e.target === overlay) { remove(); resolve(false); } };
    });
}

/**
 * 初始化
 */
function initAIModelsManager() {
    loadRemoteModelData();
    bindEvents();
    // 端点树独立加载：端点接口不可用时只影响「端点」列，不该拖垮整个模型表格
    loadEndpoints();

    // 监听 AI 区块可见性：区块切到前台（showSection 加 active）时才触发状态检测，
    // 避免 dashboard/其他 admin 页加载时就并发打 /api/ai/check。
    const tbody = document.getElementById('aiModelsTableBody');
    const section = tbody ? tbody.closest('.dashboard-section') : null;
    if (section && typeof MutationObserver !== 'undefined') {
        const obs = new MutationObserver(() => {
            if (section.classList.contains('active')) detectAllModelStatuses();
        });
        obs.observe(section, { attributes: true, attributeFilter: ['class'] });
    }
}

/**
 * 加载当前 AI 配置
 */
async function loadCurrentConfig() {
    try {
        const data = await apiUtils.getSilent('/ai/config');
        if (!data || typeof data !== 'object') throw new Error('AI 配置响应格式无效');
        currentConfig = data;
        loadState.current = 'success';
        loadErrors.current = null;
        renderLoadState();
    } catch (error) {
        loadState.current = 'error';
        loadErrors.current = error;
        renderLoadState();
        console.error('加载当前 AI 配置失败:', error);
        throw error;
    }
}

/**
 * 加载系统预设模型
 */
async function loadPresetModels() {
    try {
        const data = await apiUtils.getSilent('/ai/presets');
        if (!data || typeof data !== 'object' || !Array.isArray(data.presets)) {
            throw new Error('预设模型响应格式无效');
        }
        presetModels = data.presets;
        loadState.presets = 'success';
        loadErrors.presets = null;
        renderLoadState();
    } catch (error) {
        loadState.presets = 'error';
        loadErrors.presets = error;
        renderLoadState();
        console.error('加载预设模型失败:', error);
        throw error;
    }
}

/**
 * 加载自定义模型列表
 */
function loadCustomModels() {
    const store = window.AICustomModelStore;
    if (!store) {
        // 存储模块没加载（脚本顺序被改动）时明确报错，而不是静默当成「没有自定义模型」
        customModels = [];
        loadState.custom = 'error';
        loadErrors.custom = new Error('本机存储模块未加载');
        return;
    }

    try {
        customModels = store.listModels();
        loadState.custom = 'success';
        loadErrors.custom = null;
    } catch (error) {
        customModels = [];
        loadState.custom = 'error';
        loadErrors.custom = error;
        console.error('加载自定义 AI 模型失败:', error);
    }
}

/**
 * 保存自定义模型列表
 */
function saveCustomModels() {
    window.AICustomModelStore.saveModels(customModels);
}

/**
 * 加载模型能力数据
 */
async function loadModelsCapabilities() {
    try {
        const data = await apiUtils.getSilent('/ai/models');
        if (!data || typeof data !== 'object' || !data.models || typeof data.models !== 'object') {
            throw new Error('模型能力响应格式无效');
        }
        modelsCapabilities = data.models;
        loadState.capabilities = 'success';
        loadErrors.capabilities = null;
        renderLoadState();
    } catch (error) {
        loadState.capabilities = 'error';
        loadErrors.capabilities = error;
        renderLoadState();
        console.error('加载模型能力数据失败:', error);
        throw error;
    }
}

/**
 * 查找模型能力
 */
function getModelCapabilities(modelId) {
    for (const [, models] of Object.entries(modelsCapabilities)) {
        const found = models.find(m => m.id === modelId);
        if (found) return found.capabilities;
    }
    return null;
}

/**
 * 是否为当前使用中的模型
 */
function isInUse(model) {
    // 自定义模型只被本人选中，与全局 currentConfig 无关；反过来，本机选中自定义模型时
    // 全局预设都不算「使用中」——否则界面同时高亮两个，用户看不出提问到底走的哪一个。
    const active = window.AICustomModelStore.getActive();
    if (model && model._type === 'custom') {
        return !!(active && active.kind === 'model' && active.ref === model.name);
    }
    if (active) return false;
    return !!(currentConfig &&
        currentConfig.provider === model.provider &&
        currentConfig.baseUrl === model.baseUrl);
}

/**
 * 渲染当前配置摘要栏
 */
function renderCurrentBar() {
    if (!currentConfig) return;
    const display = document.getElementById('currentModelDisplay');
    const status = document.getElementById('currentModelStatus');
    const active = window.AICustomModelStore.getActive();

    if (display) {
        if (active && active.kind === 'model') {
            display.textContent = `${active.ref} / （仅本机）`;
        } else {
            const matched = presetModels.find(p => p.provider === currentConfig.provider && p.baseUrl === currentConfig.baseUrl);
            const name = matched ? matched.name : (currentConfig.provider || '-');
            display.textContent = `${name} / ${currentConfig.model || '-'}`;
        }
    }
    if (status) {
        if (active) {
            status.textContent = '本机自定义';
            status.className = 'ai-current-status active';
        } else if (currentConfig.enabled && currentConfig.apiKey) {
            status.textContent = '已启用';
            status.className = 'ai-current-status active';
        } else {
            status.textContent = '未配置';
            status.className = 'ai-current-status inactive';
        }
    }
    // 详细信息标签：选中本机自定义模型时，展示的是那份配置，不是全局 ai_config
    const shown = (active && active.kind === 'model')
        ? window.AICustomModelStore.configFromModel(customModels.find(m => m.name === active.ref) || {})
        : currentConfig;
    const setTag = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    setTag('currentProtocol', `协议：${shown.protocol || '-'}`);
    setTag('currentBaseUrl', `地址：${shown.baseUrl || '-'}`);
    setTag('currentTimeout', `超时：${shown.timeout || 30000}ms`);
    setTag('currentMaxTokens', `Token：${shown.maxTokens || 8000}`);
}

/**
 * 渲染统一模型表格：渠道 → 端点 → 模型 三层整合在同一张表
 * @description
 *  一行一个端点，渠道自己的默认模型补在该渠道最后一行的「模型 ID」里（标「默认」），
 *  所以渠道默认模型不再单独占一行 —— 它在端点树里往往已经被某个端点挂载，单列会重复。
 *  自定义模型没有端点概念，直接作为顶层行。
 */
function renderModelsTable() {
    const tbody = document.getElementById('aiModelsTableBody');
    if (!tbody) return;
    if (Object.values(loadState).some(state => state !== 'success')) {
        renderLoadState();
        return;
    }

    if (!presetModels.length && !customModels.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;padding:40px 20px;">暂无模型，请在环境变量中配置预设模型或添加自定义模型</td></tr>';
        return;
    }

    const esc = (v) => window.SecurityUtils ? window.SecurityUtils.escapeHtml(String(v ?? '')) : String(v ?? '');
    const rows = [];

    // 端点接口还没回来时不要先渲染成「无端点」，否则会闪一下空态
    const epHint = endpointsState === 'success' ? null
        : (endpointsState === 'loading' ? '端点加载中…' : '端点加载失败');

    presetsWithStatusCell.clear();

    for (const preset of presetModels) {
        const channel = epHint ? null : endpointChannels.find(c => c.channelId === preset.id);
        const endpoints = (channel && channel.endpoints) || [];
        const model = { ...preset, _type: 'preset' };

        if (!endpoints.length) {
            // 只有这一行带渠道级可用性状态；有端点的渠道状态列归端点所有
            presetsWithStatusCell.add(preset.id);
            rows.push(renderChannelRow(model, null, esc, true, epHint));
            continue;
        }
        endpoints.forEach((ep, i) => {
            const isFirst = i === 0;
            const isLast = i === endpoints.length - 1;
            rows.push(renderChannelRow(model, ep, esc, isLast, epHint, isFirst));
        });
    }

    // 本机端点：不属于任何服务端渠道，单独成一组。
    // 没有「渠道默认模型」的概念，所以 showDefaultModel 一律 false。
    const localGroup = endpointChannels.find(c => c.channelId === LOCAL_CHANNEL_ID);
    if (localGroup && localGroup.endpoints.length) {
        const pseudo = { name: LOCAL_CHANNEL_NAME, id: LOCAL_CHANNEL_ID, model: '', protocol: '-', _type: 'local' };
        localGroup.endpoints.forEach((ep, i) => {
            rows.push(renderChannelRow(pseudo, ep, esc, false, null, i === 0));
        });
    }

    customModels.forEach((custom, index) => {
        const model = { ...custom, _type: 'custom', _index: index };
        const inUse = isInUse(model);
        const statusAttr = `data-custom-index="${index}"`;
        const actionsHtml = `<button class="ai-btn ai-btn-switch" data-custom-index="${index}" ${inUse ? 'disabled' : ''}>${inUse ? '使用中' : '切换'}</button>
               <button class="ai-btn ai-btn-test" data-custom-index="${index}">测试</button>
               <button class="ai-btn ai-btn-edit" data-custom-index="${index}">编辑</button>
               <button class="ai-btn ai-btn-delete" data-custom-index="${index}">删除</button>`;

        rows.push(`<tr class="ai-row-model">
            <td>
                <span class="ai-model-name">${esc(model.name)}</span>
                <span class="ai-model-source custom">自定义</span>
            </td>
            <td><span class="ai-ep-none">无端点</span></td>
            <td><span class="ai-protocol-tag">${esc(model.protocol)}</span></td>
            <td><div class="ai-caps">${renderCapsTags(getModelCapabilities(model.model))}</div></td>
            <td><span class="ai-status ${inUse ? 'in-use' : 'checking'}" ${statusAttr}><span class="ai-status-dot"></span>${inUse ? '使用中' : '检测中...'}</span></td>
            <td><div class="ai-actions">${actionsHtml}</div></td>
        </tr>`);
    });

    tbody.innerHTML = rows.join('');

    // 仅在 AI 区块可见时检测模型状态（去抖/缓存由 detectAllModelStatuses 统一处理）
    detectAllModelStatuses();
}

/**
 * 渲染一个渠道的某一行。
 * @param {Object} model - 渠道预设（含 _type: 'preset'）
 * @param {Object|null} ep - 该行的端点；null 表示该渠道还没有端点，退化成「渠道行」
 * @param {Function} esc - HTML 转义
 * @param {boolean} [showDefaultModel] - 是否在本行补出渠道默认模型（该渠道最后一行）
 * @param {string|null} [epHint] - 端点接口未就绪时的占位文案（加载中/加载失败）
 */
function renderChannelRow(model, ep, esc, showDefaultModel = true, epHint = null, isFirst = true) {
    const inUse = isInUse(model);
    const statusAttr = `data-preset-id="${esc(model.id)}"`;

    // 渠道级「切换 / 测试」只在该渠道最后一行出现一次：渠道级测试打的是默认模型，
    // 与端点级测试不是同一回事，**不能**让端点行也带测试 —— 否则同一行会出现两个测试按钮。
    const channelActions = showDefaultModel
        ? `<button class="ai-btn ai-btn-switch" data-preset-id="${esc(model.id)}" ${inUse ? 'disabled' : ''}>${inUse ? '使用中' : '切换'}</button>
               <button class="ai-btn ai-btn-test" data-preset-id="${esc(model.id)}">测试</button>`
        : '';

    let endpointCell;
    let modelsHtml;
    let protocol;
    let capsHtml;
    let statusHtml;
    let actionsHtml;

    if (ep) {
        // 当前端点 = 渠道 inUse 且该端点挂载了 currentConfig.model；
        // 用于把状态从「所有端点都启用」区分出「当前生效 vs 候选 vs 停用」。
        const isCurrent = inUse && Array.isArray(ep.models)
            && ep.models.some(m => m.id === (currentConfig && currentConfig.model));

        // 完整 URL 塞 title，行内只显示去掉协议头的紧凑形式，避免每行挤下一长串字符
        const shortUrl = (ep.baseUrl || '').replace(/^https?:\/\//, '');

        // 模型 tag：每行一个，name + 上下文/输出/视觉/工具 的紧凑简写
        const modelTags = ep.models.map(m => {
            const ctx = formatTokenCount(m.contextLength);
            const out = formatTokenCount(m.maxOutput);
            const cBits = [];
            const caps = m.capabilities || {};
            if (caps.vision) cBits.push('视');
            if (caps.tools) cBits.push('工');
            const spec = [ctx, out].filter(Boolean).join('/');
            const tail = [spec, cBits.join('/')].filter(Boolean).join(' ');
            // 本机端点：每个模型给一个「使用」，用它=把这份配置设为本机生效配置
            const useBtn = ep.source === 'local'
                ? ` <button class="ai-btn ai-btn-use" data-ep-activate="${esc(ep.id)}" data-ep-model="${esc(m.id)}">使用</button>`
                : '';
            return `<span class="ai-ep-model" title="${esc(m.id)} · ${esc(modelCapSummary(m))}">` +
                `${esc(m.name)}${tail ? ` <span class="ai-ep-model-spec">${esc(tail)}</span>` : ''}` +
                `${useBtn}</span>`;
        });
        if (showDefaultModel && model.model && !ep.models.some(m => m.id === model.model)) {
            modelTags.push(`<span class="ai-ep-model ai-ep-model-default">${esc(model.model)} <span class="ai-ep-model-spec">(默认)</span></span>`);
        }
        modelsHtml = modelTags.length ? modelTags.join('') : '<span class="ai-ep-none">未挂载模型</span>';

        // 端点 cell：短地址 + 模型清单（端点名称与来源徽标已按需求去掉）
        endpointCell = `<div class="ai-ep-url" title="${esc(ep.baseUrl)}">${esc(shortUrl)}</div>` +
            `<div class="ai-ep-models">${modelsHtml}</div>`;

        protocol = ep.protocol || '-';
        // 端点挂多个模型时能力各异，取并集：这一列回答「这个端点能做什么」
        capsHtml = renderCapsTags(unionCapabilities(ep.models));

        // 状态三态：当前端点「已启用」、其他可用端点「准备」、停用端点「停用」。
        // 这样多个端点同时挂着时，状态列不再全显示「已启用」。
        const statusClass = isCurrent ? 'in-use' : (ep.enabled ? 'ready' : 'off');
        const statusText = isCurrent ? '已启用' : (ep.enabled ? '准备' : '停用');
        statusHtml = `<span class="ai-status ${statusClass}"><span class="ai-status-dot"></span>${statusText}</span>`;

        // 端点行操作：去掉「测试」按钮，避免与渠道行的测试重复。
        // 想测端点连通性请用「编辑」旁边的 test 端点接口，或在端点详情中触发。
        actionsHtml = `<button class="ai-btn ai-btn-edit" data-ep-edit="${esc(ep.id)}">编辑</button>
               <button class="ai-btn" data-ep-toggle="${esc(ep.id)}">${ep.enabled ? '停用' : '启用'}</button>
               ${ep.editable ? `<button class="ai-btn ai-btn-delete" data-ep-del="${esc(ep.id)}">删除</button>` : ''}`;
    } else {
        endpointCell = `<span class="ai-ep-none">${esc(epHint || '无端点')}</span>`;
        modelsHtml = `<span class="ai-ep-model">${esc(model.model)}<span class="ai-ep-model-spec">(默认)</span></span>`;
        protocol = model.protocol;
        capsHtml = renderCapsTags(getModelCapabilities(model.model));
        statusHtml = `<span class="ai-status ${inUse ? 'in-use' : 'checking'}" ${statusAttr}><span class="ai-status-dot"></span>${inUse ? '使用中' : '检测中...'}</span>`;
        actionsHtml = '';
    }

    // 模型服务商列：只在每个渠道的第一行渲染，后续端点行留空（视觉上像 rowspan 合并），
    // 避免每个端点行都重复一遍「渠道名 + 预设」徽标浪费空间。
    const channelCell = isFirst
        ? `<span class="ai-model-name">${esc(model.name)}</span><span class="ai-model-source preset">预设</span>`
        : '';

    return `<tr class="ai-row-endpoint${ep && !ep.enabled ? ' disabled' : ''}">
        <td>${channelCell}</td>
        <td>${endpointCell}</td>
        <td><span class="ai-protocol-tag">${esc(protocol)}</span></td>
        <td><div class="ai-caps">${capsHtml}</div></td>
        <td>${statusHtml}</td>
        <td><div class="ai-actions">${actionsHtml}${channelActions}</div></td>
    </tr>`;
}

/**
 * 渲染能力标签
 */
function renderCapsTags(caps) {
    if (!caps) return '<span style="color:#cbd5e1;font-size: var(--fs-300);">-</span>';
    const tags = [];
    if (caps.vision) tags.push('<span class="ai-cap-tag vision">视觉</span>');
    if (caps.tools) tags.push('<span class="ai-cap-tag tools">工具</span>');
    if (caps.reasoning) tags.push('<span class="ai-cap-tag reasoning">推理</span>');
    return tags.length ? tags.join('') : '<span style="color:#cbd5e1;font-size: var(--fs-300);">-</span>';
}

/**
 * 汇总一组模型的能力并集（端点行用）
 */
function unionCapabilities(models) {
    const union = { vision: false, tools: false, reasoning: false };
    let any = false;
    for (const m of models || []) {
        const caps = (m.capabilities) || getModelCapabilities(m.id || m.name);
        if (!caps) continue;
        any = true;
        union.vision = union.vision || !!caps.vision;
        union.tools = union.tools || !!caps.tools;
        union.reasoning = union.reasoning || !!caps.reasoning;
    }
    return any ? union : null;
}

/**
 * 应用模型状态到 DOM（供检测函数与缓存复用）
 */
function applyStatus(ref, status) {
    const sel = ref._type === 'preset'
        ? `.ai-status[data-preset-id="${ref.id}"]`
        : `.ai-status[data-custom-index="${ref._index}"]`;
    const statusEl = document.querySelector(sel);
    if (!statusEl) return;
    if (status.available) {
        statusEl.className = 'ai-status available';
        statusEl.innerHTML = '<span class="ai-status-dot"></span>可用';
    } else {
        statusEl.className = 'ai-status unavailable';
        statusEl.innerHTML = '<span class="ai-status-dot"></span>不可用';
        statusEl.title = status.error || '无法连接';
    }
}

/**
 * 检测预设模型状态（仅返回结果，DOM 由 applyStatus 统一处理）
 */
async function checkPresetStatus(preset) {
    const ref = { _type: 'preset', id: preset.id };
    try {
        const result = await apiUtils.post('/ai/check', {
            presetId: preset.id,
            provider: preset.provider,
            protocol: preset.protocol,
            baseUrl: preset.baseUrl,
            model: preset.model
        }, { suppressErrorToast: true });
        const status = { available: !!result.available, error: result.error || '无法连接' };
        applyStatus(ref, status);
        return status;
    } catch (error) {
        const status = { available: false, error: error.message };
        applyStatus(ref, status);
        return status;
    }
}

/**
 * 检测自定义模型状态（仅返回结果，DOM 由 applyStatus 统一处理）
 */
async function checkCustomStatus(custom, index) {
    const ref = { _type: 'custom', _index: index };
    try {
        const result = await apiUtils.post('/ai/check', {
            provider: custom.provider,
            protocol: custom.protocol,
            apiKey: custom.apiKey,
            baseUrl: custom.baseUrl,
            model: custom.model
        }, { suppressErrorToast: true });
        const status = { available: !!result.available, error: result.error || '无法连接' };
        applyStatus(ref, status);
        return status;
    } catch (error) {
        const status = { available: false, error: error.message };
        applyStatus(ref, status);
        return status;
    }
}

/**
 * 状态检测编排：去抖 + 缓存 + 并发去重 + 仅 AI 区块可见时触发
 * 解决「每次进入任意 admin 页都并发打 /api/ai/check → 上游 429 / 8s 超时」的问题。
 */
function modelStatusKey(model) {
    return [model._type, model.provider, model.baseUrl, model.model, model.protocol].join('|');
}

function isAiTableVisible() {
    const tbody = document.getElementById('aiModelsTableBody');
    return !!(tbody && tbody.offsetParent !== null);
}

function collectAllModels() {
    return [
        ...presetModels
            .filter(p => presetsWithStatusCell.has(p.id))
            .map(p => ({ ...p, _type: 'preset' })),
        ...customModels.map((c, i) => ({ ...c, _type: 'custom', _index: i }))
    ];
}

function detectAllModelStatuses() {
    if (!isAiTableVisible()) return;
    clearTimeout(detectTimer);
    detectTimer = setTimeout(() => {
        if (!isAiTableVisible()) return;
        collectAllModels().forEach(model => {
            if (isInUse(model)) return;
            const key = modelStatusKey(model);
            const cached = statusCache.get(key);
            if (cached && (Date.now() - cached.ts) < STATUS_TTL) {
                applyStatus(model, cached);
                return;
            }
            if (inFlightChecks.has(key)) return; // 并发去重：同一模型不重复打
            const p = (model._type === 'preset' ? checkPresetStatus(model) : checkCustomStatus(model, model._index))
                .then(status => { if (status) statusCache.set(key, { ts: Date.now(), ...status }); })
                .finally(() => inFlightChecks.delete(key));
            inFlightChecks.set(key, p);
        });
    }, 500);
}

/**
 * 绑定事件
 */
function bindEvents() {
    document.getElementById('addAIModelBtn').addEventListener('click', () => openAIModelForm('add'));
    document.getElementById('closeAIModelFormBtn').addEventListener('click', closeAIModelForm);
    document.getElementById('cancelAIModelFormBtn').addEventListener('click', closeAIModelForm);
    document.getElementById('aiModelForm').addEventListener('submit', handleAIModelFormSubmit);

    // 表格事件委托：模型与端点两类行共用同一个 tbody，按 data-* 前缀分流
    document.getElementById('aiModelsTableBody').addEventListener('click', (e) => {
        const epEdit = e.target.closest('[data-ep-edit]');
        const epTest = e.target.closest('[data-ep-test]');
        const epToggle = e.target.closest('[data-ep-toggle]');
        const epDel = e.target.closest('[data-ep-del]');
        const epActivate = e.target.closest('[data-ep-activate]');
        const switchBtn = e.target.closest('.ai-btn-switch');
        const testBtn = e.target.closest('.ai-btn-test');
        const editBtn = e.target.closest('.ai-btn-edit');
        const deleteBtn = e.target.closest('.ai-btn-delete');

        // 端点按钮先判：它们也带 .ai-btn-* 类，但 data-* 前缀不同
        if (epActivate) activateLocalEndpoint(epActivate.dataset.epActivate, epActivate.dataset.epModel);
        else if (epEdit) openEndpointForm('edit', epEdit.dataset.epEdit);
        else if (epTest) testEndpoint(epTest.dataset.epTest, epTest);
        else if (epToggle) toggleEndpoint(epToggle.dataset.epToggle);
        else if (epDel) deleteEndpoint(epDel.dataset.epDel);
        else if (switchBtn) {
            if (switchBtn.dataset.presetId) switchToPreset(switchBtn.dataset.presetId);
            else switchToCustom(parseInt(switchBtn.dataset.customIndex));
        } else if (testBtn) {
            if (testBtn.dataset.presetId) testPreset(testBtn.dataset.presetId, testBtn);
            else testCustom(parseInt(testBtn.dataset.customIndex), testBtn);
        } else if (editBtn) {
            openAIModelForm('edit', parseInt(editBtn.dataset.customIndex));
        } else if (deleteBtn) {
            deleteCustomModel(parseInt(deleteBtn.dataset.customIndex));
        }
    });

    // 端点表单（新增端点按钮在页面右上角操作区）
    bindEndpointEvents();
}

/**
 * 打开 AI 模型表单
 */
function openAIModelForm(mode, index = null) {
    const form = document.getElementById('aiModelForm');
    const title = document.getElementById('aiModelFormTitle');
    const container = document.getElementById('aiModelFormContainer');
    form.dataset.mode = mode;

    if (mode === 'add') {
        title.textContent = '添加自定义 AI 模型';
        form.reset();
        form.dataset.id = '';
    } else if (mode === 'edit' && index !== null) {
        title.textContent = '编辑自定义 AI 模型';
        const model = customModels[index];
        form.dataset.id = index;
        document.getElementById('aiModelName').value = model.name;
        document.getElementById('aiModelProvider').value = model.provider;
        document.getElementById('aiModelProtocol').value = model.protocol;
        document.getElementById('aiModelApiKey').value = model.apiKey || '';
        document.getElementById('aiModelBaseUrl').value = model.baseUrl;
        document.getElementById('aiModelModelName').value = model.model;
        document.getElementById('aiModelTimeout').value = model.timeout || 30000;
        document.getElementById('aiModelMaxTokens').value = model.maxTokens || 8000;
    }
    container.style.display = 'block';
}

/**
 * 关闭 AI 模型表单
 */
function closeAIModelForm() {
    document.getElementById('aiModelFormContainer').style.display = 'none';
}

/**
 * 处理表单提交
 */
function handleAIModelFormSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const mode = form.dataset.mode;
    const modelData = {
        name: document.getElementById('aiModelName').value.trim(),
        provider: document.getElementById('aiModelProvider').value.trim(),
        protocol: document.getElementById('aiModelProtocol').value,
        apiKey: document.getElementById('aiModelApiKey').value.trim(),
        baseUrl: document.getElementById('aiModelBaseUrl').value.trim(),
        model: document.getElementById('aiModelModelName').value.trim(),
        timeout: parseInt(document.getElementById('aiModelTimeout').value),
        maxTokens: parseInt(document.getElementById('aiModelMaxTokens').value)
    };

    if (mode === 'add') {
        customModels.push(modelData);
        apiUtils.showToast('自定义模型添加成功！', 'success');
    } else if (mode === 'edit') {
        customModels[parseInt(form.dataset.id)] = modelData;
        apiUtils.showToast('自定义模型更新成功！', 'success');
    }

    saveCustomModels();
    renderModelsTable();
    closeAIModelForm();
}

/**
 * 切换到预设模型（写全局 ai_config，对所有人生效）
 * @description 与自定义模型不同，预设来自服务端 env，切换它就是改全局配置。
 *              同时清掉本机自定义模型的选中态，否则用户以为切回了预设、
 *              实际提问还在用自己的自定义模型。
 */
async function switchToPreset(presetId) {
    const preset = presetModels.find(p => p.id === presetId);
    if (!preset) return;
    if (!await showConfirm(`确定要切换到"${preset.name}"吗？`, '切换后立即生效')) return;
    try {
        await apiUtils.put('/ai/config', {
            presetId: preset.id,
            provider: preset.provider,
            protocol: preset.protocol,
            baseUrl: preset.baseUrl,
            model: preset.model,
            timeout: preset.timeout || 30000,
            maxTokens: preset.maxTokens || 3000
        }, { suppressErrorToast: true });
        window.AICustomModelStore.clearActive();
        apiUtils.showToast('配置已更新并立即生效！', 'success');
        await loadCurrentConfig();
        renderModelsTable();
    } catch (error) {
        apiUtils.showToast('切换失败：' + error.message, 'error');
    }
}

/**
 * 切换到自定义模型（只在本机生效）
 * @description 自定义模型只存在本机 localStorage，**不写全局 ai_config** ——
 *              写全局等于把「我自己加的模型」推给所有人用，那不是个人自定义。
 *              选中态记在本机，提问时由前端作为 customConfig 随请求带上。
 */
async function switchToCustom(index) {
    const custom = customModels[index];
    if (!custom) return;
    if (!await showConfirm(`确定要切换到"${custom.name}"吗？`, '只在你自己的浏览器生效，不影响其他人')) return;

    if (!custom.baseUrl || !custom.apiKey || !custom.model) {
        apiUtils.showToast('该模型缺少地址 / 密钥 / 模型名，请先编辑补全', 'error');
        return;
    }

    window.AICustomModelStore.setActive({ kind: 'model', ref: custom.name });
    apiUtils.showToast(`已切换到 ${custom.name}（仅本机生效）`, 'success');
    await loadCurrentConfig();
    renderModelsTable();
}

/**
 * 启用本机端点上的某个模型（只在本机生效）
 * @description 与 switchToCustom 同一套机制：只记本机选中态，不写全局 ai_config。
 */
async function activateLocalEndpoint(endpointId, modelId) {
    const endpoint = window.AICustomModelStore.listEndpoints().find(e => String(e.id) === String(endpointId));
    if (!endpoint) { apiUtils.showToast('端点不存在', 'error'); return; }
    if (!endpoint.baseUrl || !endpoint.apiKey) {
        apiUtils.showToast('该端点缺少地址或密钥，请先编辑补全', 'error');
        return;
    }

    const name = endpoint.label || endpoint.baseUrl.replace(/^https?:\/\//, '');
    if (!await showConfirm(`确定要使用"${modelId}"吗？`, `${name} · 只在你自己的浏览器生效`)) return;

    window.AICustomModelStore.setActive({ kind: 'endpoint', ref: endpoint.id, model: modelId });
    apiUtils.showToast(`已切换到 ${modelId}（仅本机生效）`, 'success');
    await loadCurrentConfig();
    renderModelsTable();
}

/**
 * 测试预设模型
 */
async function testPreset(presetId, btn) {
    const preset = presetModels.find(p => p.id === presetId);
    if (!preset) return;
    btn = btn || document.querySelector(`[data-preset-id="${presetId}"]`);
    btn.disabled = true;
    btn.textContent = '测试中...';
    try {
        const result = await apiUtils.post('/ai/test', {
            presetId: preset.id,
            provider: preset.provider,
            protocol: preset.protocol,
            baseUrl: preset.baseUrl,
            model: preset.model,
            timeout: preset.timeout || 30000,
            maxTokens: preset.maxTokens || 1000
        }, { suppressErrorToast: true });
        if (!result || !Number.isFinite(Number(result.latency))) {
            throw new Error('模型测试响应格式无效');
        }
        apiUtils.showToast(`测试成功！响应时间：${result.latency}ms`, 'success');
    } catch (error) {
        apiUtils.showToast('测试失败：' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '测试';
    }
}

/**
 * 测试自定义模型
 */
async function testCustom(index, btn) {
    const custom = customModels[index];
    if (!custom) return;
    btn.disabled = true;
    btn.textContent = '测试中...';
    try {
        const result = await apiUtils.post('/ai/test', custom, {
            suppressErrorToast: true
        });
        if (!result || !Number.isFinite(Number(result.latency))) {
            throw new Error('模型测试响应格式无效');
        }
        apiUtils.showToast(`测试成功！响应时间：${result.latency}ms`, 'success');
    } catch (error) {
        apiUtils.showToast('测试失败：' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '测试';
    }
}

/**
 * 删除自定义模型
 */
async function deleteCustomModel(index) {
    const model = customModels[index];
    if (!await showConfirm(`确定要删除"${model.name}"吗？`, '此操作无法撤销')) return;
    customModels.splice(index, 1);
    saveCustomModels();
    renderModelsTable();
    apiUtils.showToast('删除成功！', 'success');
}

/* ===========================================
   本机端点：只在当前浏览器存在，不进服务端数据库
   -------------------------------------------
   端点决定「请求发往哪个地址、带哪把密钥」，属于个人自定义——加一个端点
   不应该成为所有人的基础设施变更，所以不再落 ai_channel_endpoints 表，
   改存 localStorage（见 utils/ai-custom-model-store.js）。
   选中某个端点上的模型后，提问时由前端把该配置作为 customConfig 发给 /api/ai/query。

   端点数据并入模型表格渲染（单独成一组），这里只负责取数与表单。
   =========================================== */

// 本机端点不属于任何服务端渠道，用一个固定的伪渠道承载，复用表格渲染
const LOCAL_CHANNEL_ID = '__local__';
const LOCAL_CHANNEL_NAME = '本机端点';

let endpointChannels = [];

// 'loading' 只出现在首屏读 localStorage 之前；本机读取不会失败
let endpointsState = 'loading'; // loading | success | error

/** token 数量格式化：524288 → 512K，1048576 → 1M */
function formatTokenCount(n) {
    if (!n || !Number.isFinite(Number(n))) return '-';
    const v = Number(n);
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1024) return Math.round(v / 1024) + 'K';
    return String(v);
}

/** 模型能力摘要：上下文 / 最大输出 / 视觉 / 工具 */
function renderModelCapHint(m) {
    const parts = [];
    if (m.contextLength) parts.push(formatTokenCount(m.contextLength) + ' 上下文');
    if (m.maxOutput) parts.push(formatTokenCount(m.maxOutput) + ' 输出');
    if (m.capabilities && m.capabilities.vision) parts.push('视觉');
    if (m.capabilities && m.capabilities.tools) parts.push('工具');
    return parts.length ? '<span class="ai-ep-model-caps">(' + parts.join(' · ') + ')</span>' : '';
}

/**
 * 模型能力摘要（纯文本，供 title 悬浮说明）。
 * 不能复用 ai-assistant-redesign.js 里的同名函数 —— 那是模块私有作用域，
 * 经典脚本里拿不到，直接调用会在渲染端点行时抛 ReferenceError，
 * 让「端点」列永久停在「端点加载中…」。
 */
function modelCapSummary(m) {
    const parts = [];
    if (m.contextLength) parts.push('上下文 ' + formatTokenCount(m.contextLength));
    if (m.maxOutput) parts.push('最大输出 ' + formatTokenCount(m.maxOutput));
    const caps = m.capabilities || {};
    parts.push('视觉 ' + (caps.vision ? '支持' : '不支持'));
    parts.push('工具 ' + (caps.tools ? '支持' : '不支持'));
    return parts.join(' · ');
}

/** 本机端点 → 表格渲染所需的渠道分组形态（模型名补上本地能力表里的元信息） */
function localEndpointsAsChannels() {
    const endpoints = window.AICustomModelStore.listEndpoints().map(e => ({
        id: e.id,
        label: e.label || '',
        baseUrl: e.baseUrl,
        protocol: e.protocol || 'openai',
        timeout: e.timeout ?? null,
        maxTokens: e.maxTokens ?? null,
        enabled: e.enabled !== false,
        extraParams: e.extraParams || {},
        editable: true,
        source: 'local',
        hasOwnKey: !!e.apiKey,
        models: (e.models || []).map(id => ({
            id,
            name: id,
            capabilities: getModelCapabilities(id) || undefined
        }))
    }));
    if (!endpoints.length) return [];
    return [{ channelId: LOCAL_CHANNEL_ID, channelName: LOCAL_CHANNEL_NAME, endpoints }];
}

function loadEndpoints() {
    try {
        endpointChannels = localEndpointsAsChannels();
        endpointsState = 'success';
    } catch (error) {
        endpointChannels = [];
        endpointsState = 'error';
        console.error('加载本机端点失败:', error);
    }
    renderModelsTable();
}

function openEndpointForm(mode, id = null) {
    const container = document.getElementById('aiEndpointFormContainer');
    const form = document.getElementById('aiEndpointForm');
    const title = document.getElementById('aiEndpointFormTitle');
    if (!container || !form) return;

    form.dataset.mode = mode;
    form.dataset.id = id === null ? '' : String(id);

    const set = (elId, v) => { const el = document.getElementById(elId); if (el) el.value = v ?? ''; };

    if (mode === 'edit' && id !== null) {
        const found = window.AICustomModelStore.listEndpoints().find(e => String(e.id) === String(id));
        if (!found) { apiUtils.showToast('端点不存在', 'error'); return; }
        title.textContent = '编辑端点';
        set('aiEpChannel', found.channel || '');
        set('aiEpLabel', found.label);
        set('aiEpBaseUrl', found.baseUrl);
        set('aiEpApiKey', '');          // 密钥不回显，留空 = 保持原值
        set('aiEpModels', (found.models || []).join(','));
        set('aiEpTimeout', found.timeout ?? '');
        set('aiEpMaxTokens', found.maxTokens ?? '');
        set('aiEpPriority', 100);
        set('aiEpParams', Object.keys(found.extraParams || {}).length ? JSON.stringify(found.extraParams) : '');
        const enabledEl = document.getElementById('aiEpEnabled');
        if (enabledEl) enabledEl.checked = found.enabled !== false;
    } else {
        title.textContent = '新增端点';
        set('aiEpChannel', '');
        set('aiEpLabel', '');
        set('aiEpBaseUrl', '');
        set('aiEpApiKey', '');
        set('aiEpModels', '');
        set('aiEpTimeout', '');
        set('aiEpMaxTokens', '');
        set('aiEpPriority', 100);
        set('aiEpParams', '');
        const enabledEl = document.getElementById('aiEpEnabled');
        if (enabledEl) enabledEl.checked = true;
    }

    container.style.display = 'block';
}

function closeEndpointForm() {
    const container = document.getElementById('aiEndpointFormContainer');
    if (container) container.style.display = 'none';
}

function handleEndpointFormSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const mode = form.dataset.mode;
    const id = form.dataset.id || null;

    const val = (elId) => { const el = document.getElementById(elId); return el ? el.value.trim() : ''; };

    const baseUrl = val('aiEpBaseUrl');
    if (!/^https?:\/\//i.test(baseUrl)) {
        apiUtils.showToast('服务地址必须是 http/https 开头的公网地址', 'error');
        return;
    }

    const list = window.AICustomModelStore.listEndpoints();
    const existing = (mode === 'edit' && id)
        ? list.find(x => String(x.id) === String(id))
        : null;
    if (mode === 'edit' && !existing) { apiUtils.showToast('端点不存在', 'error'); return; }

    // 密钥：编辑时留空 = 保持原值（不回显，也不清空）
    const key = val('aiEpApiKey');
    const apiKey = key || (existing ? existing.apiKey : '');
    if (!apiKey) {
        apiUtils.showToast('请填写密钥；地址会由服务端代你请求，需要凭证', 'error');
        return;
    }

    const record = {
        id: existing ? existing.id : window.AICustomModelStore.nextEndpointId(),
        channel: val('aiEpChannel'),
        label: val('aiEpLabel'),
        baseUrl,
        apiKey,
        models: val('aiEpModels') ? val('aiEpModels').split(',').map(s => s.trim()).filter(Boolean) : [],
        protocol: existing ? existing.protocol : 'openai',
        timeout: val('aiEpTimeout') ? Number(val('aiEpTimeout')) : null,
        maxTokens: val('aiEpMaxTokens') ? Number(val('aiEpMaxTokens')) : null,
        enabled: (() => { const el = document.getElementById('aiEpEnabled'); return el ? el.checked : true; })(),
        extraParams: existing ? (existing.extraParams || {}) : {}
    };

    const paramsRaw = val('aiEpParams');
    if (paramsRaw) {
        try {
            const parsed = JSON.parse(paramsRaw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是对象');
            record.extraParams = parsed;
        } catch (err) {
            apiUtils.showToast('自定义参数不是合法 JSON 对象', 'error');
            return;
        }
    }

    if (existing) list[list.indexOf(existing)] = record;
    else list.push(record);

    window.AICustomModelStore.saveEndpoints(list);
    apiUtils.showToast('端点已保存（仅本机生效）', 'success');
    closeEndpointForm();
    loadEndpoints();
}

function toggleEndpoint(id) {
    const list = window.AICustomModelStore.listEndpoints();
    const target = list.find(e => String(e.id) === String(id));
    if (!target) return;
    target.enabled = target.enabled === false;
    window.AICustomModelStore.saveEndpoints(list);
    apiUtils.showToast(target.enabled ? '已启用' : '已停用', 'success');
    loadEndpoints();
}

async function deleteEndpoint(id) {
    if (!await showConfirm('确定要删除该端点吗？', '只影响你自己的浏览器，此操作无法撤销')) return;
    const list = window.AICustomModelStore.listEndpoints().filter(e => String(e.id) !== String(id));
    window.AICustomModelStore.saveEndpoints(list);
    apiUtils.showToast('删除成功！', 'success');
    loadEndpoints();
}

async function testEndpoint(id, btn) {
    const endpoint = window.AICustomModelStore.listEndpoints().find(e => String(e.id) === String(id));
    if (!endpoint) { apiUtils.showToast('端点不存在', 'error'); return; }
    if (!endpoint.models || !endpoint.models.length) {
        apiUtils.showToast('该端点未填写任何模型，无法测试', 'error');
        return;
    }

    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '测试中...';
    try {
        // 本机端点不在服务端注册表里，走通用 /ai/test（它收完整配置），
        // 由服务端做出站地址护栏校验后真实打一次上游。
        const result = await apiUtils.post('/ai/test', {
            provider: 'custom',
            protocol: endpoint.protocol || 'openai',
            apiKey: endpoint.apiKey,
            baseUrl: endpoint.baseUrl,
            model: endpoint.models[0],
            timeout: endpoint.timeout || 30000
        });
        if (result && Number.isFinite(Number(result.latency))) {
            apiUtils.showToast('测试成功！响应时间：' + result.latency + 'ms', 'success');
        } else {
            apiUtils.showToast('测试失败：' + ((result && result.error) || '端点不可用'), 'error');
        }
    } catch (error) {
        apiUtils.showToast('测试失败：' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = old;
    }
}

function bindEndpointEvents() {
    const addBtn = document.getElementById('addEndpointBtn');
    if (addBtn) addBtn.addEventListener('click', () => openEndpointForm('add'));

    const closeBtn = document.getElementById('closeAIEndpointFormBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeEndpointForm);

    const cancelBtn = document.getElementById('cancelAIEndpointFormBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', closeEndpointForm);

    const form = document.getElementById('aiEndpointForm');
    if (form) form.addEventListener('submit', handleEndpointFormSubmit);
}

// 导出初始化函数
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initAIModelsManager };
}
