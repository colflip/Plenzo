/**
 * AI 模型管理模块
 * @description 管理预设和自定义 AI 模型，支持切换和测试
 */

// 预设和自定义模型列表
let presetModels = [];
let customModels = [];
let currentConfig = null;

// API 工具实例
const apiUtils = new ApiUtils();

/**
 * 显示确认对话框
 * @param {string} message - 主要消息
 * @param {string} detail - 详细说明（可选）
 * @returns {Promise<boolean>} - 用户确认返回 true，取消返回 false
 */
function showConfirm(message, detail = '') {
    return new Promise((resolve) => {
        // 创建遮罩层
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        // 创建对话框
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: white;
            border-radius: 12px;
            padding: 24px;
            max-width: 400px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
        `;

        dialog.innerHTML = `
            <h3 style="margin: 0 0 12px 0; font-size: 18px; color: #333;">${message}</h3>
            ${detail ? `<p style="margin: 0 0 20px 0; font-size: 14px; color: #666;">${detail}</p>` : '<div style="height: 8px;"></div>'}
            <div style="display: flex; gap: 12px; justify-content: flex-end;">
                <button id="cancelBtn" style="
                    padding: 8px 20px;
                    border: 1px solid #ddd;
                    background: white;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                ">取消</button>
                <button id="confirmBtn" style="
                    padding: 8px 20px;
                    border: none;
                    background: #2ECC71;
                    color: white;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                ">确定</button>
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // 绑定事件
        const remove = () => document.body.removeChild(overlay);
        dialog.querySelector('#confirmBtn').onclick = () => { remove(); resolve(true); };
        dialog.querySelector('#cancelBtn').onclick = () => { remove(); resolve(false); };
        overlay.onclick = (e) => { if (e.target === overlay) { remove(); resolve(false); } };
    });
}

/**
 * 初始化 AI 模型管理
 */
function initAIModelsManager() {
    loadCurrentConfig();
    loadPresetModels();
    loadCustomModels();
    renderCustomModels();
    bindEvents();
}

/**
 * 加载当前 AI 配置
 */
async function loadCurrentConfig() {
    try {
        const response = await fetch('/api/ai/config', {
            headers: apiUtils.getHeaders()
        });
        if (response.ok) {
            const data = await response.json();
            currentConfig = data.data;
            renderCurrentConfig();
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
        const response = await fetch('/api/ai/presets', {
            headers: apiUtils.getHeaders()
        });
        if (response.ok) {
            const data = await response.json();
            presetModels = data.data.presets || [];
            renderPresetModels();
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
    if (stored) {
        customModels = JSON.parse(stored);
    }
}

/**
 * 保存自定义模型列表
 */
function saveCustomModels() {
    localStorage.setItem('customAIModels', JSON.stringify(customModels));
}

/**
 * 渲染当前配置
 */
function renderCurrentConfig() {
    if (!currentConfig) return;

    document.getElementById('currentProvider').textContent = currentConfig.provider || '-';
    document.getElementById('currentModel').textContent = currentConfig.model || '-';
    document.getElementById('currentBaseUrl').textContent = currentConfig.baseUrl || '-';

    const statusEl = document.getElementById('currentModelStatus');
    if (currentConfig.enabled && currentConfig.apiKey) {
        statusEl.textContent = '已启用';
        statusEl.className = 'status-badge active';
    } else {
        statusEl.textContent = '未配置';
        statusEl.className = 'status-badge inactive';
    }
}

/**
 * 渲染预设模型列表
 */
function renderPresetModels() {
    const container = document.querySelector('.preset-models-section');
    if (!container) return;

    const tbody = container.querySelector('tbody');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (presetModels.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #999; padding: 40px 20px;">暂无系统预设模型</td></tr>';
        return;
    }

    presetModels.forEach((preset) => {
        const isInUse = currentConfig &&
            currentConfig.provider === preset.provider &&
            currentConfig.baseUrl === preset.baseUrl;

        const row = document.createElement('tr');
        row.innerHTML = `
            <td><span class="model-provider">${preset.name}</span></td>
            <td><span class="model-name">${preset.model}</span></td>
            <td><span class="model-protocol">${preset.protocol}</span></td>
            <td>
                <span class="model-status ${isInUse ? 'in-use' : 'checking'}" data-preset-id="${preset.id}">
                    ${isInUse ? '使用中' : '检测中...'}
                </span>
            </td>
            <td>
                <div class="model-actions">
                    <button class="btn-switch" data-preset-id="${preset.id}" ${isInUse ? 'disabled' : ''}>
                        ${isInUse ? '使用中' : '切换'}
                    </button>
                    <button class="btn-test" data-preset-id="${preset.id}">测试</button>
                </div>
            </td>
        `;
        tbody.appendChild(row);

        // 如果不是正在使用的模型，检测其状态
        if (!isInUse) {
            checkPresetStatus(preset);
        }
    });
}

/**
 * 检测预设模型状态
 */
async function checkPresetStatus(preset) {
    const statusEl = document.querySelector(`.model-status[data-preset-id="${preset.id}"]`);
    if (!statusEl) return;

    try {
        const response = await fetch('/api/ai/check', {
            method: 'POST',
            headers: apiUtils.getHeaders(),
            body: JSON.stringify({
                presetId: preset.id,
                provider: preset.provider,
                protocol: preset.protocol,
                baseUrl: preset.baseUrl,
                model: preset.model
            })
        });

        const result = await response.json();

        if (result.data && result.data.available) {
            statusEl.textContent = '可用';
            statusEl.className = 'model-status available';
        } else {
            statusEl.textContent = '不可用';
            statusEl.className = 'model-status unavailable';
            statusEl.title = result.data ? result.data.error : '无法连接';
        }
    } catch (error) {
        statusEl.textContent = '未知';
        statusEl.className = 'model-status unknown';
        statusEl.title = error.message;
    }
}

/**
 * 渲染自定义模型列表
 */
function renderCustomModels() {
    const tbody = document.getElementById('customModelsTableBody');
    tbody.innerHTML = '';

    if (customModels.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #999; padding: 40px 20px;">暂无自定义模型<br><small style="color: #bbb;">点击右上角"添加模型"按钮来添加你的 AI 模型</small></td></tr>';
        return;
    }

    customModels.forEach((custom, index) => {
        const isInUse = currentConfig &&
            currentConfig.provider === custom.provider &&
            currentConfig.baseUrl === custom.baseUrl;

        const row = document.createElement('tr');
        row.innerHTML = `
            <td><span class="model-provider">${custom.name}</span></td>
            <td><span class="model-name">${custom.baseUrl}</span></td>
            <td><span class="model-name">${custom.model}</span></td>
            <td>
                <span class="model-status ${isInUse ? 'in-use' : 'checking'}" data-custom-index="${index}">
                    ${isInUse ? '使用中' : '检测中...'}
                </span>
            </td>
            <td>
                <div class="model-actions">
                    <button class="btn-switch" data-custom-index="${index}" ${isInUse ? 'disabled' : ''}>
                        ${isInUse ? '使用中' : '切换'}
                    </button>
                    <button class="btn-test" data-custom-index="${index}">测试</button>
                    <button class="btn-edit" data-custom-index="${index}">编辑</button>
                    <button class="btn-delete" data-custom-index="${index}">删除</button>
                </div>
            </td>
        `;
        tbody.appendChild(row);

        // 如果不是正在使用的模型，检测其状态
        if (!isInUse) {
            checkCustomStatus(custom, index);
        }
    });
}

/**
 * 检测自定义模型状态
 */
async function checkCustomStatus(custom, index) {
    const statusEl = document.querySelector(`.model-status[data-custom-index="${index}"]`);
    if (!statusEl) return;

    try {
        const response = await fetch('/api/ai/check', {
            method: 'POST',
            headers: apiUtils.getHeaders(),
            body: JSON.stringify({
                provider: custom.provider,
                protocol: custom.protocol,
                apiKey: custom.apiKey,
                baseUrl: custom.baseUrl,
                model: custom.model
            })
        });

        const result = await response.json();

        if (result.data && result.data.available) {
            statusEl.textContent = '可用';
            statusEl.className = 'model-status available';
        } else {
            statusEl.textContent = '不可用';
            statusEl.className = 'model-status unavailable';
            statusEl.title = result.data ? result.data.error : '无法连接';
        }
    } catch (error) {
        statusEl.textContent = '未知';
        statusEl.className = 'model-status unknown';
        statusEl.title = error.message;
    }
}

/**
 * 绑定事件
 */
function bindEvents() {
    // 添加自定义模型按钮
    document.getElementById('addAIModelBtn').addEventListener('click', () => {
        openAIModelForm('add');
    });

    // 表单关闭按钮
    document.getElementById('closeAIModelFormBtn').addEventListener('click', closeAIModelForm);
    document.getElementById('cancelAIModelFormBtn').addEventListener('click', closeAIModelForm);

    // 表单提交
    document.getElementById('aiModelForm').addEventListener('submit', handleAIModelFormSubmit);

    // 预设模型操作按钮（事件委托）
    const presetTableBody = document.querySelector('.preset-models-section tbody');
    if (presetTableBody) {
        presetTableBody.addEventListener('click', (e) => {
            const switchBtn = e.target.closest('.btn-switch');
            const testBtn = e.target.closest('.btn-test');

            if (switchBtn) {
                const presetId = switchBtn.dataset.presetId;
                switchToPreset(presetId);
            } else if (testBtn) {
                const presetId = testBtn.dataset.presetId;
                testPreset(presetId);
            }
        });
    }

    // 自定义模型操作按钮（事件委托）
    document.getElementById('customModelsTableBody').addEventListener('click', (e) => {
        const switchBtn = e.target.closest('.btn-switch');
        const testBtn = e.target.closest('.btn-test');
        const editBtn = e.target.closest('.btn-edit');
        const deleteBtn = e.target.closest('.btn-delete');

        if (switchBtn) {
            const index = parseInt(switchBtn.dataset.customIndex);
            switchToCustom(index);
        } else if (testBtn) {
            const index = parseInt(testBtn.dataset.customIndex);
            testCustom(index);
        } else if (editBtn) {
            const index = parseInt(editBtn.dataset.customIndex);
            openAIModelForm('edit', index);
        } else if (deleteBtn) {
            const index = parseInt(deleteBtn.dataset.customIndex);
            deleteCustomModel(index);
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
        const index = parseInt(form.dataset.id);
        customModels[index] = modelData;
        apiUtils.showToast('自定义模型更新成功！', 'success');
    }

    saveCustomModels();
    renderCustomModels();
    closeAIModelForm();
}

/**
 * 切换到预设模型
 */
async function switchToPreset(presetId) {
    const preset = presetModels.find(p => p.id === presetId);
    if (!preset) return;

    // 使用自定义确认对话框
    if (!await showConfirm(`确定要切换到"${preset.name}"吗？`, '切换后立即生效')) return;

    try {
        const response = await fetch('/api/ai/config', {
            method: 'PUT',
            headers: apiUtils.getHeaders(),
            body: JSON.stringify({
                presetId: preset.id,
                provider: preset.provider,
                protocol: preset.protocol,
                baseUrl: preset.baseUrl,
                model: preset.model,
                timeout: preset.timeout || 30000,
                maxTokens: preset.maxTokens || 3000
            })
        });

        if (response.ok) {
            const result = await response.json();
            apiUtils.showToast(result.message || '配置已更新并立即生效！', 'success');
            loadCurrentConfig();
            renderPresetModels();
            renderCustomModels();
        } else {
            const result = await response.json();
            apiUtils.showToast('切换失败：' + (result.message || '请稍后重试'), 'error');
        }
    } catch (error) {
        console.error('切换模型失败:', error);
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
        const response = await fetch('/api/ai/config', {
            method: 'PUT',
            headers: apiUtils.getHeaders(),
            body: JSON.stringify({
                provider: custom.provider,
                protocol: custom.protocol,
                apiKey: custom.apiKey,
                baseUrl: custom.baseUrl,
                model: custom.model,
                timeout: custom.timeout || 30000,
                maxTokens: custom.maxTokens || 3000
            })
        });

        if (response.ok) {
            const result = await response.json();
            apiUtils.showToast(result.message || '配置已更新并立即生效！', 'success');
            loadCurrentConfig();
            renderPresetModels();
            renderCustomModels();
        } else {
            const result = await response.json();
            apiUtils.showToast('切换失败：' + (result.message || '请稍后重试'), 'error');
        }
    } catch (error) {
        console.error('切换模型失败:', error);
        apiUtils.showToast('切换失败：' + error.message, 'error');
    }
}

/**
 * 测试预设模型
 */
async function testPreset(presetId) {
    const preset = presetModels.find(p => p.id === presetId);
    if (!preset) return;

    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '测试中...';

    try {
        const response = await fetch('/api/ai/test', {
            method: 'POST',
            headers: apiUtils.getHeaders(),
            body: JSON.stringify({
                presetId: preset.id, // 传递 presetId，后端会从环境变量获取真实 API Key
                provider: preset.provider,
                protocol: preset.protocol,
                baseUrl: preset.baseUrl,
                model: preset.model,
                timeout: preset.timeout || 30000,
                maxTokens: preset.maxTokens || 1000
            })
        });

        const result = await response.json();

        if (result.data && result.data.success) {
            apiUtils.showToast(
                `测试成功！响应时间：${result.data.latency}ms，模型：${result.data.model}`,
                'success'
            );
        } else {
            apiUtils.showToast(
                `测试失败：${result.data ? result.data.error : result.message || '未知错误'}`,
                'error'
            );
        }
    } catch (error) {
        console.error('测试失败:', error);
        apiUtils.showToast('测试失败：' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '测试';
    }
}

/**
 * 测试自定义模型
 */
async function testCustom(index) {
    const custom = customModels[index];
    if (!custom) return;

    await testModel(custom);
}

/**
 * 测试模型连接
 */
async function testModel(modelConfig) {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '测试中...';

    try {
        const response = await fetch('/api/ai/test', {
            method: 'POST',
            headers: apiUtils.getHeaders(),
            body: JSON.stringify(modelConfig)
        });

        const result = await response.json();

        if (result.data && result.data.success) {
            alert(`✅ 测试成功！\n\n响应时间：${result.data.latency}ms\n模型：${result.data.model}`);
        } else {
            alert(`❌ 测试失败：${result.data ? result.data.error : '未知错误'}`);
        }
    } catch (error) {
        console.error('测试失败:', error);
        alert('❌ 测试失败：' + error.message);
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
    if (!await showConfirm(`确定要删除自定义模型"${model.name}"吗？`, '此操作无法撤销')) return;

    customModels.splice(index, 1);
    saveCustomModels();
    renderCustomModels();
    apiUtils.showToast('删除成功！', 'success');
}

// 导出初始化函数
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initAIModelsManager };
}
