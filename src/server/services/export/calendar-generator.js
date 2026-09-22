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
        // 按周跟踪报销状态（本周是否全部已报销、本周是否有课）
        const weekFlags = new Map();

        // 「钱按填的那一格算，明细按填在哪就是哪」：金额由老师/管理员在页面上手填，
        // 系统只读不摊。挂在哪儿由视图的 fee_scope 说明：
        //   'student' —— 挂在 (场次, 老师, 学生) 那一格，每位学生各一份；
        //   'pair'    —— 挂在 (场次, 教师 pair) 上的「一趟一笔」，交叉积把同一个数
        //                显示在该场每个学生那一行，合计这一趟只能计一次。
        // 明细始终逐学生原样列出（绝不摊成几份，也绝不只塞给碰巧排在第一的那个学生）。
        const countedTrips = new Set();

        const ensureFeeData = (dateStr, studentId, studentName) => {
            const key = `${dateStr}_${studentId}`;
            if (!feesByDateStudent.has(key)) {
                feesByDateStudent.set(key, {
                    date: dateStr,
                    studentId,
                    studentName,
                    teacherFees: new Map(),
                    teacherOtherFees: new Map(),
                    teacherNames: new Set(),
                    totalTransport: 0,
                    totalOther: 0
                });
            }
            return feesByDateStudent.get(key);
        };

        rawData.forEach(row => {
            const dateStr = DataTransformer.formatLocaleDate(
                row.date || row.class_date || row.arr_date
            );
            if (!dateStr) return;

            if (!dayFlags.has(dateStr)) {
                dayFlags.set(dateStr, { anyUnsubmitted: false, hasSubmitted: false, allReimbursed: true, total: 0 });
            }
            const feeStatus = String(row.fee_status || '').toLowerCase();
            const isDraftFee = feeStatus === 'draft';
            // 待提交(draft)：仅当天全部记录都待提交时费用列才显示 '-'（见下方规则）
            if (isDraftFee) dayFlags.get(dateStr).anyUnsubmitted = true;
            else dayFlags.get(dateStr).hasSubmitted = true;
            if (feeStatus !== 'reimbursed') dayFlags.get(dateStr).allReimbursed = false;

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

            // 老师计数含待提交/零费用记录：单学生模式要靠它判断当天是否多位老师
            const feeData = ensureFeeData(dateStr, studentId, studentName);
            feeData.teacherNames.add(teacherName);

            // 合计口径看这一格的钱挂在哪一层（视图 fee_scope）：
            //   'student' = 逐学生各填一份，交叉积展开出来的每一行都是不同学生的那份 → 逐行相加；
            //   'pair'    = 「一趟一笔」（老数据 / 只填了整趟金额），同一个数会被学生数重复 →
            //                按 (场次, 老师) 只计一次。
            const isPerStudent = String(row.fee_scope || 'pair') === 'student';
            const tripKey = `${row.session_id ?? row.id ?? dateStr}`
                + `|${row.teacher_uid ?? row.teacher_id ?? teacherName}`
                + (isPerStudent ? `|${row.student_uid ?? row.student_id ?? studentName}` : '');
            const counted = countedTrips.has(tripKey);
            countedTrips.add(tripKey);

            const transportFee = parseFloat(row.transport_fee) || 0;
            const otherFee = parseFloat(row.other_fee) || 0;

            // 待提交(draft)记录金额未定：不计入合计与明细（避免未提交金额进入报销单），
            // 仅已提交记录参与统计；同天部分待提交不再隐藏整天费用
            if (!isDraftFee) {
                // 明细：这一趟的数额就显示在它所属的那一行上，逐学生原样列，不摊不挪
                if (transportFee > 0) {
                    feeData.teacherFees.set(
                        teacherName, (feeData.teacherFees.get(teacherName) || 0) + transportFee
                    );
                }
                if (otherFee > 0) {
                    feeData.teacherOtherFees.set(
                        teacherName, (feeData.teacherOtherFees.get(teacherName) || 0) + otherFee
                    );
                }
                feeData.totalTransport += transportFee;
                feeData.totalOther += otherFee;

                // 合计：整趟一笔的那一档被交叉积展开成多行，只计一次，不按学生数翻倍；
                // 逐学生那一档的键已带学生，天然每行计一次
                if (!counted) {
                    dayFlags.get(dateStr).total += transportFee + otherFee;
                }
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
                // 单个学生的费用明细：老师金额逐位列出 + 「其他费用A+B」
                // showTeacherNames=false 时（单学生且当天只有一位老师）只写金额
                const buildParts = (f, showTeacherNames) => {
                    const parts = [];
                    f.teacherFees.forEach((fee, teacher) => {
                        const val = Math.round(fee * 100) / 100;
                        if (val > 0) {
                            parts.push(showTeacherNames ? `${teacher}${val}` : String(val));
                        }
                    });
                    const otherParts = [];
                    f.teacherOtherFees.forEach(fee => {
                        const val = Math.round(fee * 100) / 100;
                        if (val > 0) otherParts.push(String(val));
                    });
                    if (otherParts.length > 0) parts.push(`其他费用${otherParts.join('+')}`);
                    return parts;
                };

                const studentFees = feesByDate.get(dateStr) || [];
                const lines = [];
                studentFees.forEach(f => {
                    // 单学生模式：当天单老师不写姓名，多位老师必须区分（与报销单视图同口径）
                    const showTeacherNames = !isSingleStudent || f.teacherNames.size > 1;
                    const parts = buildParts(f, showTeacherNames);
                    if (parts.length > 0) {
                        lines.push(isSingleStudent ? parts.join('，') : `${f.studentName}：${parts.join('，')}`);
                    }
                });
                dailyFees.set(dateStr, lines.length > 0 ? lines.join('\n') : '0');
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
        // 三态与报销单视图一致：本周有费用 → 金额；本周上过课但费用为 0 → '0'；
        // 本周压根没课 → '/'
        const processedWeeks = new Set();
        dates.forEach(dateStr => {
            const dateObj = new Date(dateStr);
            const weekNumber = CalendarGenerator.getISOWeek(dateObj);

            if (processedWeeks.has(weekNumber)) return;
            processedWeeks.add(weekNumber);

            const studentFees = feesByWeek.get(weekNumber) || [];
            const weekFlag = weekFlags.get(weekNumber);
            const zeroValue = weekFlag ? '0' : '/';

            if (isSingleStudent) {
                const weekTotal = studentFees.reduce(
                    (sum, f) => sum + f.totalTransport + f.totalOther, 0
                );
                weeklyFees.set(
                    weekNumber,
                    weekTotal > 0 ? String(Math.round(weekTotal * 100) / 100) : zeroValue
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
                        lines.push(`${name}：${Math.round(total * 100) / 100}`);
                    }
                });
                weeklyFees.set(weekNumber, lines.length > 0 ? lines.join('\n') : zeroValue);
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

        // 单元格取值：算过的周/费用一律按算出的值写（含空串），只有完全没算过才兜底 '/'
        const cellOrSlash = (map, key) => (map.has(key) ? map.get(key) : '/');

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
                // 整天生成一次：逻辑行 = 时段（多学生模式下再按学生拆分），
                // 同一时段的课程落在同一行（即使类型不同），且计划/实际两列共用行键
                const { rows: scheduleRows, hasColoredCourse } =
                    RichTextFormatter.generateCourseText(daySchedules, isSingleStudent);

                // 至少 1 行；某一列在该时段无内容时写入 '/'
                const rowCount = Math.max(scheduleRows.length, 1);

                for (let index = 0; index < rowCount; index++) {
                    const scheduleRow = scheduleRows[index] || {};
                    const planRowParts = scheduleRow.planParts || [];
                    const actualRowParts = scheduleRow.actualParts || [];

                    const row = {
                        '日期': dateStr,
                        '星期': weekStr,
                        '计划安排': '',
                        '实际安排': '',
                        '费用': index === 0 ? cellOrSlash(dailyFees, dateStr) : '',
                        '周汇总': index === 0 ? cellOrSlash(weeklyFees, weekNumber) : '',
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
                    '周汇总': cellOrSlash(weeklyFees, weekNumber),
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
