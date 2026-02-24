/**
 * Admin Constants
 * @description 管理后台使用的通用常量定义
 */

export const TIME_ZONE = 'Asia/Shanghai';

// 用户列表字段映射
export const USER_FIELDS = {
    admin: ['username', 'name', 'email', 'permission_level', 'last_login', 'created_at'],
    teacher: ['username', 'name', 'profession', 'contact', 'work_location', 'home_address', 'restriction', 'student_ids', 'status', 'last_login', 'created_at'],
    student: ['username', 'name', 'profession', 'contact', 'visit_location', 'home_address', 'status', 'last_login', 'created_at']
};

export const FIELD_LABELS = {
    username: '用户名',
    name: '姓名',
    email: '邮箱',
    permission_level: '权限级别',
    last_login: '最近登录',
    created_at: '创建时间',
    profession: '职业类型',
    contact: '联系方式',
    work_location: '工作地点',
    home_address: '家庭地址',
    visit_location: '入户地点',
    restriction: '限制',
    student_ids: '关联学生',
    status: '状态'
};

// 状态映射
export function getUserStatusLabel(s) {
    const v = Number(s);
    if (v === 1) return '正常';
    if (v === 0) return '暂停';
    if (v === -1) return '删除';
    return String(s ?? '');
}

export function getUserStatusClass(s) {
    const v = Number(s);
    if (v === 1) return 'user-status-active';
    if (v === 0) return 'user-status-paused';
    if (v === -1) return 'user-status-deleted';
    return '';
}
