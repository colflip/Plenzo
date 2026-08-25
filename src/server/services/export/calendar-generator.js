/**
 * 日历生成器
 * 负责生成日期范围、计算费用、生成每日排课明细
 */

const { WEEKDAYS } = require('./export-constants');
const DataTransformer = require('./data-transformer');
const RichTextFormatter = require('./rich-text-formatter');
const PermissionFilter = require('./permission-filter');

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
        const weeklyReimburse = new Map(); // 每周报销状态：'已报销' / '未报销' / '-'（该周无课）

        // 按日期和学生分组统计费用
        const feesByDateStudent = new Map();
        // 按日期跟踪费用提交/报销状态
        const dayFlags = new Map();
        // 按周跟踪报销状态（本周是否全部已报销）
        const weekFlags = new Map();

        rawData.forEach(row => {
            const dateStr = DataTransformer.formatLocaleDate(
                row.date || row.class_date || row.arr_date
            );
            if (!dateStr) return;

            if (!dayFlags.has(dateStr)) {
                dayFlags.set(dateStr, { anyUnsubmitted: false, hasSubmitted: false, allReimbursed: true, total: 0 });
            }
            const dayFlag = dayFlags.get(dateStr);
            const feeStatus = String(row.fee_status || '').toLowerCase();
            const isDraftFee = feeStatus === 'draft';
            // 待提交(draft)：仅当天全部记录都待提交时费用列才显示 '-'（见下方规则）
            if (isDraftFee) dayFlag.anyUnsubmitted = true;
            else dayFlag.hasSubmitted = true;
            if (feeStatus !== 'reimbursed') dayFlag.allReimbursed = false;

            // 按周跟踪报销状态：本周出现任意课程则 anyRow=true；
            // 出现非 reimbursed 的课程则 allReimbursed=false
            const rowWeekNum = CalendarGenerator.getISOWeek(new Date(dateStr));
            if (!weekFlags.has(rowWeekNum)) {
                weekFlags.set(rowWeekNum, { anyRow: false, allReimbursed: true });
            }
            const weekFlag = weekFlags.get(rowWeekNum);
            weekFlag.anyRow = true;
            if (feeStatus !== 'reimbursed') weekFlag.allReimbursed = false;

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

            // 待提交(draft)记录金额未定：不计入合计与明细（避免未提交金额进入报销单），
            // 仅已提交记录参与统计；同天部分待提交不再隐藏整天费用
            if (!isDraftFee) {
                // 按日期累计费用合计（用于费用列规则判断），含当天所有学生/教师
                dayFlag.total += transportFee + otherFee;

                // 按教师累计交通费
                if (transportFee > 0) {
                    const current = feeData.teacherFees.get(teacherName) || 0;
                    feeData.teacherFees.set(teacherName, current + transportFee);
                }

                feeData.totalTransport += transportFee;
                feeData.totalOther += otherFee;
            }
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

        // 生成每日费用文本（应用费用列显示规则）
        dates.forEach(dateStr => {
            const dayFlag = dayFlags.get(dateStr);

            // 费用列显示规则（报销单 视图/文件 统一）：
            //   没课（当天无排课）→ '/'
            //   有课且当天全部记录均为待提交(draft) → '-'（整天未提交）
            //   有课且存在已提交记录：费用合计为 0 → '0'；否则保留费用明细
            //   （部分待提交不再隐藏整天费用：待提交金额不参与合计，已提交部分正常显示）
            if (!dayFlag) {
                dailyFees.set(dateStr, '/');
                return;
            }

            if (dayFlag.anyUnsubmitted && !dayFlag.hasSubmitted) {
                dailyFees.set(dateStr, '-');
            } else if (dayFlag.total === 0) {
                dailyFees.set(dateStr, '0');
            } else {
                const studentFees = feesByDate.get(dateStr) || [];
                if (isSingleStudent) {
                    const total = studentFees.reduce((sum, f) => sum + f.totalTransport, 0);
                    const other = studentFees.reduce((sum, f) => sum + f.totalOther, 0);
                    const parts = [];
                    if (total > 0) parts.push(String(Math.ceil(total * 100) / 100));
                    if (other > 0) parts.push(`其他费用${Math.ceil(other * 100) / 100}`);
                    dailyFees.set(dateStr, parts.join('，'));
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
                    dailyFees.set(dateStr, lines.length > 0 ? lines.join('；') : '0');
                }
            }
        });

        // 计算每周报销状态（按周，而非按天）：
        //   该周无课 → '-'；该周全部课程已报销 → '已报销'；否则 '未报销'
        dates.forEach(dateStr => {
            const dateObj = new Date(dateStr);
            const weekNumber = CalendarGenerator.getISOWeek(dateObj);
            if (weeklyReimburse.has(weekNumber)) return;
            const weekFlag = weekFlags.get(weekNumber);
            if (!weekFlag || !weekFlag.anyRow) {
                weeklyReimburse.set(weekNumber, '-');
            } else {
                weeklyReimburse.set(weekNumber, weekFlag.allReimbursed ? '已报销' : '未报销');
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

        return { dailyFees, weeklyFees, weeklyReimburse };
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
        const { dailyFees, weeklyFees, weeklyReimburse } = CalendarGenerator.calculateFees(
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

            if (daySchedules.length > 0) {
                // 整天生成一次：计划/实际各自独立成列
                const { planParts, actualParts, hasColoredCourse } =
                    RichTextFormatter.generateCourseText(daySchedules, isSingleStudent);

                // 按逻辑行切分——两列互不关联，各自从上到下填充
                const planRows = RichTextFormatter.splitPartsIntoRows(planParts);
                const actualRows = RichTextFormatter.splitPartsIntoRows(actualParts);

                // 行数取两列最大值（至少 1 行）；缺失的一侧写入 '/'
                const rowCount = Math.max(planRows.length, actualRows.length, 1);

                for (let index = 0; index < rowCount; index++) {
                    const planRowParts = planRows[index] || [];
                    const actualRowParts = actualRows[index] || [];

                    const row = {
                        '日期': dateStr,
                        '星期': weekStr,
                        '计划安排': '',
                        '实际安排': '',
                        '费用': index === 0 ? dailyFees.get(dateStr) || '/' : '',
                        '周汇总': index === 0 ? weeklyFees.get(weekNumber) || '/' : '',
                        // 报销状态不在按周合并，仅在该周最后一个单元格显示（见下方后处理）
                        '报销状态': '',

                        // 内部标记字段
                        '_weekNumber': weekNumber,
                        '_isSunday': isSunday,
                        '_isRedRow': hasColoredCourse,
                        '_planTextParts': planRowParts,
                        '_actualTextParts': actualRowParts
                    };

                    // 空值写入 '/'（渲染层遇 '/' 走普通单元格）
                    const planText = RichTextFormatter.textPartsToPlainText(planRowParts);
                    const actualText = RichTextFormatter.textPartsToPlainText(actualRowParts);
                    row['计划安排'] = planText || '/';
                    row['实际安排'] = actualText || '/';

                    calendarData.push(row);
                }
            } else {
                // 没有课程的日期也要显示（空行）
                calendarData.push({
                    '日期': dateStr,
                    '星期': weekStr,
                    '计划安排': '',
                    '实际安排': '',
                    '费用': '/',
                    '周汇总': weeklyFees.get(weekNumber) || '/',
                    // 报销状态不在按周合并，仅在该周最后一个单元格显示（见下方后处理）
                    '报销状态': '',
                    '_weekNumber': weekNumber,
                    '_isSunday': isSunday,
                    '_isRedRow': false,
                    '_planTextParts': [],
                    '_actualTextParts': []
                });
            }
        });

        // 5.5 报销状态：不按周合并，仅在该周最后一个单元格显示
        // 找到每个 ISO 周在 calendarData 中出现的最后一行下标，只在其上写值，
        // 其余单元格留空。无课周的值为 '-'（语义：该周无费用，等同 N/A）。
        const lastRowIndexByWeek = new Map();
        calendarData.forEach((row, idx) => {
            lastRowIndexByWeek.set(row._weekNumber, idx);
        });
        lastRowIndexByWeek.forEach((idx, weekNumber) => {
            calendarData[idx]['报销状态'] = weeklyReimburse.get(weekNumber) || '-';
        });

        // 6. 学生端移除费用和周汇总列
        PermissionFilter.removeFeeColumns(calendarData, userType);

        return calendarData;
    }
}

module.exports = CalendarGenerator;
