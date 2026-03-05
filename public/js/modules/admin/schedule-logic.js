// Extracted Schedule Management UI Logic
import { loadSchedules } from './schedule-manager.js';

// 排课管理相关函数
export async function showAddScheduleModal() {
    
    const formContainer = document.getElementById('scheduleFormContainer');
    const form = document.getElementById('scheduleForm');
    const title = document.getElementById('scheduleFormTitle');
    if (!formContainer || !form) {
        
        return;
    }
    // ... rest of logic
    form.dataset.mode = 'add';
    form.dataset.id = '';
    title.textContent = '添加排课';
    // 清空表单
    const teacherSel = form.querySelector('#scheduleTeacher');
    const studentSel = form.querySelector('#scheduleStudent');
    const studentReadonlyDiv = form.querySelector('#scheduleStudentReadonly');
    const typeSel = form.querySelector('#scheduleTypeSelect');
    const dateInput = form.querySelector('#scheduleDate');
    const dateReadonlyDiv = form.querySelector('#scheduleDateReadonly');
    const startTimeInput = form.querySelector('#scheduleStartTime');
    const endTimeInput = form.querySelector('#scheduleEndTime');
    const locationInput = form.querySelector('#scheduleLocation');
    const familyParticipantsSelect = form.querySelector('#scheduleFamilyParticipants');
    if (teacherSel) teacherSel.value = '';
    if (studentSel) { studentSel.value = ''; studentSel.disabled = false; studentSel.style.display = ''; }
    if (studentReadonlyDiv) studentReadonlyDiv.style.display = 'none';
    if (typeSel) {
        typeSel.value = '';
        // Reset family participants logic and visibility
        if (familyParticipantsSelect) familyParticipantsSelect.value = '4'; // Default to 4 (Both Parents)
        // Visibility update will be handled by change event dispatch below or manual check
    }
    const todayISO = toISODate(new Date());
    if (dateInput) { dateInput.value = todayISO; dateInput.disabled = false; dateInput.style.display = ''; }
    if (dateReadonlyDiv) dateReadonlyDiv.style.display = 'none';

    if (startTimeInput) startTimeInput.value = '19:00';
    if (endTimeInput) endTimeInput.value = '22:00';
    if (locationInput) locationInput.value = '';
    // 隐藏删除按钮（仅编辑模式显示）
    const delBtn = document.getElementById('scheduleFormDelete');
    if (delBtn) delBtn.style.display = 'none';

    // 立即显示弹窗，避免等待数据加载导致“点击没反应”的卡顿感
    formContainer.style.display = 'block';

    // Clear availability cache to force fresh calculation on open
    window.__availabilityCache = null;

    // 异步加载选项，加载完后会自动填充和check
    try {
        await loadScheduleFormOptions();
    } catch (e) {
        
    }

    // 默认选择第一个老师和课程类型（如果有）
    if (teacherSel && teacherSel.options.length > 1) {
        teacherSel.selectedIndex = 1;
    }
    if (studentSel && studentSel.options.length > 1) {
        studentSel.selectedIndex = 1;
    }
    if (typeSel && typeSel.options.length > 1) {
        typeSel.selectedIndex = 1;
    }
    // 默认家庭参与人 (Default to first option)
    if (familyParticipantsSelect && familyParticipantsSelect.options.length > 0) {
        familyParticipantsSelect.selectedIndex = 0;
    }
    // 默认状态 (Default to first option - usually pending)
    const statusSel = form.querySelector('#scheduleStatus');
    if (statusSel && statusSel.options.length > 0) {
        statusSel.selectedIndex = 0;
    }

    // Trigger visibility update for family participants
    if (typeSel) typeSel.dispatchEvent(new Event('change'));

    // Trigger auto-resize for location if value exists (though usually empty for Add)
    if (locationInput && locationInput.value) {
        locationInput.style.height = 'auto'; // Reset
        locationInput.dispatchEvent(new Event('input'));
    }

    if (window.forceUpdateTeacherAvailability) window.forceUpdateTeacherAvailability();
}
// Expose to window for direct HTML access
window.showAddScheduleModal = showAddScheduleModal;

export async function editSchedule(scheduleId) {
    try {
        const formContainer = document.getElementById('scheduleFormContainer');
        const form = document.getElementById('scheduleForm');
        const title = document.getElementById('scheduleFormTitle');
        if (!formContainer || !form) return;

        // Clear cache for edit mode as well (though date might change, fresh start is good)
        window.__availabilityCache = null;
        // 并行加载表单选项和排课数据，大幅提升响应速度
        const [, data] = await Promise.all([
            loadScheduleFormOptions(),
            window.apiUtils.get(`/admin/schedules/${scheduleId}`)
        ]);


        const teacherSel = form.querySelector('#scheduleTeacher');
        const studentSel = form.querySelector('#scheduleStudent');
        const typeSel = form.querySelector('#scheduleTypeSelect');
        const dateInput = form.querySelector('#scheduleDate');
        const dateReadonlyDiv = document.getElementById('scheduleDateReadonly');
        const dateReadonlyHint = document.getElementById('dateReadonlyHint');
        const startTimeInput = form.querySelector('#scheduleStartTime');
        const endTimeInput = form.querySelector('#scheduleEndTime');
        const locationInput = form.querySelector('#scheduleLocation');
        const statusSel = form.querySelector('#scheduleStatus');
        const studentReadonlyDiv = document.getElementById('scheduleStudentReadonly');
        const studentReadonlyHint = document.getElementById('studentReadonlyHint');
        const origTeacher = document.getElementById('origTeacher');
        const origStudent = document.getElementById('origStudent');
        const origType = document.getElementById('origType');
        const origDate = document.getElementById('origDate');
        const origStartTime = document.getElementById('origStartTime');
        const origEndTime = document.getElementById('origEndTime');
        const origLocation = document.getElementById('origLocation');
        const origStatus = document.getElementById('origStatus');

        const getOptionLabel = (selectEl, val) => {
            if (!selectEl) return String(val || '');
            const opt = Array.from(selectEl.options || []).find(o => String(o.value) === String(val));
            return opt ? opt.textContent : String(val || '');
        };

        if (teacherSel) teacherSel.value = data.teacher_id || '';
        if (studentSel) studentSel.value = data.student_id || '';
        if (typeSel) typeSel.value = data.course_id || '';
        // 规范化日期为 YYYY-MM-DD，避免 <input type="date"> 赋值失败
        let isoDate = '';
        if (data.date) {
            try {
                const raw = String(data.date).trim();
                isoDate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : toISODate(new Date(raw));
            } catch (e) {
                isoDate = String(data.date).slice(0, 10);
            }
        }
        if (dateInput) dateInput.value = isoDate || '';
        // 规范化时间为 HH:MM，避免出现 HH:MM:SS 导致校验失败
        const normStart = sanitizeTimeString(data.start_time) || '19:00';
        const normEnd = sanitizeTimeString(data.end_time) || '22:00';
        if (startTimeInput) startTimeInput.value = normStart;
        if (endTimeInput) endTimeInput.value = normEnd;
        if (locationInput) locationInput.value = data.location || '';
        if (statusSel) {
            const allowedStatuses = new Set(['pending', 'confirmed', 'cancelled', 'completed']);
            const s = String(data.status || 'pending').trim();
            if (allowedStatuses.has(s)) {
                statusSel.value = s;
            } else {
                statusSel.value = 'pending';
            }
        }

        // 展示原始值并准备高亮逻辑
        const original = {
            teacher_id: data.teacher_id || '',
            student_id: data.student_id || '',
            course_id: data.course_id || '',
            date: isoDate || '',
            start_time: normStart,
            end_time: normEnd,
            location: data.location || '',
            status: data.status || 'pending'
        };
        form.__originalData = original;

        if (origTeacher) {
            origTeacher.textContent = `原值：${getOptionLabel(teacherSel, original.teacher_id)}`;
            origTeacher.style.display = 'block';
        }
        if (origStudent) {
            const foundStu = (window.__studentsFormList || []).find(x => String(x.id) === String(original.student_id));
            origStudent.textContent = `原值：${foundStu ? foundStu.name : `ID ${original.student_id}`}`;
            origStudent.style.display = 'block';
        }
        if (origType) {
            origType.textContent = `原值：${getOptionLabel(typeSel, original.course_id)}`;
            origType.style.display = 'block';
        }
        if (origDate) { origDate.textContent = `原值：${original.date}`; origDate.style.display = 'block'; }
        if (origStartTime) { origStartTime.textContent = `原值：${original.start_time}`; origStartTime.style.display = 'block'; }
        if (origEndTime) { origEndTime.textContent = `原值：${original.end_time}`; origEndTime.style.display = 'block'; }
        if (origLocation) { origLocation.textContent = `原值：${original.location || '（空）'}`; origLocation.style.display = 'block'; }
        if (origStatus) { origStatus.textContent = `原值：${getStatusText(original.status)}`; origStatus.style.display = 'block'; }

        // 学生信息设为只读：隐藏选择框，显示只读展示与提示
        if (studentSel) {
            studentSel.disabled = true;
            studentSel.style.display = 'none';
        }
        if (studentReadonlyDiv) {
            const stu = (window.__studentsFormList || []).find(x => String(x.id) === String(original.student_id));
            studentReadonlyDiv.textContent = stu ? `${stu.name}` : `ID ${original.student_id}`;
            studentReadonlyDiv.style.display = 'block';
        }
        if (studentReadonlyHint) {
            studentReadonlyHint.style.display = 'block';
        }

        // 日期设为只读：隐藏输入框，显示只读展示与提示
        if (dateInput) {
            dateInput.disabled = true;
            dateInput.style.display = 'none';
        }
        if (dateReadonlyDiv) {
            dateReadonlyDiv.textContent = original.date || '';
            dateReadonlyDiv.style.display = 'block';
        }
        if (dateReadonlyHint) {
            dateReadonlyHint.style.display = 'block';
        }

        const toggleChanged = (el, isChanged) => {
            const group = el ? el.closest('.form-group') : null;
            if (!group) return;
            if (isChanged) group.classList.add('changed');
            else group.classList.remove('changed');
        };
        const bindHighlight = () => {
            if (teacherSel) {
                teacherSel.addEventListener('change', () => {
                    toggleChanged(teacherSel, String(teacherSel.value) !== String(original.teacher_id));
                });
                toggleChanged(teacherSel, String(teacherSel.value) !== String(original.teacher_id));
            }
            if (typeSel) {
                typeSel.addEventListener('change', () => {
                    toggleChanged(typeSel, String(typeSel.value) !== String(original.course_id));
                });
                toggleChanged(typeSel, String(typeSel.value) !== String(original.course_id));
            }
            if (dateInput) {
                dateInput.addEventListener('input', () => {
                    toggleChanged(dateInput, String(dateInput.value) !== String(original.date));
                });
                toggleChanged(dateInput, String(dateInput.value) !== String(original.date));
            }
            if (startTimeInput) {
                startTimeInput.addEventListener('input', () => {
                    // 输入时也进行规范化对比
                    const v = sanitizeTimeString(startTimeInput.value) || startTimeInput.value;
                    toggleChanged(startTimeInput, String(v) !== String(original.start_time));
                });
                const v0 = sanitizeTimeString(startTimeInput.value) || startTimeInput.value;
                toggleChanged(startTimeInput, String(v0) !== String(original.start_time));
            }
            if (endTimeInput) {
                endTimeInput.addEventListener('input', () => {
                    const v = sanitizeTimeString(endTimeInput.value) || endTimeInput.value;
                    toggleChanged(endTimeInput, String(v) !== String(original.end_time));
                });
                const v0 = sanitizeTimeString(endTimeInput.value) || endTimeInput.value;
                toggleChanged(endTimeInput, String(v0) !== String(original.end_time));
            }
            if (locationInput) {
                locationInput.addEventListener('input', () => {
                    toggleChanged(locationInput, String(locationInput.value || '') !== String(original.location || ''));
                });
                toggleChanged(locationInput, String(locationInput.value || '') !== String(original.location || ''));
                // Trigger auto-grow for existing value
                if (locationInput.value) {
                    locationInput.style.height = 'auto'; // Reset
                    locationInput.dispatchEvent(new Event('input'));
                }
            }
            if (statusSel) {
                statusSel.addEventListener('change', () => {
                    toggleChanged(statusSel, String(statusSel.value || '') !== String(original.status || ''));
                });
                toggleChanged(statusSel, String(statusSel.value || '') !== String(original.status || ''));
            }
        };
        bindHighlight();

        form.dataset.mode = 'edit';
        form.dataset.id = String(scheduleId);
        if (title) title.textContent = '编辑排课';
        // 显示并绑定删除按钮
        const delBtn = document.getElementById('scheduleFormDelete');
        if (delBtn) {
            delBtn.style.display = '';
            const newDel = delBtn.cloneNode(true);
            delBtn.parentNode.replaceChild(newDel, delBtn);
            newDel.addEventListener('click', () => deleteSchedule(scheduleId));
        }
        if (window.forceUpdateTeacherAvailability) window.forceUpdateTeacherAvailability();
        formContainer.style.display = 'block';
    } catch (error) {
        
        if (window.apiUtils && typeof window.apiUtils.handleError === 'function') {
            window.apiUtils.handleError(error);
        }
    }
}

export async function deleteSchedule(scheduleId) {
    if (confirm('确定要删除此排课吗？')) {
        try {
            // 使用新的API工具类删除排课
            await window.apiUtils.delete(`/admin/schedules/${scheduleId}`);
            // 关闭编辑窗口或详情弹窗
            const formContainer = document.getElementById('scheduleFormContainer');
            if (formContainer) formContainer.style.display = 'none';
            const modal = document.getElementById('scheduleModal');
            if (modal) modal.style.display = 'none';
            try { if (window.WeeklyDataStore && WeeklyDataStore.schedules) WeeklyDataStore.schedules.clear(); } catch (_) { }
            loadSchedules();
        } catch (error) {
            
        }
    }
}

export async function confirmSchedule(scheduleId) {
    try {
        // 使用新的API工具类确认排课
        await window.apiUtils.post(`/admin/schedules/${scheduleId}/confirm`, {
            adminConfirmed: true
        });
        try { if (window.WeeklyDataStore && WeeklyDataStore.schedules) WeeklyDataStore.schedules.clear(); } catch (_) { }
        loadSchedules();
    } catch (error) {
        
    }
}

// 加载排课表单的教师/学生选项
export async function loadScheduleFormOptions() {
    try {
        // User Request: Always recalculate on modal open to avoid stale state.
        // Cache is cleared in show/edit functions, or we can clear here?
        // Note: loadScheduleFormOptions is called by show/edit.
        // It's safer to rely on explicit clearing in those functions if we want "per modal session" caching.
        // But the user said "every time open window...".
        // Let's Ensure cache logic inside updateTeacherAvailability respects this.

        const teacherSel = document.getElementById('scheduleTeacher');
        const studentSel = document.getElementById('scheduleStudent');
        const typeSel = document.getElementById('scheduleTypeSelect');
        const teacherFilterSel = document.getElementById('teacherFilter');

        // Populate Type Select from Store
        if (typeSel && window.ScheduleTypesStore) {
            const currentTypeVal = typeSel.value;
            const types = window.ScheduleTypesStore.getAll();
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(typeSel, '<option value="">选择类型</option>'); } else { typeSel.innerHTML = '<option value="">选择类型</option>'; }
            types.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.id; // Use ID for backend submission
                opt.textContent = t.description || t.name;
                typeSel.appendChild(opt);
            });
            if (currentTypeVal) typeSel.value = currentTypeVal;
        }

        // 特殊教师白名单 (ID: 7-叶老师, 9-金博, 10-侯老师)
        const WHITELIST_IDS = [7, 9, 10];

        // 并行获取数据以进一步加速
        const [teachers, students] = await Promise.all([
            WeeklyDataStore.getTeachers(),
            WeeklyDataStore.getStudents()
        ]);

        // 缓存完整列表用于前端动态筛选
        window.__allTeachersCache = teachers || [];

        // 定义渲染函数：根据忙碌状态和限制渲染教师选项
        // preservedVal: 可选，用于在异步操作后恢复之前的选中值
        const renderTeacherOptions = (busyIds = new Set(), unavailableIds = new Set(), preservedVal = null) => {
            if (!teacherSel) return;
            // 如果传入了 preservedVal 则使用，否则获取当前值
            const currentVal = preservedVal !== null ? preservedVal : teacherSel.value;
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(teacherSel, '<option value="">选择教师</option>'); } else { teacherSel.innerHTML = '<option value="">选择教师</option>'; }

            // 基础排序权重：正常(1) -> 暂停(0) -> 删除/其他
            const statusWeight = (v) => { const n = Number(v); if (n === 1) return 0; if (n === 0) return 1; return 2; };

            const validTeachers = (window.__allTeachersCache || []).filter(t => Number(t.status) !== -1);

            // 预排序：先按状态，再按姓名
            validTeachers.sort((a, b) => {
                const wa = statusWeight(a?.status), wb = statusWeight(b?.status);
                if (wa !== wb) return wa - wb;
                return String(a?.name || '').localeCompare(String(b?.name || ''), 'zh-CN');
            });

            // 分组容器
            const groups = {
                available: [],    // 普通可用 (Available)
                unrestricted: [], // 无限制/特权 (Unrestricted/Special)
                conflict: [],     // 时间冲突 (Time Conflict)
                unavailable: []   // 不在服务时间 (Unavailable)
            };

            validTeachers.forEach(t => {
                const tid = Number(t.id);
                const isBusy = busyIds.has(tid);
                const isRestricted = (t.restriction !== 0);
                // unavailableIds ONLY contains restricted teachers who don't work at this time
                const isUnavailable = unavailableIds.has(tid);

                if (isBusy) {
                    groups.conflict.push(t);
                } else if (isUnavailable) {
                    groups.unavailable.push(t);
                } else if (!isRestricted) {
                    groups.unrestricted.push(t);
                } else {
                    groups.available.push(t);
                }
            });

            // 辅助渲染函数
            const renderOption = (t, type) => {
                const opt = document.createElement('option');
                opt.value = t.id;
                let label = t.name;
                const isPaused = (Number(t.status) === 0);
                if (isPaused) label += '（暂停）';

                // 根据类型应用样式
                switch (type) {
                    case 'unrestricted': // 特殊/无限制 - 绿色 + 星标
                        label += ' ⭐';
                        opt.style.color = '#15803d'; // Green 700
                        opt.style.fontWeight = '500';
                        break;
                    case 'conflict': // 冲突 - 灰色 + 标记
                        label += ' (时间冲突)';
                        opt.style.color = '#94a3b8'; // Slate 400
                        // opt.disabled = true; // Optional: disable user from selecting? User didn't strictly say disable, just categorize. Usually better to allow override.
                        break;
                    case 'unavailable': // 不在服务时间 - 浅灰色
                        label += ' (休息中)';
                        opt.style.color = '#cbd5e1'; // Slate 300
                        break;
                    case 'available': // 普通可用 - 默认深色
                    default:
                        opt.style.color = '#334155'; // Slate 700
                        break;
                }
                opt.textContent = label;
                teacherSel.appendChild(opt);
            };

            // 添加分隔线的辅助函数
            const addSeparator = () => {
                if (teacherSel.lastChild && teacherSel.lastChild.value !== '') {
                    const sep = document.createElement('option');
                    sep.disabled = true;
                    // 使用较短的线条以避免撑宽下拉框，同时调整字号减少上下间隙
                    sep.textContent = '──────────';
                    sep.style.fontSize = '10px'; // 尝试减小字号以压缩高度
                    sep.style.color = '#e2e8f0'; // 浅色
                    sep.style.textAlign = 'center'; // 尝试居中
                    teacherSel.appendChild(sep);
                }
            };

            let hasPrevGroups = false;

            // 1. Available Teachers (Restricted=1 but OK)
            if (groups.available.length > 0) {
                groups.available.forEach(t => renderOption(t, 'available'));
                hasPrevGroups = true;
            }

            // 2. Unrestricted Teachers (Restricted=0)
            // Show them near the top as they are "always feasible" fallback
            if (groups.unrestricted.length > 0) {
                if (hasPrevGroups) addSeparator();
                groups.unrestricted.forEach(t => renderOption(t, 'unrestricted'));
                hasPrevGroups = true;
            }

            // 3. Unavailable Teachers (Good teacher, wrong time)
            if (groups.unavailable.length > 0) {
                if (hasPrevGroups) addSeparator();
                groups.unavailable.forEach(t => renderOption(t, 'unavailable'));
                hasPrevGroups = true;
            }

            // 4. Time Conflicts (Busy right now)
            if (groups.conflict.length > 0) {
                if (hasPrevGroups) addSeparator();
                groups.conflict.forEach(t => renderOption(t, 'conflict'));
            }

            // 恢复选中值或设置默认值
            if (currentVal) {
                teacherSel.value = currentVal;
            } else {
                // 默认选中逻辑：优先选择 Available 组的第一个
                if (groups.available.length > 0) {
                    teacherSel.value = groups.available[0].id;
                } else if (groups.unrestricted.length > 0) {
                    teacherSel.value = groups.unrestricted[0].id;
                }
                // 否则不自动选 conflict/unavailable，保持空或 'Select Teacher'
            }
            // 触发一次提示检查
            checkSpecialTeacherHint();
        };

        // 提示检查函数
        const checkSpecialTeacherHint = () => {
            if (!teacherSel) return;
            const val = Number(teacherSel.value);
            // 查找或创建提示元素
            let hint = document.getElementById('specialTeacherHint');
            const selectedTeacher = (window.__allTeachersCache || []).find(t => Number(t.id) === val);

            if (selectedTeacher && (selectedTeacher.restriction === 0)) {
                if (!hint) {
                    hint = document.createElement('div');
                    hint.id = 'specialTeacherHint';
                    hint.style.fontSize = '12px';
                    hint.style.color = '#15803d';
                    hint.style.marginTop = '4px';
                    hint.style.padding = '4px 8px';
                    hint.style.backgroundColor = '#f0fdf4';
                    hint.style.borderRadius = '4px';
                    hint.style.border = '1px solid #bbf7d0';
                    hint.textContent = '💡 该老师不受排课时间限制。';
                    teacherSel.parentNode.appendChild(hint);
                } else {
                    hint.style.display = 'block';
                }
            } else {
                if (hint) hint.style.display = 'none';
            }
        };

        // 动态可用性检查函数 - 已在新版 schedule-manager.js 中由 updateTeacherStatusHints 代替
        const updateTeacherAvailability = async () => {
            return; // 彻底禁用旧逻辑，避免干扰新版 (Task Refinement)
            const dateInput = document.getElementById('scheduleDate');
            const startInput = document.getElementById('scheduleStartTime');
            const endInput = document.getElementById('scheduleEndTime');

            const dateVal = dateInput ? dateInput.value : '';
            const startVal = startInput ? startInput.value : '';
            const endVal = endInput ? endInput.value : '';

            // Loading State - 先保存当前选中值，在异步完成后恢复
            let preservedTeacherVal = '';
            if (teacherSel) {
                preservedTeacherVal = teacherSel.value; // 保存当前选中值
                teacherSel.disabled = true;
            }

            try {
                // 如果日期时间不完整，显示所有（默认状态，假设无限制）
                if (!dateVal || !startVal || !endVal) {
                    // Still render all, but need to clear loading
                    renderTeacherOptions(new Set(), new Set(), preservedTeacherVal);
                    return;
                }

                // 获取时间段的分钟数用于比较
                const targetStart = hhmmToMinutes(startVal);
                const targetEnd = hhmmToMinutes(endVal);
                if (Number.isNaN(targetStart) || Number.isNaN(targetEnd)) {
                    renderTeacherOptions(new Set(), new Set(), preservedTeacherVal);
                    return;
                }

                // 计算时间段涵盖的时段 (Morning/Afternoon/Evening)
                const checkSlots = { morning: false, afternoon: false, evening: false };
                const mStart = 6 * 60;
                const mEnd = 12 * 60;
                const aEnd = 19 * 60;
                const eEnd = 24 * 60;

                if (!(targetEnd <= mStart || targetStart >= mEnd)) checkSlots.morning = true;
                if (!(targetEnd <= mEnd || targetStart >= aEnd)) checkSlots.afternoon = true;
                if (!(targetEnd <= aEnd || targetStart >= eEnd)) checkSlots.evening = true;

                // 初始化缓存
                if (!window.__availabilityCache) window.__availabilityCache = new Map();

                let schedules, availabilityData;

                // 检查缓存
                if (window.__availabilityCache.has(dateVal)) {
                    // Availability 配置很少变动，可以缓存；排课冲突需要实时检查
                    availabilityData = window.__availabilityCache.get(dateVal);
                    schedules = await window.apiUtils.get('/admin/schedules/grid', { start_date: dateVal, end_date: dateVal });
                } else {
                    // 并行获取排课冲突 和 教师可用性配置
                    [schedules, availabilityData] = await Promise.all([
                        window.apiUtils.get('/admin/schedules/grid', { start_date: dateVal, end_date: dateVal }),
                        window.apiUtils.get('/admin/teacher-availability', { startDate: dateVal, endDate: dateVal })
                    ]);
                    // 写入缓存
                    window.__availabilityCache.set(dateVal, availabilityData);
                }

                // 处理 availability mapping: TeacherID -> Record
                const availabilityMap = {};
                (Array.isArray(availabilityData) ? availabilityData : []).forEach(item => {
                    availabilityMap[item.id] = item.availability || {};
                });

                // 处理 busy set (排课冲突)
                const busyIds = new Set();
                const form = document.getElementById('scheduleForm');
                const currentId = form ? form.dataset.id : '';

                (Array.isArray(schedules) ? schedules : []).forEach(s => {
                    if (currentId && String(s.id) === String(currentId)) return;
                    if (s.status === 'cancelled') return;
                    if (!s.teacher_id) return;
                    const sStart = hhmmToMinutes(sanitizeTimeString(s.start_time));
                    const sEnd = hhmmToMinutes(sanitizeTimeString(s.end_time));
                    if (Number.isFinite(sStart) && Number.isFinite(sEnd)) {
                        if (!(sEnd <= targetStart || sStart >= targetEnd)) {
                            busyIds.add(Number(s.teacher_id));
                        }
                    }
                });

                // 处理 unavailable set (restriction check)
                const unavailableIds = new Set();
                const allTeachers = window.__allTeachersCache || [];

                allTeachers.forEach(t => {
                    const tid = Number(t.id);
                    const restriction = t.restriction ?? 1;

                    if (restriction === 0) return; // Always available
                    if (restriction === 1) { // Check availability
                        const teacherAvail = availabilityMap[tid];
                        let dayRecord = teacherAvail ? teacherAvail[dateVal] : null;

                        if (!dayRecord && teacherAvail) {
                            const dateKey = Object.keys(teacherAvail).find(k => k.startsWith(dateVal));
                            dayRecord = dateKey ? teacherAvail[dateKey] : null;
                        }

                        if (!dayRecord) return; // Assume available

                        let isOk = true;
                        if (checkSlots.morning && dayRecord.morning === false) isOk = false;
                        if (checkSlots.afternoon && dayRecord.afternoon === false) isOk = false;
                        if (checkSlots.evening && dayRecord.evening === false) isOk = false;

                        if (!isOk) unavailableIds.add(tid);
                    }
                });

                renderTeacherOptions(busyIds, unavailableIds, preservedTeacherVal);

            } catch (e) {
                
                renderTeacherOptions(new Set(), new Set(), preservedTeacherVal);
            } finally {
                if (teacherSel) {
                    teacherSel.disabled = false;
                    // Remove loading option if it persists? renderTeacherOptions rebuilds content, so usually gone.
                }
            }
        };


        // Family Participants Toggle Logic
        const familyParticipantsGroup = document.getElementById('scheduleFamilyParticipantsGroup');
        const familyParticipantsSelect = document.getElementById('scheduleFamilyParticipants');

        const toggleFamilyParticipants = () => {
            if (!typeSel || !familyParticipantsGroup) return;
            const typeVal = typeSel.value;
            // Check if Review (review) or Advisory (advisory) or Review Record (review_record)
            const isReviewOrConsultation = ['review', 'advisory', 'review_record'].includes(typeVal);

            if (isReviewOrConsultation) {
                familyParticipantsGroup.style.display = 'block';
            } else {
                familyParticipantsGroup.style.display = 'none';
                // Reset to default (4: Both Parents) when hidden? Or keep?
                // Better to keep as is, but maybe reset on form open.
            }
        };

        if (typeSel) {
            typeSel.addEventListener('change', toggleFamilyParticipants);
            // Initial check
            toggleFamilyParticipants();
        }

        // 绑定事件监听
        const dateInput = document.getElementById('scheduleDate');
        const startInput = document.getElementById('scheduleStartTime');
        const endInput = document.getElementById('scheduleEndTime');

        if (dateInput) {
            dateInput.removeEventListener('change', updateTeacherAvailability);
            dateInput.addEventListener('change', updateTeacherAvailability);
        }
        if (startInput) startInput.addEventListener('change', updateTeacherAvailability);
        if (endInput) endInput.addEventListener('change', updateTeacherAvailability);
        if (teacherSel) teacherSel.addEventListener('change', checkSpecialTeacherHint);

        window.forceUpdateTeacherAvailability = updateTeacherAvailability;


        // 初始渲染：如果有日期/时间，立即执行检查；否则显示全部
        if (dateInput && dateInput.value && startInput && startInput.value) {
            await updateTeacherAvailability();
        } else {
            if (teacherSel) renderTeacherOptions(new Set(), new Set());
        }

        if (studentSel) {
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(studentSel, '<option value="">选择学生</option>'); } else { studentSel.innerHTML = '<option value="">选择学生</option>'; }
            const sortedStudents = (students || []).filter(s => Number(s.status ?? 1) === 1).sort((a, b) => {
                const an = String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
                return an;
            });

            window.__studentsFormList = sortedStudents;
            sortedStudents.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id;
                opt.textContent = s.name;
                studentSel.appendChild(opt);
            });
            const locationInput = document.getElementById('scheduleLocation');
            const autoResize = (el) => {
                if (!el) return;
                el.style.height = 'auto';
                el.style.height = (el.scrollHeight + 6) + 'px';
            };
            if (locationInput) {
                locationInput.addEventListener('input', function () { autoResize(this); });
                // Initial resize if value exists
                if (locationInput.value) autoResize(locationInput);
            }

            studentSel.addEventListener('change', () => {
                const sid = Number(studentSel.value);
                const found = (window.__studentsFormList || []).find(x => Number(x.id) === sid);
                if (locationInput) {
                    locationInput.value = found?.visit_location || '';
                    autoResize(locationInput);
                }
            });
        }
        if (typeSel) {
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(typeSel, '<option value="">选择类型</option>'); } else { typeSel.innerHTML = '<option value="">选择类型</option>'; }
            let types = ScheduleTypesStore.getAll();
            const hasAdvisory = types.some(t => (t.name || '').includes('advisory') || (t.description || '').includes('咨询'));

            // If empty or missing Advisory (and we suspect it should exist), try fresh fetch
            if (types.length === 0 || !hasAdvisory) {
                try {
                    const fetched = await window.apiUtils.get('/schedule/types');
                    if (Array.isArray(fetched) && fetched.length > 0) {
                        ScheduleTypesStore.load(fetched);
                        types = ScheduleTypesStore.getAll();
                    }
                } catch (error) {  }
            }

            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(typeSel, '<option value="">选择类型</option>'); } else { typeSel.innerHTML = '<option value="">选择类型</option>'; }
            types.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.id;
                opt.textContent = (t.description || t.name || `类型${t.id}`);
                typeSel.appendChild(opt);
            });
            let defaultType = types.find(t => {
                const name = String(t.name || '').trim();
                const desc = String(t.description || '').trim();
                return desc === '入户' || name === '入户' || name === 'visit';
            });
            if (!defaultType) {
                defaultType = types.find(t => {
                    const name = String(t.name || '').trim();
                    const desc = String(t.description || '').trim();
                    return (name.includes('入户') || desc.includes('入户')) && !(name.includes('半次') || desc.includes('半次'));
                });
            }
            if (defaultType) typeSel.value = String(defaultType.id);
        }

        // 教师筛选器（仅用于列表页筛选，无需可用性逻辑）
        if (teacherFilterSel) {
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(teacherFilterSel, '<option value="">全部教师</option>'); } else { teacherFilterSel.innerHTML = '<option value="">全部教师</option>'; }
            // 复用缓存的教师列表
            const weight = (v) => { const n = Number(v); if (n === 1) return 0; if (n === 0) return 1; if (n === -1) return 2; return 3; };
            const filterTeachers = (teachers || []).filter(t => Number(t?.status) !== -1).sort((a, b) => {
                const wa = weight(a?.status); const wb = weight(b?.status);
                if (wa !== wb) return wa - wb;
                return String(a?.name || '').localeCompare(String(b?.name || ''), 'zh-CN');
            });
            filterTeachers.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.id;
                opt.textContent = t.name + (Number(t.status) === 0 ? '（暂停）' : '');
                teacherFilterSel.appendChild(opt);
            });
        }
    } catch (error) {
        
    }
}

// 退出登录函数已经迁移至 public/js/utils/auth.js

// 显示排课详情弹窗（使用现有 #scheduleModal 结构与样式）
export function showScheduleDetails(schedule, student) {
    const modal = document.getElementById('scheduleModal');
    if (!modal) return;
    const titleEl = modal.querySelector('#modalTitle');
    const studentEl = modal.querySelector('#modalStudent');
    const teacherEl = modal.querySelector('#modalTeacher');
    const dateEl = modal.querySelector('#modalDate');
    const timeEl = modal.querySelector('#modalTime');
    const locationEl = modal.querySelector('#modalLocation');
    const typeEl = modal.querySelector('#modalType');
    const statusEl = modal.querySelector('#modalStatus');
    const notesEl = modal.querySelector('#modalNotes');
    const editBtn = modal.querySelector('#editScheduleBtn');
    const deleteBtn = modal.querySelector('#deleteScheduleBtn');
    const closeBtn = modal.querySelector('#closeModalBtn');
    const headerClose = modal.querySelector('.modal-header .close');

    // 填充内容
    if (titleEl) titleEl.textContent = '排课详情';
    if (studentEl) studentEl.textContent = student && student.name ? student.name : (schedule.student_name || '-');
    if (teacherEl) teacherEl.textContent = schedule.teacher_name || '待分配';
    if (dateEl) {
        const d = schedule.date ? new Date(schedule.date) : null;
        dateEl.textContent = d && !Number.isNaN(d.getTime()) ? formatDate(d) : (schedule.date || '-');
    }
    if (timeEl) {
        timeEl.textContent = (schedule.start_time && schedule.end_time)
            ? `${formatTime(schedule.start_time)} - ${formatTime(schedule.end_time)}`
            : '时间待定';
    }
    if (locationEl) locationEl.textContent = (schedule.location || '地点待定');
    if (typeEl) typeEl.textContent = (schedule.schedule_types || '未分类');
    if (statusEl) statusEl.textContent = getStatusText(schedule.status || 'pending');
    if (notesEl) notesEl.textContent = schedule.notes || '-';

    // 绑定操作按钮（先移除旧的事件避免重复）
    if (editBtn) {
        const newEdit = editBtn.cloneNode(true);
        editBtn.parentNode.replaceChild(newEdit, editBtn);
        newEdit.addEventListener('click', () => editSchedule(schedule.id));
    }
    if (deleteBtn) {
        const newDelete = deleteBtn.cloneNode(true);
        deleteBtn.parentNode.replaceChild(newDelete, deleteBtn);
        newDelete.addEventListener('click', () => deleteSchedule(schedule.id));
    }
    if (closeBtn) {
        const newClose = closeBtn.cloneNode(true);
        closeBtn.parentNode.replaceChild(newClose, closeBtn);
        newClose.addEventListener('click', () => { modal.style.display = 'none'; });
    }
    if (headerClose) {
        const newHeaderClose = headerClose.cloneNode(true);
        headerClose.parentNode.replaceChild(newHeaderClose, headerClose);
        newHeaderClose.addEventListener('click', () => { modal.style.display = 'none'; });
    }

    // 显示模态
    modal.style.display = 'block';
}

// 关闭排课详情弹窗
export function closeScheduleDetails() {
    const modal = document.getElementById('scheduleModal');
    if (modal) modal.style.display = 'none';
}

// 获取状态文本
export function getStatusText(status) {
    const statusMap = {
        'pending': '待确认',
        'confirmed': '已确认',
        'completed': '已完成',
        'cancelled': '已取消'
    };
    return statusMap[status] || status;
}
// loadSchedules forms duplicate code. Handled by schedule-manager.js

// Global exposure
window.showAddScheduleModal = showAddScheduleModal;
window.editSchedule = editSchedule;
window.deleteSchedule = deleteSchedule;
window.confirmSchedule = confirmSchedule;
window.loadScheduleFormOptions = loadScheduleFormOptions;
window.showScheduleDetails = showScheduleDetails;
window.closeScheduleDetails = closeScheduleDetails;
window.getStatusText = getStatusText;

// --- Extracted from legacy-adapter.js ---
// 显示排课选择弹窗（用于合并显示的排课）
export function showScheduleSelector(items) {
    if (!items || items.length === 0) return;

    // 创建简单的遮罩层和弹窗
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    overlay.style.zIndex = '2000';
    overlay.style.display = 'flex';
    overlay.style.justifyContent = 'center';
    overlay.style.alignItems = 'center';

    const modal = document.createElement('div');
    modal.style.background = 'white';
    modal.style.padding = '20px';
    modal.style.borderRadius = '12px';
    modal.style.width = '90%';
    modal.style.maxWidth = '400px';
    modal.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)';
    modal.style.maxHeight = '80vh';
    modal.style.display = 'flex';
    modal.style.flexDirection = 'column';

    const header = document.createElement('div');
    header.innerHTML = `
        <h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #1e293b;">请选择要编辑的排课</h3>
        <p style="margin: 0 0 12px 0; font-size: 14px; color: #64748b;">当前时段/地点共有 ${items.length} 个排课</p>
    `;
    modal.appendChild(header);

    const list = document.createElement('div');
    list.style.overflowY = 'auto';
    list.style.flex = '1';

    items.forEach(item => {
        const row = document.createElement('div');
        row.style.padding = '12px';
        row.style.border = '1px solid #e2e8f0';
        row.style.borderRadius = '8px';
        row.style.marginBottom = '8px';
        row.style.cursor = 'pointer';
        row.style.transition = 'all 0.2s';

        // 简单的一行布局
        // student | type | status
        const typeName = item.schedule_types || item.schedule_type_name || item.type_name || '课程';
        const statusMap = {
            'pending': '待确认',
            'confirmed': '已确认',
            'completed': '已完成',
            'cancelled': '已取消'
        };
        const statusText = statusMap[item.status] || item.status;

        row.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <span style="font-weight: 600; font-size: 15px;">${item.student_name || '未知学生'}</span>
                <span style="font-size: 12px; color: #64748b;">${statusText}</span>
            </div>
            <div style="font-size: 13px; color: #475569;">
                <span style="display:inline-block; background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">${typeName}</span>
                <span style="margin-left: 8px;">${item.teacher_name || '未分配'}</span>
            </div>
        `;

        row.addEventListener('mouseover', () => {
            row.style.background = '#f8fafc';
            row.style.borderColor = '#cbd5e1';
        });
        row.addEventListener('mouseout', () => {
            row.style.background = 'white';
            row.style.borderColor = '#e2e8f0';
        });

        row.addEventListener('click', () => {
            // 关闭弹窗并打开编辑
            document.body.removeChild(overlay);
            editSchedule(item.id);
        });

        list.appendChild(row);
    });
    modal.appendChild(list);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '关闭';
    closeBtn.className = 'btn secondary-btn';
    closeBtn.style.marginTop = '16px';
    closeBtn.style.width = '100%';
    closeBtn.onclick = () => {
        document.body.removeChild(overlay);
    };
    modal.appendChild(closeBtn);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // 点击背景关闭
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            document.body.removeChild(overlay);
        }
    });
}

// Global exposure
window.showScheduleSelector = showScheduleSelector;
