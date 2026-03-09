import { getStatusLabel } from './constants.js';
import { formatDateTimeDisplay, setText } from './utils.js';

const STATUS_TEXT_MAP = Object.freeze({
    '1': '正常',
    '0': '暂停',
    '-1': '删除'
});

let cachedProfile = null;
let isEditMode = false;
let cachedStudents = [];

const elements = {
    avatar: () => document.getElementById('profileAvatar'),
    summaryName: () => document.getElementById('profileSummaryTitle'),
    summaryRole: () => document.querySelector('.profile-summary-role'),
    lastLoginSummary: () => document.getElementById('lastLoginDisplay'),
    statusSummary: () => document.getElementById('statusDisplay'),
    teacherNameHeader: () => document.getElementById('teacherName'),
    teacherRoleHeader: () => document.getElementById('teacherRole'),
    form: () => document.getElementById('profileForm'),
    nameInput: () => document.getElementById('profileNameInput'),
    professionInput: () => document.getElementById('profileProfessionInput'),
    contactInput: () => document.getElementById('profileContactInput'),
    workLocationInput: () => document.getElementById('profileWorkLocationInput'),
    homeAddressInput: () => document.getElementById('profileHomeAddressInput'),
    statusSelect: () => document.getElementById('profileStatusSelect'),
    lastLoginInput: () => document.getElementById('profileLastLoginInput'),
    editBtn: () => document.getElementById('profileEditBtn'),
    saveBtn: () => document.getElementById('profileSaveBtn'),
    changePasswordBtn: () => document.getElementById('changePasswordBtn'),
    // Modal elements
    passwordModal: () => document.getElementById('passwordChangeModal'),
    passwordForm: () => document.getElementById('passwordChangeForm'),
    modalCurrentPassword: () => document.getElementById('modalCurrentPassword'),
    modalNewPassword: () => document.getElementById('modalNewPassword'),
    modalConfirmPassword: () => document.getElementById('modalConfirmPassword'),
    modalPasswordMatchFeedback: () => document.getElementById('modalPasswordMatchFeedback'),
    closePasswordModal: () => document.getElementById('closePasswordModal'),
    cancelPasswordChange: () => document.getElementById('cancelPasswordChange'),
    // 学生管理元素
    studentManagementSection: () => document.getElementById('studentManagementSection'),
    studentListContainer: () => document.getElementById('studentListContainer'),
    refreshStudentsBtn: () => document.getElementById('refreshStudentsBtn'),
    // 学生编辑弹窗
    studentEditModal: () => document.getElementById('studentEditModal'),
    studentEditForm: () => document.getElementById('studentEditForm'),
    editStudentId: () => document.getElementById('editStudentId'),
    editStudentName: () => document.getElementById('editStudentName'),
    editStudentProfession: () => document.getElementById('editStudentProfession'),
    editStudentContact: () => document.getElementById('editStudentContact'),
    editStudentVisitLocation: () => document.getElementById('editStudentVisitLocation'),
    editStudentHomeAddress: () => document.getElementById('editStudentHomeAddress'),
    editStudentStatus: () => document.getElementById('editStudentStatus'),
    closeStudentEditModal: () => document.getElementById('closeStudentEditModal'),
    cancelStudentEdit: () => document.getElementById('cancelStudentEdit'),
    saveStudentEdit: () => document.getElementById('saveStudentEdit')
};

export async function initProfileSection() {
    bindProfileActions();
    bindPasswordModalActions();
    bindStudentManagementActions();
    await loadProfile();
}

function bindProfileActions() {
    const form = elements.form();
    if (form) {
        form.addEventListener('submit', (event) => {
            event.preventDefault();
        });
    }
    elements.editBtn()?.addEventListener('click', enableEditMode);
    elements.saveBtn()?.addEventListener('click', saveProfile);
}

function bindPasswordModalActions() {
    // Open modal
    elements.changePasswordBtn()?.addEventListener('click', openPasswordModal);

    // Close modal
    elements.closePasswordModal()?.addEventListener('click', closePasswordModal);
    elements.cancelPasswordChange()?.addEventListener('click', closePasswordModal);

    // 点击遮罩层（modal-overlay）关闭弹窗
    const modal = elements.passwordModal();
    if (modal) {
        const overlay = modal.querySelector('.modal-overlay');
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                // 遮罩层被点击时关闭弹窗
                closePasswordModal();
            });
        }
    }

    // 阻止点击 modal-content 内部时事件冒泡到 overlay
    const modalContent = modal?.querySelector('.modal-content');
    if (modalContent) {
        modalContent.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

    // Password match validation
    const modalNewPassword = elements.modalNewPassword();
    const modalConfirmPassword = elements.modalConfirmPassword();

    if (modalNewPassword) {
        modalNewPassword.addEventListener('input', checkModalPasswordsMatch);
    }

    if (modalConfirmPassword) {
        modalConfirmPassword.addEventListener('input', checkModalPasswordsMatch);
    }

    // Form submission
    const passwordForm = elements.passwordForm();
    if (passwordForm) {
        passwordForm.addEventListener('submit', handlePasswordChange);
    }
}

async function loadProfile() {
    try {
        const profile = await window.apiUtils.get('/teacher/profile');
        cachedProfile = profile;
        renderProfile(profile);
        if (profile.student_ids) {
            loadAssociatedStudents();
        }
    } catch (error) {
        
        window.apiUtils.showErrorToast(error);
    }
}

function renderProfile(profile) {
    if (!profile) return;
    const {
        name = '教师',
        profession = '',
        contact = '',
        work_location = '',
        home_address = '',
        status = 1,
        last_login,
        last_login_iso,
        student_ids
    } = profile;

    setText(elements.summaryName(), name);
    setText(elements.teacherNameHeader(), name);

    const avatar = elements.avatar();
    if (avatar && profile.id) {
        avatar.textContent = profile.id;
    }

    const statusText = STATUS_TEXT_MAP[String(status)] ?? getStatusLabel(status);
    setText(elements.statusSummary(), statusText);
    setText(elements.summaryRole(), '教师账号');
    setText(elements.teacherRoleHeader(), '(老师)');

    const formattedLastLogin = formatDateTimeDisplay(last_login_iso || last_login);
    setText(elements.lastLoginSummary(), formattedLastLogin);

    const nameInput = elements.nameInput();
    if (nameInput) nameInput.value = name;
    const professionInput = elements.professionInput();
    if (professionInput) professionInput.value = profession ?? '';
    const contactInput = elements.contactInput();
    if (contactInput) contactInput.value = contact ?? '';
    const workLocationInput = elements.workLocationInput();
    if (workLocationInput) workLocationInput.value = work_location ?? '';
    const homeAddressInput = elements.homeAddressInput();
    if (homeAddressInput) homeAddressInput.value = home_address ?? '';
    const statusSelect = elements.statusSelect();
    if (statusSelect) statusSelect.value = String(status ?? 1);
    const lastLoginInput = elements.lastLoginInput();
    if (lastLoginInput) lastLoginInput.value = formattedLastLogin;

    const studentManagementSection = elements.studentManagementSection();
    if (studentManagementSection) {
        if (student_ids && student_ids.trim() !== '') {
            studentManagementSection.style.display = 'block';
        } else {
            studentManagementSection.style.display = 'none';
        }
    }

    disableEditMode(false);
}

function enableEditMode() {
    if (isEditMode) return;
    isEditMode = true;
    toggleFormDisabled(false);

    const editBtn = elements.editBtn();
    const saveBtn = elements.saveBtn();
    if (editBtn) editBtn.hidden = true;
    if (saveBtn) saveBtn.hidden = false;

    elements.nameInput()?.focus();
}

function disableEditMode(reset = false) {
    isEditMode = false;
    toggleFormDisabled(true);

    const editBtn = elements.editBtn();
    const saveBtn = elements.saveBtn();
    if (editBtn) editBtn.hidden = false;
    if (saveBtn) saveBtn.hidden = true;

    if (reset && cachedProfile) {
        renderProfile(cachedProfile);
    }
}

// Modal functions
function openPasswordModal() {
    const modal = elements.passwordModal();
    if (modal) {
        modal.style.display = 'flex';
        // Clear form
        const form = elements.passwordForm();
        if (form) form.reset();
        const feedback = elements.modalPasswordMatchFeedback();
        if (feedback) {
            feedback.textContent = '';
            feedback.className = 'password-match-feedback';
        }
    }
}

function closePasswordModal() {
    const modal = elements.passwordModal();
    if (modal) {
        modal.style.display = 'none';
    }
}

function checkModalPasswordsMatch() {
    const newPassword = elements.modalNewPassword();
    const confirmPassword = elements.modalConfirmPassword();
    const feedback = elements.modalPasswordMatchFeedback();

    if (!newPassword || !confirmPassword || !feedback) return;

    const newPwd = newPassword.value;
    const confirmPwd = confirmPassword.value;

    if (!confirmPwd) {
        feedback.textContent = '';
        feedback.className = 'password-match-feedback';
        return;
    }

    if (newPwd === confirmPwd) {
        feedback.textContent = '✓ 两次密码一致';
        feedback.className = 'password-match-feedback match';
    } else {
        feedback.textContent = '✗ 两次密码不一致';
        feedback.className = 'password-match-feedback mismatch';
    }
}

async function handlePasswordChange(event) {
    event.preventDefault();

    const currentPassword = elements.modalCurrentPassword()?.value;
    const newPassword = elements.modalNewPassword()?.value;
    const confirmPassword = elements.modalConfirmPassword()?.value;

    try {
        // Validation
        if (!currentPassword) {
            throw new Error('请输入当前密码');
        }
        if (!newPassword) {
            throw new Error('请输入新密码');
        }
        if (!confirmPassword) {
            throw new Error('请确认新密码');
        }
        if (newPassword !== confirmPassword) {
            throw new Error('两次输入的新密码不一致');
        }
        if (newPassword === currentPassword) {
            throw new Error('新密码不能与当前密码相同');
        }

        // Call API
        await window.apiUtils.put('/teacher/password', {
            currentPassword: currentPassword,
            newPassword: newPassword
        });

        window.apiUtils.showSuccessToast('密码修改成功');
        closePasswordModal();
    } catch (error) {
        
        window.apiUtils.showErrorToast(error);
    }
}

function toggleFormDisabled(disabled) {
    [
        elements.nameInput(),
        elements.professionInput(),
        elements.contactInput(),
        elements.workLocationInput(),
        elements.homeAddressInput(),
        elements.statusSelect()
    ].forEach(input => {
        if (!input) return;
        if (disabled) {
            input.setAttribute('disabled', 'true');
        } else {
            input.removeAttribute('disabled');
        }
    });
}

async function saveProfile() {
    if (!isEditMode) return;
    const nameInput = elements.nameInput();
    try {
        window.apiUtils.validate.required(nameInput?.value, '姓名');
    } catch (validationError) {
        window.apiUtils.showErrorToast(validationError);
        nameInput?.focus();
        return;
    }

    const payload = {
        name: nameInput?.value?.trim() ?? '',
        profession: elements.professionInput()?.value?.trim() ?? '',
        contact: elements.contactInput()?.value?.trim() ?? '',
        work_location: elements.workLocationInput()?.value?.trim() ?? '',
        home_address: elements.homeAddressInput()?.value?.trim() ?? '',
        status: parseInt(elements.statusSelect()?.value ?? '1', 10)
    };

    try {
        const updated = await window.apiUtils.put('/teacher/profile', payload);
        cachedProfile = {
            ...cachedProfile,
            ...payload,
            ...updated
        };
        window.apiUtils.showSuccessToast('个人信息更新成功');
        renderProfile(cachedProfile);
    } catch (error) {
        
        window.apiUtils.showErrorToast(error);
    } finally {
        disableEditMode(false);
    }
}

// ============ 学生管理功能 ============

function bindStudentManagementActions() {
    elements.refreshStudentsBtn()?.addEventListener('click', loadAssociatedStudents);
    
    elements.closeStudentEditModal()?.addEventListener('click', closeStudentEditModalFn);
    elements.cancelStudentEdit()?.addEventListener('click', closeStudentEditModalFn);
    elements.saveStudentEdit()?.addEventListener('click', handleSaveStudentEdit);
    
    const modal = elements.studentEditModal();
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeStudentEditModalFn();
            }
        });
    }
    
    const modalContent = modal?.querySelector('.modal-content');
    if (modalContent) {
        modalContent.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }
}

async function loadAssociatedStudents() {
    try {
        const response = await window.apiUtils.get('/teacher/associated-students/detail');
        if (response.success && response.data) {
            cachedStudents = response.data;
            renderStudentList(response.data);
        } else {
            renderStudentList([]);
        }
    } catch (error) {
        
        window.apiUtils.showErrorToast(error);
    }
}

function renderStudentList(students) {
    const container = elements.studentListContainer();
    if (!container) return;

    if (!students || students.length === 0) {
        container.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 20px;">暂无关联学生</p>';
        return;
    }

    const tableHTML = `
        <table class="student-info-table" style="width: 100%; border-collapse: collapse;">
            <thead>
                <tr style="background: var(--bg-secondary); border-bottom: 1px solid var(--border-color);">
                    <th style="padding: 12px; text-align: left; font-weight: 500;">ID</th>
                    <th style="padding: 12px; text-align: left; font-weight: 500;">姓名</th>
                    <th style="padding: 12px; text-align: left; font-weight: 500;">专业</th>
                    <th style="padding: 12px; text-align: left; font-weight: 500;">联系方式</th>
                    <th style="padding: 12px; text-align: left; font-weight: 500;">状态</th>
                    <th style="padding: 12px; text-align: center; font-weight: 500;">操作</th>
                </tr>
            </thead>
            <tbody>
                ${students.map(student => `
                    <tr style="border-bottom: 1px solid var(--border-color);" data-student-id="${student.id}">
                        <td style="padding: 12px;">${student.id}</td>
                        <td style="padding: 12px;">${student.name || '-'}</td>
                        <td style="padding: 12px;">${student.profession || '-'}</td>
                        <td style="padding: 12px;">${student.contact || '-'}</td>
                        <td style="padding: 12px;">
                            <span class="status-badge ${getStatusClass(student.status)}" style="padding: 4px 8px; border-radius: 4px; font-size: 12px;">
                                ${STATUS_TEXT_MAP[String(student.status)] || '未知'}
                            </span>
                        </td>
                        <td style="padding: 12px; text-align: center;">
                            <button class="edit-student-btn info-btn" data-student-id="${student.id}" style="padding: 6px 12px; font-size: 13px;">
                                <span class="material-icons-round" style="font-size: 16px;">edit</span> 编辑
                            </button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
    
    container.innerHTML = tableHTML;
    
    container.querySelectorAll('.edit-student-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const studentId = parseInt(btn.dataset.studentId);
            openStudentEditModal(studentId);
        });
    });
}

function getStatusClass(status) {
    switch (String(status)) {
        case '1': return 'status-active';
        case '0': return 'status-pending';
        case '-1': return 'status-cancelled';
        default: return '';
    }
}

function openStudentEditModal(studentId) {
    const student = cachedStudents.find(s => s.id === studentId);
    if (!student) {
        window.apiUtils.showErrorToast('未找到学生信息');
        return;
    }

    elements.editStudentId()?.setAttribute('value', student.id);
    const nameInput = elements.editStudentName();
    if (nameInput) nameInput.value = student.name || '';
    const professionInput = elements.editStudentProfession();
    if (professionInput) professionInput.value = student.profession || '';
    const contactInput = elements.editStudentContact();
    if (contactInput) contactInput.value = student.contact || '';
    const visitLocationInput = elements.editStudentVisitLocation();
    if (visitLocationInput) visitLocationInput.value = student.visit_location || '';
    const homeAddressInput = elements.editStudentHomeAddress();
    if (homeAddressInput) homeAddressInput.value = student.home_address || '';
    const statusSelect = elements.editStudentStatus();
    if (statusSelect) statusSelect.value = String(student.status ?? 1);

    const modal = elements.studentEditModal();
    if (modal) {
        modal.style.display = 'flex';
    }
}

function closeStudentEditModalFn() {
    const modal = elements.studentEditModal();
    if (modal) {
        modal.style.display = 'none';
    }
}

async function handleSaveStudentEdit() {
    const studentId = elements.editStudentId()?.value;
    const nameInput = elements.editStudentName();
    
    try {
        window.apiUtils.validate.required(nameInput?.value, '姓名');
    } catch (validationError) {
        window.apiUtils.showErrorToast(validationError);
        nameInput?.focus();
        return;
    }

    const payload = {
        name: nameInput?.value?.trim() ?? '',
        profession: elements.editStudentProfession()?.value?.trim() ?? '',
        contact: elements.editStudentContact()?.value?.trim() ?? '',
        visit_location: elements.editStudentVisitLocation()?.value?.trim() ?? '',
        home_address: elements.editStudentHomeAddress()?.value?.trim() ?? '',
        status: parseInt(elements.editStudentStatus()?.value ?? '1', 10)
    };

    try {
        const response = await window.apiUtils.put(`/teacher/associated-students/${studentId}`, payload);
        if (response.success) {
            window.apiUtils.showSuccessToast('学生信息更新成功');
            closeStudentEditModalFn();
            await loadAssociatedStudents();
        } else {
            throw new Error(response.message || '更新失败');
        }
    } catch (error) {
        
        window.apiUtils.showErrorToast(error);
    }
}
