/**
 * 边界情况测试
 */

const UnifiedExportService = require('../../src/server/services/export/sheet-builder');
const {
    seedScheduleTypes,
    createTestTeacher,
    createTestStudent,
    createTestSchedule,
    createBatchSchedules,
    cleanupTestData
} = require('../helpers/test-data');

describe('导出功能边界情况测试', () => {
    let service;

    beforeAll(async () => {
        service = UnifiedExportService;
        // 播种基础课程类型（courseId 外键依赖 id 1~5）
        await seedScheduleTypes();
    });

    afterAll(async () => {
        await cleanupTestData();
    });

    test('空数据 - 应抛出错误', async () => {
        await expect(
            service.generateCompleteExport([], {
                startDate: '2026-06-01',
                endDate: '2026-06-30',
                userType: 'admin',
                userId: 1,
                studentName: '全部学生'
            })
        ).rejects.toThrow('无可导出的数据');
    });

    test('超过5000条 - 应抛出错误', async () => {
        const largeData = Array(5001).fill(null).map((_, i) => ({
            schedule_id: i,
            teacher_id: 1,
            teacher_name: '测试教师',
            student_id: 1,
            student_name: '测试学生',
            date: '2026-06-01',
            start_time: '14:00:00',
            end_time: '16:00:00',
            course_id: 1,
            type_name: '入户',
            status: 'confirmed'
        }));

        await expect(
            service.generateCompleteExport(largeData, {
                startDate: '2026-06-01',
                endDate: '2026-06-30',
                userType: 'admin',
                userId: 1,
                studentName: '全部学生'
            })
        ).rejects.toThrow('导出记录数量超过限制');
    });

    test('单日数据 - 日期列不应合并', async () => {
        const t = await createTestTeacher();
        const s = await createTestStudent();

        // 创建同一天的3条记录
        await createTestSchedule(t.id, s.id, '2026-06-15', {
            startTime: '09:00:00',
            endTime: '11:00:00',
            courseId: 1
        });
        await createTestSchedule(t.id, s.id, '2026-06-15', {
            startTime: '14:00:00',
            endTime: '16:00:00',
            courseId: 2
        });
        await createTestSchedule(t.id, s.id, '2026-06-15', {
            startTime: '19:00:00',
            endTime: '21:00:00',
            courseId: 3
        });

        const db = require('../../src/server/db/db');
        const result = await db.query(
            `SELECT ca.*, t.name as teacher_name, s.name as student_name,
                    st.id as course_id, st.name as type_name
             FROM course_arrangement ca
             LEFT JOIN teachers t ON ca.teacher_id = t.id
             LEFT JOIN students s ON ca.student_id = s.id
             LEFT JOIN schedule_types st ON ca.course_id = st.id
             WHERE ca.created_by = 1`
        );

        const exportResult = await service.generateCompleteExport(result.rows, {
            startDate: '2026-06-15',
            endDate: '2026-06-15',
            userType: 'admin',
            userId: 1,
            studentName: '全部学生'
        });

        const detailSheet = exportResult.sheets['每日排课明细'];
        expect(detailSheet.length).toBe(1); // 只有一天的数据
        expect(detailSheet[0]['日期']).toBe('2026-06-15');
    });

    test('跨年数据 - 周次计算正确', async () => {
        const t = await createTestTeacher();
        const s = await createTestStudent();

        // 2026年最后一周 (2026-12-29是周二，属于2026年最后一周)
        await createTestSchedule(t.id, s.id, '2026-12-29', {
            startTime: '14:00:00',
            endTime: '16:00:00'
        });

        // 2027年第一周
        await createTestSchedule(t.id, s.id, '2027-01-05', {
            startTime: '14:00:00',
            endTime: '16:00:00'
        });

        const db = require('../../src/server/db/db');
        const result = await db.query(
            `SELECT ca.*, t.name as teacher_name, s.name as student_name,
                    st.id as course_id, st.name as type_name
             FROM course_arrangement ca
             LEFT JOIN teachers t ON ca.teacher_id = t.id
             LEFT JOIN students s ON ca.student_id = s.id
             LEFT JOIN schedule_types st ON ca.course_id = st.id
             WHERE ca.created_by = 1
             ORDER BY ca.class_date`
        );

        const exportResult = await service.generateCompleteExport(result.rows, {
            startDate: '2026-12-29',
            endDate: '2027-01-05',
            userType: 'admin',
            userId: 1,
            studentName: '全部学生'
        });

        const detailSheet = exportResult.sheets['每日排课明细'];
        expect(detailSheet.length).toBeGreaterThan(0);

        // 验证周次不同
        const week2026 = detailSheet.find(row => row['日期'] === '2026-12-29')?._weekNumber;
        const week2027 = detailSheet.find(row => row['日期'] === '2027-01-05')?._weekNumber;

        expect(week2026).toBeDefined();
        expect(week2027).toBeDefined();
        expect(week2026).not.toBe(week2027);
    });

    test('周日数据 - 背景色标记正确', async () => {
        const t = await createTestTeacher();
        const s = await createTestStudent();

        // 2026-06-21 是周日
        await createTestSchedule(t.id, s.id, '2026-06-21', {
            startTime: '14:00:00',
            endTime: '16:00:00'
        });

        // 2026-06-22 是周一
        await createTestSchedule(t.id, s.id, '2026-06-22', {
            startTime: '14:00:00',
            endTime: '16:00:00'
        });

        const db = require('../../src/server/db/db');
        const result = await db.query(
            `SELECT ca.*, t.name as teacher_name, s.name as student_name,
                    st.id as course_id, st.name as type_name
             FROM course_arrangement ca
             LEFT JOIN teachers t ON ca.teacher_id = t.id
             LEFT JOIN students s ON ca.student_id = s.id
             LEFT JOIN schedule_types st ON ca.course_id = st.id
             WHERE ca.created_by = 1`
        );

        const exportResult = await service.generateCompleteExport(result.rows, {
            startDate: '2026-06-21',
            endDate: '2026-06-22',
            userType: 'admin',
            userId: 1,
            studentName: '全部学生'
        });

        const detailSheet = exportResult.sheets['每日排课明细'];
        const sundayRow = detailSheet.find(row => row['日期'] === '2026-06-21');
        const mondayRow = detailSheet.find(row => row['日期'] === '2026-06-22');

        expect(sundayRow._isSunday).toBe(true);
        expect(mondayRow._isSunday).toBe(false);
    });

    test('已取消课程 - Rich Text 样式标记正确', async () => {
        const t = await createTestTeacher();
        const s = await createTestStudent();

        // 创建已取消的课程
        await createTestSchedule(t.id, s.id, '2026-06-20', {
            startTime: '14:00:00',
            endTime: '16:00:00',
            courseId: 1,
            status: 'cancelled'
        });

        const db = require('../../src/server/db/db');
        const result = await db.query(
            `SELECT ca.*, t.name as teacher_name, s.name as student_name,
                    st.id as course_id, st.name as type_name
             FROM course_arrangement ca
             LEFT JOIN teachers t ON ca.teacher_id = t.id
             LEFT JOIN students s ON ca.student_id = s.id
             LEFT JOIN schedule_types st ON ca.course_id = st.id
             WHERE ca.created_by = 1 AND ca.status = 'cancelled'`
        );

        const exportResult = await service.generateCompleteExport(result.rows, {
            startDate: '2026-06-20',
            endDate: '2026-06-20',
            userType: 'admin',
            userId: 1,
            studentName: '全部学生'
        });

        const detailSheet = exportResult.sheets['每日排课明细'];
        expect(detailSheet.length).toBeGreaterThan(0);

        // 验证 Rich Text 包含 isCancelled 标记
        const firstRow = detailSheet[0];
        if (firstRow._planTextParts && firstRow._planTextParts.length > 0) {
            const hasCancelled = firstRow._planTextParts.some(part => part.isCancelled);
            expect(hasCancelled).toBe(true);
        }
    });

    test('评审/咨询课程 - Rich Text 颜色标记正确', async () => {
        const t = await createTestTeacher();
        const s = await createTestStudent();

        // 创建评审课程 (courseId = 3)
        await createTestSchedule(t.id, s.id, '2026-06-25', {
            startTime: '14:00:00',
            endTime: '16:00:00',
            courseId: 3 // 评审
        });

        // 创建咨询课程 (courseId = 5)
        await createTestSchedule(t.id, s.id, '2026-06-25', {
            startTime: '19:00:00',
            endTime: '21:00:00',
            courseId: 5 // 咨询
        });

        const db = require('../../src/server/db/db');
        const result = await db.query(
            `SELECT ca.*, t.name as teacher_name, s.name as student_name,
                    st.id as course_id, st.name as type_name
             FROM course_arrangement ca
             LEFT JOIN teachers t ON ca.teacher_id = t.id
             LEFT JOIN students s ON ca.student_id = s.id
             LEFT JOIN schedule_types st ON ca.course_id = st.id
             WHERE ca.created_by = 1 AND ca.course_id IN (3, 5)`
        );

        const exportResult = await service.generateCompleteExport(result.rows, {
            startDate: '2026-06-25',
            endDate: '2026-06-25',
            userType: 'admin',
            userId: 1,
            studentName: '全部学生'
        });

        const detailSheet = exportResult.sheets['每日排课明细'];
        expect(detailSheet.length).toBeGreaterThan(0);

        // 验证 Rich Text 包含 isRed 标记
        const firstRow = detailSheet[0];
        if (firstRow._planTextParts && firstRow._planTextParts.length > 0) {
            const hasRed = firstRow._planTextParts.some(part => part.isRed);
            expect(hasRed).toBe(true);
        }
    });
});
