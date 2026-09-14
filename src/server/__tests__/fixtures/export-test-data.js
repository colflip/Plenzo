/**
 * 导出测试数据
 * 提供标准的测试数据集，用于测试导出功能
 */

// 标准排课记录数据
const standardSchedules = [
    {
        id: 1,
        student_id: 101,
        student_name: '张三',
        teacher_id: 201,
        teacher_name: '李老师',
        type_id: 1,
        type_name: '入户',
        date: '2024-06-10',
        class_date: '2024-06-10',
        arr_date: '2024-06-10',
        start_time: '09:00:00',
        end_time: '10:00:00',
        status: 'confirmed',
        transport_fee: 20,
        other_fee: 0,
        adjustment_type: null
    },
    {
        id: 2,
        student_id: 101,
        student_name: '张三',
        teacher_id: 201,
        teacher_name: '李老师',
        type_id: 2,
        type_name: '评审',
        date: '2024-06-11',
        class_date: '2024-06-11',
        arr_date: '2024-06-11',
        start_time: '14:00:00',
        end_time: '15:00:00',
        status: 'confirmed',
        transport_fee: 15,
        other_fee: 5,
        adjustment_type: null
    }
];

// 不同状态的课程数据
const differentStatusSchedules = [
    {
        id: 10,
        student_id: 102,
        student_name: '李四',
        teacher_id: 202,
        teacher_name: '王老师',
        type_id: 1,
        type_name: '入户',
        date: '2024-06-10',
        start_time: '09:00:00',
        end_time: '10:00:00',
        status: 'confirmed',
        transport_fee: 20,
        other_fee: 0,
        adjustment_type: null
    },
    {
        id: 11,
        student_id: 102,
        student_name: '李四',
        teacher_id: 202,
        teacher_name: '王老师',
        type_id: 1,
        type_name: '入户',
        date: '2024-06-11',
        start_time: '09:00:00',
        end_time: '10:00:00',
        status: 'cancelled',
        transport_fee: 0,
        other_fee: 0,
        adjustment_type: null
    },
    {
        id: 12,
        student_id: 102,
        student_name: '李四',
        teacher_id: 202,
        teacher_name: '王老师',
        type_id: 1,
        type_name: '入户',
        date: '2024-06-12',
        start_time: '09:00:00',
        end_time: '10:00:00',
        status: 'modified_away',
        transport_fee: 0,
        other_fee: 0,
        adjustment_type: null
    },
    {
        id: 13,
        student_id: 102,
        student_name: '李四',
        teacher_id: 202,
        teacher_name: '王老师',
        type_id: 1,
        type_name: '入户',
        date: '2024-06-13',
        start_time: '09:00:00',
        end_time: '10:00:00',
        status: 'confirmed',
        transport_fee: 20,
        other_fee: 0,
        adjustment_type: 1  // 新增课程
    }
];

// 不同类型的课程数据
const differentTypeSchedules = [
    {
        id: 20,
        student_id: 103,
        student_name: '王五',
        teacher_id: 203,
        teacher_name: '赵老师',
        type: 'trial',
        type_name: '试教',
        date: '2024-06-10',
        start_time: '09:00:00',
        end_time: '10:00:00',
        status: 'confirmed',
        transport_fee: 25,
        other_fee: 0
    },
    {
        id: 21,
        student_id: 103,
        student_name: '王五',
        teacher_id: 203,
        teacher_name: '赵老师',
        type: 'visit',
        type_name: '入户',
        date: '2024-06-11',
        start_time: '09:00:00',
        end_time: '10:00:00',
        status: 'confirmed',
        transport_fee: 20,
        other_fee: 0
    },
    {
        id: 22,
        student_id: 103,
        student_name: '王五',
        teacher_id: 203,
        teacher_name: '赵老师',
        type: 'half_visit',
        type_name: '半次入户',
        date: '2024-06-12',
        start_time: '09:00:00',
        end_time: '10:00:00',
        status: 'confirmed',
        transport_fee: 10,
        other_fee: 0
    },
    {
        id: 23,
        student_id: 103,
        student_name: '王五',
        teacher_id: 203,
        teacher_name: '赵老师',
        type: 'review',
        type_name: '评审',
        date: '2024-06-13',
        start_time: '14:00:00',
        end_time: '15:00:00',
        status: 'confirmed',
        transport_fee: 15,
        other_fee: 0
    },
    {
        id: 24,
        student_id: 103,
        student_name: '王五',
        teacher_id: 203,
        teacher_name: '赵老师',
        type: 'review_record',
        type_name: '评审记录',
        date: '2024-06-14',
        start_time: '14:00:00',
        end_time: '15:00:00',
        status: 'confirmed',
        transport_fee: 10,
        other_fee: 0
    },
    {
        id: 25,
        student_id: 103,
        student_name: '王五',
        teacher_id: 203,
        teacher_name: '赵老师',
        type: 'consultation',
        type_name: '咨询',
        date: '2024-06-15',
        start_time: '16:00:00',
        end_time: '17:00:00',
        status: 'confirmed',
        transport_fee: 15,
        other_fee: 5
    },
    {
        id: 26,
        student_id: 103,
        student_name: '王五',
        teacher_id: 203,
        teacher_name: '赵老师',
        type: 'group_activity',
        type_name: '集体活动',
        date: '2024-06-16',
        start_time: '10:00:00',
        end_time: '12:00:00',
        status: 'confirmed',
        transport_fee: 30,
        other_fee: 0
    }
];

// 边界情况数据
const edgeCaseSchedules = {
    empty: [],
    single: [{
        id: 1,
        student_id: 101,
        student_name: '测试学生',
        teacher_id: 201,
        teacher_name: '测试老师',
        type_name: '入户',
        date: '2024-06-10',
        start_time: '09:00:00',
        end_time: '10:00:00',
        status: 'confirmed',
        transport_fee: 20,
        other_fee: 0
    }],
    nullFields: [{
        id: 1,
        student_id: null,
        student_name: null,
        teacher_id: null,
        teacher_name: null,
        type_name: null,
        date: null,
        start_time: null,
        end_time: null,
        status: null,
        transport_fee: null,
        other_fee: null
    }],
    zeroFees: [{
        id: 1,
        student_id: 101,
        student_name: '张三',
        teacher_id: 201,
        teacher_name: '李老师',
        type_name: '入户',
        date: '2024-06-10',
        start_time: '09:00:00',
        end_time: '10:00:00',
        status: 'confirmed',
        transport_fee: 0,
        other_fee: 0
    }]
};

// 多学生数据
const multiStudentSchedules = [
    {
        id: 1,
        student_id: 101,
        student_name: '张三',
        teacher_id: 201,
        teacher_name: '李老师',
        type_name: '入户',
        date: '2024-06-10',
        start_time: '09:00:00',
        end_time: '10:00:00',
        status: 'confirmed',
        transport_fee: 20,
        other_fee: 0
    },
    {
        id: 2,
        student_id: 102,
        student_name: '李四',
        teacher_id: 202,
        teacher_name: '王老师',
        type_name: '入户',
        date: '2024-06-10',
        start_time: '14:00:00',
        end_time: '15:00:00',
        status: 'confirmed',
        transport_fee: 25,
        other_fee: 5
    },
    {
        id: 3,
        student_id: 103,
        student_name: '王五',
        teacher_id: 203,
        teacher_name: '赵老师',
        type_name: '评审',
        date: '2024-06-10',
        start_time: '16:00:00',
        end_time: '17:00:00',
        status: 'confirmed',
        transport_fee: 15,
        other_fee: 0
    }
];

module.exports = {
    standardSchedules,
    differentStatusSchedules,
    differentTypeSchedules,
    edgeCaseSchedules,
    multiStudentSchedules
};
