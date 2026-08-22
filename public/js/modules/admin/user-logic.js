// Extracted User Management Logic
// Delegates to UserManager and handles some legacy table rendering

import { USER_FIELDS, FIELD_LABELS, TIME_ZONE, getUserStatusClass, getUserStatusLabel } from './constants.js';

// 渲染用户表头（根据类型动态列）
export function renderUsersTableHeader(type) {
    const thead = document.querySelector('#usersTable thead');
    if (!thead) return;
    const tr = thead.querySelector('tr');
    if (!tr) return;
    window.SecurityUtils.safeSetHTML(tr, '');

    // 权限落地（Phase 2）：表格列随操作者级别裁剪（与后端字段下发对齐）
    const baseFields = USER_FIELDS[type] || USER_FIELDS['admin'];
    const fields = (window.permissionUtils && window.permissionUtils.visibleFields)
        ? window.permissionUtils.visibleFields(baseFields)
        : baseFields;
    fields.forEach(field => {
        const th = document.createElement('th');
        th.classList.add(`col-${field}`);
        th.textContent = (type === 'student' && field === 'profession') ? '年级' : (FIELD_LABELS[field] || field);
        th.dataset.field = field;
        th.style.cursor = 'pointer';
        th.addEventListener('click', () => {
            const state = window.__usersState || { type };
            state.sort = state.sort || { key: 'created_at', direction: 'desc' };
            if (state.sort.key === field) {
                state.sort.direction = state.sort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                state.sort.key = field;
                state.sort.direction = 'asc';
            }
            // 重置分页并清空缓存，避免排序时出现重复行
            state.page = 1;
            state.hasMore = true;
            window.__usersCache = window.__usersCache || {};
            window.__usersCache[state.type] = [];
            loadUsers(state.type, { reset: true });
        });
        tr.appendChild(th);
    });

    // 权限落地（Phase 3）：非 L1 不渲染「操作」列表头
    if (!window.permissionUtils || window.permissionUtils.isSuperAdmin()) {
        const opsTh = document.createElement('th');
        opsTh.textContent = '操作';
        tr.appendChild(opsTh);
    }
}

// 追加一行用户数据
export function appendUserRow(type, user) {
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;

    const tr = document.createElement('tr');

    // 权限落地（Phase 2）：行内列与表头使用同一份裁剪结果
    const baseFields = USER_FIELDS[type] || USER_FIELDS['admin'];
    const fields = (window.permissionUtils && window.permissionUtils.visibleFields)
        ? window.permissionUtils.visibleFields(baseFields)
        : baseFields;
    fields.forEach(field => {
        const td = document.createElement('td');
        td.classList.add(`col-${field}`);
        let value = user[field];
        if (field === 'created_at' || field === 'last_login') {
            if (user[field]) {
                const date = new Date(user[field]);
                const formatter = new Intl.DateTimeFormat('en-CA', {
                    timeZone: TIME_ZONE,
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false
                });
                value = formatter.format(date).replace(', ', ' ');
            } else {
                value = '';
            }
        }
        if (field === 'contact') {
            value = user.contact || user.phone || user.email || '';
        }
        if (field === 'status') {
            const badge = document.createElement('span');
            badge.className = `status-badge ${getUserStatusClass(value)}`;
            badge.textContent = getUserStatusLabel(value);
            badge.title = `当前状态：${getUserStatusLabel(value)}`;
            td.appendChild(badge);
        } else {
            const span = document.createElement('span');
            span.className = 'clip';
            span.textContent = (value ?? '');
            span.title = String(value ?? '');
            td.appendChild(span);
        }
        tr.appendChild(td);
    });

    const actionsCell = document.createElement('td');
    actionsCell.classList.add('actions');
    // 权限落地（Phase 2）：账号增删改仅 L1（后端路由门禁兜底），非 L1 不渲染操作按钮
    const canManageAccounts = !window.permissionUtils || window.permissionUtils.isSuperAdmin();
    if (canManageAccounts) {
        const safeId = window.SecurityUtils ? window.SecurityUtils.escapeHtml(String(user.id || '')) : String(user.id || '');
        const safeType = window.SecurityUtils ? window.SecurityUtils.escapeHtml(String(type || '')) : String(type || '');
        // 权限落地（Phase 3）：不能删除自己的账号——自己的行不渲染删除按钮
        let meId = '';
        try { meId = String(JSON.parse(localStorage.getItem('userData') || '{}').id ?? ''); } catch (_) { /* ignore */ }
        const isSelfRow = String(user.id) === meId;
        const delBtnHtml = isSelfRow ? '' :
            `<button class="action-btn delete-btn" data-id="${safeId}" data-type="${safeType}">删除</button>`;
        if (window.SecurityUtils) {
            window.SecurityUtils.safeSetHTML(actionsCell, `
                <button class="action-btn edit-btn" data-id="${safeId}" data-type="${safeType}">编辑</button>
                ${delBtnHtml}
            `);
        } else {
            actionsCell.innerHTML = `
                <button class="action-btn edit-btn" data-id="${safeId}" data-type="${safeType}">编辑</button>
                ${delBtnHtml}
            `;
        }
    }
    if (canManageAccounts) {
        tr.appendChild(actionsCell);
        const editBtn = actionsCell.querySelector('.edit-btn');
        const deleteBtn = actionsCell.querySelector('.delete-btn');
        if (editBtn) {
            editBtn.addEventListener('click', () => showEditUserModal(user.id, type));
        }
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => deleteUser(type, user.id));
        }
    }

    tbody.appendChild(tr);
}


// 分页加载用户列表，支持搜索与虚拟滚动
// 全量更新本地用户缓存（用于导出等功能）
export async function refreshFullUserCache(type) {
    if (window.UserManager?.refreshFullUserCache) {
        return window.UserManager.refreshFullUserCache(type);
    }
}

export async function loadUsers(type, opts = {}) {
    if (window.UserManager && window.UserManager.loadUsers) {
        return window.UserManager.loadUsers(type, opts);
    }
    
}

// 用户管理：委托给 UserManager
export function showAddUserModal() {
    if (window.UserManager) window.UserManager.showAddUserModal();
}
export function showEditUserModal(id, userType) {
    if (window.UserManager) window.UserManager.showEditUserModal(id, userType);
}
export function closeUserFormModal() {
    if (window.UserManager) window.UserManager.closeUserFormModal();
}
export function toggleContactFields(type) {
    
    // If needed, we can call a method if exposed. Usually not needed globally.
}
export function openUserFormModal(c, o) {
    // Internal to UserManager usually.
}
export function editUser() { } // No-op
export async function deleteUser(type, id) {
    if (window.UserManager) return window.UserManager.deleteUser(type, id);
}
export function setUsersLoading(isLoading) {
    // Possibly used by other parts? If so, reimplement or keep.
    // user-manager likely handles loading state itself.
}


// Expose these globally since legacy inline handlers might need them
window.renderUsersTableHeader = renderUsersTableHeader;
window.appendUserRow = appendUserRow;
window.refreshFullUserCache = refreshFullUserCache;
window.loadUsers = loadUsers;
window.showAddUserModal = showAddUserModal;
window.showEditUserModal = showEditUserModal;
window.closeUserFormModal = closeUserFormModal;
window.toggleContactFields = toggleContactFields;
window.openUserFormModal = openUserFormModal;
window.editUser = editUser;
window.deleteUser = deleteUser;
window.setUsersLoading = setUsersLoading;

