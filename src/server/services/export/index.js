/**
 * 导出服务门面（Export Facade）
 * @description services/export/ 的唯一对外入口。
 *              分层：schedule-queries（数据查询）→ sheet-builder（Sheet 结构）→ excel-writer（二进制），
 *              由 pipeline 编排；控制器只应 import 本文件，不直接依赖内部子模块。
 * @module services/export
 */

const pipeline = require('./pipeline');
const scheduleQueries = require('./schedule-queries');

module.exports = {
    /** 导出流水线：runRoleScheduleExport / generateExcelFromData / validateScheduleDateRange */
    pipeline,
    /** 排课与用户信息数据查询：queryTeacherSchedule / queryStudentSchedule / exportTeacherInfo / exportStudentInfo */
    scheduleQueries
};
