/**
 * Holiday Manager Module
 * 管理员端节假日管理功能
 */

import { showTableLoading, hideTableLoading } from './ui-helper.js';
import { renderTableErrorRow } from '../shared/error-ui.js';

let holidayData = [];

// ========================
// 加载节假日列表
// ========================
export async function loadHolidays() {
    const tbody = document.getElementById('holidaysTableBody');
    const tableContainer = document.querySelector('#holiday-config-view .table-container');
    if (!tbody || !tableContainer) return;

    const thead = tableContainer.querySelector('table thead');
    if (thead) void thead.offsetHeight;

    showTableLoading(tableContainer, '正在加载节假日数据...');

    try {
        const result = await window.apiUtils.get('/admin/holidays');
        if (!Array.isArray(result)) {
            throw new Error('节假日响应格式无效');
        }
        holidayData = result;
        renderHolidaysTable(holidayData);
    } catch (err) {
        holidayData = [];
        renderTableErrorRow(tbody, {
            colspan: 6,
            error: err,
            title: '节假日数据加载失败',
            detail: null,
            onRetry: () => loadHolidays(),
            retryText: '重试'
        });
    } finally {
        hideTableLoading(tableContainer);
    }
}

// ========================
// 渲染节假日表格
// ========================
function renderHolidaysTable(data) {
    const tbody = document.getElementById('holidaysTableBody');
    if (!tbody) return;

    if (!data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;padding:20px;">暂无节假日数据，可手动添加或点击"从 API 同步"</td></tr>';
        return;
    }

    const sorted = data.sort((a, b) => {
        if (a.year !== b.year) return a.year - b.year;
        return a.start_date.localeCompare(b.start_date);
    });

    const esc = window.SecurityUtils ? (v) => window.SecurityUtils.escapeHtml(String(v ?? '')) : (s) => String(s ?? '');
    const fmtDate = (d) => d ? d.replace(/-/g, '/') : '';
    const holidaysHtml = sorted.map(item => {
        const sameDate = item.start_date === item.end_date;
        return `
        <tr data-id="${esc(item.id)}">
            <td>${esc(item.year)}</td>
            <td>${item.type === 'makeup' ? '调休补班' : '法定节假日'}</td>
            <td>${esc(item.label)}</td>
            <td>${fmtDate(item.start_date)}</td>
            <td>${sameDate ? '同上' : fmtDate(item.end_date)}</td>
            <td>
                <button class="edit-btn" data-id="${esc(item.id)}" title="编辑" style="background:none;border:none;color:#2ECC71;cursor:pointer;margin-right:8px;">
                    <span class="material-icons-round" style="font-size:18px;">edit</span>
                </button>
                <button class="delete-btn" data-id="${esc(item.id)}" title="删除" style="background:none;border:none;color:#ef4444;cursor:pointer;">
                    <span class="material-icons-round" style="font-size:18px;">delete</span>
                </button>
            </td>
        </tr>`;
    }).join('');
    tbody.innerHTML = holidaysHtml;

    // 绑定编辑/删除事件
    tbody.querySelectorAll('.edit-btn').forEach(btn => {
        btn.addEventListener('click', () => editHoliday(btn.dataset.id));
    });
    tbody.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteHoliday(btn.dataset.id));
    });
}

// ========================
// 日期格式化
// ========================
function formatDateRange(start, end) {
    if (!start) return '';
    if (start === end) return start;
    return `${start} ~ ${end}`;
}

// ========================
// 打开新增表单
// ========================
export function openHolidayForm(mode = 'add', item = null) {
    const container = document.getElementById('holidayFormContainer');
    const form = document.getElementById('holidayForm');
    const title = document.getElementById('holidayFormTitle');
    const overlay = document.getElementById('modalOverlay');

    if (!container || !form) return;

    container.style.display = 'block';
    if (overlay) overlay.style.display = 'block';

    if (mode === 'add') {
        title.textContent = '添加节假日';
        form.dataset.mode = 'add';
        form.dataset.id = '';
        form.reset();
        document.getElementById('holidayYear').value = '2027';
    } else if (mode === 'edit' && item) {
        title.textContent = '编辑节假日';
        form.dataset.mode = 'edit';
        form.dataset.id = item.id || '';
        document.getElementById('holidayYear').value = item.year || '';
        document.getElementById('holidayType').value = item.type || '';
        document.getElementById('holidayLabel').value = item.label || '';
        document.getElementById('holidayStart').value = item.start_date || '';
        document.getElementById('holidayEnd').value = item.end_date || '';
    }
}

// ========================
// 关闭表单
// ========================
export function closeHolidayForm() {
    const container = document.getElementById('holidayFormContainer');
    const overlay = document.getElementById('modalOverlay');
    if (container) container.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
}

// ========================
// 保存节假日
// ========================
async function saveHoliday(data) {
    try {
        if (data.id) {
            // 编辑
            await window.apiUtils.put(`/admin/holidays/${data.id}`, data);
            window.showToast('节假日已更新', 'success');
        } else {
            // 新增
            await window.apiUtils.post('/admin/holidays', data);
            window.showToast('节假日已添加', 'success');
        }
        closeHolidayForm();
        loadHolidays();
    } catch (err) {
        window.showToast('保存失败：' + (err.message || '未知错误'), 'error');
    }
}

// ========================
// 编辑节假日
// ========================
async function editHoliday(id) {
    if (!id) {
        // 无 ID，直接打开空表单（使用本地数据模式）
        openHolidayForm('add');
        return;
    }
    const item = holidayData.find(h => String(h.id) === String(id));
    if (item) openHolidayForm('edit', item);
}

// ========================
// 删除节假日
// ========================
async function deleteHoliday(id) {
    if (!id || !await Modal.confirm('确定删除此节假日记录？', { title: '删除节假日', confirmText: '删除', confirmStyle: 'danger' })) return;
    try {
        await window.apiUtils.delete(`/admin/holidays/${id}`);
        window.showToast('节假日已删除', 'success');
        loadHolidays();
    } catch (err) {
        window.showToast('删除失败：' + (err.message || '未知错误'), 'error');
    }
}

// ========================
// 从 API 同步节假日数据（通过后端代理，规避浏览器 CSP/CORS）
// ========================
async function syncHolidaysFromAPI() {
    const btn = document.getElementById('loadHolidaysBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="material-icons-round">hourglass_empty</span> 同步中...';
    }

    try {
        const result = await window.apiUtils.post('/admin/holidays/sync', { years: [2025, 2026, 2027] });
        if (!Array.isArray(result)) {
            throw new Error('节假日同步响应格式无效');
        }
        const rows = result;
        const count = rows.length;
        if (count > 0) {
            holidayData = rows;
            renderHolidaysTable(holidayData);
            window.showToast(`成功同步 ${count} 条节假日数据`, 'success');
        } else {
            window.showToast('未获取到节假日数据（该年份可能尚未发布）', 'warning');
            loadHolidays();
        }
    } catch (err) {
        window.showToast('同步失败：' + (err.message || '未知错误'), 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<span class="material-icons-round">sync</span> 从 API 同步';
        }
    }
}

// ========================
// 初始化事件监听
// ========================
export function setupHolidayEventListeners() {
    // 添加按钮
    const addBtn = document.getElementById('addHolidayBtn');
    if (addBtn) {
        addBtn.addEventListener('click', () => openHolidayForm('add'));
    }

    // 从 API 同步按钮
    const syncBtn = document.getElementById('loadHolidaysBtn');
    if (syncBtn) {
        syncBtn.addEventListener('click', syncHolidaysFromAPI);
    }

    // 关闭表单按钮
    const closeBtn = document.getElementById('closeHolidayFormBtn');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeHolidayForm);
    }

    // 取消按钮
    const cancelBtn = document.getElementById('cancelHolidayFormBtn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeHolidayForm);
    }

    // 表单提交
    const form = document.getElementById('holidayForm');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const mode = form.dataset.mode;
            const data = {
                year: parseInt(document.getElementById('holidayYear').value),
                type: document.getElementById('holidayType').value,
                label: document.getElementById('holidayLabel').value,
                start_date: document.getElementById('holidayStart').value,
                end_date: document.getElementById('holidayEnd').value
            };

            if (mode === 'edit') {
                data.id = form.dataset.id;
            }

            // 验证日期范围
            if (data.start_date && data.end_date && data.start_date > data.end_date) {
                window.showToast('结束日期不能早于开始日期', 'error');
                return;
            }

            await saveHoliday(data);
        });
    }
}

// 暴露全局函数（兼容 legacy-adapter）
window.openHolidayForm = openHolidayForm;
window.closeHolidayForm = closeHolidayForm;
window.loadHolidays = loadHolidays;
