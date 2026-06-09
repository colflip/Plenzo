/**
 * Holiday Manager Module
 * 管理员端节假日管理功能
 */

import { showTableLoading, hideTableLoading } from './ui-helper.js';

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
        // 优先从 API 加载，失败则使用本地缓存数据
        const result = await window.apiUtils.get('/admin/holidays');
        holidayData = Array.isArray(result) ? result : (result.data || []);
        renderHolidaysTable(holidayData);
    } catch (err) {
        // API 不可用时使用本地预填充数据
        console.warn('Holiday API unavailable, using fallback data:', err.message);
        holidayData = getFallbackHolidays();
        renderHolidaysTable(holidayData);
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
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;padding:20px;">暂无节假日数据，可手动添加或点击"从 API 同步"</td></tr>';
        return;
    }

    const sorted = data.sort((a, b) => {
        if (a.year !== b.year) return a.year - b.year;
        return a.start_date.localeCompare(b.start_date);
    });

    tbody.innerHTML = sorted.map(item => `
        <tr data-id="${item.id || ''}">
            <td>${item.year || ''}</td>
            <td>${item.type === 'makeup' ? '调休补班' : '法定节假日'}</td>
            <td>${formatDateRange(item.start_date, item.end_date)}</td>
            <td>${item.label || ''}</td>
            <td>
                <button class="edit-btn" data-id="${item.id || ''}" title="编辑" style="background:none;border:none;color:#2ECC71;cursor:pointer;margin-right:8px;">
                    <span class="material-icons-round" style="font-size:18px;">edit</span>
                </button>
                <button class="delete-btn" data-id="${item.id || ''}" title="删除" style="background:none;border:none;color:#ef4444;cursor:pointer;">
                    <span class="material-icons-round" style="font-size:18px;">delete</span>
                </button>
            </td>
        </tr>
    `).join('');

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
            const result = await window.apiUtils.put(`/admin/holidays/${data.id}`, data);
            window.showToast('节假日已更新', 'success');
        } else {
            // 新增
            const result = await window.apiUtils.post('/admin/holidays', data);
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
    if (!id || !confirm('确定删除此节假日记录？')) return;
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
        const rows = Array.isArray(result) ? result : (result.data || []);
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
// 本地预填充 fallback 数据
// ========================
function getFallbackHolidays() {
    return [
        // 2025 节假日
        { id: 'fb-2025-1', year: 2025, type: 'holiday', label: '元旦假期', start_date: '2025-01-01', end_date: '2025-01-01' },
        { id: 'fb-2025-2', year: 2025, type: 'holiday', label: '春节假期', start_date: '2025-01-28', end_date: '2025-02-04' },
        { id: 'fb-2025-3', year: 2025, type: 'holiday', label: '清明节假期', start_date: '2025-04-04', end_date: '2025-04-06' },
        { id: 'fb-2025-4', year: 2025, type: 'holiday', label: '劳动节假期', start_date: '2025-05-01', end_date: '2025-05-05' },
        { id: 'fb-2025-5', year: 2025, type: 'holiday', label: '端午节假期', start_date: '2025-05-31', end_date: '2025-06-02' },
        { id: 'fb-2025-6', year: 2025, type: 'holiday', label: '国庆节假期', start_date: '2025-10-01', end_date: '2025-10-08' },
        { id: 'fb-2025-7', year: 2025, type: 'holiday', label: '中秋节假期', start_date: '2025-10-01', end_date: '2025-10-08' },
        { id: 'fb-2025-m1', year: 2025, type: 'makeup', label: '春节前补班', start_date: '2025-01-26', end_date: '2025-01-26' },
        { id: 'fb-2025-m2', year: 2025, type: 'makeup', label: '春节后补班', start_date: '2025-02-08', end_date: '2025-02-08' },
        { id: 'fb-2025-m3', year: 2025, type: 'makeup', label: '劳动节前补班', start_date: '2025-04-27', end_date: '2025-04-27' },
        { id: 'fb-2025-m4', year: 2025, type: 'makeup', label: '国庆节前补班', start_date: '2025-09-28', end_date: '2025-09-28' },
        { id: 'fb-2025-m5', year: 2025, type: 'makeup', label: '国庆节后补班', start_date: '2025-10-11', end_date: '2025-10-11' },
        // 2026 节假日
        { id: 'fb-2026-1', year: 2026, type: 'holiday', label: '元旦假期', start_date: '2026-01-01', end_date: '2026-01-03' },
        { id: 'fb-2026-2', year: 2026, type: 'holiday', label: '春节假期', start_date: '2026-02-15', end_date: '2026-02-23' },
        { id: 'fb-2026-3', year: 2026, type: 'holiday', label: '清明节假期', start_date: '2026-04-04', end_date: '2026-04-06' },
        { id: 'fb-2026-4', year: 2026, type: 'holiday', label: '劳动节假期', start_date: '2026-05-01', end_date: '2026-05-05' },
        { id: 'fb-2026-5', year: 2026, type: 'holiday', label: '端午节假期', start_date: '2026-06-19', end_date: '2026-06-21' },
        { id: 'fb-2026-6', year: 2026, type: 'holiday', label: '中秋节假期', start_date: '2026-09-25', end_date: '2026-09-27' },
        { id: 'fb-2026-7', year: 2026, type: 'holiday', label: '国庆节假期', start_date: '2026-10-01', end_date: '2026-10-07' },
        { id: 'fb-2026-m1', year: 2026, type: 'makeup', label: '元旦后补班', start_date: '2026-01-04', end_date: '2026-01-04' },
        { id: 'fb-2026-m2', year: 2026, type: 'makeup', label: '春节前补班', start_date: '2026-02-14', end_date: '2026-02-14' },
        { id: 'fb-2026-m3', year: 2026, type: 'makeup', label: '春节后补班', start_date: '2026-02-28', end_date: '2026-02-28' },
        { id: 'fb-2026-m4', year: 2026, type: 'makeup', label: '劳动节后补班', start_date: '2026-05-09', end_date: '2026-05-09' },
        { id: 'fb-2026-m5', year: 2026, type: 'makeup', label: '中秋节前补班', start_date: '2026-09-20', end_date: '2026-09-20' },
        { id: 'fb-2026-m6', year: 2026, type: 'makeup', label: '国庆节后补班', start_date: '2026-10-10', end_date: '2026-10-10' },
        // 2027 预填（国务院尚未正式发布，以下为预测数据）
        { id: 'fb-2027-1', year: 2027, type: 'holiday', label: '元旦假期', start_date: '2027-01-01', end_date: '2027-01-03' },
        { id: 'fb-2027-2', year: 2027, type: 'holiday', label: '春节假期', start_date: '2027-02-17', end_date: '2027-02-23' },
        { id: 'fb-2027-3', year: 2027, type: 'holiday', label: '清明节假期', start_date: '2027-04-03', end_date: '2027-04-05' },
        { id: 'fb-2027-4', year: 2027, type: 'holiday', label: '劳动节假期', start_date: '2027-05-01', end_date: '2027-05-05' },
        { id: 'fb-2027-5', year: 2027, type: 'holiday', label: '端午节假期', start_date: '2027-06-12', end_date: '2027-06-14' },
        { id: 'fb-2027-6', year: 2027, type: 'holiday', label: '中秋节假期', start_date: '2027-09-17', end_date: '2027-09-19' },
        { id: 'fb-2027-7', year: 2027, type: 'holiday', label: '国庆节假期', start_date: '2027-10-01', end_date: '2027-10-07' }
    ];
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
