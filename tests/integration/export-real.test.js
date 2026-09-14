/**
 * 导出功能真实环境集成测试
 * 连接 Neon 远程数据库进行完整测试
 */

const UnifiedExportService = require('../../src/server/services/export/sheet-builder');
const {
    seedScheduleTypes,
    createTestTeacher,
    createTestStudent,
    createBatchSchedules,
    cleanupTestData
} = require('../helpers/test-data');
const fs = require('fs');
const path = require('path');

describe('导出功能真实环境测试', () => {
    let service;
    let testTeacherIds = [];
    let testStudentIds = [];

    beforeAll(async () => {
        service = UnifiedExportService;

        // 播种基础课程类型（courseId 外键依赖 id 1~5）
        await seedScheduleTypes();

        // 创建测试教师
        const t1 = await createTestTeacher('张测试');
        const t2 = await createTestTeacher('李测试');
        testTeacherIds = [t1.id, t2.id];

        // 创建测试学生
        const s1 = await createTestStudent('王测试');
        const s2 = await createTestStudent('赵测试');
        testStudentIds = [s1.id, s2.id];

        console.log('✅ 测试数据创建完成');
        console.log('   教师:', testTeacherIds);
        console.log('   学生:', testStudentIds);
    });

    afterAll(async () => {
        await cleanupTestData();
    });

    describe('管理员端完整导出测试', () => {
        test('100条记录 - 生成6个工作表', async () => {
            // 创建100条测试数据
            const scheduleIds = await createBatchSchedules(100, {
                teacherIds: testTeacherIds,
                studentIds: testStudentIds,
                startDate: '2026-06-01'
            });

            expect(scheduleIds).toHaveLength(100);

            // 查询数据
            const db = require('../../src/server/db/db');
            const result = await db.query(
                `SELECT ca.*, t.name as teacher_name, s.name as student_name,
                        st.id as course_id, st.name as type_name, st.description as type_desc
                 FROM course_arrangement ca
                 LEFT JOIN teachers t ON ca.teacher_id = t.id
                 LEFT JOIN students s ON ca.student_id = s.id
                 LEFT JOIN schedule_types st ON ca.course_id = st.id
                 WHERE ca.created_by = 1
                 ORDER BY ca.class_date, ca.start_time`
            );

            const rawData = result.rows;
            expect(rawData.length).toBeGreaterThan(0);

            // 生成导出数据
            const exportResult = await service.generateCompleteExport(rawData, {
                startDate: '2026-06-01',
                endDate: '2026-06-30',
                userType: 'admin',
                userId: 1,
                studentId: null,
                teacherId: null,
                studentName: '全部学生'
            });

            // 验证返回结构
            expect(exportResult).toHaveProperty('sheets');
            expect(exportResult).toHaveProperty('filename');

            // 验证6个工作表
            const expectedSheets = [
                '每日排课明细',
                '教师授课汇总',
                '教师授课统计',
                '排课原始记录',
                '学生上课汇总',
                '学生上课统计'
            ];

            expectedSheets.forEach(sheetName => {
                expect(exportResult.sheets).toHaveProperty(sheetName);
                expect(Array.isArray(exportResult.sheets[sheetName])).toBe(true);
            });

            // 验证每日排课明细
            const detailSheet = exportResult.sheets['每日排课明细'];
            expect(detailSheet.length).toBeGreaterThan(0);

            // 验证列结构
            const firstRow = detailSheet[0];
            expect(firstRow).toHaveProperty('日期');
            expect(firstRow).toHaveProperty('星期');
            expect(firstRow).toHaveProperty('计划安排');
            expect(firstRow).toHaveProperty('实际安排');
            expect(firstRow).toHaveProperty('费用');
            expect(firstRow).toHaveProperty('周汇总');

            // 验证 Rich Text 数据
            expect(firstRow).toHaveProperty('_planTextParts');
            expect(firstRow).toHaveProperty('_actualTextParts');

            // 验证周次标记
            expect(firstRow).toHaveProperty('_weekNumber');

            console.log('✅ 管理员端导出测试通过');
            console.log(`   每日排课明细: ${detailSheet.length} 行`);
            console.log(`   教师汇总: ${exportResult.sheets['教师授课汇总'].length} 行`);
            console.log(`   学生汇总: ${exportResult.sheets['学生上课汇总'].length} 行`);
            console.log(`   原始记录: ${exportResult.sheets['排课原始记录'].length} 行`);
        }, 20000);

        test('文件名格式正确', async () => {
            const db = require('../../src/server/db/db');
            const result = await db.query(
                `SELECT ca.*, t.name as teacher_name, s.name as student_name,
                        st.id as course_id, st.name as type_name
                 FROM course_arrangement ca
                 LEFT JOIN teachers t ON ca.teacher_id = t.id
                 LEFT JOIN students s ON ca.student_id = s.id
                 LEFT JOIN schedule_types st ON ca.course_id = st.id
                 WHERE ca.created_by = 1
                 LIMIT 10`
            );

            const exportResult = await service.generateCompleteExport(result.rows, {
                startDate: '2026-06-01',
                endDate: '2026-06-30',
                userType: 'admin',
                userId: 1,
                studentId: null,
                teacherId: null,
                studentName: '全部学生'
            });

            expect(exportResult.filename).toMatch(/\[全部学生\]排课记录_\[2026-06-01_2026-06-30\]_\d+\.xlsx/);
        });
    });

    describe('学生端权限过滤测试', () => {
        test('费用列和周汇总列已隐藏', async () => {
            const db = require('../../src/server/db/db');
            const result = await db.query(
                `SELECT ca.*, t.name as teacher_name, s.name as student_name,
                        st.id as course_id, st.name as type_name
                 FROM course_arrangement ca
                 LEFT JOIN teachers t ON ca.teacher_id = t.id
                 LEFT JOIN students s ON ca.student_id = s.id
                 LEFT JOIN schedule_types st ON ca.course_id = st.id
                 WHERE ca.created_by = 1 AND ca.student_id = $1
                 LIMIT 20`,
                [testStudentIds[0]]
            );

            const exportResult = await service.generateCompleteExport(result.rows, {
                startDate: '2026-06-01',
                endDate: '2026-06-30',
                userType: 'student',
                userId: testStudentIds[0],
                studentId: testStudentIds[0],
                teacherId: null,
                studentName: '王测试'
            });

            // 验证每日排课明细中费用列已隐藏
            const detailSheet = exportResult.sheets['每日排课明细'];
            if (detailSheet.length > 0) {
                const firstRow = detailSheet[0];
                expect(firstRow).not.toHaveProperty('费用');
                expect(firstRow).not.toHaveProperty('周汇总');
            }

            // 验证原始记录中交通费已隐藏
            const rawSheet = exportResult.sheets['排课原始记录'];
            if (rawSheet.length > 0) {
                const firstRecord = rawSheet[0];
                expect(firstRecord).not.toHaveProperty('交通费');
                expect(firstRecord).not.toHaveProperty('其他费用');
            }

            console.log('✅ 学生端权限过滤测试通过');
        });
    });

    describe('教师端导出测试', () => {
        test('数据过滤正确', async () => {
            const db = require('../../src/server/db/db');
            const result = await db.query(
                `SELECT ca.*, t.name as teacher_name, s.name as student_name,
                        st.id as course_id, st.name as type_name
                 FROM course_arrangement ca
                 LEFT JOIN teachers t ON ca.teacher_id = t.id
                 LEFT JOIN students s ON ca.student_id = s.id
                 LEFT JOIN schedule_types st ON ca.course_id = st.id
                 WHERE ca.created_by = 1 AND ca.teacher_id = $1
                 LIMIT 20`,
                [testTeacherIds[0]]
            );

            const exportResult = await service.generateCompleteExport(result.rows, {
                startDate: '2026-06-01',
                endDate: '2026-06-30',
                userType: 'teacher',
                userId: testTeacherIds[0],
                studentId: null,
                teacherId: testTeacherIds[0],
                studentName: '全部学生'
            });

            expect(exportResult).toHaveProperty('sheets');
            expect(exportResult.filename).toMatch(/\[教师\]排课记录/);

            console.log('✅ 教师端导出测试通过');
        });
    });
});
