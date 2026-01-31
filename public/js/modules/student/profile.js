import { API_ENDPOINTS } from './constants.js';
import { showToast, handleApiError, setText, formatDateTimeDisplay } from './utils.js';

let profileData = null;
let isEditing = false;

export async function initProfileSection() {

    // Set up event listeners
    const editBtn = document.getElementById('profileEditBtn');
    const saveBtn = document.getElementById('profileSaveBtn');
    const profileForm = document.getElementById('profileForm');

    if (editBtn) {
        editBtn.addEventListener('click', enableEditing);
    }
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            profileForm.dispatchEvent(new Event('submit'));
        });
    }
    if (profileForm) {
        profileForm.addEventListener('submit', handleProfileSubmit);
    }

    // Bind password modal actions
    bindPasswordModalActions();

    // Load profile data
    await loadProfile();
}

function bindPasswordModalActions() {
    // Open modal
    const changePasswordBtn = document.getElementById('changePasswordBtn');
    if (changePasswordBtn) {
        changePasswordBtn.addEventListener('click', openPasswordModal);
    }

    // Close modal
    const closePasswordModal = document.getElementById('closePasswordModal');
    const cancelPasswordChange = document.getElementById('cancelPasswordChange');
    if (closePasswordModal) {
        closePasswordModal.addEventListener('click', closePasswordModalFn);
    }
    if (cancelPasswordChange) {
        cancelPasswordChange.addEventListener('click', closePasswordModalFn);
    }

    // Close on modal background click only (not on content click)
    const modal = document.getElementById('passwordChangeModal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            // Only close if clicking the modal background, not the content
            if (e.target === modal) {
                closePasswordModalFn();
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
    const modalNewPassword = document.getElementById('modalNewPassword');
    const modalConfirmPassword = document.getElementById('modalConfirmPassword');

    if (modalNewPassword) {
        modalNewPassword.addEventListener('input', checkModalPasswordsMatch);
    }

    if (modalConfirmPassword) {
        modalConfirmPassword.addEventListener('input', checkModalPasswordsMatch);
    }

    // Form submission
    const passwordForm = document.getElementById('passwordChangeForm');
    if (passwordForm) {
        passwordForm.addEventListener('submit', handlePasswordChange);
    }
}

function openPasswordModal() {
    const modal = document.getElementById('passwordChangeModal');
    if (modal) {
        modal.style.display = 'flex';
        // Clear form
        const form = document.getElementById('passwordChangeForm');
        if (form) form.reset();
        const feedback = document.getElementById('modalPasswordMatchFeedback');
        if (feedback) {
            feedback.textContent = '';
            feedback.className = 'password-match-feedback';
        }
    }
}

function closePasswordModalFn() {
    const modal = document.getElementById('passwordChangeModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

function checkModalPasswordsMatch() {
    const newPassword = document.getElementById('modalNewPassword');
    const confirmPassword = document.getElementById('modalConfirmPassword');
    const feedback = document.getElementById('modalPasswordMatchFeedback');

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

    const currentPassword = document.getElementById('modalCurrentPassword')?.value;
    const newPassword = document.getElementById('modalNewPassword')?.value;
    const confirmPassword = document.getElementById('modalConfirmPassword')?.value;

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
        const response = await fetch(API_ENDPOINTS.PASSWORD_CHANGE || '/student/password', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify({
                currentPassword: currentPassword,
                newPassword: newPassword
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || '密码修改失败');
        }

        showToast('密码修改成功', 'success');
        closePasswordModalFn();
    } catch (error) {
        console.error('密码修改失败:', error);
        showToast(error.message || '密码修改失败', 'error');
    }
}

export async function loadProfile() {
    try {
        const response = await fetch(API_ENDPOINTS.PROFILE, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            }
        });

        if (!response.ok) {
            throw new Error('获取个人信息失败');
        }

        const data = await response.json();
        profileData = data;

        updateProfileDisplay(data);
    } catch (error) {
        handleApiError(error, '加载个人信息失败');
    }
}

function updateProfileDisplay(data) {
    // Update summary card
    const profileName = document.getElementById('profileSummaryTitle');
    if (profileName) {
        profileName.textContent = data.name || '学生';
    }

    // Update avatar with user ID
    const avatar = document.getElementById('profileAvatar');
    if (avatar && data.id) {
        avatar.textContent = data.id;
    }

    // Update form fields
    const fields = {
        'profileNameInput': data.name,
        'profileProfessionInput': data.profession,
        'profileContactInput': data.contact,
        'profileWorkLocationInput': data.visit_location || data.work_location,
        'profileHomeAddressInput': data.home_address
    };

    Object.entries(fields).forEach(([id, value]) => {
        const element = document.getElementById(id);
        if (element) {
            element.value = value || '';
        }
    });

    const lastLogin = document.getElementById('lastLoginDisplay');
    const status = document.getElementById('statusDisplay');

    if (lastLogin) setText(lastLogin, formatDateTimeDisplay(data.last_login));
    if (status) setText(status, data.status === 1 ? '正常' : '异常');
}

function toggleFormFields(disabled) {
    const fields = [
        'profileNameInput',
        'profileProfessionInput',
        'profileContactInput',
        'profileWorkLocationInput',
        'profileHomeAddressInput'
    ];

    fields.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.disabled = disabled;
        }
    });
}

function enableEditing() {
    isEditing = true;
    toggleFormFields(false);
    toggleButtons(true);
}

function cancelEditing() {
    isEditing = false;
    toggleFormFields(true);
    toggleButtons(false);
    if (profileData) {
        updateProfileDisplay(profileData);
    }
}

function toggleButtons(editing) {
    const editBtn = document.getElementById('profileEditBtn');
    const saveBtn = document.getElementById('profileSaveBtn');

    if (editBtn) editBtn.hidden = editing;
    if (saveBtn) saveBtn.hidden = !editing;
}

async function handleProfileSubmit(event) {
    event.preventDefault();

    if (!isEditing) {
        return;
    }

    const nameInput = document.getElementById('profileNameInput');
    const professionInput = document.getElementById('profileProfessionInput');
    const contactInput = document.getElementById('profileContactInput');
    const workLocationInput = document.getElementById('profileWorkLocationInput');
    const homeAddressInput = document.getElementById('profileHomeAddressInput');

    const name = nameInput?.value?.trim();
    if (!name) {
        showToast('请输入姓名', 'error');
        nameInput?.focus();
        return;
    }

    const payload = {
        name: name,
        profession: professionInput?.value?.trim() || '',
        contact: contactInput?.value?.trim() || '',
        visit_location: workLocationInput?.value?.trim() || '',
        home_address: homeAddressInput?.value?.trim() || ''
    };

    try {
        const response = await fetch(API_ENDPOINTS.PROFILE, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error('更新个人信息失败');
        }

        const updatedData = await response.json();
        profileData = { ...profileData, ...updatedData };

        showToast('个人信息更新成功', 'success');
        updateProfileDisplay(profileData);
        isEditing = false;
        toggleFormFields(true);
        toggleButtons(false);
    } catch (error) {
        handleApiError(error, '保存个人信息失败');
    }
}
