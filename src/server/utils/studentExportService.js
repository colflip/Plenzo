const db = require('../db/db');
const enhancedExcel = require('../services/enhancedExcelService');

class StudentExportService {
    /**
     * generating export data for student
     * @param {number} studentId
     * @param {string} startDate
     * @param {string} endDate
     */
    async exportSchedule(studentId, startDate, endDate) {
        // 0. Determine Date Column dynamically
        const dateColResult = await db.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema='public' AND table_name='course_arrangement'
            AND column_name IN ('arr_date','class_date','date')
        `);
        const cols = new Set(dateColResult.rows.map(x => x.column_name));
        let dateCol = 'date';
        if (cols.has('arr_date')) dateCol = 'arr_date';
        else if (cols.has('class_date')) dateCol = 'class_date';

        // 1. Query Data
        const query = `
            SELECT
                ca.id,
                ca.${dateCol} as date,
                ca.start_time,
                ca.end_time,
                ca.status,
                ca.student_comment as notes,
                ca.created_at,
                ca.teacher_id,
                ca.student_id,
                s.name as student_name,
                t.name as teacher_name,
                ca.adjustment_type,
                COALESCE(sty.description, sty.name) as type_name
            FROM course_arrangement ca
            JOIN students s ON ca.student_id = s.id
            JOIN teachers t ON ca.teacher_id = t.id
            LEFT JOIN schedule_types sty ON ca.course_id = sty.id
            WHERE ca.student_id = $1
              AND ca.${dateCol} BETWEEN $2 AND $3
            ORDER BY ca.${dateCol}, ca.start_time
        `;

        const result = await db.query(query, [studentId, startDate, endDate]);
        const rows = result.rows;

        if (rows.length === 0) {
            throw new Error('该时间段内无数据');
        }

        const studentName = rows[0].student_name || '学生';

        // 2. 生成按时间段分组的总览表
        const timeSlotOverview = this.generateTimeSlotOverview(rows);

        // 3. 生成传统总览表（保持兼容）
        const overviewSheet = this.generateOverviewSheet(rows);

        // 4. 生成明细信息表
        const detailSheet = this.generateDetailSheet(rows, startDate, endDate);

        // 5. Create Workbook using enhanced service
        const workbook = enhancedExcel.createWorkbook();

        // Add Time Slot Overview Sheet (新增：按时间段分组) - 启用合并单元格
        enhancedExcel.addWorksheet(workbook, timeSlotOverview, '课程安排（按时间段）', { mergeDateColumns: true });

        // Add Traditional Overview Sheet
        enhancedExcel.addWorksheet(workbook, overviewSheet, '总览表');

        // Add Detail Sheet
        enhancedExcel.addWorksheet(workbook, detailSheet, '明细信息表');

        // 6. Generate Buffer
        const buffer = await enhancedExcel.writeToBuffer(workbook);

        // 7. Generate Filename
        const timestamp = enhancedExcel.getTimestamp();
        const filename = `[${studentName}]学习记录_[${startDate}_${endDate}]_${timestamp}.xlsx`;

        return {
            buffer,
            filename
        };
    }

    /**
     * 生成按时间段分组的总览表
     */
    generateTimeSlotOverview(rows) {
        // 按日期和时间段分组
        const grouped = new Map();

        rows.forEach(row => {
            const date = enhancedExcel.formatDate(row.date);
            const timeSlot = `${enhancedExcel.formatTime(row.start_time)}-${enhancedExcel.formatTime(row.end_time)}`;
            const key = `${date}_${timeSlot}`;

            if (!grouped.has(key)) {
                const dateObj = new Date(row.date);
                const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

                grouped.set(key, {
                    '日期': date,
                    '星期': days[dateObj.getDay()],
                    '时间段': timeSlot,
                    '计划安排': [],
                    '实际安排': []
                });
            }

            const group = grouped.get(key);
            const isCancelled = row.status === 'cancelled' || row.status === '已取消' || row.status === 0 || row.status === 2;
            const isNew = row.adjustment_type == 1;

            // 构建课程信息（包含时间段）
            const courseInfo = `${row.type_name || '未知'}(${timeSlot})：${row.teacher_name}`;

            if (isCancelled) {
                group['计划安排'].push(`[已取消]${courseInfo}`);
            } else if (isNew) {
                group['实际安排'].push(`[新增]${courseInfo}`);
            } else {
                group['计划安排'].push(courseInfo);
                group['实际安排'].push(courseInfo);
            }
        });

        // 转换为数组并格式化，使用分号分隔
        return Array.from(grouped.values()).map(group => ({
            '日期': group['日期'],
            '星期': group['星期'],
            '时间段': group['时间段'],
            '计划安排': group['计划安排'].join('；'),
            '实际安排': group['实际安排'].join('；')
        }));
    }

    generateOverviewSheet(rows) {
        const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

        return rows.map(row => {
            const dateObj = new Date(row.date);
            const week = days[dateObj.getDay()];

            // 状态标记
            let teacherName = row.teacher_name;
            const isCancelled = row.status === 'cancelled' || row.status === '已取消' || row.status === 0 || row.status === 2;
            const isNew = row.adjustment_type == 1;
            const isAdjusted = row.adjustment_type == 2;

            if (isCancelled) {
                teacherName = `[已取消]${teacherName}`;
            } else if (isNew) {
                teacherName = `[新增]${teacherName}`;
            } else if (isAdjusted) {
                teacherName = `[调整]${teacherName}`;
            }

            return {
                '教师名称': teacherName,
                '类型': row.type_name || '未知',
                '日期': enhancedExcel.formatDate(row.date),
                '时间段': `${enhancedExcel.formatTime(row.start_time)}-${enhancedExcel.formatTime(row.end_time)}`,
                '星期': week,
                '状态': enhancedExcel.formatStatus(row.status),
                '创建时间': enhancedExcel.formatDateTime(row.created_at),
                '排课ID': row.id,
                '教师ID': row.teacher_id,
                '学生ID': row.student_id,
                '备注': row.notes || ''
            };
        });
    }

    generateDetailSheet(rows, startDate, endDate) {
        const stats = {};

        // 类型归一化映射
        const normalizeType = (typeName) => {
            if (!typeName) return typeName;
            const lower = String(typeName).toLowerCase();
            if (lower.includes('线上入户') || lower.includes('（线上）入户')) return '入户';
            if (lower.includes('线上评审') || lower.includes('（线上）评审')) return '评审';
            if (lower.includes('线上咨询') || lower.includes('（线上）咨询')) return '咨询';
            if (lower.includes('线上评审记录') || lower.includes('（线上）评审记录')) return '评审记录';
            if (lower.includes('线上咨询记录') || lower.includes('（线上）咨询记录')) return '咨询记录';
            return typeName;
        };

        rows.filter(row => !['cancelled', '0', 'modified_away'].includes(String(row.status || '').toLowerCase())).forEach(row => {
            const teacherName = row.teacher_name || '未知';
            if (!stats[teacherName]) {
                stats[teacherName] = {
                    '教师姓名': teacherName,
                    '试教': 0,
                    '入户': 0,
                    '半次入户': 0,
                    '评审': 0,
                    '评审记录': 0,
                    '集体活动': 0,
                    '咨询': 0,
                    '备注': ''
                };
            }

            const type = normalizeType(row.type_name);
            if (type && stats[teacherName].hasOwnProperty(type)) {
                stats[teacherName][type]++;
            } else if (type === '入户课') {
                stats[teacherName]['入户']++;
            }
        });

        const dateRangeStr = `${enhancedExcel.formatDate(startDate)}-${enhancedExcel.formatDate(endDate)}`;

        const globalTotals = {
            '试教': 0, '入户': 0, '半次入户': 0, '评审': 0,
            '评审记录': 0, '集体活动': 0, '咨询': 0
        };

        const result = Object.values(stats);

        result.forEach(item => {
            globalTotals['试教'] += item['试教'];
            globalTotals['入户'] += item['入户'];
            globalTotals['半次入户'] += item['半次入户'];
            globalTotals['评审'] += item['评审'];
            globalTotals['评审记录'] += item['评审记录'];
            globalTotals['集体活动'] += item['集体活动'];
            globalTotals['咨询'] += item['咨询'];

            let totalInHome = item['入户'] + (item['半次入户'] * 0.5) + (item['评审记录'] * 0.5);
            let totalReview = item['评审'] + (item['评审记录'] * 1);
            let totalGroup = item['集体活动'];
            let totalConsult = item['咨询'];

            const parts = [];
            if (totalInHome > 0) parts.push(`${totalInHome}次入户`);
            if (totalReview > 0) parts.push(`${totalReview}次评审`);
            if (totalGroup > 0) parts.push(`${totalGroup}次集体活动`);
            if (totalConsult > 0) parts.push(`${totalConsult}次咨询`);

            const details = parts.length > 0 ? `，${parts.join('，')}。` : '。';
            item['备注'] = `在${item['教师姓名']}，${dateRangeStr}${details}`;
        });

        // Summary Row
        const summaryRow = {
            '教师姓名': '',
            '试教': globalTotals['试教'],
            '入户': globalTotals['入户'],
            '半次入户': globalTotals['半次入户'],
            '评审': globalTotals['评审'],
            '评审记录': globalTotals['评审记录'],
            '集体活动': globalTotals['集体活动'],
            '咨询': globalTotals['咨询'],
            '备注': ''
        };

        let sumInHome = globalTotals['入户'] + (globalTotals['半次入户'] * 0.5) + (globalTotals['评审记录'] * 0.5);
        let sumReview = globalTotals['评审'] + (globalTotals['评审记录'] * 1);
        let sumGroup = globalTotals['集体活动'];
        let sumConsult = globalTotals['咨询'];

        const sumParts = [];
        if (sumInHome > 0) sumParts.push(`${sumInHome}次入户`);
        if (sumReview > 0) sumParts.push(`${sumReview}次评审`);
        if (sumGroup > 0) sumParts.push(`${sumGroup}次集体活动`);
        if (sumConsult > 0) sumParts.push(`${sumConsult}次咨询`);

        const sumDetails = sumParts.length > 0 ? `，${sumParts.join('，')}。` : '。';
        summaryRow['备注'] = `${dateRangeStr}${sumDetails}`;

        result.push(summaryRow);

        return result;
    }
}

module.exports = new StudentExportService();
