/**
 * User Manager Module
 * @description 处理用户管理相关的逻辑：列表加载、增删改查、表单处理
 */

import { USER_FIELDS, FIELD_LABELS, TIME_ZONE, getUserStatusClass, getUserStatusLabel } from './constants.js';
import { adjustSelectMinWidth, showTableLoading, hideTableLoading, showBlockLoading } from './ui-helper.js';


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

// 主键(ID)只允许 L1 超级管理员改动；与 permissionUtils 缺失时的既有约定一致——前端放行，后端 users:write 门禁兜底
function canEditUserId() {
    return !window.permissionUtils || window.permissionUtils.isSuperAdmin();
}

// 按「是否在编辑自己」+「是否 L1」决定 ID 输入框的只读态与提示语
function applyUserIdGuard(lockedBySelfEdit) {
    const userIdInput = document.getElementById('userId');
    if (!userIdInput) return;
    const notSuperAdmin = !canEditUserId();
    userIdInput.readOnly = lockedBySelfEdit || notSuperAdmin;
    if (lockedBySelfEdit) {
        userIdInput.title = '不能修改自己的该字段（如需变更请联系其他超级管理员）';
    } else if (notSuperAdmin) {
        userIdInput.title = '仅超级管理员(L1)可修改用户ID';
    } else {
        userIdInput.removeAttribute('title');
    }
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
        // 权限落地（Phase 3）：编辑自己时不回传 username / permission_level（后端禁止自改，同值回显也会被拒）
        const selfEdit = mode === 'edit' && userForm.dataset.selfEdit === '1';
        const body = { userType: type, name };
        if (!selfEdit) body.username = username;

        // 主键仅 L1 可指定/改动，非 L1 一律不回传（后端 users:write 门禁兜底）
        const userIdInput = document.getElementById('userId');
        if (canEditUserId() && userIdInput && userIdInput.value) {
            const parsedId = parseInt(userIdInput.value, 10);
            if (mode === 'add') {
                body.id = parsedId;
            } else if (mode === 'edit' && String(parsedId) !== String(id)) {
                body.new_id = parsedId;
            }
        }

        // 创建时必须提供密码，编辑时可选择性修改密码
        if (mode === 'add') {
            if (!password) throw new Error('请填写密码');
            body.password = password;
        } else if (password) {
            // 编辑模式下，如果填写了密码则更新
            body.password = password;
        }

        // Type-specific fields
        if (type === 'admin') {
            const permissionLevelInput = document.getElementById('userPermissionLevel');
            const emailInput = document.getElementById('userEmail');

            if (!selfEdit) {
                if (!permissionLevelInput || !permissionLevelInput.value.trim()) throw new Error('请填写权限级别(1-3)');
                const lvl = parseInt(permissionLevelInput.value, 10);
                if (isNaN(lvl) || lvl < 1 || lvl > 3) throw new Error('权限级别范围为1-3');
                body.permission_level = lvl;
            }

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
            const nicknameInput = document.getElementById('userNickname');

            if (nicknameInput && nicknameInput.value) body.nickname = nicknameInput.value.trim();
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

        // Also handle nickname for admin type
        if (type === 'admin') {
            const nicknameInput = document.getElementById('userNickname');
            if (nicknameInput && nicknameInput.value) body.nickname = nicknameInput.value.trim();
        }

        // Conflict detection for edit
        if (mode === 'edit') {
            const snapJson = userForm.dataset.snapshot || '{}';
            let snapshot = JSON.parse(snapJson);
            let latest;
            try {
                latest = await window.apiUtils.get(`/admin/users/${type}/${id}`);
                latest = latest && latest.data ? latest.data : latest;
            } catch (err) { latest = null; }

            if (latest) {
                const conflictKeys = ['username', 'name', 'nickname', 'email', 'permission_level', 'profession', 'contact', 'work_location', 'home_address', 'visit_location'];
                const changed = conflictKeys.some(k => String(latest[k] ?? '') !== String(snapshot[k] ?? ''));
                if (changed) {
                    const proceed = await Modal.confirm('检测到该用户已被其他人修改，是否仍继续保存您的更改？', { title: '数据冲突', confirmText: '继续保存' });
                    if (!proceed) throw new Error('USER_CANCELLED');
                }
            }
        }

        // Submit
        console.log('[UserManager] PUT body:', JSON.stringify(body, null, 2));

        // Defensive pre-send checks to give clearer error messages
        if (body.name !== undefined && !String(body.name).trim()) {
            throw new Error('姓名不能为空');
        }
        if (body.password !== undefined && body.password.length < 6) {
            throw new Error('密码长度至少为6个字符');
        }

        if (mode === 'add') {
            const resp = await withRetry((attempt, isFinal) => window.apiUtils.post('/admin/users', body, { suppressErrorToast: !isFinal }));
            const newUser = resp && resp.data ? resp.data : resp;
            closeUserFormModal();
            appendUserRow(type, newUser);
            refreshLocalCache(type, newUser);
            invalidateUserCaches(type, newUser?.id);
            logOperation('createUser', 'success', { type, username });
            if (window.apiUtils) window.apiUtils.showSuccessToast('用户已添加');

            // Backend confirm and refresh
            try {
                const confirmItem = await withRetry(() => window.apiUtils.get(`/admin/users/${type}/${newUser.id}`));
                if (confirmItem) {
                    await Promise.allSettled([
                        loadUsers(type, { reset: true }),
                        refreshFullUserCache(type)
                    ]);
                    window.eventBus?.emit(window.EVENTS?.USER_CHANGED || 'user:changed', {
                        action: 'create', type, userId: newUser.id
                    });
                }
            } catch (e) { console.warn('[UserManager] 刷新用户缓存失败:', e.message); }
        } else {
            await withRetry((attempt, isFinal) => window.apiUtils.put(`/admin/users/${type}/${id}`, body, { suppressErrorToast: !isFinal }));
            invalidateUserCaches(type, id);
            closeUserFormModal();
            logOperation('updateUser', 'success', { type, id });
            if (window.apiUtils) window.apiUtils.showSuccessToast('保存成功');
            await Promise.allSettled([
                loadUsers(type, { reset: true }),
                refreshFullUserCache(type)
            ]);
            window.eventBus?.emit(window.EVENTS?.USER_CHANGED || 'user:changed', {
                action: 'update', type, userId: id
            });
        }

    } catch (err) {
        if (err.message === 'USER_CANCELLED') {
            if (window.apiUtils) window.apiUtils.showToast('已取消保存', 'info');
        } else {
            console.warn('[UserManager] 保存失败:', err);
            // Show specific field errors from server validation if available
            let msg = err.message || '保存失败';
            if (err.errors && Array.isArray(err.errors) && err.errors.length > 0) {
                msg = err.errors.map(e => `${e.field ? e.field + ': ' : ''}${e.message}`).join('；');
            }
            if (window.apiUtils) window.apiUtils.showToast(msg, 'error');
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

function invalidateUserCaches(type, userId = null) {
    window.__usersCache = window.__usersCache || {};
    window.__usersCache[type] = null;
    const storageKey = `cached_${type}s_full`;
    try { localStorage.removeItem(storageKey); } catch (_) { }
    if (window.WeeklyDataStore) {
        if (type === 'student') window.WeeklyDataStore.students = { list: [], loadedAt: 0 };
        if (type === 'teacher') window.WeeklyDataStore.teachers = { list: [], loadedAt: 0 };
    }
    window.eventBus?.emit(window.EVENTS?.USER_CHANGED || 'user:changed', {
        action: 'invalidate', type, userId
    });
}

export async function loadUsers(type, opts = {}) {
    const requestedType = type || window.__usersState?.type || 'teacher';
    let requestGuard = null;
    try {
        const initialType = requestedType;
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
            state.loading = false;
            const tbody = document.getElementById('usersTableBody');
            if (tbody) window.SecurityUtils.safeSetHTML(tbody, '');
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
            state.loading = false;
            const tbody = document.getElementById('usersTableBody');
            if (tbody) window.SecurityUtils.safeSetHTML(tbody, '');
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
            window.SecurityUtils.safeSetHTML(tbody, '');
            
            const typeLabels = {
                teacher: '教师',
                student: '学生',
                admin: '管理员'
            };
            const loadingText = `正在加载${typeLabels[state.type] || ''}用户数据...`;
            showTableLoading(tableContainer, loadingText);
        }

        // 4. 设置加载状态，并固定本次请求的资源快照。
        // 切换角色/重置列表会提升序号，旧响应不能再覆盖新列表。
        const requestType = state.type;
        const requestPage = state.page;
        requestGuard = window.syncGuards?.nextRequest(`admin:users:list:${requestType}`);
        state.loading = true;

        const data = await window.apiUtils.get(`/admin/users/${requestType}`, {
            page: requestPage,
            size: state.pageSize
        });

        if (requestGuard && !requestGuard.isCurrent()) return;
        if (state.type !== requestType || (opts.append && state.page !== requestPage)) return;

        const users = Array.isArray(data) ? data : (data.users || data.data || data.results || []);

        // 加载完成，如果是第一页或不追加模式，则清空容器（移除显示残余内容）
        if (!opts.append) {
            window.SecurityUtils.safeSetHTML(tbody, '');
        }
        
        // 隐藏加载动画
        hideTableLoading(tableContainer);

        if (state.page === 1 && users.length === 0) {
            tbody.innerHTML = `<tr><td colspan="${(USER_FIELDS[state.type] || []).length + 1}">暂无数据</td></tr>`;
            state.hasMore = false;
            state.loading = false;
            return;
        }

        // 对教师数据按ID升序排序
        if (requestType === 'teacher') {
            users.sort((a, b) => {
                const idA = parseInt(a.id) || 0;
                const idB = parseInt(b.id) || 0;
                return idA - idB; // 升序
            });
        }

        users.forEach(u => appendUserRow(requestType, u));
        hideEmptyColumns();

        // Cache update
        window.__usersCache = window.__usersCache || {};
        const list = window.__usersCache[requestType] || [];
        window.__usersCache[requestType] = list.concat(users);

        if (users.length < state.pageSize) {
            state.hasMore = false;
        } else {
            state.page += 1;
        }
        state.loading = false;

        setupSentinel(state, tbody);

    } catch (err) {
        if (requestGuard && !requestGuard.isCurrent()) return;
        const state = window.__usersState || {};
        if (state.type && state.type !== requestedType) return;
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
            // 使用 innerHTML：safeSetHTML 的 DOMParser 会在 <body> 上下文中解析 <tr>/<td>
            // 导致 table 结构丢失，行内元素垂直堆叠。
            tbody.innerHTML = `
                    <tr>
                        <td colspan="${(USER_FIELDS[state.type] || []).length + 1}">
                            <div style="text-align: center; padding: 40px 20px;">
                                <div style="color: #ef4444; margin-bottom: 12px;">
                                    <span class="material-icons-round" style="font-size: 48px;">error_outline</span>
                                </div>
                                <div style="color: #64748b; margin-bottom: 16px;">${errorText}：${errorMsg}</div>
                                <button data-action="user-manager-load" data-type="${state.type}"
                                    style="padding: 8px 20px; background: #10b981; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: var(--fs-300);">
                                    <span class="material-icons-round" style="font-size: 18px; vertical-align: middle; margin-right: 4px;">refresh</span>
                                    点击重试
                                </button>
                            </div>
                        </td>
                    </tr>`;
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
        if (key === 'created_at') {
            av = av ? new Date(av).getTime() : 0;
            bv = bv ? new Date(bv).getTime() : 0;
        }
        if (av === bv) return 0;
        return av > bv ? dir : -dir;
    });

    window.SecurityUtils.safeSetHTML(tbody, '');
    toRender.forEach(u => appendUserRow(state.type, u));
    hideEmptyColumns();
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

    // 权限落地（Phase 3）：非 L1 不渲染「操作」列表头（与行内空操作单元格一致，消除空白列）
    const canManageAccounts = !window.permissionUtils || window.permissionUtils.isSuperAdmin();
    if (canManageAccounts) {
        const opsTh = document.createElement('th');
        opsTh.textContent = '操作';
        tr.appendChild(opsTh);
    }
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

    // 权限落地（Phase 2/3）：账号增删改仅 L1（后端路由门禁兜底），非 L1 不渲染操作单元格
    const canManageAccounts = !window.permissionUtils || window.permissionUtils.isSuperAdmin();
    if (canManageAccounts) {
        // 权限落地（Phase 3）：不能删除自己的账号——自己的行不渲染删除按钮
        let meId = '';
        try { meId = String(JSON.parse(localStorage.getItem('userData') || '{}').id ?? ''); } catch (_) { /* ignore */ }
        const isSelfRow = String(user.id) === meId;
        const actionsCell = document.createElement('td');
        actionsCell.classList.add('actions');
        actionsCell.innerHTML = `
            <button class="btn-icon edit-btn" title="编辑">
                <span class="material-icons-round">edit</span>
            </button>
            ${isSelfRow ? '' : `
            <button class="btn-icon delete-btn" title="删除" style="color: #ef4444;">
                <span class="material-icons-round">delete</span>
            </button>`}
        `;
        // Bind events directly
        actionsCell.querySelector('.edit-btn').addEventListener('click', () => showEditUserModal(user.id, type));
        const delBtn = actionsCell.querySelector('.delete-btn');
        if (delBtn) delBtn.addEventListener('click', () => deleteUser(type, user.id));
        tr.appendChild(actionsCell);
    }
    tbody.appendChild(tr);
}

/**
 * 隐藏所有行内容均为空的列（display:none）。
 * 列宽与内边距完全交给 CSS（table-layout: fixed + 统一 padding），JS 不再干预，
 * 否则会按内容宽度反向补 padding，导致内容少的列出现大量空白。
 */
function hideEmptyColumns() {
    const table = document.getElementById('usersTable');
    if (!table) return;
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    if (!thead || !tbody) return;

    // 恢复所有列可见，并清除历史版本可能残留的 inline padding/display
    const ths = Array.from(thead.querySelectorAll('th'));
    const dataRows = Array.from(tbody.querySelectorAll('tr'));
    ths.forEach(th => {
        th.style.display = '';
        th.style.paddingLeft = '';
        th.style.paddingRight = '';
    });
    dataRows.forEach(row => {
        Array.from(row.querySelectorAll('td')).forEach(td => {
            td.style.display = '';
            td.style.paddingLeft = '';
            td.style.paddingRight = '';
        });
    });

    // 隐藏全空列
    ths.forEach((th, colIndex) => {
        if (th.textContent.trim() === '操作') return;
        const allEmpty = dataRows.every(row => {
            const cell = row.querySelectorAll('td')[colIndex];
            return !cell || cell.textContent.trim() === '';
        });
        if (allEmpty) {
            th.style.display = 'none';
            dataRows.forEach(row => {
                const cell = row.querySelectorAll('td')[colIndex];
                if (cell) cell.style.display = 'none';
            });
        }
    });
}

// 自动生成下一个用户ID：同类型最后一个用户（即最大 ID）+ 1
// 以后端 next-id 为准而不是 window.__usersCache：该缓存只装了一页，
// 用户超过一页后本地 max 会偏小，预填的 ID 会撞上已存在的行并被创建接口拒掉。
// 各角色 ID 号段（与后端 user-service 的 ID_RANGES 保持一致）
const USER_ID_RANGES = { admin: [1000, 1999], teacher: [2000, 2999], student: [3000, 3999] };

async function generateNextUserId() {
    const form = document.getElementById('userForm');
    const userType = document.getElementById('userType').value;
    const userIdInput = document.getElementById('userId');
    if (!userIdInput) return;

    const users = (window.__usersCache && window.__usersCache[userType]) || [];
    const [lo, hi] = USER_ID_RANGES[userType] || [1, 999999];
    // 号段内取 max 作本地占位，避免预填出号段外的值
    const cachedMax = users.reduce((max, u) => {
        const n = Number(u.id);
        return (Number.isInteger(n) && n >= lo && n <= hi) ? Math.max(max, n) : max;
    }, lo - 1);
    userIdInput.value = cachedMax + 1;

    try {
        const resp = await window.apiUtils.getSilent(`/admin/users/${userType}/next-id`);
        const payload = resp && resp.data ? resp.data : resp;
        const nextId = Number(payload && payload.nextId);
        if (!Number.isInteger(nextId) || nextId < 1) return;
        // 往返期间操作者可能已切换类型或离开新增模式，此时不能再覆盖输入框
        if (form && form.dataset.mode !== 'add') return;
        if (document.getElementById('userType').value !== userType) return;
        userIdInput.value = nextId;
    } catch (_) { /* 后端不可用时保留上面的本地估算值 */ }
}

export function showAddUserModal() {
    const form = document.getElementById('userForm');
    if (!form) return;
    document.getElementById('userFormTitle').textContent = '添加用户';
    form.reset();
    form.dataset.mode = 'add';
    form.dataset.id = '';
    // 权限落地（Phase 3）：新增模式清除自我保护置灰状态
    form.dataset.selfEdit = '';
    ['userUsername', 'userPassword', 'userId', 'userPermissionLevel'].forEach(fid => {
        const el = document.getElementById(fid);
        if (el) { el.disabled = false; el.removeAttribute('title'); }
    });
    applyUserIdGuard(false);

    // Default values
    document.getElementById('userType').value = 'admin';
    const statusSelect = document.getElementById('userStatus');
    if (statusSelect) statusSelect.value = '1';

    const passwordInput = document.getElementById('userPassword');
    if (passwordInput) {
        passwordInput.required = true;
        passwordInput.placeholder = '';
    }

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

    // 权限落地（Phase 3）：判断是否在编辑自己的账号（后端防提权③兜底）
    let isSelfEdit = false;
    try {
        const me = JSON.parse(localStorage.getItem('userData') || '{}');
        isSelfEdit = userType === 'admin' && String(user.id) === String(me.id);
    } catch (_) { /* ignore */ }
    form.dataset.selfEdit = isSelfEdit ? '1' : '';

    // Fill fields - simplified for brevity, assume elements exist
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    setVal('userUsername', user.username);
    setVal('userName', user.name);
    setVal('userNickname', user.nickname);

    // 设置ID（只读态与提示语在下方 applyUserIdGuard 里统一决定）
    setVal('userId', user.id);
    const userIdInput = document.getElementById('userId');

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
    // 编辑模式下密码为可选项，留空表示不修改
    const passwordInput = document.getElementById('userPassword');
    if (passwordInput) {
        passwordInput.value = '';
        passwordInput.required = false;
        passwordInput.placeholder = '留空表示不修改密码';
    }

    // 权限落地（Phase 3）：自我保护——登录名/密码/主键/权限级别不可自改，置灰并提示
    const selfGuardTargets = [
        document.getElementById('userUsername'),
        passwordInput,
        userIdInput,
        userType === 'admin' ? document.getElementById('userPermissionLevel') : null
    ];
    selfGuardTargets.forEach(el => {
        if (!el) return;
        el.disabled = isSelfEdit;
        if (isSelfEdit) el.title = '不能修改自己的该字段（如需变更请联系其他超级管理员）';
        else el.removeAttribute('title');
    });
    // 必须排在自我保护之后：上面的 removeAttribute('title') 会抹掉非 L1 的提示语
    applyUserIdGuard(isSelfEdit);

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
        // 权限落地（Phase 2）：新增账号仅 L1 可见可用
        if (window.permissionUtils && !window.permissionUtils.isSuperAdmin()) {
            addUserBtn.style.display = 'none';
        }
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
                applyUserIdGuard(false);
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

    // 统一加载视觉：紧凑横向 spinner + 文案（shared/loading-ui.js）
    showBlockLoading(container, '正在加载学生列表...', { compact: true });

    let students = window.__usersCache?.student || [];
    if (students.length === 0) {
        try {
            const res = await window.apiUtils.get(`/admin/users/student?limit=1000`);
            students = res?.data || res || [];
            if (!window.__usersCache) window.__usersCache = {};
            window.__usersCache.student = students;
        } catch (err) {
            
            window.SecurityUtils.safeSetHTML(container, '<div style="color: #ef4444; font-size: var(--fs-300); padding: 10px;">加载失败，请重试</div>');
            return;
        }
    }

    if (students.length === 0) {
        window.SecurityUtils.safeSetHTML(container, '<div style="color: #64748b; font-size: var(--fs-300); padding: 10px;">暂无可用学生</div>');
        return;
    }

    const selectedIds = (selectedIdsStr || '').split(',').map(s => String(s).trim()).filter(Boolean);

    // XSS 安全：统一复用 core/security.js 的 escapeHtml（window.SecurityUtils 始终先加载）
    const esc = window.SecurityUtils.escapeHtml;

    let html = '';
    [...students].sort((a, b) => a.id - b.id).forEach(s => {
        const isChecked = selectedIds.includes(String(s.id)) ? 'checked' : '';
        html += `
            <label style="display: flex; align-items: flex-start; padding: 6px; cursor: pointer; border-bottom: 1px solid #f1f5f9; font-size: var(--fs-300); width: 100%; box-sizing: border-box; mso-line-break: no-wrap; word-break: break-all;">
                <input type="checkbox" class="student-checkbox" value="${s.id}" ${isChecked} style="flex-shrink: 0; margin: 2px 8px 0 0; width: 16px; height: 16px; min-width: 16px;">
                <span style="flex: 1; min-width: 0;">${esc(s.name || s.username)} <span style="color: #94a3b8; font-size: var(--fs-300);">(ID: ${s.id})</span></span>
            </label>
        `;
    });

    window.SecurityUtils.safeSetHTML(container, html);

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
        studentIds: document.getElementById('userStudentIdsGroup'),
        nickname: document.getElementById('userNicknameGroup')
    };

    // Hide all first
    Object.values(groups).forEach(g => { if (g) g.style.display = 'none'; });

    // 昵称对所有角色可见（恢复 CSS 定义的 display，不强制 block）
    if (groups.nickname) groups.nickname.style.display = '';

    if (userType === 'admin') {
        if (groups.permission) groups.permission.style.display = '';
        if (groups.email) groups.email.style.display = '';
    } else {
        if (groups.contact) groups.contact.style.display = '';
        if (groups.profession) groups.profession.style.display = '';
        if (groups.home) groups.home.style.display = '';
        if (groups.status) groups.status.style.display = '';

        if (userType === 'teacher') {
            if (groups.work) groups.work.style.display = '';
            if (groups.restriction) groups.restriction.style.display = '';
            if (groups.studentIds) groups.studentIds.style.display = '';
        }
        if (userType === 'student' && groups.visit) {
            groups.visit.style.display = '';
        }
    }
}

export async function deleteUser(userType, userId) {
    if (!await Modal.confirm('确定要删除该用户吗？', { title: '删除用户', confirmText: '删除', confirmStyle: 'danger' })) return;
    try {
        await window.apiUtils.delete(`/admin/users/${userType}/${userId}`);
        invalidateUserCaches(userType, userId);
        logOperation('deleteUser', 'success', { type: userType, id: userId });
        await Promise.allSettled([
            loadUsers(userType, { reset: true }),
            refreshFullUserCache(userType)
        ]);
        if (window.apiUtils) window.apiUtils.showSuccessToast('删除成功');
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

// 模块初始化时自动启动静默预取（用户管理 Tab 的「秒切」靠它）
if (typeof window !== 'undefined') {
    // 1 秒的固定延迟拦不住首屏：实测这三个请求（student/teacher/admin）正好和总览的
    // schedules/grid、statistics/overview 撞在一起抢连接池。改成等主线程真正空下来再发，
    // 拿不到 requestIdleCallback 的浏览器退回一个更长的定时器。
    const startPrefetch = () => refreshFullUserCache();
    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(startPrefetch, { timeout: 5000 });
    } else {
        setTimeout(startPrefetch, 3000);
    }
}

