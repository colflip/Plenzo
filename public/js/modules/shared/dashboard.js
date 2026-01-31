document.addEventListener('DOMContentLoaded', function () {
    // 获取导航菜单项和内容部分
    const navItems = document.querySelectorAll('.nav-item');
    const sections = document.querySelectorAll('.dashboard-section');
    const sidebar = document.querySelector('.sidebar');
    const mainContent = document.querySelector('.main-content');
    const toggleBtn = document.querySelector('.toggle-sidebar');

    // 保存菜单状态到本地存储
    const saveMenuState = (isCollapsed) => {
        localStorage.setItem('sidebarCollapsed', isCollapsed);
    };

    // 读取菜单状态
    const loadMenuState = () => {
        const isCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
        if (isCollapsed) {
            sidebar.classList.add('collapsed');
            mainContent.classList.add('expanded');
        }
    };

    // 切换菜单状态
    const toggleSidebar = () => {
        const isCollapsed = sidebar.classList.toggle('collapsed');
        mainContent.classList.toggle('expanded', isCollapsed);
        saveMenuState(isCollapsed);
    };

    // 侧边栏切换功能
    if (toggleBtn) {
        toggleBtn.addEventListener('click', toggleSidebar);
    }

    // 加载保存的菜单状态
    loadMenuState();

    // 为每个导航项添加点击事件
    navItems.forEach(item => {
        item.addEventListener('click', function (e) {
            e.preventDefault();

            // 移除所有活动类
            navItems.forEach(nav => nav.classList.remove('active'));
            sections.forEach(section => section.classList.remove('active'));

            // 添加活动类到当前项
            this.classList.add('active');

            // 显示相应的部分
            const sectionId = this.getAttribute('data-section');
            document.getElementById(sectionId).classList.add('active');
        });
    });

    // 退出登录功能
    const logoutBtn = document.getElementById('logout');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', function (e) {
            e.preventDefault();
            // 清除本地存储的用户信息
            // Clear Schedule Cache
            Object.keys(localStorage).forEach(key => {
                if (key.startsWith('schedule_widget_admin_')) {
                    localStorage.removeItem(key);
                }
            });

            // Clear Auth
            localStorage.removeItem('token');
            localStorage.removeItem('userData');
            localStorage.removeItem('userType');
            localStorage.removeItem('userName');
            // Redirect
            window.location.href = '/';
        });
    }

    // 显示用户名和角色（从 userData 读取 name 与 userType）
    const userNameElement = document.getElementById('adminName');
    if (userNameElement) {
        const userDataStr = localStorage.getItem('userData');
        if (userDataStr) {
            try {
                const user = JSON.parse(userDataStr);
                const name = user.name || user.username || '用户';
                const type = user.userType;
                let roleName = '未知';
                if (type === 'admin') roleName = '管理员';
                else if (type === 'teacher') roleName = '老师';
                else if (type === 'student') roleName = '学生';
                userNameElement.textContent = `${name}/${roleName}`;
            } catch (_) {
                userNameElement.textContent = '用户/未知';
            }
        }
    }

    // 用户管理功能
    initUserManagement();

    // 排课管理功能
    initScheduleManagement();

    // 数据统计功能
    initStatistics();
});

// 用户管理功能初始化
function initUserManagement() {
    const addUserBtn = document.getElementById('addUserBtn');
    const userForm = document.getElementById('userForm');
    const userTable = document.getElementById('userTable');
    const userFormSubmit = document.getElementById('userFormSubmit');

    if (addUserBtn && userForm) {
        addUserBtn.addEventListener('click', function () {
            // 重置表单
            userForm.reset();
            userForm.setAttribute('data-mode', 'add');
            userForm.setAttribute('data-id', '');
            document.getElementById('userFormTitle').textContent = '添加用户';

            // 显示表单
            document.getElementById('userFormContainer').style.display = 'block';
        });
    }

    if (userFormSubmit && userForm) {
        userFormSubmit.addEventListener('click', function (e) {
            e.preventDefault();

            const mode = userForm.getAttribute('data-mode');
            const userId = userForm.getAttribute('data-id');

            const userData = {
                name: document.getElementById('userName').value,
                email: document.getElementById('userEmail').value,
                password: document.getElementById('userPassword').value,
                type: document.getElementById('userType').value
            };

            if (mode === 'add') {
                // 添加用户
                addUser(userData);
            } else if (mode === 'edit') {
                // 编辑用户
                updateUser(userId, userData);
            }
        });
    }

    // 加载用户列表
    loadUsers();
}

// 加载用户列表
function loadUsers() {
    const userTable = document.getElementById('userTableBody');
    if (!userTable) return;

    // 清空表格
    userTable.innerHTML = '<tr><td colspan="5">加载中...</td></tr>';

    // 获取用户列表
    fetch('/api/users', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
            'Content-Type': 'application/json'
        }
    })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                if (data.users.length === 0) {
                    userTable.innerHTML = '<tr><td colspan="5">暂无用户</td></tr>';
                    return;
                }

                userTable.innerHTML = '';
                data.users.forEach(user => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                    <td>${user.id}</td>
                    <td>${user.username || ''}</td>
                    <td>${user.name || ''}</td>
                    <td>${user.phone || user.email || ''}</td>
                    <td>
                        <button class="edit-btn" data-id="${user.id}">编辑</button>
                        <button class="delete-btn" data-id="${user.id}">删除</button>
                    </td>
                `;
                    userTable.appendChild(tr);
                });

                // 添加编辑和删除事件
                document.querySelectorAll('.edit-btn').forEach(btn => {
                    btn.addEventListener('click', function () {
                        const userId = this.getAttribute('data-id');
                        editUser(userId);
                    });
                });

                document.querySelectorAll('.delete-btn').forEach(btn => {
                    btn.addEventListener('click', function () {
                        const userId = this.getAttribute('data-id');
                        deleteUser(userId);
                    });
                });
            } else {
                userTable.innerHTML = `<tr><td colspan="5">加载失败: ${data.message}</td></tr>`;
            }
        })
        .catch(error => {
            userTable.innerHTML = `<tr><td colspan="5">加载失败: ${error.message}</td></tr>`;
        });
}

// 获取用户类型名称
function getUserTypeName(type) {
    switch (type) {
        case 'admin': return '管理员';
        case 'teacher': return '教师';
        case 'student': return '学生';
        default: return '未知';
    }
}

// 添加用户
function addUser(userData) {
    fetch('/api/users', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(userData)
    })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                // 隐藏表单
                document.getElementById('userFormContainer').style.display = 'none';
                // 重新加载用户列表
                loadUsers();
                // 显示成功消息
                showMessage('用户添加成功', 'success');
            } else {
                showMessage(`用户添加失败: ${data.message}`, 'error');
            }
        })
        .catch(error => {
            showMessage(`用户添加失败: ${error.message}`, 'error');
        });
}

// 编辑用户
function editUser(userId) {
    // 获取用户信息
    fetch(`/api/users/${userId}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
            'Content-Type': 'application/json'
        }
    })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                const user = data.user;

                // 填充表单
                document.getElementById('userName').value = user.name;
                document.getElementById('userEmail').value = user.email;
                document.getElementById('userPassword').value = '';
                document.getElementById('userType').value = user.type;

                // 设置表单模式
                const userForm = document.getElementById('userForm');
                userForm.setAttribute('data-mode', 'edit');
                userForm.setAttribute('data-id', userId);
                document.getElementById('userFormTitle').textContent = '编辑用户';

                // 显示表单
                document.getElementById('userFormContainer').style.display = 'block';
            } else {
                showMessage(`获取用户信息失败: ${data.message}`, 'error');
            }
        })
        .catch(error => {
            showMessage(`获取用户信息失败: ${error.message}`, 'error');
        });
}

// 更新用户
function updateUser(userId, userData) {
    fetch(`/api/users/${userId}`, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(userData)
    })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                // 隐藏表单
                document.getElementById('userFormContainer').style.display = 'none';
                // 重新加载用户列表
                loadUsers();
                // 显示成功消息
                showMessage('用户更新成功', 'success');
            } else {
                showMessage(`用户更新失败: ${data.message}`, 'error');
            }
        })
        .catch(error => {
            showMessage(`用户更新失败: ${error.message}`, 'error');
        });
}

// 删除用户
function deleteUser(userId) {
    if (confirm('确定要删除该用户吗？')) {
        fetch(`/api/users/${userId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`,
                'Content-Type': 'application/json'
            }
        })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    // 重新加载用户列表
                    loadUsers();
                    // 显示成功消息
                    showMessage('用户删除成功', 'success');
                } else {
                    showMessage(`用户删除失败: ${data.message}`, 'error');
                }
            })
            .catch(error => {
                showMessage(`用户删除失败: ${error.message}`, 'error');
            });
    }
}

// 排课管理功能初始化
function initScheduleManagement() {
    const addScheduleBtn = document.getElementById('addScheduleBtn');
    const scheduleForm = document.getElementById('scheduleForm');
    const scheduleFormSubmit = document.getElementById('scheduleFormSubmit');

    if (addScheduleBtn && scheduleForm) {
        addScheduleBtn.addEventListener('click', function () {
            // 重置表单
            scheduleForm.reset();
            scheduleForm.setAttribute('data-mode', 'add');
            scheduleForm.setAttribute('data-id', '');
            document.getElementById('scheduleFormTitle').textContent = '添加排课';

            // 显示表单
            document.getElementById('scheduleFormContainer').style.display = 'block';
        });
    }

    if (scheduleFormSubmit && scheduleForm) {
        scheduleFormSubmit.addEventListener('click', function (e) {
            e.preventDefault();

            const mode = scheduleForm.getAttribute('data-mode');
            const scheduleId = scheduleForm.getAttribute('data-id');

            const scheduleData = {
                teacherId: document.getElementById('scheduleTeacher').value,
                studentIds: [document.getElementById('scheduleStudent').value],
                date: document.getElementById('scheduleDate').value,
                timeSlot: document.getElementById('scheduleTimeSlot') ? document.getElementById('scheduleTimeSlot').value : 'morning',
                startTime: document.getElementById('scheduleStartTime').value,
                endTime: document.getElementById('scheduleEndTime').value,
                scheduleTypes: [1] // 默认类型
            };

            if (mode === 'add') {
                // 添加排课
                addSchedule(scheduleData);
            } else if (mode === 'edit') {
                // 编辑排课
                updateSchedule(scheduleId, scheduleData);
            }
        });
    }

    // 加载排课列表
    loadSchedules();

    // 加载教师和学生下拉列表
    loadTeachers();
    loadStudents();
}

// 加载排课列表
function loadSchedules() {
    const scheduleTable = document.getElementById('scheduleTableBody');
    if (!scheduleTable) return;

    // 清空表格
    scheduleTable.innerHTML = '<tr><td colspan="7">加载中...</td></tr>';

    // 获取排课列表（管理员路由）
    fetch('/api/admin/schedules', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
            'Content-Type': 'application/json'
        }
    })
        .then(response => response.json())
        .then(list => {
            const schedules = Array.isArray(list) ? list : (list && Array.isArray(list.schedules) ? list.schedules : []);
            if (schedules.length === 0) {
                scheduleTable.innerHTML = '<tr><td colspan="7">暂无排课</td></tr>';
                return;
            }

            scheduleTable.innerHTML = '';
            schedules.forEach(schedule => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                <td>${schedule.date || ''}</td>
                <td>${schedule.time_slot || ''}</td>
                <td>${schedule.teacher_name || ''}</td>
                <td>${schedule.student_names || ''}</td>
                <td>${schedule.schedule_types || ''}</td>
                <td>${schedule.status || ''}</td>
                <td>
                    <button class="edit-schedule-btn" data-id="${schedule.id}">编辑</button>
                    <button class="delete-schedule-btn" data-id="${schedule.id}">删除</button>
                </td>
            `;
                scheduleTable.appendChild(tr);
            });

            // 添加编辑和删除事件
            document.querySelectorAll('.edit-schedule-btn').forEach(btn => {
                btn.addEventListener('click', function () {
                    const scheduleId = this.getAttribute('data-id');
                    editSchedule(scheduleId);
                });
            });

            document.querySelectorAll('.delete-schedule-btn').forEach(btn => {
                btn.addEventListener('click', function () {
                    const scheduleId = this.getAttribute('data-id');
                    deleteSchedule(scheduleId);
                });
            });
        })
        .catch(error => {
            scheduleTable.innerHTML = `<tr><td colspan="7">加载失败: ${error.message}</td></tr>`;
        });
}

// 加载教师下拉列表
function loadTeachers() {
    const teacherSelect = document.getElementById('scheduleTeacher');
    if (!teacherSelect) return;

    // 清空下拉列表
    teacherSelect.innerHTML = '<option value="">选择教师</option>';

    // 获取教师列表
    fetch('/api/users?type=teacher', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
            'Content-Type': 'application/json'
        }
    })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                data.users.forEach(teacher => {
                    const option = document.createElement('option');
                    option.value = teacher.id;
                    option.textContent = teacher.name;
                    teacherSelect.appendChild(option);
                });
            }
        })
        .catch(error => {
            console.error('加载教师列表失败:', error);
        });
}

// 加载学生下拉列表
function loadStudents() {
    const studentSelect = document.getElementById('scheduleStudent');
    if (!studentSelect) return;

    // 清空下拉列表
    studentSelect.innerHTML = '<option value="">选择学生</option>';

    // 获取学生列表
    fetch('/api/users?type=student', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
            'Content-Type': 'application/json'
        }
    })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                data.users.forEach(student => {
                    const option = document.createElement('option');
                    option.value = student.id;
                    option.textContent = student.name;
                    studentSelect.appendChild(option);
                });
            }
        })
        .catch(error => {
            console.error('加载学生列表失败:', error);
        });
}

// 数据统计功能初始化
function initStatistics() {
    // 加载教师统计数据
    loadTeacherStatistics();

    // 加载学生统计数据
    loadStudentStatistics();
}

// 加载教师统计数据
function loadTeacherStatistics() {
    const teacherStatsContainer = document.getElementById('teacherStats');
    if (!teacherStatsContainer) return;

    // 清空容器
    teacherStatsContainer.innerHTML = '<div class="loading">加载中...</div>';

    // 获取教师统计数据
    fetch('/api/statistics/teachers', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
            'Content-Type': 'application/json'
        }
    })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                if (data.teachers.length === 0) {
                    teacherStatsContainer.innerHTML = '<div class="no-data">暂无教师数据</div>';
                    return;
                }

                teacherStatsContainer.innerHTML = '';
                data.teachers.forEach(teacher => {
                    const teacherCard = document.createElement('div');
                    teacherCard.className = 'stat-card teacher-stat';
                    teacherCard.innerHTML = `
                    <h3>${teacher.name}</h3>
                    <div class="stat-item">
                        <span>本月课程数:</span>
                        <span>${teacher.monthlySchedules}</span>
                    </div>
                    <div class="stat-item">
                        <span>总课程数:</span>
                        <span>${teacher.totalSchedules}</span>
                    </div>
                    <div class="stat-item">
                        <span>学生数:</span>
                        <span>${teacher.studentCount}</span>
                    </div>
                `;
                    teacherStatsContainer.appendChild(teacherCard);
                });
            } else {
                teacherStatsContainer.innerHTML = `<div class="error">加载失败: ${data.message}</div>`;
            }
        })
        .catch(error => {
            teacherStatsContainer.innerHTML = `<div class="error">加载失败: ${error.message}</div>`;
        });
}

// 加载学生统计数据
function loadStudentStatistics() {
    const studentStatsContainer = document.getElementById('studentStats');
    if (!studentStatsContainer) return;

    // 清空容器
    studentStatsContainer.innerHTML = '<div class="loading">加载中...</div>';

    // 获取学生统计数据
    fetch('/api/statistics/students', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
            'Content-Type': 'application/json'
        }
    })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                if (data.students.length === 0) {
                    studentStatsContainer.innerHTML = '<div class="no-data">暂无学生数据</div>';
                    return;
                }

                studentStatsContainer.innerHTML = '';
                data.students.forEach(student => {
                    const studentCard = document.createElement('div');
                    studentCard.className = 'stat-card student-stat';
                    studentCard.innerHTML = `
                    <h3>${student.name}</h3>
                    <div class="stat-item">
                        <span>本月课程数:</span>
                        <span>${student.monthlySchedules}</span>
                    </div>
                    <div class="stat-item">
                        <span>总课程数:</span>
                        <span>${student.totalSchedules}</span>
                    </div>
                    <div class="stat-item">
                        <span>教师数:</span>
                        <span>${student.teacherCount}</span>
                    </div>
                `;
                    studentStatsContainer.appendChild(studentCard);
                });
            } else {
                studentStatsContainer.innerHTML = `<div class="error">加载失败: ${data.message}</div>`;
            }
        })
        .catch(error => {
            studentStatsContainer.innerHTML = `<div class="error">加载失败: ${error.message}</div>`;
        });
}

// 显示消息
function showMessage(message, type = 'info') {
    const messageContainer = document.getElementById('messageContainer');
    if (!messageContainer) {
        // 创建消息容器
        const container = document.createElement('div');
        container.id = 'messageContainer';
        document.body.appendChild(container);
    }

    const messageElement = document.createElement('div');
    messageElement.className = `message ${type}`;
    messageElement.textContent = message;

    document.getElementById('messageContainer').appendChild(messageElement);

    // 3秒后自动移除
    setTimeout(() => {
        messageElement.remove();
    }, 3000);
}

// 添加排课
function addSchedule(scheduleData) {
    fetch('/api/admin/schedules', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(scheduleData)
    })
        .then(response => response.json())
        .then(data => {
            if (data.id) {
                // 关闭表单
                document.getElementById('scheduleFormContainer').style.display = 'none';
                // 重新加载排课列表
                loadSchedules();
                // 显示成功消息
                showMessage('排课添加成功', 'success');
            } else {
                showMessage(`排课添加失败: ${data.message || '未知错误'}`, 'error');
            }
        })
        .catch(error => {
            showMessage(`排课添加失败: ${error.message}`, 'error');
        });
}

// 编辑排课（管理员列表过滤）
function editSchedule(scheduleId) {
    fetch('/api/admin/schedules', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
            'Content-Type': 'application/json'
        }
    })
        .then(response => response.json())
        .then(list => {
            const schedules = Array.isArray(list) ? list : (list && Array.isArray(list.schedules) ? list.schedules : []);
            const schedule = schedules.find(s => String(s.id) === String(scheduleId));
            if (schedule) {
                document.getElementById('scheduleTeacher').value = schedule.teacher_id || '';
                document.getElementById('scheduleStudent').value = '';
                document.getElementById('scheduleDate').value = schedule.date || '';
                const timeSlotSelect = document.getElementById('scheduleTimeSlot');
                if (timeSlotSelect) timeSlotSelect.value = schedule.time_slot || 'morning';
                document.getElementById('scheduleStartTime').value = schedule.start_time || '';
                document.getElementById('scheduleEndTime').value = schedule.end_time || '';

                const scheduleForm = document.getElementById('scheduleForm');
                scheduleForm.setAttribute('data-mode', 'edit');
                scheduleForm.setAttribute('data-id', scheduleId);
                document.getElementById('scheduleFormTitle').textContent = '编辑排课';

                document.getElementById('scheduleFormContainer').style.display = 'block';
            } else {
                showMessage('未找到该排课记录', 'error');
            }
        })
        .catch(error => {
            showMessage(`获取排课信息失败: ${error.message}`, 'error');
        });
}

// 更新排课
function updateSchedule(scheduleId, scheduleData) {
    fetch(`/api/admin/schedules/${scheduleId}`, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(scheduleData)
    })
        .then(async (response) => {
            const data = await response.json().catch(() => ({}));
            if (response.ok) {
                document.getElementById('scheduleFormContainer').style.display = 'none';
                loadSchedules();
                showMessage('排课更新成功', 'success');
            } else {
                showMessage(`排课更新失败: ${data.message || '未知错误'}`, 'error');
            }
        })
        .catch(error => {
            showMessage(`排课更新失败: ${error.message}`, 'error');
        });
}

// 删除排课
function deleteSchedule(scheduleId) {
    if (confirm('确定要删除这个排课吗？')) {
        fetch(`/api/admin/schedules/${scheduleId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`,
                'Content-Type': 'application/json'
            }
        })
            .then(async (response) => {
                const data = await response.json().catch(() => ({}));
                if (response.ok) {
                    // 重新加载排课列表
                    loadSchedules();
                    // 显示成功消息
                    showMessage('排课删除成功', 'success');
                } else {
                    showMessage(`排课删除失败: ${data.message || '未知错误'}`, 'error');
                }
            })
            .catch(error => {
                showMessage(`排课删除失败: ${error.message}`, 'error');
            });
    }
}