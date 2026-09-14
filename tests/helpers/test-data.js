/**
 * 测试数据生成工具
 * 用于创建和清理测试数据（对齐当前 schema：teachers/students 需 username+password_hash+name，
 * status 为整数；course_arrangement 日期列为 class_date；无 users 表）。
 */

const db = require('../../src/server/db/db');

/**
 * 播种基础课程类型（试教/入户/评审/集体活动/咨询 → id 1~5）
 * 供 createTestSchedule/createBatchSchedules 的 courseId 外键使用。
 */
async function seedScheduleTypes() {
    const types = [
        ['试教', '试教课程'],
        ['入户', '入户课程'],
        ['评审', '评审课程'],
        ['集体活动', '集体活动课程'],
        ['咨询', '咨询课程']
    ];
    for (const [name, description] of types) {
        await db.query(
            `INSERT INTO schedule_types (name, description) VALUES ($1, $2)
             ON CONFLICT (name) DO NOTHING`,
            [name, description]
        );
    }
    return true;
}

/**
 * 创建测试教师
 */
async function createTestTeacher(name = null) {
    const teacherName = name || `测试教师_${Date.now()}`;
    const username = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const result = await db.query(
        `INSERT INTO teachers (username, password_hash, name, status)
         VALUES ($1, $2, $3, 1) RETURNING id`,
        [username, '$2a$10$test_hash', teacherName]
    );
    return { id: result.rows[0].id, name: teacherName };
}

/**
 * 创建测试学生
 */
async function createTestStudent(name = null) {
    const studentName = name || `测试学生_${Date.now()}`;
    const username = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const result = await db.query(
        `INSERT INTO students (username, password_hash, name, status)
         VALUES ($1, $2, $3, 1) RETURNING id`,
        [username, '$2a$10$test_hash', studentName]
    );
    return { id: result.rows[0].id, name: studentName };
}

/**
 * 创建测试排课记录
 */
async function createTestSchedule(teacherId, studentId, date, options = {}) {
    const {
        startTime = '14:00:00',
        endTime = '16:00:00',
        courseId = 1,
        status = 'confirmed',
        adjustmentType = null,
        transportFee = 50,
        otherFee = 20,
        createdBy = 1
    } = options;

    const result = await db.query(
        `INSERT INTO course_arrangement
         (teacher_id, student_id, class_date, start_time, end_time,
          course_id, status, adjustment_type, transport_fee, other_fee, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [teacherId, studentId, date, startTime, endTime, courseId, status,
         adjustmentType, transportFee, otherFee, createdBy]
    );
    return result.rows[0].id;
}

/**
 * 批量创建测试排课数据
 */
async function createBatchSchedules(count, options = {}) {
    const schedules = [];
    const {
        teacherIds = [],
        studentIds = [],
        startDate = '2026-06-01',
        courseTypes = [1, 2, 3, 4, 5] // 试教、入户、评审、集体活动、咨询
    } = options;

    // 如果没有提供教师/学生，创建默认的
    let teachers = teacherIds;
    let students = studentIds;

    if (teachers.length === 0) {
        const t1 = await createTestTeacher('张老师');
        const t2 = await createTestTeacher('李老师');
        teachers = [t1.id, t2.id];
    }

    if (students.length === 0) {
        const s1 = await createTestStudent('王小明');
        const s2 = await createTestStudent('赵小红');
        students = [s1.id, s2.id];
    }

    // 生成日期序列
    const dates = [];
    const start = new Date(startDate);
    for (let i = 0; i < Math.min(count, 30); i++) {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        dates.push(d.toISOString().split('T')[0]);
    }

    // 创建排课记录
    for (let i = 0; i < count; i++) {
        const teacherId = teachers[i % teachers.length];
        const studentId = students[i % students.length];
        const date = dates[i % dates.length];
        const courseId = courseTypes[i % courseTypes.length];

        // 变化时间段
        const hour = 9 + (i % 8); // 9:00 - 16:00
        const startTime = `${hour.toString().padStart(2, '0')}:00:00`;
        const endTime = `${(hour + 2).toString().padStart(2, '0')}:00:00`;

        const scheduleId = await createTestSchedule(teacherId, studentId, date, {
            startTime,
            endTime,
            courseId,
            status: i % 10 === 0 ? 'cancelled' : 'confirmed', // 10%取消
            transportFee: 30 + (i % 5) * 10,
            otherFee: i % 3 === 0 ? 20 : 0
        });

        schedules.push(scheduleId);
    }

    return schedules;
}

/**
 * 清理测试数据
 */
async function cleanupTestData() {
    try {
        // 删除测试排课记录（通过 created_by = 1 标识；教师/学生级联删除也会带走）
        await db.query(`DELETE FROM course_arrangement WHERE created_by = 1`);

        // 删除测试学生/教师（名称含"测试"，覆盖"测试教师_x"与显式"张测试"等）
        await db.query(`DELETE FROM students WHERE name LIKE '%测试%'`);
        await db.query(`DELETE FROM teachers WHERE name LIKE '%测试%'`);

        console.log('✅ 测试数据清理完成');
    } catch (error) {
        console.error('清理测试数据失败:', error);
        throw error;
    }
}

/**
 * 获取课程类型列表
 */
async function getScheduleTypes() {
    const result = await db.query(
        `SELECT id, name, description FROM schedule_types ORDER BY id ASC`
    );
    return result.rows;
}

module.exports = {
    seedScheduleTypes,
    createTestTeacher,
    createTestStudent,
    createTestSchedule,
    createBatchSchedules,
    cleanupTestData,
    getScheduleTypes
};
