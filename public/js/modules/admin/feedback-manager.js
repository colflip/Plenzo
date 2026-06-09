/**
 * Feedback Manager Module
 * 管理员端反馈管理功能（功能反馈 / 系统 Bug / 新功能需求 / 其他）
 */

import { showTableLoading, hideTableLoading } from './ui-helper.js';

let feedbackData = [];

const TYPE_LABELS = {
    feature: '功能反馈',
    bug: '系统 Bug',
    request: '新功能需求',
    other: '其他反馈'
};
const TYPE_COLORS = {
    feature: '#2563eb',
    bug: '#ef4444',
    request: '#7c3aed',
    other: '#64748b'
};
const STATUS_LABELS = {
    open: '未处理',
    in_progress: '处理中',
    done: '已完成',
    rejected: '已拒绝'
};
const STATUS_COLORS = {
    open: { bg: '#fef3c7', fg: '#b45309' },
    in_progress: { bg: '#dbeafe', fg: '#1d4ed8' },
    done: { bg: '#d1fae5', fg: '#047857' },
    rejected: { bg: '#fee2e2', fg: '#b91c1c' }
};
const PRIORITY_LABELS = { high: '高', medium: '中', low: '低' };

// ========================
// 加载反馈列表
// ========================
export async function loadFeedbacks() {
    const tbody = document.getElementById('feedbacksTableBody');
    const tableContainer = document.querySelector('#feedback-view .table-container');
    if (!tbody || !tableContainer) return;

    const thead = tableContainer.querySelector('table thead');
    if (thead) void thead.offsetHeight;

    showTableLoading(tableContainer, '正在加载反馈数据...');

    try {
        const result = await window.apiUtils.get('/admin/feedbacks');
        feedbackData = Array.isArray(result) ? result : (result.data || []);
        renderFeedbacksTable(feedbackData);
    } catch (err) {
        console.warn('Feedback API unavailable:', err.message);
        feedbackData = [];
        renderFeedbacksTable(feedbackData);
    } finally {
        hideTableLoading(tableContainer);
    }
}

// ========================
// 渲染反馈表格
// ========================
function renderFeedbacksTable(data) {
    const tbody = document.getElementById('feedbacksTableBody');
    if (!tbody) return;

    if (!data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#999;padding:20px;">暂无反馈，点击"提交反馈"开始</td></tr>';
        return;
    }

    tbody.innerHTML = data.map(item => {
        const typeColor = TYPE_COLORS[item.type] || '#64748b';
        const typeLabel = TYPE_LABELS[item.type] || item.type;
        const statusColors = STATUS_COLORS[item.status] || STATUS_COLORS.open;
        const statusLabel = STATUS_LABELS[item.status] || item.status;
        const submitter = item.submitter_name || item.submitter_role || '-';
        const time = formatDateTime(item.created_at);
        const title = escapeHtml(item.title || '');
        return `
            <tr data-id="${item.id}">
                <td>#${item.id}</td>
                <td><span style="display:inline-block;padding:2px 10px;border-radius:12px;background:${typeColor}1a;color:${typeColor};font-size:12px;font-weight:500;">${typeLabel}</span></td>
                <td>${PRIORITY_LABELS[item.priority] || item.priority || '-'}</td>
                <td title="${title}" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${title}</td>
                <td><span style="display:inline-block;padding:2px 10px;border-radius:12px;background:${statusColors.bg};color:${statusColors.fg};font-size:12px;font-weight:500;">${statusLabel}</span></td>
                <td>${escapeHtml(submitter)}</td>
                <td>${time}</td>
                <td>
                    <button class="edit-btn" data-id="${item.id}" title="编辑" style="background:none;border:none;color:#2ECC71;cursor:pointer;margin-right:8px;">
                        <span class="material-icons-round" style="font-size:18px;">edit</span>
                    </button>
                    <button class="delete-btn" data-id="${item.id}" title="删除" style="background:none;border:none;color:#ef4444;cursor:pointer;">
                        <span class="material-icons-round" style="font-size:18px;">delete</span>
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    tbody.querySelectorAll('.edit-btn').forEach(btn => {
        btn.addEventListener('click', () => editFeedback(btn.dataset.id));
    });
    tbody.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteFeedback(btn.dataset.id));
    });
}

function formatDateTime(s) {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d.getTime())) return String(s);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ========================
// 打开/关闭表单
// ========================
export function openFeedbackForm(mode = 'add', item = null) {
    const container = document.getElementById('feedbackFormContainer');
    const form = document.getElementById('feedbackForm');
    const title = document.getElementById('feedbackFormTitle');
    const statusGroup = document.getElementById('feedbackStatusGroup');
    const overlay = document.getElementById('modalOverlay');

    if (!container || !form) return;

    container.style.display = 'block';
    if (overlay) overlay.style.display = 'block';

    if (mode === 'add') {
        title.textContent = '提交反馈';
        form.dataset.mode = 'add';
        form.dataset.id = '';
        form.reset();
        document.getElementById('feedbackType').value = 'feature';
        document.getElementById('feedbackPriority').value = 'medium';
        if (statusGroup) statusGroup.style.display = 'none';
    } else if (mode === 'edit' && item) {
        title.textContent = '编辑反馈';
        form.dataset.mode = 'edit';
        form.dataset.id = item.id || '';
        document.getElementById('feedbackType').value = item.type || 'feature';
        document.getElementById('feedbackPriority').value = item.priority || 'medium';
        document.getElementById('feedbackStatus').value = item.status || 'open';
        document.getElementById('feedbackDescription').value = item.description || '';
        document.getElementById('feedbackTitle').value = item.title || '';
        if (statusGroup) statusGroup.style.display = 'flex';
    }
}

export function closeFeedbackForm() {
    const container = document.getElementById('feedbackFormContainer');
    const overlay = document.getElementById('modalOverlay');
    if (container) container.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
}

// ========================
// 保存反馈
// ========================
async function saveFeedback(mode) {
    const form = document.getElementById('feedbackForm');
    const data = {
        type: document.getElementById('feedbackType').value,
        priority: document.getElementById('feedbackPriority').value,
        description: document.getElementById('feedbackDescription').value.trim()
    };
    const titleVal = document.getElementById('feedbackTitle').value.trim();
    if (titleVal) data.title = titleVal;

    if (mode === 'edit') {
        data.id = form.dataset.id;
        data.status = document.getElementById('feedbackStatus').value;
    }

    try {
        if (data.id) {
            await window.apiUtils.put(`/admin/feedbacks/${data.id}`, data);
            window.showToast('反馈已更新', 'success');
        } else {
            await window.apiUtils.post('/admin/feedbacks', data);
            window.showToast('反馈已提交', 'success');
        }
        closeFeedbackForm();
        loadFeedbacks();
    } catch (err) {
        window.showToast('保存失败：' + (err.message || '未知错误'), 'error');
    }
}

// ========================
// 编辑/删除
// ========================
async function editFeedback(id) {
    if (!id) return;
    const item = feedbackData.find(f => String(f.id) === String(id));
    if (item) openFeedbackForm('edit', item);
}

async function deleteFeedback(id) {
    if (!id || !confirm('确定删除此反馈？')) return;
    try {
        await window.apiUtils.delete(`/admin/feedbacks/${id}`);
        window.showToast('反馈已删除', 'success');
        loadFeedbacks();
    } catch (err) {
        window.showToast('删除失败：' + (err.message || '未知错误'), 'error');
    }
}

// ========================
// 初始化事件监听
// ========================
export function setupFeedbackEventListeners() {
    const addBtn = document.getElementById('addFeedbackBtn');
    if (addBtn) addBtn.addEventListener('click', () => openFeedbackForm('add'));

    const closeBtn = document.getElementById('closeFeedbackFormBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeFeedbackForm);

    const cancelBtn = document.getElementById('cancelFeedbackFormBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', closeFeedbackForm);

    const form = document.getElementById('feedbackForm');
    if (form) {
        let isSubmitting = false;

        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            if (isSubmitting) {
                window.showToast('提交中，请勿重复操作', 'warning');
                return;
            }

            const description = document.getElementById('feedbackDescription').value.trim();
            if (!description) {
                window.showToast('请填写详细描述', 'error');
                return;
            }

            isSubmitting = true;
            const submitBtn = document.getElementById('feedbackFormSubmit');
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = '提交中...';
                submitBtn.style.opacity = '0.6';
            }

            try {
                await saveFeedback(form.dataset.mode);
            } finally {
                isSubmitting = false;
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = '提交';
                    submitBtn.style.opacity = '1';
                }
            }
        });
    }
}

// 暴露全局函数
window.openFeedbackForm = openFeedbackForm;
window.closeFeedbackForm = closeFeedbackForm;
window.loadFeedbacks = loadFeedbacks;
