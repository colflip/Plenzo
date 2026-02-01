/**
 * User Manager Module
 * @description 处理用户管理相关的逻辑：列表加载、增删改查、表单处理
 */

import { USER_FIELDS, FIELD_LABELS, TIME_ZONE, getUserStatusClass, getUserStatusLabel } from './constants.js';
import { adjustSelectMinWidth } from './ui-helper.js';

// Retry helper
/*
- **CRUD Operations**: Confirmed "Edit" and "Delete" buttons are rendered and functional in the last column.
- **Improved Alignment**: Optimized the operations column to ensure Edit and Delete buttons are perfectly centered both horizontally and vertically.
- **Fixed Navigation**: Resolved the interface "jumping" issue. Clicking User Management now directly and stably displays the Teacher view by default.
*/
async function withRetry(fn, retries = 2, delayMs = 800) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn(attempt, attempt === retries);
        } catch (err) {
            lastErr = err;
            const status = err && err.status;
            if (status === 400 || status === 409 || status === 404) break;
            if (attempt < retries) {
                await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
            }
        }
    }
    throw lastErr;
}

function logOperation(action, status, details = {}) {
    try {
        window.__opLogs = window.__opLogs || [];
        window.__opLogs.push({ ts: new Date().toISOString(), action, status, details });
    } catch (_) { }
}



async function handleUserFormSubmit(e) {
    e.preventDefault();
    const userForm = e.target;
    // 防重复提交
    if (userForm.dataset.submitting === 'true') return;
    userForm.dataset.submitting = 'true';

    const submitBtn = document.getElementById('userFormSubmit');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '保存中…'; }

    try {
        const mode = userForm.dataset.mode;
        const id = userForm.dataset.id;
        const type = document.getElementById('userType').value;
        const username = document.getElementById('userUsername').value.trim();
        const name = document.getElementById('userName').value.trim();
        const password = document.getElementById('userPassword').value.trim();

        // Construct body
        const body = { userType: type, username, name };
        if (mode === 'add') body.password = password;

        // Type-specific fields
        if (type === 'admin') {
            const permissionLevelInput = document.getElementById('userPermissionLevel');
            const emailInput = document.getElementById('userEmail');

            if (!permissionLevelInput || !permissionLevelInput.value.trim()) throw new Error('请填写权限级别(1-3)');
            const lvl = parseInt(permissionLevelInput.value, 10);
            if (isNaN(lvl) || lvl < 1 || lvl > 3) throw new Error('权限级别范围为1-3');
            body.permission_level = lvl;

            const emailVal = emailInput ? emailInput.value.trim() : '';
            if (mode === 'add') {
                if (window.apiUtils) {
                    window.apiUtils.validate.required(emailVal, '邮箱');
                    window.apiUtils.validate.email(emailVal, '邮箱');
                }
                body.email = emailVal;
            } else if (emailVal) {
                if (window.apiUtils) window.apiUtils.validate.email(emailVal, '邮箱');
                body.email = emailVal;
            }
        } else {
            const professionInput = document.getElementById('userProfession');
            const contactInput = document.getElementById('userContact');
            const homeAddressInput = document.getElementById('userHomeAddress');
            const statusSelect = document.getElementById('userStatus');

            if (contactInput && contactInput.value) body.contact = contactInput.value.trim();
            if (professionInput && professionInput.value) body.profession = professionInput.value.trim();
            if (homeAddressInput && homeAddressInput.value) body.home_address = homeAddressInput.value.trim();

            if (type === 'teacher') {
                const workLocationInput = document.getElementById('userWorkLocation');
                const restrictionSelect = document.getElementById('userRestriction');
                if (workLocationInput && workLocationInput.value) body.work_location = workLocationInput.value.trim();
                if (restrictionSelect) body.restriction = parseInt(restrictionSelect.value, 10);
            } else if (type === 'student') {
                const visitLocationInput = document.getElementById('userVisitLocation');
                if (visitLocationInput && visitLocationInput.value) body.visit_location = visitLocationInput.value.trim();
            }

            if (statusSelect && statusSelect.value !== '') {
                const sv = parseInt(statusSelect.value, 10);
                if (![-1, 0, 1].includes(sv)) throw new Error('状态值不合法');
                body.status = sv;
            }
        }

        // Conflict detection for edit
        if (mode === 'edit') {
            const snapJson = userForm.dataset.snapshot || '{}';
            let snapshot = JSON.parse(snapJson);
            let latest;
            try {
                latest = await withRetry(() => window.apiUtils.get(`/admin/users/${type}/${id}`));
                latest = latest && latest.data ? latest.data : latest;
            } catch (err) { latest = null; }

            if (latest) {
                const conflictKeys = ['username', 'name', 'email', 'permission_level', 'profession', 'contact', 'work_location', 'home_address', 'visit_location'];
                const changed = conflictKeys.some(k => String(latest[k] ?? '') !== String(snapshot[k] ?? ''));
                if (changed) {
                    const proceed = confirm('检测到该用户已被其他人修改，是否仍继续保存您的更改？');
                    if (!proceed) throw new Error('USER_CANCELLED');
                }
            }
        }

        // Submit
        if (mode === 'add') {
            const resp = await withRetry((attempt, isFinal) => window.apiUtils.post('/admin/users', body, { suppressErrorToast: !isFinal }));
            const newUser = resp && resp.data ? resp.data : resp;
            closeUserFormModal();
            appendUserRow(type, newUser);
            refreshLocalCache(type, newUser);
            logOperation('createUser', 'success', { type, username });
            if (window.apiUtils) window.apiUtils.showSuccessToast('用户已添加');

            // Backend confirm and refresh
            try {
                const confirmItem = await withRetry(() => window.apiUtils.get(`/admin/users/${type}/${newUser.id}`));
                if (confirmItem) {
                    loadUsers(type, { reset: true }); // refresh table
                    refreshFullUserCache(type);
                }
            } catch (e) { console.warn('Refresh after add failed', e); }
        } else {
            await withRetry((attempt, isFinal) => window.apiUtils.put(`/admin/users/${type}/${id}`, body, { suppressErrorToast: !isFinal }));
            closeUserFormModal();
            logOperation('updateUser', 'success', { type, id });
            if (window.apiUtils) window.apiUtils.showSuccessToast('保存成功');
            loadUsers(type, { reset: true });
            refreshFullUserCache(type);
        }

    } catch (err) {
        if (err.message === 'USER_CANCELLED') {
            if (window.apiUtils) window.apiUtils.showToast('已取消保存', 'info');
        } else {
            console.error('保存用户失败:', err);
            if (window.apiUtils) window.apiUtils.showToast(err.message || '保存失败', 'error');
        }
    } finally {
        userForm.dataset.submitting = 'false';
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '保存'; }
    }
}

function refreshLocalCache(type, newUser) {
    window.__usersCache = window.__usersCache || {};
    const list = window.__usersCache[type] || [];
    window.__usersCache[type] = list.concat(newUser);
}

export async function loadUsers(type, opts = {}) {
    try {
        const initialType = type || 'teacher';
        window.__usersState = window.__usersState || {
            type: initialType,
            page: 1,
            pageSize: 20,
            sort: initialType === 'admin' ? { key: 'permission_level', direction: 'desc' } : { key: 'status', direction: 'asc' },
            loading: false,
            hasMore: true
        };
        const state = window.__usersState;

        if (type && type !== state.type) {
            state.type = type;
            state.page = 1;
            state.hasMore = true;
            const tbody = document.getElementById('usersTableBody');
            if (tbody) tbody.innerHTML = '';
            window.__usersCache = window.__usersCache || {};
            window.__usersCache[state.type] = [];
            state.sort = (type === 'admin') ? { key: 'permission_level', direction: 'desc' } : { key: 'status', direction: 'asc' };
        }

        // Sync Tab UI
        const tabs = document.querySelectorAll('#userRoleTabs .tab-btn');
        tabs.forEach(t => {
            if (t.dataset.type === state.type) t.classList.add('active');
            else t.classList.remove('active');
        });

        if (opts.reset) {
            state.page = 1;
            state.hasMore = true;
            const tbody = document.getElementById('usersTableBody');
            if (tbody) tbody.innerHTML = '';
            window.__usersCache = window.__usersCache || {};
            window.__usersCache[state.type] = [];
        }

        renderUsersTableHeader(state.type);
        const tbody = document.getElementById('usersTableBody');
        if (!tbody) return;

        // Stale-while-revalidate strategy:
        // 1. Try to render from cache immediately
        let renderedFromCache = false;
        if (opts.useCache !== false) { // Default to true unless explicitly disabled
            const cacheKey = state.type; // simple key
            const cachedList = (window.__usersCache && window.__usersCache[cacheKey]);
            if (cachedList && cachedList.length > 0) {
                // Determine if cache covers the requested page
                const startIdx = (state.page - 1) * state.pageSize;
                const endIdx = startIdx + state.pageSize;
                // If we have data for this page in cache (approximate check)
                if (cachedList.length >= startIdx) {
                    renderFromCache(state, tbody);
                    renderedFromCache = true;
                    // Don't return! Continue to fetch fresh data.
                }
            }
        }

        if (state.loading || !state.hasMore) return;

        // 显示加载中提示 - Only if NOT rendered from cache
        if (state.page === 1 && !opts.append && !renderedFromCache) {
            tbody.innerHTML = `
                <tr class="loading-row">
                    <td colspan="15" style="text-align: center; padding: 40px; color: #64748b;">
                        <div style="display: flex; flex-direction: column; align-items: center; gap: 12px;">
                            <div class="loading-spinner" style="margin: 0 auto;"></div>
                            <span>正在加载用户数据...</span>
                        </div>
                    </td>
                </tr>
            `;
        }

        state.loading = true;

        const data = await window.apiUtils.get(`/admin/users/${state.type}`, {
            page: state.page,
            size: state.pageSize
        });

        const users = Array.isArray(data) ? data : (data.users || data.data || data.results || []);

        // 加载完成，如果是第一页或不追加模式，则清空容器（移除加载行）
        if (!opts.append) {
            tbody.innerHTML = '';
        } else {
            // 如果是追加模式，尝试移除可能存在的单一加载行
            const loadingRows = tbody.querySelectorAll('.loading-row');
            loadingRows.forEach(row => row.remove());
        }
        if (state.page === 1 && users.length === 0) {
            tbody.innerHTML = `<tr><td colspan="${(USER_FIELDS[state.type] || []).length + 1}">暂无数据</td></tr>`;
            state.hasMore = false;
            state.loading = false;
            return;
        }

        users.forEach(u => appendUserRow(state.type, u));

        // Cache update
        window.__usersCache = window.__usersCache || {};
        const list = window.__usersCache[state.type] || [];
        window.__usersCache[state.type] = list.concat(users);

        if (users.length < state.pageSize) {
            state.hasMore = false;
        } else {
            state.page += 1;
        }
        state.loading = false;

        setupSentinel(state, tbody);

    } catch (err) {
        console.error('加载用户列表错误:', err);
        const state = window.__usersState || {};
        state.loading = false;
        if (window.apiUtils) window.apiUtils.showToast('加载用户列表失败', 'error');
    }
}

function renderFromCache(state, tbody) {
    const rawList = (window.__usersCache && window.__usersCache[state.type]) || [];
    const key = state.sort?.key || 'created_at';
    const dir = state.sort?.direction === 'asc' ? 1 : -1;

    const toRender = [...rawList].sort((a, b) => {
        let av = a[key];
        let bv = b[key];
        if (key === 'status') {
            const weight = (v) => { const n = Number(v); return n === 1 ? 0 : n === 0 ? 1 : n === -1 ? 2 : 3; };
            const wa = weight(av), wb = weight(bv);
            if (wa !== wb) return (wa - wb) * dir;
            return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
        }
        if (key === 'last_login' || key === 'created_at') {
            av = av ? new Date(av).getTime() : 0;
            bv = bv ? new Date(bv).getTime() : 0;
        }
        if (av === bv) return 0;
        return av > bv ? dir : -dir;
    });

    tbody.innerHTML = '';
    toRender.forEach(u => appendUserRow(state.type, u));
    const sentinel = document.getElementById('usersListSentinel');
    if (sentinel) sentinel.remove();
}

function setupSentinel(state, tbody) {
    let sentinel = document.getElementById('usersListSentinel');
    if (!sentinel && state.hasMore) {
        sentinel = document.createElement('tr');
        sentinel.id = 'usersListSentinel';
        sentinel.innerHTML = `<td colspan="${(USER_FIELDS[state.type] || []).length + 2}"></td>`;
        tbody.appendChild(sentinel);
        const io = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    loadUsers(state.type);
                }
            });
        });
        io.observe(sentinel);
        state._io = io;
    }
}

export function renderUsersTableHeader(type) {
    const thead = document.querySelector('#usersTable thead');
    if (!thead) return;
    const tr = thead.querySelector('tr');
    if (!tr) return;
    tr.innerHTML = '';

    const fields = USER_FIELDS[type] || USER_FIELDS['admin'];
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
            loadUsers(state.type, { useCache: true, sortField: field });
        });
        tr.appendChild(th);
    });

    const opsTh = document.createElement('th');
    opsTh.textContent = '操作';
    tr.appendChild(opsTh);
}

export function appendUserRow(type, user) {
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;

    const tr = document.createElement('tr');
    const fields = USER_FIELDS[type] || USER_FIELDS['admin'];

    fields.forEach(field => {
        const td = document.createElement('td');
        td.classList.add(`col-${field}`);
        let value = user[field];

        if (field === 'last_login' || field === 'created_at') {
            if (value) {
                const date = new Date(value);
                const formatter = new Intl.DateTimeFormat('en-CA', {
                    timeZone: TIME_ZONE,
                    year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit', second: '2-digit',
                    hour12: false
                });
                value = formatter.format(date).replace(', ', ' ');
            } else value = '';
        }
        if (field === 'contact') value = user.contact || user.phone || user.email || '';
        if (field === 'status') {
            const badge = document.createElement('span');
            badge.className = `status-badge ${getUserStatusClass(value)}`;
            badge.textContent = getUserStatusLabel(value);
            td.appendChild(badge);
        } else {
            const span = document.createElement('span');
            span.className = 'clip';
            span.textContent = (value ?? '');
            td.appendChild(span);
        }
        tr.appendChild(td);
    });

    const actionsCell = document.createElement('td');
    actionsCell.classList.add('actions');
    actionsCell.innerHTML = `
        <button class="btn-icon edit-btn" title="编辑">
            <span class="material-icons-round">edit</span>
        </button>
        <button class="btn-icon delete-btn" title="删除" style="color: #ef4444;">
            <span class="material-icons-round">delete</span>
        </button>
    `;
    // Bind events directly
    actionsCell.querySelector('.edit-btn').addEventListener('click', () => showEditUserModal(user.id, type));
    actionsCell.querySelector('.delete-btn').addEventListener('click', () => deleteUser(type, user.id));

    tr.appendChild(actionsCell);
    tbody.appendChild(tr);
}

export function showAddUserModal() {
    const form = document.getElementById('userForm');
    if (!form) return;
    document.getElementById('userFormTitle').textContent = '添加用户';
    form.reset();
    form.dataset.mode = 'add';
    form.dataset.id = '';

    // Default values
    document.getElementById('userType').value = 'admin';
    const statusSelect = document.getElementById('userStatus');
    if (statusSelect) statusSelect.value = '1';

    document.getElementById('userPassword').required = true;

    toggleContactFields('admin');
    openUserFormModal();
}

export function showEditUserModal(id, userType) {
    const users = (window.__usersCache && window.__usersCache[userType]) || [];
    const user = users.find(u => String(u.id) === String(id));
    if (!user) { console.warn('User not found in cache'); return; }

    const form = document.getElementById('userForm');
    document.getElementById('userFormTitle').textContent = '编辑用户';
    form.dataset.mode = 'edit';
    form.dataset.id = id;

    // Fill fields - simplified for brevity, assume elements exist
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    setVal('userUsername', user.username);
    setVal('userName', user.name);
    if (userType === 'admin') {
        setVal('userPermissionLevel', user.permission_level);
        setVal('userEmail', user.email);
    }
    setVal('userContact', user.contact);
    setVal('userProfession', user.profession);
    setVal('userWorkLocation', user.work_location);
    setVal('userHomeAddress', user.home_address);
    setVal('userVisitLocation', user.visit_location);

    document.getElementById('userType').value = userType;
    document.getElementById('userPassword').required = false;

    const statusSelect = document.getElementById('userStatus');
    if (statusSelect && userType !== 'admin') statusSelect.value = String(user.status ?? 1);

    const restrictionSelect = document.getElementById('userRestriction');
    if (restrictionSelect && userType === 'teacher') restrictionSelect.value = String(user.restriction ?? 1);

    toggleContactFields(userType);
    openUserFormModal();

    // Snapshot for conflict
    form.dataset.snapshot = JSON.stringify(user);
}

export function openUserFormModal() {
    const overlay = document.getElementById('modalOverlay');
    const container = document.getElementById('userFormContainer');
    if (overlay) overlay.style.display = 'block';
    if (container) container.style.display = 'block';

    const escHandler = (e) => { if (e.key === 'Escape') closeUserFormModal(); };
    document.addEventListener('keydown', escHandler, { once: true });
    if (overlay) overlay.addEventListener('click', closeUserFormModal, { once: true });
}

export function closeUserFormModal() {
    const overlay = document.getElementById('modalOverlay');
    const container = document.getElementById('userFormContainer');
    if (overlay) overlay.style.display = 'none';
    if (container) container.style.display = 'none';
}

export function setupUserEventListeners() {
    const userRoleTabs = document.getElementById('userRoleTabs');
    if (userRoleTabs) {
        userRoleTabs.addEventListener('click', (e) => {
            const btn = e.target.closest('.tab-btn');
            if (!btn) return;
            const type = btn.dataset.type;
            const allTabs = userRoleTabs.querySelectorAll('.tab-btn');
            allTabs.forEach(t => t.classList.remove('active'));
            btn.classList.add('active');
            loadUsers(type, { reset: true });
        });
    }

    const addUserBtn = document.getElementById('addUserBtn');
    if (addUserBtn) {
        addUserBtn.addEventListener('click', showAddUserModal);
    }

    const userForm = document.getElementById('userForm');
    if (userForm) {
        userForm.addEventListener('submit', handleUserFormSubmit);
    }

    // 新增：监听用户类型切换，动态调整表单字段
    const userTypeSelect = document.getElementById('userType');
    if (userTypeSelect) {
        userTypeSelect.addEventListener('change', (e) => {
            toggleContactFields(e.target.value);
        });
    }
}



function toggleContactFields(userType) {
    const groups = {
        permission: document.getElementById('userPermissionLevelGroup'),
        email: document.getElementById('userEmailGroup'),
        contact: document.getElementById('userContactGroup'),
        profession: document.getElementById('userProfessionGroup'),
        work: document.getElementById('userWorkLocationGroup'),
        home: document.getElementById('userHomeAddressGroup'),
        visit: document.getElementById('userVisitLocationGroup'),
        status: document.getElementById('userStatusGroup'),
        restriction: document.getElementById('userRestrictionGroup')
    };

    // Hide all first
    Object.values(groups).forEach(g => { if (g) g.style.display = 'none'; });

    if (userType === 'admin') {
        if (groups.permission) groups.permission.style.display = 'block';
        if (groups.email) groups.email.style.display = 'block';
    } else {
        if (groups.contact) groups.contact.style.display = 'block';
        if (groups.profession) groups.profession.style.display = 'block';
        if (groups.home) groups.home.style.display = 'block';
        if (groups.status) groups.status.style.display = 'block';

        if (userType === 'teacher') {
            if (groups.work) groups.work.style.display = 'block';
            if (groups.restriction) groups.restriction.style.display = 'block';
        }
        if (userType === 'student' && groups.visit) {
            groups.visit.style.display = 'block';
        }
    }
}

export async function deleteUser(userType, userId) {
    if (!confirm('确定要删除该用户吗？')) return;
    try {
        await window.apiUtils.delete(`/admin/users/${userType}/${userId}`);
        logOperation('deleteUser', 'success', { type: userType, id: userId });
        if (window.apiUtils) window.apiUtils.showSuccessToast('删除成功');
        loadUsers(userType, { reset: true });
        refreshFullUserCache(userType);
    } catch (err) {
        console.error('删除用户失败:', err);
        if (window.apiUtils) window.apiUtils.showToast('删除失败', 'error');
    }
}

export async function refreshFullUserCache(type) {
    if (!window.apiUtils) return;
    if (!type) {
        refreshFullUserCache('student');
        refreshFullUserCache('teacher');
        return;
    }
    const storageKey = type === 'student' ? 'cached_students_full' : 'cached_teachers_full';
    try {
        const response = await window.apiUtils.get(`/admin/users/${type}`);
        const list = Array.isArray(response) ? response : (response.data || []);
        localStorage.setItem(storageKey, JSON.stringify(list));
    } catch (e) {
        console.warn(`[Cache] Failed to refresh ${type} cache`, e);
    }
}
