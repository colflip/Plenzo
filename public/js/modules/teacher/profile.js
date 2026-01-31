import { getStatusLabel } from './constants.js';
import { formatDateTimeDisplay, setText } from './utils.js';

const STATUS_TEXT_MAP = Object.freeze({
    '1': '正常',
    '0': '暂停',
    '-1': '删除'
});

let cachedProfile = null;
let isEditMode = false;

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
    cancelPasswordChange: () => document.getElementById('cancelPasswordChange')
};

export async function initProfileSection() {
    bindProfileActions();
    bindPasswordModalActions();
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

    // Close on overlay click only (not on content click)
    const modal = elements.passwordModal();
    if (modal) {
        modal.addEventListener('click', (e) => {
            // Only close if clicking the modal background, not the content
            if (e.target === modal) {
                closePasswordModal();
            }
        });
    }

    // Prevent modal from closing when clicking inside modal-content
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
    } catch (error) {
        console.error('加载教师个人信息失败', error);
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
        last_login_iso
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
        console.error('密码修改失败:', error);
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
        console.error('保存教师个人信息失败', error);
        window.apiUtils.showErrorToast(error);
    } finally {
        disableEditMode(false);
    }
}
