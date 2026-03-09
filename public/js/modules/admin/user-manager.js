/**
 * User Manager Module
 * @description 处理用户管理相关的逻辑：列表加载、增删改查、表单处理
 */

import { USER_FIELDS, FIELD_LABELS, TIME_ZONE, getUserStatusClass, getUserStatusLabel } from './constants.js';
import { adjustSelectMinWidth, showTableLoading, hideTableLoading } from './ui-helper.js';


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

        // 添加ID字段(如果有指定或修改)
        const userIdInput = document.getElementById('userId');
        if (userIdInput && userIdInput.value) {
            const parsedId = parseInt(userIdInput.value, 10);
            if (mode === 'add') {
                body.id = parsedId;
            } else if (mode === 'edit' && String(parsedId) !== String(id)) {
                body.new_id = parsedId;
            }
        }

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
                const studentIdsInput = document.getElementById('userStudentIds');
                if (workLocationInput && workLocationInput.value) body.work_location = workLocationInput.value.trim();
                if (restrictionSelect) body.restriction = parseInt(restrictionSelect.value, 10);
                if (studentIdsInput) body.student_ids = studentIdsInput.value.trim(); // Always submit regardless of empty to allow unchecking all
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
            } catch (e) {  }
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
            sort: { key: 'id', direction: 'asc' },
            loading: false,
            hasMore: true
        };
        const state = window.__usersState;

        if (type && type !== state.type) {
            state.type = type;
            state.page = 1;
            state.hasMore = true;
            const tbody = document.getElementById('usersTableBody');
            if (tbody) if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, ''); } else { tbody.innerHTML = ''; }
            window.__usersCache = window.__usersCache || {};
            window.__usersCache[state.type] = [];
            state.sort = { key: 'id', direction: 'asc' };
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
            if (tbody) if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, ''); } else { tbody.innerHTML = ''; }
            window.__usersCache = window.__usersCache || {};
            window.__usersCache[state.type] = [];
        }

        // --- Proactive cache warming for teachers ---
        // Load student names if needed to map IDs correctly in the table
        if (state.type === 'teacher' && (!window.__usersCache?.student || window.__usersCache.student.length === 0)) {
            // Non-blocking fetch to ensure names appear after first load or tab switch
            (async () => {
                try {
                    // Try to use full cache from storage first for instant names
                    const cached = localStorage.getItem('cached_students_full');
                    if (cached) {
                        const parsed = JSON.parse(cached);
                        if (Array.isArray(parsed)) {
                            window.__usersCache = window.__usersCache || {};
                            window.__usersCache.student = parsed;
                        }
                    }
                    // Fetch fresh list from server in background if small enough
                    const res = await window.apiUtils.get(`/admin/users/student?limit=1000`);
                    const list = res?.data || res || [];
                    if (Array.isArray(list)) {
                        window.__usersCache = window.__usersCache || {};
                        window.__usersCache.student = list;
                        localStorage.setItem('cached_students_full', JSON.stringify(list));

                        // If we already finished rendering teachers, they might show [ID]. 
                        // A quick re-render from cache would fix it if needed.
                        // However, appendUserRow is usually fast enough that if this resolves before 
                        // the teacher request finishes, it will be fine.
                    }
                } catch (e) {  }
            })();
        }

        // 1. 立即渲染/刷新表头，确保 showTableLoading 能正确避开它
        renderUsersTableHeader(state.type);

        const tbody = document.getElementById('usersTableBody');
        if (!tbody) return;

        const tableContainer = document.querySelector('#users.dashboard-section .table-container');

        // 2. 状态拦截检查（必须在显示加载动画之前）
        if (state.loading && state.page > 1) {
            // 如果正在加载且不是第一页，不阻塞
        } else if (state.loading) {
            // 第一页正在加载中，直接返回
            return;
        }
        
        if (!state.hasMore && !opts.reset && state.page > 1) {
            // 非第一页且没有更多数据，不加载
            return;
        }

        // 3. 显示加载动画策略
        // 始终在第一页非追加模式时显示加载动画，确保首次和后续进入动画一致
        // 先清空tbody，确保动画位置一致
        if (state.page === 1 && !opts.append) {
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, ''); } else { tbody.innerHTML = ''; }
            
            const typeLabels = {
                teacher: '教师',
                student: '学生',
                admin: '管理员'
            };
            const loadingText = `正在加载${typeLabels[state.type] || ''}用户数据...`;
            showTableLoading(tableContainer, loadingText);
        }

        // 4. 设置加载状态
        state.loading = true;

        const data = await window.apiUtils.get(`/admin/users/${state.type}`, {
            page: state.page,
            size: state.pageSize
        });

        const users = Array.isArray(data) ? data : (data.users || data.data || data.results || []);

        // 加载完成，如果是第一页或不追加模式，则清空容器（移除显示残余内容）
        if (!opts.append) {
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, ''); } else { tbody.innerHTML = ''; }
        }
        
        // 隐藏加载动画
        hideTableLoading(tableContainer);

        if (state.page === 1 && users.length === 0) {
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, `<tr><td colspan="${(USER_FIELDS[state.type] || []).length + 1}">暂无数据</td></tr>`); } else { tbody.innerHTML = `<tr><td colspan="${(USER_FIELDS[state.type] || []).length + 1}">暂无数据</td></tr>`; }
            state.hasMore = false;
            state.loading = false;
            return;
        }

        // 对教师数据按ID升序排序
        if (state.type === 'teacher') {
            users.sort((a, b) => {
                const idA = parseInt(a.id) || 0;
                const idB = parseInt(b.id) || 0;
                return idA - idB; // 升序
            });
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
        
        const state = window.__usersState || {};
        state.loading = false;
        const tableContainer = document.querySelector('#users.dashboard-section .table-container');
        hideTableLoading(tableContainer);
        
        const tbody = document.getElementById('usersTableBody');
        const typeLabels = {
            teacher: '教师',
            student: '学生',
            admin: '管理员'
        };
        const errorMsg = err?.message || '网络错误';
        const errorText = `加载${typeLabels[state.type] || ''}用户数据失败`;
        
        if (tbody) {
            if (window.SecurityUtils) {
                window.SecurityUtils.safeSetHTML(tbody, `
                    <tr>
                        <td colspan="${(USER_FIELDS[state.type] || []).length + 1}">
                            <div style="text-align: center; padding: 40px 20px;">
                                <div style="color: #ef4444; margin-bottom: 12px;">
                                    <span class="material-icons-round" style="font-size: 48px;">error_outline</span>
                                </div>
                                <div style="color: #64748b; margin-bottom: 16px;">${errorText}：${errorMsg}</div>
                                <button onclick="window.UserManager?.loadUsers('${state.type}', { reset: true })" 
                                    style="padding: 8px 20px; background: #10b981; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">
                                    <span class="material-icons-round" style="font-size: 18px; vertical-align: middle; margin-right: 4px;">refresh</span>
                                    点击重试
                                </button>
                            </div>
                        </td>
                    </tr>
                `);
            } else {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="${(USER_FIELDS[state.type] || []).length + 1}">
                            <div style="text-align: center; padding: 40px 20px;">
                                <div style="color: #ef4444; margin-bottom: 12px;">
                                    <span class="material-icons-round" style="font-size: 48px;">error_outline</span>
                                </div>
                                <div style="color: #64748b; margin-bottom: 16px;">${errorText}：${errorMsg}</div>
                                <button onclick="window.UserManager?.loadUsers('${state.type}', { reset: true })" 
                                    style="padding: 8px 20px; background: #10b981; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">
                                    <span class="material-icons-round" style="font-size: 18px; vertical-align: middle; margin-right: 4px;">refresh</span>
                                    点击重试
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }
        }
        
        if (window.apiUtils) {
            window.apiUtils.showToast(`${errorText}：${errorMsg}`, 'error');
        }
    }
}

function renderFromCache(state, tbody) {
    const rawList = (window.__usersCache && window.__usersCache[state.type]) || [];
    const key = state.sort?.key || 'created_at';
    const dir = state.sort?.direction === 'asc' ? 1 : -1;

    const toRender = [...rawList].sort((a, b) => {
        let av = a[key];
        let bv = b[key];

        // ID排序特殊处理
        if (key === 'id') {
            return (Number(av) || 0) - (Number(bv) || 0);
        }

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

    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, ''); } else { tbody.innerHTML = ''; }
    toRender.forEach(u => appendUserRow(state.type, u));
    const sentinel = document.getElementById('usersListSentinel');
    if (sentinel) sentinel.remove();
}

function setupSentinel(state, tbody) {
    let sentinel = document.getElementById('usersListSentinel');
    if (!sentinel && state.hasMore) {
        sentinel = document.createElement('tr');
        sentinel.id = 'usersListSentinel';
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(sentinel, `<td colspan="${(USER_FIELDS[state.type] || []).length + 2}"></td>`); } else { sentinel.innerHTML = `<td colspan="${(USER_FIELDS[state.type] || []).length + 2}"></td>`; }
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
    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tr, ''); } else { tr.innerHTML = ''; }

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

/**
 * 格式化关联学生 ID 列表为 姓名[ID] 格式
 */
function formatStudentIds(idsStr) {
    if (!idsStr) return '-';
    // 优先从内存缓存获取学生数据
    let studentList = (window.__usersCache && window.__usersCache.student) || [];

    // 如果内存缓存为空，尝试从 localStorage 获取(由 refreshFullUserCache 维护)
    if (studentList.length === 0) {
        try {
            const cached = localStorage.getItem('cached_students_full');
            if (cached) studentList = JSON.parse(cached);
        } catch (e) { }
    }

    const ids = String(idsStr).split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return '-';

    const result = ids.map(id => {
        const student = studentList.find(s => String(s.id) === String(id));
        if (student) {
            // 优先使用姓名，无姓名则使用用户名
            const displayName = student.name || student.username || '未知';
            return `${displayName}[${id}]`;
        }
        return `[${id}]`;
    });

    return result.join(', ');
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
        if (field === 'student_ids') value = formatStudentIds(value);

        if (field === 'status') {
            const badge = document.createElement('span');
            badge.className = `status-badge ${getUserStatusClass(value)}`;
            badge.textContent = getUserStatusLabel(value);
            td.appendChild(badge);
        } else {
            const span = document.createElement('span');
            span.className = 'clip';
            span.textContent = (value ?? '');
            if (field === 'student_ids' && value && value !== '-') {
                span.title = value; // 增加悬浮提示，防止学生过多被截断
            }
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

// 自动生成下一个用户ID
async function generateNextUserId() {
    const userType = document.getElementById('userType').value;
    const userIdInput = document.getElementById('userId');

    if (!userIdInput) return;

    try {
        // 获取当前类型的最大ID
        const cache = window.__usersCache || {};
        const users = cache[userType] || [];

        let maxId = 0;
        users.forEach(u => {
            if (u.id && u.id > maxId) maxId = u.id;
        });

        // 建议下一个ID
        userIdInput.value = maxId + 1;
    } catch (err) {
        
        userIdInput.value = '';
    }
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

    // 自动生成ID号
    generateNextUserId();

    toggleContactFields('admin');
    openUserFormModal();
}

export function showEditUserModal(id, userType) {
    const users = (window.__usersCache && window.__usersCache[userType]) || [];
    const user = users.find(u => String(u.id) === String(id));
    if (!user) {  return; }

    const form = document.getElementById('userForm');
    document.getElementById('userFormTitle').textContent = '编辑用户';
    form.dataset.mode = 'edit';
    form.dataset.id = id;

    // Fill fields - simplified for brevity, assume elements exist
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    setVal('userUsername', user.username);
    setVal('userName', user.name);

    // 设置ID (允许修改)
    setVal('userId', user.id);
    const userIdInput = document.getElementById('userId');
    if (userIdInput) userIdInput.readOnly = false;

    if (userType === 'admin') {
        setVal('userPermissionLevel', user.permission_level);
        setVal('userEmail', user.email);
    }
    setVal('userContact', user.contact);
    setVal('userProfession', user.profession);
    setVal('userWorkLocation', user.work_location);
    setVal('userHomeAddress', user.home_address);
    setVal('userVisitLocation', user.visit_location);
    if (userType === 'teacher') {
        setVal('userStudentIds', user.student_ids);
        populateStudentCheckboxes(user.student_ids);
    }

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

    const closeBtn = document.getElementById('closeUserFormBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeUserFormModal);
    const cancelBtn = document.getElementById('cancelUserFormBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', closeUserFormModal);

    const overlay = document.getElementById('modalOverlay');
    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeUserFormModal();
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
            // 切换类型时重新生成ID(仅添加模式)
            const form = document.getElementById('userForm');
            if (form && form.dataset.mode === 'add') {
                const userIdInput = document.getElementById('userId');
                if (userIdInput) userIdInput.readOnly = false;
                generateNextUserId();

                if (e.target.value === 'teacher') {
                    populateStudentCheckboxes('');
                }
            } else if (form && form.dataset.mode === 'edit') {
                if (e.target.value === 'teacher') {
                    const hiddenInput = document.getElementById('userStudentIds');
                    populateStudentCheckboxes(hiddenInput ? hiddenInput.value : '');
                }
            }
        });
    }
}

async function populateStudentCheckboxes(selectedIdsStr = '') {
    const container = document.getElementById('userStudentIdsContainer');
    if (!container) return;

    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(container, '<div style="color: #64748b; font-size: 13px; text-align: center; padding: 10px;">加载中...</div>'); } else { container.innerHTML = '<div style="color: #64748b; font-size: 13px; text-align: center; padding: 10px;">加载中...</div>'; }

    let students = window.__usersCache?.student || [];
    if (students.length === 0) {
        try {
            const res = await window.apiUtils.get(`/admin/users/student?limit=1000`);
            students = res?.data || res || [];
            if (!window.__usersCache) window.__usersCache = {};
            window.__usersCache.student = students;
        } catch (err) {
            
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(container, '<div style="color: #ef4444; font-size: 13px; padding: 10px;">加载失败，请重试</div>'); } else { container.innerHTML = '<div style="color: #ef4444; font-size: 13px; padding: 10px;">加载失败，请重试</div>'; }
            return;
        }
    }

    if (students.length === 0) {
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(container, '<div style="color: #64748b; font-size: 13px; padding: 10px;">暂无可用学生</div>'); } else { container.innerHTML = '<div style="color: #64748b; font-size: 13px; padding: 10px;">暂无可用学生</div>'; }
        return;
    }

    const selectedIds = (selectedIdsStr || '').split(',').map(s => String(s).trim()).filter(Boolean);

    let html = '';
    [...students].sort((a, b) => a.id - b.id).forEach(s => {
        const isChecked = selectedIds.includes(String(s.id)) ? 'checked' : '';
        html += `
            <label style="display: flex; align-items: flex-start; padding: 6px; cursor: pointer; border-bottom: 1px solid #f1f5f9; font-size: 14px; width: 100%; box-sizing: border-box; mso-line-break: no-wrap; word-break: break-all;">
                <input type="checkbox" class="student-checkbox" value="${s.id}" ${isChecked} style="flex-shrink: 0; margin: 2px 8px 0 0; width: 16px; height: 16px; min-width: 16px;">
                <span style="flex: 1; min-width: 0;">${s.name || s.username} <span style="color: #94a3b8; font-size: 13px;">(ID: ${s.id})</span></span>
            </label>
        `;
    });

    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(container, html); } else { container.innerHTML = html; }

    const checkboxes = container.querySelectorAll('.student-checkbox');
    const updateHiddenInput = () => {
        const checked = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.value);
        const hiddenInput = document.getElementById('userStudentIds');
        if (hiddenInput) {
            hiddenInput.value = checked.join(',');
        }
    };

    checkboxes.forEach(cb => cb.addEventListener('change', updateHiddenInput));
    updateHiddenInput();
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
        restriction: document.getElementById('userRestrictionGroup'),
        studentIds: document.getElementById('userStudentIdsGroup')
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
            if (groups.studentIds) groups.studentIds.style.display = 'block';
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
        
        if (window.apiUtils) window.apiUtils.showToast('删除失败', 'error');
    }
}

export async function refreshFullUserCache(type) {
    if (!window.apiUtils) return;
    if (!type) {
        // 并发预取所有类型，实现极致 Tab 切换
        return Promise.all([
            refreshFullUserCache('student'),
            refreshFullUserCache('teacher'),
            refreshFullUserCache('admin')
        ]);
    }
    const storageKey = `cached_${type}s_full`;
    try {
        // 背景预取第一页数据（50条），足以覆盖 90% 的初始展示场景
        const response = await window.apiUtils.get(`/admin/users/${type}`, { page: 1, size: 50 });
        const list = Array.isArray(response) ? response : (response.data || []);
        
        // 同步至内存缓存，供 loadUsers 瞬间调用
        window.__usersCache = window.__usersCache || {};
        window.__usersCache[type] = list;
        
        // 持久化备份
        localStorage.setItem(storageKey, JSON.stringify(list));
    } catch (e) { }
}

// 模块初始化时自动启动静默预取
if (typeof window !== 'undefined') {
    // 延迟 1 秒启动，避免抢占首屏关键资源
    setTimeout(() => refreshFullUserCache(), 1000);
}
