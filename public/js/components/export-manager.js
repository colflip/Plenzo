// ==========================================
// Export Data Manager
//
// Excel 导出已迁移到后端 UnifiedExportService。
// 本文件保留数据转换函数供 weekly-view-export.js（图片截图导出）使用。
// ==========================================

/**
 * 标准化类型键：任意写法（中文 description / 英文 slug / 线上变体）→ 规范类型键
 * 委托给全系统唯一实现 public/js/utils/type-conversion.js，本文件不再维护别名表。
 * @param {string} typeKey - 原始类型标识
 * @returns {string} trial | visit | half_visit | review | review_record | group_activity | consultation | consultation_record
 */
function normalizeTypeKey(typeKey) {
    const raw = String(typeKey == null ? '' : typeKey).trim();
    const tc = typeof window !== 'undefined' ? window.TypeConversion : null;
    if (tc) return tc.normalizeTypeKey(raw) || raw.toLowerCase();
    return raw.toLowerCase();
}

/**
 * 取全系统唯一实现 public/js/utils/type-conversion.js。
 * 未加载即报错 —— 宁可炸也不悄悄退回旧口径（历史上两份公式并存就是这么漂移的）。
 * @returns {Object} window.TypeConversion
 */
function requireTypeConversion() {
    const tc = typeof window !== 'undefined' ? window.TypeConversion : null;
    if (!tc) {
        throw new Error('TypeConversion 未加载：dashboard.html 必须在 export-manager.js 之前引入 /js/utils/type-conversion.js');
    }
    return tc;
}

/**
 * 把本模块内部的英文原始计数交给唯一实现折算。
 * 折算规则（含 大评审 = 1 评审、集体活动 = 1 评审）见 public/js/utils/type-conversion.js，
 * 本文件不再自维护公式 —— 曾因两份公式并存而与 Excel 导出、浏览页统计口径不一致。
 * @param {Object} stat - trial/home_visit/half_visit/review/review_record/consultation/consultation_record/group_activity
 * @returns {{trial:number, visit:number, review:number, consultation:number, uncategorized:number}}
 */
function convertStatBuckets(stat) {
    const tc = requireTypeConversion();
    if (typeof tc.accumulateConvertedColumns !== 'function') {
        throw new Error('TypeConversion 缺少 accumulateConvertedColumns：请检查 /js/utils/type-conversion.js 是否完整');
    }
    return tc.accumulateConvertedColumns(tc.createConvertedTotals(), {
        '试教': stat.trial,
        '入户': stat.home_visit,
        '半次入户': stat.half_visit,
        '评审': stat.review,
        '评审记录': stat.review_record,
        '集体活动': stat.group_activity,
        '咨询': stat.consultation,
        '咨询记录': stat.consultation_record
    });
}

/**
 * 单元格（或某一状态分组）的文字颜色类别。
 * 规则唯一实现见 public/js/utils/type-conversion.js::getColorKind：
 *   红 = 评审族（评审 / 大评审 / 评审记录）+ 咨询族；蓝 = 集体活动；其余黑。
 * 同一格内有多种类型时的优先级：红 > 蓝 > 黑（评审/咨询的信息量最大）。
 * 此前这里只有红/黑两档（`typeName.includes('评审') || includes('咨询')`），
 * 集体活动被当成"其余"染成黑色，与 Excel 导出的蓝字不一致。
 * @param {Array} items - 已带 _typeName 的课程行
 * @returns {'red'|'blue'|'black'}
 */
function cellColorKind(items) {
    const tc = requireTypeConversion();
    if (typeof tc.getColorKind !== 'function') {
        throw new Error('TypeConversion 缺少 getColorKind：请检查 /js/utils/type-conversion.js 是否完整');
    }
    let kind = 'black';
    (items || []).forEach(r => {
        const k = tc.getColorKind(r._typeName);
        if (k === 'red') kind = 'red';
        else if (k === 'blue' && kind !== 'red') kind = 'blue';
    });
    return kind;
}

function isCountableSchedule(row) {
    const status = String(row?.status ?? row?.['状态'] ?? '').toLowerCase();
    return !['0', 'cancelled', '已取消', 'modified_away', '已调整'].includes(status);
}

/**
 * 辅助函数：为数据添加汇总行
 * @param {Array} data 数据数组
 * @param {Array} skipKeys 跳过统计的键
 */
function appendSummaryRow(data, skipKeys = ['备注', '核对']) {
    if (!data || data.length === 0) return data;
    const summary = { _isSummaryRow: true };
    const firstRow = data[0];

    // 统计各类型的总数，用于生成最终的“汇总”列
    const typeTotals = {};

    Object.keys(firstRow).forEach(key => {
        if (key.startsWith('_')) return;

        // 姓名列保持显示为 /
        if (key === '姓名' || key === '学生姓名' || key === '教师姓名') {
            summary[key] = '/';
        } else if (skipKeys.includes(key)) {
            summary[key] = '/';
        } else if (key === '汇总') {
            // 先占位，后面根据 typeTotals 生成
            summary[key] = '';
        } else {
            let sum = 0;
            let isNumeric = false;
            data.forEach(row => {
                const val = row[key];
                if (val !== undefined && val !== null && val !== '/' && val !== '') {
                    const num = parseFloat(val);
                    if (!isNaN(num)) {
                        sum += num;
                        isNumeric = true;
                    }
                }
            });
            if (isNumeric && sum > 0) {
                summary[key] = sum;
                typeTotals[key] = sum;
            } else {
                summary[key] = '/';
            }
        }
    });

    // 处理特殊的“汇总”列逻辑：按类型进行的汇总字符串
    const details = [];
    Object.keys(typeTotals).forEach(type => {
        details.push(`${typeTotals[type]}次${type}`);
    });
    summary['汇总'] = details.length > 0 ? details.join('、') : '/';

    data.push(summary);
    return data;
}

/**
 * 辅助函数：过滤掉全空的课程类型列
 * @param {Array} data 数据数组
 * @param {Array} columnsToCheck 需要检查的列名
 * @returns {Array} 过滤后的数据
 */
function filterEmptyColumns(data, columnsToCheck = ['试教', '入户', '评审', '集体活动', '咨询']) {
    if (!data || data.length === 0) return data;

    // 检查哪些列确实有有效数据 (排除 summary 行，或检查 summary 行是否为 /)
    const columnsWithData = new Set();
    data.forEach(row => {
        // 如果是汇总行，我们需要看汇总行本身是否有数值（非 /）
        columnsToCheck.forEach(col => {
            const val = row[col];
            // 只要有一个非空值（非 0, 非 /, 非空串），则该列保留
            if (val !== undefined && val !== null && val !== '/' && val !== 0 && val !== '0' && val !== '') {
                columnsWithData.add(col);
            }
        });
    });

    const columnsToRemove = columnsToCheck.filter(col => !columnsWithData.has(col));
    if (columnsToRemove.length === 0) return data;

    return data.map(row => {
        const newRow = { ...row };
        columnsToRemove.forEach(col => delete newRow[col]);
        return newRow;
    });
}

/**
 * 转换导出数据：映射列名，格式化类型和状态
 * @param {Array} originalData 原始数据数组
 * @returns {Array|Object} 转换后的数据数组或多 Sheet 对象
 */
// 生成日历排课表数据 —— 唯一实现在 public/js/utils/schedule-calendar-core.js，
// 与服务端 Excel 第 1 工作表（calendar-generator.js）共用同一份行模型/费用口径/周键。
// isStudent 只影响学生前缀渲染，费用列的移除发生在 transformExportData 的 sheet1Data。
function transformToCalendarData(originalData, startDate, endDate, studentId, isStudent = false) {
    const core = window.ScheduleCalendarCore;
    if (!core) return [];
    return core.generateCalendarRows(Array.isArray(originalData) ? originalData : [], {
        startDate,
        endDate,
        studentId
    });
}
/**
 * 数据转换处理函数
 * @param {Array} originalData 原始数据
 * @param {string} studentId 学生ID (可选)
 * @param {string} studentName 学生姓名 (可选)
 * @param {string} userType 用户类型 (通过调用方显式传入，默认 undefined)
 */
function transformExportData(originalData, studentId, studentName = '全部学生', passedUserType, passedState, passedExportTypes) {
    // 使用传入的参数，提供默认值避免后续代码报错
    const state = passedState || { startDate: null, endDate: null, selectedType: null };
    const EXPORT_TYPES = passedExportTypes || { TEACHER_SCHEDULE: 'teacher_schedule', STUDENT_SCHEDULE: 'student_schedule' };
    // 如果后端已经返回了多 Sheet 格式（对象且非数组），则直接原样返回（由 generateExcelFile 处理）词词词
    if (originalData && typeof originalData === 'object' && !Array.isArray(originalData)) {
        return originalData;
    }

    if (!Array.isArray(originalData)) return [];

    // 状态映射
    const statusMap = {
        1: '正常',
        0: '已取消',
        2: '已完成',
        'pending': '待确认',
        'confirmed': '已确认',
        'completed': '已完成',
        'cancelled': '已取消',
        'modified_away': '已调整'
    };

    // 优先使用传入的 userType，否则尝试从全局获取，最后默认为 'admin'
    const currentUser = window.currentUser || {};
    const userType = passedUserType || currentUser.userType || 'admin';

    // 核心助手：格式化本地日期 (解决时区偏置)
    const formatLocaleDate = (val) => {
        if (!val) return '';
        const d = new Date(val);
        if (isNaN(d.getTime())) return String(val);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    // 获取类型名称的辅助函数
    const getTypeName = (typeIdOrName) => {
        if (!typeIdOrName) return '';
        // 如果是数字ID，尝试查找
        if (window.ScheduleTypesStore) {
            const type = window.ScheduleTypesStore.getById(typeIdOrName);
            if (type) return type.name || type.description;
        }
        return String(typeIdOrName);
    };

    // 转换基础数据（第一张表：排课明细）
    const baseData = originalData.map(row => {
        // 解析日期和时间
        let dateStr = row.date || row.arr_date || row.class_date || row['日期'] || '';
        if (dateStr) {
            dateStr = formatLocaleDate(dateStr);
        }

        // 计算星期
        let weekStr = '';
        if (dateStr) {
            const date = new Date(dateStr);
            if (!isNaN(date.getTime())) {
                const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
                weekStr = days[date.getDay()];
            }
        }

        // 3. 类型: 中文 (英文)
        // 后端返回的 Keys 中包含 '类型' (值为英文 name, e.g. 'visit')
        const rawTypeVal = row['类型'] || row.course_id || row.courseId || row.type || row.schedule_type || row.type_id;
        let typeKey = '';
        let typeDesc = '未知';

        // 尝试从 Store 获取
        if (window.ScheduleTypesStore && typeof window.ScheduleTypesStore.getAll === 'function') {
            const allTypes = window.ScheduleTypesStore.getAll();
            let t = null;

            // 1. 尝试通过 name 匹配 (e.g. rawTypeVal === 'visit')
            t = allTypes.find(item => item.name === rawTypeVal);

            // 2. 如果没找到，尝试通过 ID 匹配
            if (!t) {
                t = allTypes.find(item => String(item.id) === String(rawTypeVal));
            }

            if (t) {
                typeKey = t.name || '';         // e.g. visit, review_online
                typeDesc = t.description || '未知'; // e.g. 入户, （线上）评审
            }
        }

        // 如果 Store 查找失败，但有原始值
        if (typeDesc === '未知' && rawTypeVal) {
            typeKey = String(rawTypeVal);
        }

        // 使用"中文 (英文)"格式显示
        const typeStr = (typeDesc !== '未知' || (typeKey && typeKey !== '0')) ? `${typeDesc} (${typeKey})` : '未知';

        // 4. 时间段 start_time-end_time
        // 后端返回的 Keys 中包含 '时间'，或尝试 start_time
        let timeStr = '';

        // 优先检查 start_time / end_time (以防后端修正后返回这些字段)
        let sTime = row.start_time || row.startTime || row.begin_time;
        let eTime = row.end_time || row.endTime || row.finish_time;

        if (sTime && eTime) {
            const fmt = (t) => {
                if (!t) return '';
                const match = String(t).match(/(\d{1,2}:\d{2})/);
                return match ? match[1].padStart(5, '0') : String(t);
            };
            timeStr = `${fmt(sTime)} -${fmt(eTime)} `;
        } else if (row['时间']) {
            // 如果后端直接返回 '时间' 字段
            timeStr = row['时间'];
        } else if (row['时间段']) {
            // 兼容高级导出中已映射为中文 Key 的 '时间段'
            timeStr = row['时间段'];
        } else if (row.time_range && row.time_range !== 'undefined-undefined') {
            timeStr = row.time_range;
        }

        // 格式化创建时间
        let createdAtStr = row.created_at || row['创建时间'] || '';
        if (createdAtStr) {
            if (String(createdAtStr).includes('-') && String(createdAtStr).includes(':')) {
                // 可能是已经格式化的，不做处理
            } else {
                try {
                    const d = new Date(createdAtStr);
                    if (!isNaN(d.getTime())) {
                        createdAtStr = d.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
                    }
                } catch (e) { }
            }
        }

        const statusVal = row.status || row['状态'];

        return {
            '教师名称': row.teacher_name || row.name || row['教师名称'] || '',
            '学生名称': row.student_name || row['学生名称'] || '',
            '类型': typeStr,
            '日期': dateStr,
            '星期': weekStr,
            '时间段': timeStr,
            '状态': statusMap[statusVal] || statusVal || '未知',
            '创建时间': createdAtStr,
            '排课ID': row.id || row.schedule_id || row['排课ID'] || '',
            '教师ID': row.teacher_id || row['教师ID'] || '',
            '学生ID': row.student_id || row['学生ID'] || '',
            '备注': row.remark || row.notes || row['备注'] || '',
            '_transport_fee': parseFloat(row.transport_fee) || 0,
            '_other_fee': parseFloat(row.other_fee) || 0
        };
    });

    // ============ 管理员/班主任教师角色导出逻辑 (4个工作表深度重构) ============
    if (userType === 'admin' || userType === 'teacher' || userType === 'student') {
        const isTeacher = userType === 'teacher';
        const isStudent = userType === 'student';
        const studentStats = aggregateStudentStats(originalData, state);
        const teacherStats = aggregateTeacherStats(originalData, studentName, state);
        const calendarData = transformToCalendarData(originalData, state.startDate, state.endDate, studentId, isStudent);

        // 1. 每日排课明细 (Sheet 1) - 已按要求移除“周汇总”列
        const sheet1Data = calendarData.map(row => {
            const newRow = { ...row };
            if (isStudent) {
                delete newRow['费用'];
                delete newRow['周汇总'];
            }
            return newRow;
        });

        // 2 & 5. 授课/上课汇总：始终同时构建教师汇总与学生汇总，两表结构与样式完全一致
        const fz = (v) => (v === 0 || v === '0' || !v) ? '/' : v;

        const buildSummary = (stats, nameHeader) => stats.map(stat => ({
            [nameHeader]: stat['姓名'],
            '试教': fz(stat['试教']),
            '入户': fz(stat['入户']),
            '评审': fz(stat['评审']),
            '集体活动': fz(stat['集体活动']),
            '咨询': fz(stat['咨询']),
            '汇总': fz(stat['汇总']),
            '核对': '未核对',
            '备注': stat['备注']
        }));

        let teacherSummary = buildSummary(teacherStats, '教师姓名');
        let studentSummary = buildSummary(studentStats, '学生姓名');

        appendSummaryRow(teacherSummary);
        appendSummaryRow(studentSummary);

        // 汇总行核对列祝福语
        const blessingText = (isTeacher || userType === 'admin') ? 'Congratulations！🎉' : 'Good Luck！🎉';
        [teacherSummary, studentSummary].forEach(sheet => {
            if (sheet.length > 0) sheet[sheet.length - 1]['核对'] = blessingText;
        });

        // 过滤空列需求: 如果‘集体活动’列或‘咨询’列为空，则不显示此列
        teacherSummary = filterEmptyColumns(teacherSummary, ['集体活动', '咨询']);
        studentSummary = filterEmptyColumns(studentSummary, ['集体活动', '咨询']);

        // 3. 排课原始记录 (Sheet 3 - 21个列精准映射)
        // 预处理：找出同一天有多位老师授课的日期（包含已取消的课程）
        const dateTeacherMap = new Map();
        originalData.forEach(row => {
            const dateStr = formatLocaleDate(row.date || row.class_date || row['日期']);
            const teacherName = row.teacher_name || '';
            if (!dateStr || !teacherName) return;

            if (!dateTeacherMap.has(dateStr)) {
                dateTeacherMap.set(dateStr, new Map());
            }
            const teacherMap = dateTeacherMap.get(dateStr);
            if (!teacherMap.has(teacherName)) {
                teacherMap.set(teacherName, []);
            }
            teacherMap.get(teacherName).push(row);
        });

        // 标记有多个老师的日期
        const multiTeacherDates = new Set();
        dateTeacherMap.forEach((teacherMap, dateStr) => {
            if (teacherMap.size > 1) {
                multiTeacherDates.add(dateStr);
            }
        });

        let sheet3Data = originalData.map(row => {
            const dateStr = formatLocaleDate(row.date || row.class_date || row['日期']);
            const d = new Date(dateStr);
            const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
            // 重要：基于格式化后的 dateStr 重新解析，确保星期同步
            const weekStr = dateStr ? weekDays[new Date(dateStr).getDay()] : '';

            const startTime = row.start_time || '';
            const endTime = row.end_time || '';
            const timeStr = (startTime && endTime) ? `${String(startTime).substring(0, 5)}-${String(endTime).substring(0, 5)}` : '';

            const familyMap = {
                0: '无人', 1: '妈', 2: '爸', 3: '爸妈', 4: '多人',
                10: '学生', 11: '学生+妈', 12: '学生+爸', 13: '学生+爸妈', 14: '学生+多人'
            };

            const statusMap = {
                'pending': '待确认', 'confirmed': '已确认', 'cancelled': '已取消', 'completed': '已完成', 'modified_away': '已调整'
            };

            // 格式化时间函数
            const fmt = (val) => {
                if (!val) return '';
                const date = new Date(val);
                return isNaN(date.getTime()) ? String(val) : date.toLocaleString('zh-CN', { hour12: false });
            };

            // 费用 0 处理：仅已完成(completed/2)、已取消(cancelled/0)状态显示为 /
            const sVal = String(row.status || '').toLowerCase();
            const isFinalStatus = ['completed', '2', 'cancelled', '0'].includes(sVal);

            // 费用处理逻辑优化：改回按单行记录显示。取消原有的 multiTeacherDates 汇总字符串逻辑。
            // 交通费处理
            let tFeeRaw = row.transport_fee !== undefined ? row.transport_fee : (row['交通费'] || '');
            let tFeeStr = '';

            if (tFeeRaw === '' || tFeeRaw === null || Number(tFeeRaw) === 0) {
                tFeeStr = '\\'; // 零值或空值显示 \
            } else {
                tFeeStr = String(tFeeRaw);
            }

            // 其他费用处理
            let oFeeRaw = row.other_fee !== undefined ? row.other_fee : (row['其他费用'] || '');
            let oFeeStr = '';
            if (oFeeRaw === '' || oFeeRaw === null || Number(oFeeRaw) === 0) {
                oFeeStr = '\\';
            } else {
                oFeeStr = String(oFeeRaw);
            }

            // 构建有序对象
            return {
                '日期': dateStr,
                '星期': weekStr,
                '教师名称': row.teacher_name || '',
                '学生名称': row.student_name || '',
                '类型': row.type_desc || row.type_name || row['类型'] || '',
                '时间段': timeStr,
                '状态': statusMap[row.status] || row.status || '',
                '上课地点': row.location || '',
                '创建时间': fmt(row.created_at),
                '更新时间': fmt(row.updated_at),
                '课程状态自动更新时间': fmt(row.last_auto_update),
                '排课 ID': row.schedule_id || row.id || '',
                '教师 ID': row.teacher_id || '',
                '学生 ID': row.student_id || '',
                'admin ID': row.created_by || '',
                '家庭参加人员': familyMap[row.family_participants] !== undefined ? familyMap[row.family_participants] : (row.family_participants || ''),
                '教师评分': row.teacher_rating || '',
                '教师评价内容': row.teacher_comment || '',
                '学生评分': row.student_rating || '',
                '学生评价内容': row.student_comment || '',
                '交通费': tFeeStr,
                '其他费用': oFeeStr,
                '备注': ''
            };
        });

        // 学生端移除敏感列
        if (isStudent) {
            sheet3Data = sheet3Data.map(row => {
                const newRow = { ...row };
                delete newRow['学生名称'];
                delete newRow['交通费'];
                delete newRow['其他费用'];
                return newRow;
            });
        }

        // 管理员端：交通费用数据权限控制 - 仅显示当前管理员的交通费用
        if (userType === 'admin' && currentUser.id) {
            const currentAdminId = currentUser.id;
            sheet3Data = sheet3Data.map(row => {
                const newRow = { ...row };
                // 仅当记录的 created_by 与当前管理员ID匹配时才显示交通费，否则显示 "/"
                if (newRow['admin ID'] !== currentAdminId) {
                    newRow['交通费'] = '/';
                }
                return newRow;
            });
        }

        // 管理员端：交通费用格式设置 - 纯数字，保留两位小数，null/空/0 显示 "/"
        if (userType === 'admin') {
            sheet3Data = sheet3Data.map(row => {
                const newRow = { ...row };
                const feeValue = newRow['交通费'];
                // 处理交通费格式：如果是有效数字则保留两位小数，否则显示 "/"
                if (feeValue !== '/' && feeValue !== '' && feeValue !== null && feeValue !== undefined) {
                    const num = parseFloat(feeValue);
                    if (!isNaN(num) && num !== 0) {
                        newRow['交通费'] = Number(num.toFixed(2));
                    } else {
                        newRow['交通费'] = '/';
                    }
                }
                return newRow;
            });
        }

        // 教师授课统计 / 学生上课统计 (动态透视结构) —— 同一逻辑按维度跑两次
        // 获取全量课程类型列表 (从 Store 获取描述)
        let allTypeConfigs = [];
        if (window.ScheduleTypesStore) {
            allTypeConfigs = window.ScheduleTypesStore.getAll() || [];
        }
        // 按 ID 排序以保证列顺序稳定
        allTypeConfigs.sort((a, b) => Number(a.id) - Number(b.id));

        const typeHeaders = allTypeConfigs.map(t => t.description || t.name);
        const typeIdToHeader = {};
        allTypeConfigs.forEach(t => {
            typeIdToHeader[t.id] = t.description || t.name;
        });

        // 构建透视统计表：dimension = 'teacher' | 'student'
        const buildPivot = (dimension) => {
            const nameHeader = dimension === 'teacher' ? '教师姓名' : '学生姓名';
            const statsMap = new Map();

            originalData.forEach(row => {
                if (!isCountableSchedule(row)) return;

                const name = dimension === 'teacher'
                    ? (row.teacher_name || row['教师名称'] || '')
                    : (row.student_name || row['学生名称'] || '');
                const personId = dimension === 'teacher'
                    ? (row.teacher_id || row['教师ID'] || 999999)
                    : (row.student_id || row['学生ID'] || 999999);

                if (!name) return;

                if (!statsMap.has(name)) {
                    statsMap.set(name, { 姓名: name, _id: personId, types: {} });
                }
                const entry = statsMap.get(name);

                const typeId = row.course_id || row.type_id;
                const header = typeIdToHeader[typeId] || row.type_desc || row.type_name || '其他';
                entry.types[header] = (entry.types[header] || 0) + 1;
            });

            const sortedEntries = Array.from(statsMap.values())
                .sort((a, b) => Number(a._id) - Number(b._id));

            const data = sortedEntries.map(entry => {
                const r = {};
                r[nameHeader] = entry.姓名;
                typeHeaders.forEach(header => {
                    const val = entry.types[header] || 0;
                    r[header] = val === 0 ? '/' : val;
                });
                const parts = [];
                typeHeaders.forEach(header => {
                    const count = entry.types[header] || 0;
                    if (count > 0) parts.push(`${count}次${header}`);
                });
                r['汇总'] = parts.join('，') || '/';
                return r;
            });

            appendSummaryRow(data, ['备注', '核对']);
            return data;
        };

        const teacherStatsSheet = buildPivot('teacher');
        const studentStatsSheet = buildPivot('student');

        // ============ 组装 6 张工作表（固定顺序）============
        return {
            '每日排课明细': sheet1Data,
            '教师授课汇总': teacherSummary,
            '教师授课统计': teacherStatsSheet,
            '排课原始记录': sheet3Data,
            '学生上课汇总': studentSummary,
            '学生上课统计': studentStatsSheet
        };
    }

    return baseData;
}
/**
 * 聚合学生统计数据 (第二张表)
 * 逻辑：
 * 1. 按学生汇总
 * 2. 入户/评审 去重逻辑：同一日期和时间(start_time)的n个老师授课/评审，当作一次。
 */
function aggregateStudentStats(rawData, state = {}) {
    const statsMap = new Map();

    rawData.forEach(row => {
        if (!isCountableSchedule(row)) return;

        const studentName = row.student_name || row['学生名称'] || '未知学生';
        const studentId = row.student_id || row.id || row['学生ID'] || 999999;  // 收集学生ID,默认值为大数字

        if (!statsMap.has(studentName)) {
            statsMap.set(studentName, {
                name: studentName,
                student_id: studentId,  // 添加学生ID字段
                trial: 0,        // 试教
                home_visit: 0,   // 入户
                half_visit: 0,   // 半次入户
                review: 0,       // 评审
                review_record: 0,// 评审记录
                consultation: 0, // 咨询/advisory
                consultation_record: 0, // 咨询记录
                group_activity: 0, // 集体活动
                others: 0,
                dates: new Set() // 用于记录日期范围
            });
        }

        const stat = statsMap.get(studentName);

        // 记录日期
        let dateStr = row.date || row.arr_date || row.class_date || row['日期'] || '';
        if (dateStr && dateStr.includes('T')) dateStr = dateStr.split('T')[0];
        if (dateStr) stat.dates.add(dateStr);

        // 统计类型
        let typeKey = ''; // english key: visit, review, etc.
        const typeVal = row.course_id || row.type || row.schedule_type || row['类型'];

        if (window.ScheduleTypesStore && window.ScheduleTypesStore.getById) {
            const t = window.ScheduleTypesStore.getById(typeVal);
            typeKey = t ? t.name : String(typeVal); // name is usually the english key
        } else {
            // Fallback if store not loaded
            typeKey = String(typeVal || '');
        }

        // 标准化处理：线上类型 → 基础类型 (review_online → review, visit_online → visit)
        typeKey = normalizeTypeKey(typeKey);

        // Strict matching based on schedule_types table (image provided by user)
        if (typeKey === 'visit') stat.home_visit++;
        else if (typeKey === 'half_visit') stat.half_visit++;
        else if (typeKey === 'review') stat.review++;
        else if (typeKey === 'review_record') stat.review_record++;
        else if (typeKey === 'trial') stat.trial++;
        else if (typeKey === 'consultation' || typeKey === 'advisory') stat.consultation++;
        else if (typeKey === 'consultation_record') stat.consultation_record++;
        else if (typeKey === 'group_activity') stat.group_activity++;
        else {
            // Regex fallbacks only if strict match fails
            if (/half_visit/i.test(typeKey)) stat.half_visit++;
            else if (/visit/i.test(typeKey)) stat.home_visit++;
            else if (/review_record/i.test(typeKey)) stat.review_record++;
            else if (/review/i.test(typeKey)) stat.review++;
            else if (/trial/i.test(typeKey)) stat.trial++;
            else if (/consultation|advisory/i.test(typeKey)) stat.consultation++;
            else if (/consultation_record/i.test(typeKey)) stat.consultation_record++;
            else if (/group/i.test(typeKey)) stat.group_activity++;
            else stat.others++;
        }
    });

    const result = [];
    // 转换 Map 为数组并可以计算衍生字段
    statsMap.forEach(stat => {
        // 计算日期范围字符串
        let dateRangeStr = '';
        if (state.startDate && state.endDate) {
            const s = state.startDate.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
            const e = state.endDate.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
            dateRangeStr = `${s}至${e} `;
        } else {
            const sortedDates = Array.from(stat.dates).sort();
            if (sortedDates.length > 0) {
                dateRangeStr = sortedDates.length === 1 ? sortedDates[0] : `${sortedDates[0]}至${sortedDates[sortedDates.length - 1]} `;
            }
        }

        // ============ 折算（唯一实现 public/js/utils/type-conversion.js）============
        // 入户 = 入户 + 半次入户×0.5 + 评审记录×0.5 + 咨询记录×0.5
        // 评审 = 评审 + 评审记录 + 大评审 + 集体活动（1:1）  试教 取原值
        const totals = convertStatBuckets(stat);
        const finalTrial = totals.trial;
        const finalVisit = totals.visit;
        const finalReview = totals.review;
        const finalConsult = totals.consultation;
        // 集体活动已 1:1 折算进评审，恒为 0；保留该键让 filterEmptyColumns 能把整列删掉
        const finalGroup = 0;

        let cleanDateRange = dateRangeStr.trim().replace('至', ' 至 ');

        const details = [];
        if (finalTrial > 0) details.push(`${finalTrial}次试教`);
        if (finalVisit > 0) details.push(`${finalVisit}次入户`);
        if (finalReview > 0) details.push(`${finalReview}次评审`);
        if (finalConsult > 0) details.push(`${finalConsult}次咨询`);

        const detailsStr = details.length > 0 ? details.join('、') : '无';

        let teacherText = state.teacherName || '所有老师';
        const remarks = `${stat.name}同学好！${cleanDateRange} 期间，您在[${teacherText}]处入户等相关数据为 ：${detailsStr}。请问是否正确？`;

        result.push({
            '姓名': stat.name,
            '_student_id': stat.student_id,  // 内部字段用于排序
            '试教': finalTrial,
            '入户': finalVisit,
            '评审': finalReview,
            '集体活动': finalGroup,
            '咨询': finalConsult,
            '汇总': detailsStr,
            '核对': '确定', // 默认为确定，管理员可手动微调
            '备注': remarks
        });
    });

    // 按学生ID从小到大排序
    result.sort((a, b) => Number(a._student_id) - Number(b._student_id));

    return result;
}
/**
 * 聚合老师统计数据 (第二张表)
 * @param {Array} rawData 原始数据
 * @param {string} studentName 学生名称（用于备注）
 */
function aggregateTeacherStats(rawData, studentName = '全部学生', state = {}) {
    const statsMap = new Map();

    rawData.forEach(row => {
        if (!isCountableSchedule(row)) return;

        const teacherName = row.teacher_name || row.name || row['教师名称'] || '未知老师';
        const teacherId = row.teacher_id || row.id || row['教师ID'] || 999999;  // 收集教师ID,默认值为大数字

        if (!statsMap.has(teacherName)) {
            statsMap.set(teacherName, {
                name: teacherName,
                teacher_id: teacherId,  // 添加教师ID字段
                trial: 0,        // 试教
                home_visit: 0,   // 入户
                half_visit: 0,   // 半次入户
                review: 0,       // 评审
                review_record: 0,// 评审记录
                consultation: 0, // 咨询/advisory
                consultation_record: 0, // 咨询记录
                group_activity: 0, // 集体活动
                others: 0,
                dates: new Set() // 用于记录日期范围
            });
        }

        const stat = statsMap.get(teacherName);

        // 记录日期
        let dateStr = row.date || row.arr_date || row.class_date || row['日期'] || '';
        if (dateStr && dateStr.includes('T')) dateStr = dateStr.split('T')[0];
        if (dateStr) stat.dates.add(dateStr);

        // 统计类型
        let typeKey = ''; // english key: visit, review, etc.
        // let typeName = ''; // localized name

        const typeVal = row.course_id || row.type || row.schedule_type || row['类型'];

        if (window.ScheduleTypesStore && window.ScheduleTypesStore.getById) {
            const t = window.ScheduleTypesStore.getById(typeVal);
            typeKey = t ? t.name : String(typeVal); // name is usually the english key
        } else {
            // Fallback if store not loaded
            typeKey = String(typeVal || '');
        }

        // 标准化处理：线上类型 → 基础类型 (review_online → review, visit_online → visit)
        typeKey = normalizeTypeKey(typeKey);

        // Strict matching based on schedule_types table (image provided by user)
        if (typeKey === 'visit') stat.home_visit++;
        else if (typeKey === 'half_visit') stat.half_visit++;
        else if (typeKey === 'review') stat.review++;
        else if (typeKey === 'review_record') stat.review_record++;
        else if (typeKey === 'trial') stat.trial++;
        else if (typeKey === 'consultation' || typeKey === 'advisory') stat.consultation++;
        else if (typeKey === 'consultation_record') stat.consultation_record++;
        else if (typeKey === 'group_activity') stat.group_activity++;
        else {
            // Regex fallbacks only if strict match fails
            if (/half_visit/i.test(typeKey)) stat.half_visit++;
            else if (/visit/i.test(typeKey)) stat.home_visit++;
            else if (/review_record/i.test(typeKey)) stat.review_record++;
            else if (/review/i.test(typeKey)) stat.review++;
            else if (/trial/i.test(typeKey)) stat.trial++;
            else if (/consultation|advisory/i.test(typeKey)) stat.consultation++;
            else if (/consultation_record/i.test(typeKey)) stat.consultation_record++;
            else if (/group/i.test(typeKey)) stat.group_activity++;
            else stat.others++;
        }
    });

    const result = [];
    // 转换 Map 为数组并可以计算衍生字段
    statsMap.forEach(stat => {
        // 计算日期范围字符串
        let dateRangeStr = '';
        if (state.startDate && state.endDate) {
            const s = state.startDate.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
            const e = state.endDate.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
            dateRangeStr = `${s}至${e} `;
        } else {
            const sortedDates = Array.from(stat.dates).sort();
            if (sortedDates.length > 0) {
                dateRangeStr = sortedDates.length === 1 ? sortedDates[0] : `${sortedDates[0]}至${sortedDates[sortedDates.length - 1]} `;
            }
        }

        // ============ 折算（唯一实现 public/js/utils/type-conversion.js）============
        // 入户 = 入户 + 半次入户×0.5 + 评审记录×0.5 + 咨询记录×0.5
        // 评审 = 评审 + 评审记录 + 大评审 + 集体活动（1:1）  试教 取原值
        const totals = convertStatBuckets(stat);
        const finalTrial = totals.trial;
        const finalVisit = totals.visit;
        const finalReview = totals.review;
        const finalConsult = totals.consultation;
        // 集体活动已 1:1 折算进评审，恒为 0；保留该键让 filterEmptyColumns 能把整列删掉
        const finalGroup = 0;

        let cleanDateRange = dateRangeStr.trim().replace('至', ' 至 ');

        const details = [];
        if (finalTrial > 0) details.push(`${finalTrial}次试教`);
        if (finalVisit > 0) details.push(`${finalVisit}次入户`);
        if (finalReview > 0) details.push(`${finalReview}次评审`);
        if (finalConsult > 0) details.push(`${finalConsult}次咨询`);

        const detailsStr = details.length > 0 ? details.join('、') : '无';

        const summaryTextForRemarks = details.length > 0 ? details.join('，') : '无';
        const surname = stat.name ? stat.name.charAt(0) : '';
        const remarks = `${surname}老师好！${cleanDateRange}期间，您在[${studentName}]处入户等相关数据为 ：${summaryTextForRemarks}。请问是否正确？`;

        result.push({
            '姓名': stat.name,
            '_teacher_id': stat.teacher_id,  // 内部字段用于排序
            '试教': finalTrial,
            '入户': finalVisit,
            '评审': finalReview,
            '集体活动': finalGroup,
            '咨询': finalConsult,
            '汇总': detailsStr,
            '核对': '确定', // 默认为确定，管理员可手动微调
            '备注': remarks
        });
    });

    // 按教师ID从小到大排序
    result.sort((a, b) => Number(a._teacher_id) - Number(b._teacher_id));

    return result;
}

// Global exposure — 仅保留 weekly-view-export.js 等模块实际使用的函数
window.ExportManager = {
    normalizeTypeKey,
    transformToCalendarData,
    transformExportData,
    aggregateTeacherStats,
    aggregateStudentStats
};
