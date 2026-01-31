/**
 * 服务层索引
 * @description 统一导出所有服务模块
 * @module services
 */

const scheduleService = require('./scheduleService');
const excelService = require('./excelService');

module.exports = {
    // 排课服务
    scheduleService,
    checkTeacherConflicts: scheduleService.checkTeacherConflicts,
    checkStudentConflicts: scheduleService.checkStudentConflicts,
    getTeacherAvailableSlots: scheduleService.getTeacherAvailableSlots,
    findMatchingSlots: scheduleService.findMatchingSlots,
    createScheduleWithConflictCheck: scheduleService.createScheduleWithConflictCheck,

    // Excel服务
    excelService,
    exportSchedulesToExcel: excelService.exportSchedulesToExcel,
    exportUsersToExcel: excelService.exportUsersToExcel,
    parseSchedulesFromExcel: excelService.parseSchedulesFromExcel,
    generateImportTemplate: excelService.generateImportTemplate
};
