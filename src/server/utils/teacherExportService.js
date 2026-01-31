const db = require('../db/db');
const xlsx = require('xlsx');

class TeacherExportService {
    /**
     * generating export data for teacher
     * @param {number} teacherId 
     * @param {string} startDate 
     * @param {string} endDate 
     */
    async exportSchedule(teacherId, startDate, endDate) {
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
                ca.teacher_comment as notes,
                ca.created_at,
                ca.teacher_id,
                ca.student_id,
                s.name as student_name,
                t.name as teacher_name,
                COALESCE(sty.description, sty.name) as type_name
            FROM course_arrangement ca
            JOIN students s ON ca.student_id = s.id
            JOIN teachers t ON ca.teacher_id = t.id
            LEFT JOIN schedule_types sty ON ca.course_id = sty.id
            WHERE ca.teacher_id = $1
              AND ca.${dateCol} BETWEEN $2 AND $3
            ORDER BY ca.${dateCol}, ca.start_time
        `;

        const result = await db.query(query, [teacherId, startDate, endDate]);
        const rows = result.rows;

        if (rows.length === 0) {
            throw new Error('该时间段内无数据');
        }

        const teacherName = rows[0].teacher_name || '教师';

        // 2. Prepare Sheets
        const overviewSheet = this.generateOverviewSheet(rows);
        const detailSheet = this.generateDetailSheet(rows, startDate, endDate);

        // 3. Create Workbook
        const workbook = xlsx.utils.book_new();

        // Add Overview Sheet
        const wsOverview = xlsx.utils.json_to_sheet(overviewSheet);
        this.autoFitColumns(wsOverview, overviewSheet);
        xlsx.utils.book_append_sheet(workbook, wsOverview, '总览表');

        // Add Detail Sheet
        const wsDetail = xlsx.utils.json_to_sheet(detailSheet);
        this.autoFitColumns(wsDetail, detailSheet);
        xlsx.utils.book_append_sheet(workbook, wsDetail, '明细信息表');

        // 4. Generate Buffer
        const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        // 5. Generate Filename
        const timestamp = this.getTimestamp();
        const filename = `[${teacherName}]授课记录_[${startDate}_${endDate}]_${timestamp}.xlsx`;

        return {
            buffer,
            filename
        };
    }

    generateOverviewSheet(rows) {
        const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

        return rows.map(row => {
            const dateObj = new Date(row.date);
            const week = days[dateObj.getDay()];

            return {
                '学生名称': row.student_name,
                '类型': row.type_name || '未知',
                '日期': this.formatDate(row.date),
                '时间段': `${row.start_time?.slice(0, 5)}-${row.end_time?.slice(0, 5)}`,
                '星期': week,
                '状态': this.formatStatus(row.status),
                '创建时间': this.formatDateTime(row.created_at),
                '排课ID': row.id,
                '教师ID': row.teacher_id,
                '学生ID': row.student_id,
                '备注': row.notes || ''
            };
        });
    }

    generateDetailSheet(rows, startDate, endDate) {
        const stats = {};

        rows.forEach(row => {
            const studentName = row.student_name || '未知';
            if (!stats[studentName]) {
                stats[studentName] = {
                    '学生姓名': studentName,
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

            const type = row.type_name;
            if (type && stats[studentName].hasOwnProperty(type)) {
                stats[studentName][type]++;
            } else if (type === '入户课') {
                stats[studentName]['入户']++;
            }
        });

        const dateRangeStr = `${this.formatDate(startDate)}-${this.formatDate(endDate)}`;

        // Track totals for the summary row
        const globalTotals = {
            '试教': 0,
            '入户': 0,
            '半次入户': 0,
            '评审': 0,
            '评审记录': 0,
            '集体活动': 0,
            '咨询': 0
        };

        const result = Object.values(stats);

        // Calculate remarks for each student and accumulate totals
        result.forEach(item => {
            // Accumulate totals
            globalTotals['试教'] += item['试教'];
            globalTotals['入户'] += item['入户'];
            globalTotals['半次入户'] += item['半次入户'];
            globalTotals['评审'] += item['评审'];
            globalTotals['评审记录'] += item['评审记录'];
            globalTotals['集体活动'] += item['集体活动'];
            globalTotals['咨询'] += item['咨询'];

            // Calculate weighted sums for remarks
            let totalInHome = item['入户'] + (item['半次入户'] * 0.5) + (item['评审记录'] * 0.5);
            let totalReview = item['评审'] + (item['评审记录'] * 1);
            let totalGroup = item['集体活动'];
            let totalConsult = item['咨询'];

            const parts = [];
            if (totalInHome > 0) parts.push(`${totalInHome}次入户`);
            if (totalReview > 0) parts.push(`${totalReview}次评审`);
            if (totalGroup > 0) parts.push(`${totalGroup}次集体活动`);
            if (totalConsult > 0) parts.push(`${totalConsult}次咨询`);

            // Format: 在[学生姓名]，导出选择的日期段，a次入户...
            const details = parts.length > 0 ? `，${parts.join('，')}。` : '。';
            item['备注'] = `在${item['学生姓名']}，${dateRangeStr}${details}`;
        });

        // Create Summary Row
        const summaryRow = {
            '学生姓名': '', // Empty or '汇总'
            '试教': globalTotals['试教'],
            '入户': globalTotals['入户'],
            '半次入户': globalTotals['半次入户'],
            '评审': globalTotals['评审'],
            '评审记录': globalTotals['评审记录'],
            '集体活动': globalTotals['集体活动'],
            '咨询': globalTotals['咨询'],
            '备注': ''
        };

        // Calculate weighted sums for Summary details
        let sumInHome = globalTotals['入户'] + (globalTotals['半次入户'] * 0.5) + (globalTotals['评审记录'] * 0.5);
        let sumReview = globalTotals['评审'] + (globalTotals['评审记录'] * 1);
        let sumGroup = globalTotals['集体活动'];
        let sumConsult = globalTotals['咨询'];

        const sumParts = [];
        if (sumInHome > 0) sumParts.push(`${sumInHome}次入户`);
        if (sumReview > 0) sumParts.push(`${sumReview}次评审`);
        if (sumGroup > 0) sumParts.push(`${sumGroup}次集体活动`);
        if (sumConsult > 0) sumParts.push(`${sumConsult}次咨询`);

        // Format: 导出选择的日期段，a次入户...
        const sumDetails = sumParts.length > 0 ? `，${sumParts.join('，')}。` : '。';
        summaryRow['备注'] = `${dateRangeStr}${sumDetails}`;

        result.push(summaryRow);

        return result;
    }

    autoFitColumns(ws, data) {
        if (!data || data.length === 0) return;
        const keys = Object.keys(data[0]);
        const colWidths = keys.map(key => {
            // Header width
            let maxWidth = this.getStringWidth(key);
            // Content width
            data.forEach(row => {
                const val = row[key] ? String(row[key]) : '';
                const width = this.getStringWidth(val);
                if (width > maxWidth) maxWidth = width;
            });
            // Max limit to avoid super wide columns
            return { wch: Math.min(maxWidth + 10, 80) };
        });
        ws['!cols'] = colWidths;
    }

    getStringWidth(str) {
        if (!str) return 0;
        let width = 0;
        for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            if (code > 255) width += 2;
            else width += 1;
        }
        return width;
    }

    formatDate(date) {
        if (!date) return '';
        if (date instanceof Date) return date.toISOString().slice(0, 10);
        return String(date).slice(0, 10);
    }

    formatDateTime(date) {
        if (!date) return '';
        try {
            const d = new Date(date);
            return d.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
        } catch (e) {
            return String(date);
        }
    }

    formatStatus(status) {
        const map = {
            'pending': '待确认',
            'confirmed': '已确认',
            'completed': '已完成',
            'cancelled': '已取消'
        };
        return map[status] || status;
    }

    getTimestamp() {
        const now = new Date();
        const yyyyMMdd = now.toISOString().slice(0, 10).replace(/-/g, '');
        const hhmmss = now.toTimeString().slice(0, 8).replace(/:/g, '');
        return `${yyyyMMdd}${hhmmss}`;
    }
}

module.exports = new TeacherExportService();
