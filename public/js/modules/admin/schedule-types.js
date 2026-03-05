
// Schedule Types Logic

// ==========================================
// 课程类型管理功能
// ==========================================

// 加载课程类型列表
export async function loadScheduleTypes() {
    const tbody = document.getElementById('scheduleTypesTableBody');
    if (!tbody) return;

    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, '<tr><td colspan="4" style="text-align: center; padding: 40px 0;"><div class="loading-spinner" style="margin: 0 auto 12px;"></div><div style="color: #64748b;">加载中...</div></td></tr>'); } else { tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 40px 0;"><div class="loading-spinner" style="margin: 0 auto 12px;"></div><div style="color: #64748b;">加载中...</div></td></tr>'; }

    try {
        const result = await window.apiUtils.get('/admin/schedule-types');
        const types = Array.isArray(result) ? result : (result.data || []);
        renderScheduleTypesTable(types);
    } catch (error) {
        
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, '<tr><td colspan="4" style="text-align:center; padding: 20px; color: red;">加载失败，请重试</td></tr>'); } else { tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 20px; color: red;">加载失败，请重试</td></tr>'; }
        if (window.apiUtils) window.apiUtils.showToast('加载课程类型失败', 'error');
    }
}

// 渲染课程类型表格
export function renderScheduleTypesTable(types) {
    const tbody = document.getElementById('scheduleTypesTableBody');
    if (!tbody) return;

    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, ''); } else { tbody.innerHTML = ''; }

    if (types.length === 0) {
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, '<tr><td colspan="3" style="text-align:center; padding: 20px; color: #666;">暂无数据</td></tr>'); } else { tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding: 20px; color: #666;">暂无数据</td></tr>'; }
        return;
    }

    types.forEach(type => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong style="color: #333;">${type.name}</strong></td>
            <td style="color: #666;">${type.description || '-'}</td>
            <td class="actions">
                <button class="btn-icon edit-type-btn" data-id="${type.id}" data-name="${type.name}" data-description="${type.description || ''}" title="编辑">
                    <span class="material-icons-round">edit</span>
                </button>
                <button class="btn-icon delete-type-btn" data-id="${type.id}" title="删除" style="color: #ef4444;">
                    <span class="material-icons-round">delete</span>
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    // 绑定行内按钮事件
    tbody.querySelectorAll('.edit-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const { id, name, description } = btn.dataset;
            openScheduleTypeModal('edit', { id, name, description });
        });
    });

    tbody.querySelectorAll('.delete-type-btn').forEach(btn => {
        btn.addEventListener('click', () => handleDeleteScheduleType(btn.dataset.id));
    });
}

// 打开课程类型表单模态
export function openScheduleTypeModal(mode, data = {}) {
    const container = document.getElementById('scheduleTypeFormContainer');
    const form = document.getElementById('scheduleTypeForm');
    const title = document.getElementById('scheduleTypeFormTitle');
    const overlay = document.getElementById('modalOverlay') || createModalOverlay();

    if (!container || !form) return;

    form.dataset.mode = mode;
    form.dataset.id = data.id || '';

    document.getElementById('scheduleTypeName').value = data.name || '';
    document.getElementById('scheduleTypeDescription').value = data.description || '';

    title.textContent = mode === 'add' ? '添加课程类型' : '编辑课程类型';

    container.style.display = 'block';
    overlay.style.display = 'block';
}

// 关闭课程类型表单模态
export function closeScheduleTypeFormModal() {
    const container = document.getElementById('scheduleTypeFormContainer');
    const overlay = document.getElementById('modalOverlay');
    if (container) container.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
}

// 处理删除课程类型
export async function handleDeleteScheduleType(id) {
    if (!confirm('确定要删除这个课程类型吗？如果已被现有排课引用，将无法删除。')) {
        return;
    }

    try {
        await window.apiUtils.delete(`/admin/schedule-types/${id}`);
        if (window.apiUtils) window.apiUtils.showSuccessToast('删除成功');
        loadScheduleTypes(); // 重新加载列表
    } catch (error) {
        
        if (window.apiUtils) window.apiUtils.showToast(error.message || '删除失败', 'error');
    }
}

// 设置课程类型相关的事件监听器
export function setupScheduleTypeListeners() {
    // 添加类型按钮
    const addBtn = document.getElementById('addScheduleTypeBtn');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            openScheduleTypeModal('add');
        });
    }

    // 表单提交
    const form = document.getElementById('scheduleTypeForm');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const mode = form.dataset.mode;
            const id = form.dataset.id;
            const name = document.getElementById('scheduleTypeName').value.trim();
            const description = document.getElementById('scheduleTypeDescription').value.trim();

            if (!name) {
                alert('类型名称不能为空');
                return;
            }

            const submitBtn = document.getElementById('scheduleTypeFormSubmit');
            const originalText = submitBtn.textContent;
            submitBtn.disabled = true;
            submitBtn.textContent = '保存中...';

            try {
                if (mode === 'add') {
                    await window.apiUtils.post('/admin/schedule-types', { name, description });
                    if (window.apiUtils) window.apiUtils.showSuccessToast('添加成功');
                } else {
                    await window.apiUtils.put(`/admin/schedule-types/${id}`, { name, description });
                    if (window.apiUtils) window.apiUtils.showSuccessToast('更新成功');
                }
                closeScheduleTypeFormModal();
                loadScheduleTypes();
            } catch (error) {
                
                if (window.apiUtils) {
                    // 处理后端返回的错误信息(如名称重复)
                    const msg = error.message || (error.data && error.data.message) || '保存失败';
                    window.apiUtils.showToast(msg, 'error');
                } else {
                    alert('保存失败');
                }
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        });
    }
}

// 辅助函数：如果 overlay 不存在则创建
export function createModalOverlay() {
    let overlay = document.getElementById('modalOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'modalOverlay';
        overlay.className = 'modal-overlay';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', () => {
            // 关闭所有已打开的模态框
            closeScheduleTypeFormModal();
            // 也可以调用其他关闭函数...
            if (typeof closeUserFormModal === 'function') closeUserFormModal();
        });
    }
    return overlay;
}

// Global exposure
window.loadScheduleTypes = loadScheduleTypes;
window.openScheduleTypeModal = openScheduleTypeModal;
window.closeScheduleTypeFormModal = closeScheduleTypeFormModal;
window.handleDeleteScheduleType = handleDeleteScheduleType;
window.setupScheduleTypeListeners = setupScheduleTypeListeners;
