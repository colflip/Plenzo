/**
 * 导出批量测试共用的排课数据生成器。
 * 原 sheet-builder.batch.test.js 与 performance.batch.test.js 各存一份逐字相同的实现。
 */

/**
 * 生成测试数据
 * @param {number} count 记录数
 */
function generateTestData(count) {
    const data = [];
    const startDate = new Date('2024-01-01');

    for (let i = 0; i < count; i++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + Math.floor(i / 10));

        data.push({
            id: i + 1,
            schedule_id: i + 1,
            teacher_id: (i % 5) + 1,
            teacher_name: `教师${(i % 5) + 1}`,
            student_id: (i % 10) + 1,
            student_name: `学生${(i % 10) + 1}`,
            date: date.toISOString().split('T')[0],
            class_date: date.toISOString().split('T')[0],
            arr_date: date.toISOString().split('T')[0],
            start_time: '09:00:00',
            end_time: '10:00:00',
            type: i % 2 === 0 ? '入户' : '试教',
            type_name: i % 2 === 0 ? '入户' : '试教',
            type_desc: i % 2 === 0 ? '入户' : '试教',
            type_id: i % 2 === 0 ? 2 : 1,
            course_id: i % 2 === 0 ? 2 : 1,
            status: 'confirmed',
            location: '测试地点',
            transport_fee: 10,
            other_fee: 5,
            family_participants: 3,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            created_by: 1
        });
    }

    return data;
}

module.exports = { generateTestData };
