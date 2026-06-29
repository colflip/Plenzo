/**
 * 日历生成器
 * 负责生成日期范围、计算费用、生成每日排课明细
 */

const { WEEKDAYS } = require('./ExportConstants');
const DataTransformer = require('./DataTransformer');
const RichTextFormatter = require('./RichTextFormatter');
const PermissionFilter = require('./PermissionFilter');

class CalendarGenerator {
    /**
     * 生成日期范围数组
     * @param {string} startDate - 开始日期 (YYYY-MM-DD)
     * @param {string} endDate - 结束日期 (YYYY-MM-DD)
     * @returns {Array} 日期字符串数组
     */
    static generateDateRange(startDate, endDate) {
        const dates = [];
        const start = new Date(startDate);
        const end = new Date(endDate);

        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            dates.push(DataTransformer.formatLocaleDate(d));
        }

        return dates;
    }

    /**
     * 获取ISO周次
     * @param {Date} date - 日期对象
     * @returns {string} ISO周次 (YYYY-WXX)
     */
    static getISOWeek(date) {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + 4 - (d.getDay() || 7));
        const yearStart = new Date(d.getFullYear(), 0, 1);
        const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
        return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
    }

    /**
     * 计算每日费用和周费用
     * @param {Array} rawData - 原始数据
     * @param {Array} dates - 日期数组
     * @param {boolean} isSingleStudent - 是否为单学生模式
     * @returns {Object} { dailyFees, weeklyFees }
     */
    static calculateFees(rawData, dates, isSingleStudent) {
        const dailyFees = new Map();
        const weeklyFees = new Map();

        // 按日期和学生分组统计费用
        const feesByDateStudent = new Map();

        rawData.forEach(row => {
            const dateStr = DataTransformer.formatLocaleDate(
                row.date || row.class_date || row.arr_date
            );
            if (!dateStr) return;

            const studentId = row.student_id;
            const studentName = row.student_name || '未知';
            const teacherName = row.teacher_name || '未知';
            const key = `${dateStr}_${studentId}`;

            if (!feesByDateStudent.has(key)) {
                feesByDateStudent.set(key, {
                    date: dateStr,
                    studentId,
                    studentName,
                    teacherFees: new Map(),
                    totalTransport: 0,
                    totalOther: 0
                });
            }

            const feeData = feesByDateStudent.get(key);
            const transportFee = parseFloat(row.transport_fee) || 0;
            const otherFee = parseFloat(row.other_fee) || 0;

            // 按教师累计交通费
            if (transportFee > 0) {
                const current = feeData.teacherFees.get(teacherName) || 0;
                feeData.teacherFees.set(teacherName, current + transportFee);
            }

            feeData.totalTransport += transportFee;
            feeData.totalOther += otherFee;
        });

        // 预索引：按日期和按周分组，避免 O(dates × data) 嵌套循环
        const feesByDate = new Map();   // dateStr → fee[]
        const feesByWeek = new Map();   // weekNumber → fee[]
        for (const f of feesByDateStudent.values()) {
            // 按日期索引
            if (!feesByDate.has(f.date)) feesByDate.set(f.date, []);
            feesByDate.get(f.date).push(f);

            // 按周索引（复用日期对象，避免重复 getISOWeek 计算）
            const fDate = new Date(f.date);
            const weekNum = CalendarGenerator.getISOWeek(fDate);
            if (!feesByWeek.has(weekNum)) feesByWeek.set(weekNum, []);
            feesByWeek.get(weekNum).push(f);
        }

        // 生成每日费用文本
        dates.forEach(dateStr => {
            const studentFees = feesByDate.get(dateStr);

            if (!studentFees || studentFees.length === 0) {
                dailyFees.set(dateStr, '/');
                return;
            }

            if (isSingleStudent) {
                const total = studentFees.reduce((sum, f) => sum + f.totalTransport, 0);
                const other = studentFees.reduce((sum, f) => sum + f.totalOther, 0);

                if (total === 0 && other === 0) {
                    dailyFees.set(dateStr, '/');
                } else {
                    const parts = [];
                    if (total > 0) parts.push(String(Math.ceil(total * 100) / 100));
                    if (other > 0) parts.push(`其他费用${Math.ceil(other * 100) / 100}`);
                    dailyFees.set(dateStr, parts.join('，'));
                }
            } else {
                const lines = [];
                studentFees.forEach(f => {
                    const teacherParts = [];
                    f.teacherFees.forEach((fee, teacher) => {
                        teacherParts.push(`${teacher}${Math.ceil(fee * 100) / 100}`);
                    });
                    if (teacherParts.length > 0) {
                        lines.push(`${f.studentName}：${teacherParts.join('，')}`);
                    }
                });
                dailyFees.set(dateStr, lines.length > 0 ? lines.join('；') : '/');
            }
        });

        // 计算周费用汇总（直接查预索引，O(1) 查找）
        const processedWeeks = new Set();
        dates.forEach(dateStr => {
            const dateObj = new Date(dateStr);
            const weekNumber = CalendarGenerator.getISOWeek(dateObj);

            if (processedWeeks.has(weekNumber)) return;
            processedWeeks.add(weekNumber);

            const studentFees = feesByWeek.get(weekNumber) || [];

            if (isSingleStudent) {
                const weekTotal = studentFees.reduce(
                    (sum, f) => sum + f.totalTransport + f.totalOther, 0
                );
                weeklyFees.set(
                    weekNumber,
                    weekTotal > 0 ? String(Math.ceil(weekTotal * 100) / 100) : '/'
                );
            } else {
                const studentWeekTotals = new Map();
                studentFees.forEach(f => {
                    const current = studentWeekTotals.get(f.studentName) || 0;
                    studentWeekTotals.set(
                        f.studentName,
                        current + f.totalTransport + f.totalOther
                    );
                });

                const lines = [];
                studentWeekTotals.forEach((total, name) => {
                    if (total > 0) {
                        lines.push(`${name}：${Math.ceil(total * 100) / 100}`);
                    }
                });
                weeklyFees.set(weekNumber, lines.length > 0 ? lines.join('\n') : '/');
            }
        });

        return { dailyFees, weeklyFees };
    }

    /**
     * 生成每日排课明细工作表（日历视图）
     * @param {Array} rawData - 原始数据
     * @param {Object} options - 选项
     * @returns {Array} 日历数据
     */
    static generateDailyScheduleSheet(rawData, options) {
        const { startDate, endDate, studentId, userType = 'admin' } = options;

        // 1. 生成日期序列
        const dates = CalendarGenerator.generateDateRange(startDate, endDate);

        // 2. 按日期分组数据
        const groupedByDate = DataTransformer.groupDataByDate(rawData);

        // 3. 判断是否为单学生模式
        const uniqueStudents = new Set(rawData.map(r => r.student_id).filter(Boolean));
        const isSingleStudent = uniqueStudents.size === 1 || Boolean(studentId);

        // 4. 预计算费用数据
        const { dailyFees, weeklyFees } = CalendarGenerator.calculateFees(
            rawData,
            dates,
            isSingleStudent
        );

        // 5. 生成日历数据
        const calendarData = [];

        dates.forEach(dateStr => {
            const dateObj = new Date(dateStr);
            const dayOfWeek = dateObj.getDay();
            const weekStr = WEEKDAYS[dayOfWeek];
            const isSunday = dayOfWeek === 0;

            // 获取ISO周次
            const weekNumber = CalendarGenerator.getISOWeek(dateObj);

            // 获取当天的课程
            const daySchedules = groupedByDate.get(dateStr) || [];

            // 按时间段分组（已按时间排序）
            const timeSlotGroups = DataTransformer.groupByTimeSlot(daySchedules);

            // 如果当天有课程，生成多行（每个时间段一行）
            if (timeSlotGroups.length > 0) {
                timeSlotGroups.forEach((group, index) => {
                    const row = {
                        '日期': dateStr,
                        '星期': weekStr,
                        '计划安排': '',
                        '实际安排': '',
                        '费用': index === 0 ? dailyFees.get(dateStr) || '/' : '',
                        '周汇总': index === 0 ? weeklyFees.get(weekNumber) || '/' : '',

                        // 内部标记字段
                        '_weekNumber': weekNumber,
                        '_isSunday': isSunday,
                        '_isRedRow': false,
                        '_planTextParts': [],
                        '_actualTextParts': []
                    };

                    // 生成计划和实际的课程文本（同一时间段内合并、排序）
                    const { planParts, actualParts, hasColoredCourse } =
                        RichTextFormatter.generateCourseText(group.schedules, isSingleStudent);

                    row._planTextParts = planParts;
                    row._actualTextParts = actualParts;
                    row._isRedRow = hasColoredCourse;

                    // 将 textParts 转换为纯文本（用于Excel）
                    row['计划安排'] = RichTextFormatter.textPartsToPlainText(planParts);
                    row['实际安排'] = RichTextFormatter.textPartsToPlainText(actualParts);

                    calendarData.push(row);
                });
            } else {
                // 没有课程的日期也要显示（空行）
                calendarData.push({
                    '日期': dateStr,
                    '星期': weekStr,
                    '计划安排': '',
                    '实际安排': '',
                    '费用': '/',
                    '周汇总': weeklyFees.get(weekNumber) || '/',
                    '_weekNumber': weekNumber,
                    '_isSunday': isSunday,
                    '_isRedRow': false,
                    '_planTextParts': [],
                    '_actualTextParts': []
                });
            }
        });

        // 6. 学生端移除费用和周汇总列
        PermissionFilter.removeFeeColumns(calendarData, userType);

        return calendarData;
    }
}

module.exports = CalendarGenerator;
