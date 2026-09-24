/**
 * 日历生成器 —— 服务端薄壳
 *
 * 「每日排课明细」的行模型、课程富文本、趟费聚合、ISO 周键全部收敛在
 * public/js/utils/schedule-calendar-core.js（浏览器报销视图共用同一实现）。
 * 本文件只保留服务端入口形状：日期范围、单学生判定、报销状态列与权限裁剪。
 * calculateFees / getISOWeek 继续原样暴露 —— 既有测试与调用方依赖这两个静态方法。
 */

const Core = require('../../../../public/js/utils/schedule-calendar-core.js');
const PermissionFilter = require('./permission-filter');

class CalendarGenerator {
    static generateDateRange(startDate, endDate) {
        return Core.generateDateRange(startDate, endDate);
    }

    static getISOWeek(date) {
        return Core.getISOWeek(date);
    }

    static calculateFees(rawData, dates, isSingleStudent) {
        return Core.calculateFees(rawData, dates, isSingleStudent);
    }

    /**
     * 生成每日排课明细工作表（日历视图）
     * @param {Array} rawData - 原始数据（queryTeacherSchedule/queryStudentSchedule 的行形状）
     * @param {Object} options - { startDate, endDate, studentId, userType }
     * @returns {Array} 日历数据
     */
    static generateDailyScheduleSheet(rawData, options) {
        const { userType = 'admin' } = options;

        const calendarData = Core.generateCalendarRows(rawData, options);

        // 学生端移除费用和周汇总列
        PermissionFilter.removeFeeColumns(calendarData, userType);

        return calendarData;
    }
}

module.exports = CalendarGenerator;
