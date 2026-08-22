/**
 * AI 模型管理模块
 * @description 管理预设和自定义 AI 模型，支持切换和测试
 */

let presetModels = [];
let customModels = [];
let currentConfig = null;
let modelsCapabilities = {};

const apiUtils = new ApiUtils();

function escapeHtml(str) {
    if (str == null) return '';
    if (typeof str !== 'string') str = String(str);
    const map = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
    return str.replace(/[&<>"']/g, c => map[c]);
}

/** fetch wrapper — 自动处理 401 未授权（token 过期）跳转登录页 */
async function fetchWithAuth(url, options = {}) {
    const headers = { ...apiUtils.getHeaders(), ...(options.headers || {}) };
    const resp = await fetch(url, { ...options, headers });
    if (resp.status === 401) {
        const path = window.location.pathname || '';
        const onDashboard = /\/(admin|teacher|student)(\/|$)/.test(path);
        const onLogin = path.endsWith('/index.html') || path === '/' || path === '';
        if (onDashboard && !onLogin) {
            window.location.href = '/index.html';
            return null;
        }
    }
    return resp;
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
            display: flex; align-items: center; justify-content: center;
        `;
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: white; border-radius: 12px; padding: 24px;
            max-width: 400px; box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        `;
        dialog.innerHTML = `
            <h3 style="margin:0 0 12px 0;font-size:18px;color:#333;">${message}</h3>
            ${detail ? `<p style="margin:0 0 20px 0;font-size:14px;color:#666;">${detail}</p>` : '<div style="height:8px;"></div>'}
            <div style="display:flex;gap:12px;justify-content:flex-end;">
                <button id="cancelBtn" style="padding:8px 20px;border:1px solid #ddd;background:white;border-radius:6px;cursor:pointer;font-size:14px;">取消</button>
                <button id="confirmBtn" style="padding:8px 20px;border:none;background:#2ECC71;color:white;border-radius:6px;cursor:pointer;font-size:14px;">确定</button>
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
    loadCurrentConfig();
    loadPresetModels();
    loadCustomModels();
    loadModelsCapabilities();
    bindEvents();
}

/**
 * 加载当前 AI 配置
 */
async function loadCurrentConfig() {
    try {
        const response = await fetchWithAuth('/api/ai/config');
        if (response.ok) {
            const data = await response.json();
            currentConfig = data.data;
            renderCurrentBar();
            renderModelsTable();
        }
    } catch (error) {
        console.error('加载当前 AI 配置失败:', error);
    }
}

/**
 * 加载系统预设模型
 */
async function loadPresetModels() {
    try {
        const response = await fetchWithAuth('/api/ai/presets');
        if (response.ok) {
            const data = await response.json();
            presetModels = data.data.presets || [];
            renderModelsTable();
            renderCurrentBar(); // 预设加载后重新渲染摘要栏，确保显示预设名称
        }
    } catch (error) {
        console.error('加载预设模型失败:', error);
    }
}

/**
 * 加载自定义模型列表
 */
function loadCustomModels() {
    const stored = localStorage.getItem('customAIModels');
    if (stored) customModels = JSON.parse(stored);
}

/**
 * 保存自定义模型列表
 */
function saveCustomModels() {
    localStorage.setItem('customAIModels', JSON.stringify(customModels));
}

/**
 * 加载模型能力数据
 */
async function loadModelsCapabilities() {
    try {
        const response = await fetchWithAuth('/api/ai/models');
        if (response.ok) {
            const data = await response.json();
            modelsCapabilities = data.data.models || {};
            renderModelsTable();
        }
    } catch (error) {
        console.error('加载模型能力数据失败:', error);
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
    return currentConfig &&
        currentConfig.provider === model.provider &&
        currentConfig.baseUrl === model.baseUrl;
}

/**
 * 渲染当前配置摘要栏
 */
function renderCurrentBar() {
    if (!currentConfig) return;
    const display = document.getElementById('currentModelDisplay');
    const status = document.getElementById('currentModelStatus');
    if (display) {
        const matched = presetModels.find(p => p.provider === currentConfig.provider && p.baseUrl === currentConfig.baseUrl);
        const name = matched ? matched.name : (currentConfig.provider || '-');
        display.textContent = `${name} / ${currentConfig.model || '-'}`;
    }
    if (status) {
        if (currentConfig.enabled && currentConfig.apiKey) {
            status.textContent = '已启用';
            status.className = 'ai-current-status active';
        } else {
            status.textContent = '未配置';
            status.className = 'ai-current-status inactive';
        }
    }
    // 详细信息标签
    const setTag = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    setTag('currentProtocol', `协议：${currentConfig.protocol || '-'}`);
    setTag('currentBaseUrl', `地址：${currentConfig.baseUrl || '-'}`);
    setTag('currentTimeout', `超时：${currentConfig.timeout || 30000}ms`);
    setTag('currentMaxTokens', `Token：${currentConfig.maxTokens || 8000}`);
}

/**
 * 渲染统一模型表格
 */
function renderModelsTable() {
    const tbody = document.getElementById('aiModelsTableBody');
    if (!tbody) return;

    // 合并预设和自定义模型为一个列表
    const allModels = [
        ...presetModels.map(p => ({ ...p, _type: 'preset' })),
        ...customModels.map((c, i) => ({ ...c, _type: 'custom', _index: i }))
    ];

    if (allModels.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;padding:40px 20px;">暂无模型，请在环境变量中配置预设模型或添加自定义模型</td></tr>';
        return;
    }

    const esc = (v) => window.SecurityUtils ? window.SecurityUtils.escapeHtml(String(v ?? '')) : String(v ?? '');

    tbody.innerHTML = allModels.map(model => {
        const inUse = isInUse(model);
        const caps = getModelCapabilities(model.model);
        const capsHtml = renderCapsTags(caps);
        const statusClass = inUse ? 'in-use' : 'checking';
        const statusText = inUse ? '使用中' : '检测中...';
        const statusAttr = model._type === 'preset'
            ? `data-preset-id="${esc(model.id)}"`
            : `data-custom-index="${model._index}"`;

        const actionsHtml = model._type === 'preset'
            ? `<button class="ai-btn ai-btn-switch" data-preset-id="${esc(model.id)}" ${inUse ? 'disabled' : ''}>${inUse ? '使用中' : '切换'}</button>
               <button class="ai-btn ai-btn-test" data-preset-id="${esc(model.id)}">测试</button>`
            : `<button class="ai-btn ai-btn-switch" data-custom-index="${model._index}" ${inUse ? 'disabled' : ''}>${inUse ? '使用中' : '切换'}</button>
               <button class="ai-btn ai-btn-test" data-custom-index="${model._index}">测试</button>
               <button class="ai-btn ai-btn-edit" data-custom-index="${model._index}">编辑</button>
               <button class="ai-btn ai-btn-delete" data-custom-index="${model._index}">删除</button>`;

        return `<tr>
            <td>
                <span class="ai-model-name">${esc(model.name)}</span>
                <span class="ai-model-source ${model._type}">${model._type === 'preset' ? '预设' : '自定义'}</span>
            </td>
            <td><span class="ai-model-id">${esc(model.model)}</span></td>
            <td><span class="ai-protocol-tag">${esc(model.protocol)}</span></td>
            <td><div class="ai-caps">${capsHtml}</div></td>
            <td><span class="ai-status ${statusClass}" ${statusAttr}><span class="ai-status-dot"></span>${statusText}</span></td>
            <td><div class="ai-actions">${actionsHtml}</div></td>
        </tr>`;
    }).join('');

    // 检测非使用中的模型状态
    allModels.forEach(model => {
        if (!isInUse(model)) {
            if (model._type === 'preset') {
                checkPresetStatus(model);
            } else {
                checkCustomStatus(model, model._index);
            }
        }
    });
}

/**
 * 渲染能力标签
 */
function renderCapsTags(caps) {
    if (!caps) return '<span style="color:#cbd5e1;font-size:11px;">-</span>';
    const tags = [];
    if (caps.vision) tags.push('<span class="ai-cap-tag vision">视觉</span>');
    if (caps.tools) tags.push('<span class="ai-cap-tag tools">工具</span>');
    if (caps.reasoning) tags.push('<span class="ai-cap-tag reasoning">推理</span>');
    return tags.length ? tags.join('') : '<span style="color:#cbd5e1;font-size:11px;">-</span>';
}

/**
 * 检测预设模型状态
 */
async function checkPresetStatus(preset) {
    const statusEl = document.querySelector(`.ai-status[data-preset-id="${preset.id}"]`);
    if (!statusEl) return;
    try {
        const response = await fetchWithAuth('/api/ai/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                presetId: preset.id, provider: preset.provider,
                protocol: preset.protocol, baseUrl: preset.baseUrl, model: preset.model
            })
        });
        const result = await response.json();
        if (result.data && result.data.available) {
            statusEl.className = 'ai-status available';
            statusEl.innerHTML = '<span class="ai-status-dot"></span>可用';
        } else {
            statusEl.className = 'ai-status unavailable';
            statusEl.innerHTML = '<span class="ai-status-dot"></span>不可用';
            statusEl.title = result.data ? result.data.error : '无法连接';
        }
    } catch (error) {
        statusEl.className = 'ai-status unknown';
        statusEl.innerHTML = '<span class="ai-status-dot"></span>未知';
        statusEl.title = error.message;
    }
}

/**
 * 检测自定义模型状态
 */
async function checkCustomStatus(custom, index) {
    const statusEl = document.querySelector(`.ai-status[data-custom-index="${index}"]`);
    if (!statusEl) return;
    try {
        const response = await fetchWithAuth('/api/ai/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: custom.provider, protocol: custom.protocol,
                apiKey: custom.apiKey, baseUrl: custom.baseUrl, model: custom.model
            })
        });
        const result = await response.json();
        if (result.data && result.data.available) {
            statusEl.className = 'ai-status available';
            statusEl.innerHTML = '<span class="ai-status-dot"></span>可用';
        } else {
            statusEl.className = 'ai-status unavailable';
            statusEl.innerHTML = '<span class="ai-status-dot"></span>不可用';
            statusEl.title = result.data ? result.data.error : '无法连接';
        }
    } catch (error) {
        statusEl.className = 'ai-status unknown';
        statusEl.innerHTML = '<span class="ai-status-dot"></span>未知';
        statusEl.title = error.message;
    }
}

/**
 * 绑定事件
 */
function bindEvents() {
    document.getElementById('addAIModelBtn').addEventListener('click', () => openAIModelForm('add'));
    document.getElementById('closeAIModelFormBtn').addEventListener('click', closeAIModelForm);
    document.getElementById('cancelAIModelFormBtn').addEventListener('click', closeAIModelForm);
    document.getElementById('aiModelForm').addEventListener('submit', handleAIModelFormSubmit);

    // 表格事件委托
    document.getElementById('aiModelsTableBody').addEventListener('click', (e) => {
        const switchBtn = e.target.closest('.ai-btn-switch');
        const testBtn = e.target.closest('.ai-btn-test');
        const editBtn = e.target.closest('.ai-btn-edit');
        const deleteBtn = e.target.closest('.ai-btn-delete');

        if (switchBtn) {
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
        document.getElementById('aiModelMaxTokens').value = model.maxTokens || 3000;
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
 * 切换到预设模型
 */
async function switchToPreset(presetId) {
    const preset = presetModels.find(p => p.id === presetId);
    if (!preset) return;
    if (!await showConfirm(`确定要切换到"${preset.name}"吗？`, '切换后立即生效')) return;
    try {
        const response = await fetchWithAuth('/api/ai/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                presetId: preset.id, provider: preset.provider, protocol: preset.protocol,
                baseUrl: preset.baseUrl, model: preset.model,
                timeout: preset.timeout || 30000, maxTokens: preset.maxTokens || 3000
            })
        });
        if (response.ok) {
            const result = await response.json();
            apiUtils.showToast(result.message || '配置已更新并立即生效！', 'success');
            loadCurrentConfig();
            renderModelsTable();
        } else {
            const result = await response.json();
            apiUtils.showToast('切换失败：' + (result.message || '请稍后重试'), 'error');
        }
    } catch (error) {
        apiUtils.showToast('切换失败：' + error.message, 'error');
    }
}

/**
 * 切换到自定义模型
 */
async function switchToCustom(index) {
    const custom = customModels[index];
    if (!custom) return;
    if (!await showConfirm(`确定要切换到"${custom.name}"吗？`, '切换后立即生效')) return;
    try {
        const response = await fetchWithAuth('/api/ai/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: custom.provider, protocol: custom.protocol, apiKey: custom.apiKey,
                baseUrl: custom.baseUrl, model: custom.model,
                timeout: custom.timeout || 30000, maxTokens: custom.maxTokens || 3000
            })
        });
        if (response.ok) {
            const result = await response.json();
            apiUtils.showToast(result.message || '配置已更新并立即生效！', 'success');
            loadCurrentConfig();
            renderModelsTable();
        } else {
            const result = await response.json();
            apiUtils.showToast('切换失败：' + (result.message || '请稍后重试'), 'error');
        }
    } catch (error) {
        apiUtils.showToast('切换失败：' + error.message, 'error');
    }
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
        const response = await fetchWithAuth('/api/ai/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                presetId: preset.id, provider: preset.provider, protocol: preset.protocol,
                baseUrl: preset.baseUrl, model: preset.model,
                timeout: preset.timeout || 30000, maxTokens: preset.maxTokens || 1000
            })
        });
        const result = await response.json();
        if (result.data && result.data.success) {
            apiUtils.showToast(`测试成功！响应时间：${result.data.latency}ms`, 'success');
        } else {
            apiUtils.showToast(`测试失败：${result.data ? result.data.error : '未知错误'}`, 'error');
        }
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
        const response = await fetchWithAuth('/api/ai/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(custom)
        });
        const result = await response.json();
        if (result.data && result.data.success) {
            apiUtils.showToast(`测试成功！响应时间：${result.data.latency}ms`, 'success');
        } else {
            apiUtils.showToast(`测试失败：${result.data ? result.data.error : '未知错误'}`, 'error');
        }
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

// 导出初始化函数
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initAIModelsManager };
}
