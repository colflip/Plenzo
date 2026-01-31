/**
 * Excel处理服务
 * @description 处理Excel导入导出，支持课程安排、用户数据的批量操作
 * @module services/excelService
 */

const XLSX = require('xlsx');

/**
 * 课程安排列定义
 */
const SCHEDULE_COLUMNS = {
    date: '日期',
    teacherName: '教师',
    studentNames: '学生',
    startTime: '开始时间',
    endTime: '结束时间',
    location: '地点',
    courseTypes: '课程类型',
    status: '状态',
    notes: '备注'
};

/**
 * 用户列定义
 */
const USER_COLUMNS = {
    username: '用户名',
    name: '姓名',
    userType: '用户类型',
    contact: '联系方式',
    email: '邮箱',
    status: '状态'
};

/**
 * 状态映射
 */
const STATUS_MAP = {
    pending: '待确认',
    confirmed: '已确认',
    completed: '已完成',
    cancelled: '已取消'
};

const STATUS_REVERSE_MAP = Object.fromEntries(
    Object.entries(STATUS_MAP).map(([k, v]) => [v, k])
);

/**
 * 导出课程安排到Excel
 * @param {Array} schedules - 课程安排数据
 * @param {Object} options - 导出选项
 * @returns {Buffer} Excel文件Buffer
 */
function exportSchedulesToExcel(schedules, options = {}) {
    const { sheetName = '课程安排', includeHeader = true } = options;

    // 转换数据格式
    const data = schedules.map(schedule => ({
        [SCHEDULE_COLUMNS.date]: formatDate(schedule.schedule_date || schedule.date),
        [SCHEDULE_COLUMNS.teacherName]: schedule.teacher_name || '',
        [SCHEDULE_COLUMNS.studentNames]: Array.isArray(schedule.student_names)
            ? schedule.student_names.join('、')
            : (schedule.student_names || ''),
        [SCHEDULE_COLUMNS.startTime]: schedule.start_time || '',
        [SCHEDULE_COLUMNS.endTime]: schedule.end_time || '',
        [SCHEDULE_COLUMNS.location]: schedule.location || '',
        [SCHEDULE_COLUMNS.courseTypes]: Array.isArray(schedule.type_names)
            ? schedule.type_names.join('、')
            : (schedule.type_names || ''),
        [SCHEDULE_COLUMNS.status]: STATUS_MAP[schedule.status] || schedule.status,
        [SCHEDULE_COLUMNS.notes]: schedule.notes || ''
    }));

    return createExcelBuffer(data, sheetName);
}

/**
 * 导出用户数据到Excel
 * @param {Array} users - 用户数据
 * @param {Object} options - 导出选项
 * @returns {Buffer} Excel文件Buffer
 */
function exportUsersToExcel(users, options = {}) {
    const { sheetName = '用户列表', userType = null } = options;

    const data = users
        .filter(user => !userType || user.user_type === userType)
        .map(user => ({
            [USER_COLUMNS.username]: user.username || '',
            [USER_COLUMNS.name]: user.name || '',
            [USER_COLUMNS.userType]: user.user_type === 'teacher' ? '教师'
                : (user.user_type === 'student' ? '学生' : '管理员'),
            [USER_COLUMNS.contact]: user.contact || '',
            [USER_COLUMNS.email]: user.email || '',
            [USER_COLUMNS.status]: user.status === 1 ? '正常'
                : (user.status === 0 ? '暂停' : '删除')
        }));

    return createExcelBuffer(data, sheetName);
}

/**
 * 解析Excel文件中的课程安排
 * @param {Buffer} buffer - Excel文件Buffer
 * @param {Object} options - 解析选项
 * @returns {Object} { data: Array, errors: Array }
 */
function parseSchedulesFromExcel(buffer, options = {}) {
    const { sheetIndex = 0 } = options;
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[sheetIndex];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    const data = [];
    const errors = [];

    rows.forEach((row, index) => {
        const rowNum = index + 2; // Excel行号（考虑表头）

        try {
            const schedule = {
                date: parseDate(row[SCHEDULE_COLUMNS.date]),
                teacherName: String(row[SCHEDULE_COLUMNS.teacherName] || '').trim(),
                studentNames: String(row[SCHEDULE_COLUMNS.studentNames] || '')
                    .split(/[、,，]/)
                    .map(s => s.trim())
                    .filter(Boolean),
                startTime: parseTime(row[SCHEDULE_COLUMNS.startTime]),
                endTime: parseTime(row[SCHEDULE_COLUMNS.endTime]),
                location: String(row[SCHEDULE_COLUMNS.location] || '').trim(),
                courseTypes: String(row[SCHEDULE_COLUMNS.courseTypes] || '')
                    .split(/[、,，]/)
                    .map(s => s.trim())
                    .filter(Boolean),
                status: STATUS_REVERSE_MAP[row[SCHEDULE_COLUMNS.status]] || 'pending',
                notes: String(row[SCHEDULE_COLUMNS.notes] || '').trim()
            };

            // 基本验证
            if (!schedule.date) {
                throw new Error('日期格式不正确');
            }
            if (!schedule.teacherName) {
                throw new Error('教师不能为空');
            }
            if (!schedule.startTime || !schedule.endTime) {
                throw new Error('时间格式不正确');
            }

            data.push(schedule);
        } catch (error) {
            errors.push({
                row: rowNum,
                message: error.message,
                data: row
            });
        }
    });

    return { data, errors };
}

/**
 * 创建Excel Buffer
 * @param {Array} data - 数据数组
 * @param {string} sheetName - 工作表名称
 * @returns {Buffer} Excel文件Buffer
 */
function createExcelBuffer(data, sheetName = 'Sheet1') {
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

    // 设置列宽
    const colWidths = Object.keys(data[0] || {}).map(key => ({
        wch: Math.max(key.length * 2, 12)
    }));
    worksheet['!cols'] = colWidths;

    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * 格式化日期为 YYYY-MM-DD
 * @param {string|Date} date - 日期
 * @returns {string} 格式化后的日期
 */
function formatDate(date) {
    if (!date) return '';
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().split('T')[0];
}

/**
 * 解析日期字符串
 * @param {string|number} value - 日期值（可能是Excel日期数值）
 * @returns {string|null} YYYY-MM-DD格式日期
 */
function parseDate(value) {
    if (!value) return null;

    // Excel日期数值
    if (typeof value === 'number') {
        const date = XLSX.SSF.parse_date_code(value);
        if (date) {
            return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
        }
    }

    // 字符串日期
    const str = String(value).trim();
    const match = str.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (match) {
        return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    }

    return null;
}

/**
 * 解析时间字符串
 * @param {string|number} value - 时间值
 * @returns {string|null} HH:MM格式时间
 */
function parseTime(value) {
    if (!value) return null;

    // Excel时间数值 (0-1之间)
    if (typeof value === 'number' && value < 1) {
        const totalMinutes = Math.round(value * 24 * 60);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }

    // 字符串时间
    const str = String(value).trim();
    const match = str.match(/^(\d{1,2}):(\d{2})$/);
    if (match) {
        return `${match[1].padStart(2, '0')}:${match[2]}`;
    }

    return null;
}

/**
 * 生成导入模板
 * @param {string} type - 模板类型 ('schedules' | 'users')
 * @returns {Buffer} Excel模板文件Buffer
 */
function generateImportTemplate(type) {
    let headers;
    let sampleData;

    if (type === 'schedules') {
        headers = Object.values(SCHEDULE_COLUMNS);
        sampleData = [{
            [SCHEDULE_COLUMNS.date]: '2026-01-25',
            [SCHEDULE_COLUMNS.teacherName]: '张老师',
            [SCHEDULE_COLUMNS.studentNames]: '李同学、王同学',
            [SCHEDULE_COLUMNS.startTime]: '09:00',
            [SCHEDULE_COLUMNS.endTime]: '10:00',
            [SCHEDULE_COLUMNS.location]: '教室A',
            [SCHEDULE_COLUMNS.courseTypes]: '一对一辅导',
            [SCHEDULE_COLUMNS.status]: '待确认',
            [SCHEDULE_COLUMNS.notes]: '示例备注'
        }];
    } else if (type === 'users') {
        headers = Object.values(USER_COLUMNS);
        sampleData = [{
            [USER_COLUMNS.username]: 'teacher01',
            [USER_COLUMNS.name]: '张老师',
            [USER_COLUMNS.userType]: '教师',
            [USER_COLUMNS.contact]: '13800138000',
            [USER_COLUMNS.email]: 'teacher@example.com',
            [USER_COLUMNS.status]: '正常'
        }];
    } else {
        throw new Error('不支持的模板类型');
    }

    return createExcelBuffer(sampleData, '导入模板');
}

module.exports = {
    exportSchedulesToExcel,
    exportUsersToExcel,
    parseSchedulesFromExcel,
    generateImportTemplate,
    createExcelBuffer,
    formatDate,
    parseDate,
    parseTime,
    SCHEDULE_COLUMNS,
    USER_COLUMNS
};
