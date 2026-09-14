/**
 * PermissionFilter 测试
 */

const PermissionFilter = require('../../../services/export/permission-filter');

describe('PermissionFilter', () => {
    describe('filterStudentColumns', () => {
        test('学生端正确移除费用列', () => {
            const data = [
                {
                    '日期': '2024-06-10',
                    '学生名称': '张三',
                    '交通费': 20,
                    '其他费用': 5,
                    '费用': 25,
                    '周汇总': 100,
                    '课程': '入户'
                }
            ];

            const result = PermissionFilter.filterStudentColumns(data, 'student');

            expect(result[0]).not.toHaveProperty('学生名称');
            expect(result[0]).not.toHaveProperty('交通费');
            expect(result[0]).not.toHaveProperty('其他费用');
            expect(result[0]).not.toHaveProperty('费用');
            expect(result[0]).not.toHaveProperty('周汇总');
            expect(result[0]).toHaveProperty('日期');
            expect(result[0]).toHaveProperty('课程');
        });

        test('非学生端不移除任何列', () => {
            const data = [
                {
                    '日期': '2024-06-10',
                    '学生名称': '张三',
                    '交通费': 20,
                    '其他费用': 5,
                    '费用': 25,
                    '周汇总': 100
                }
            ];

            const adminResult = PermissionFilter.filterStudentColumns(data, 'admin');
            const teacherResult = PermissionFilter.filterStudentColumns(data, 'teacher');

            expect(adminResult[0]).toHaveProperty('学生名称');
            expect(adminResult[0]).toHaveProperty('交通费');
            expect(adminResult[0]).toHaveProperty('费用');
            expect(teacherResult[0]).toHaveProperty('学生名称');
            expect(teacherResult[0]).toHaveProperty('交通费');
        });

        test('不修改原始数据', () => {
            const data = [
                {
                    '日期': '2024-06-10',
                    '学生名称': '张三',
                    '交通费': 20
                }
            ];

            PermissionFilter.filterStudentColumns(data, 'student');

            expect(data[0]).toHaveProperty('学生名称');
            expect(data[0]).toHaveProperty('交通费');
        });

        test('处理空数组', () => {
            const result = PermissionFilter.filterStudentColumns([], 'student');

            expect(result).toEqual([]);
        });

        test('处理多行数据', () => {
            const data = [
                {
                    '日期': '2024-06-10',
                    '学生名称': '张三',
                    '费用': 20
                },
                {
                    '日期': '2024-06-11',
                    '学生名称': '李四',
                    '费用': 30
                }
            ];

            const result = PermissionFilter.filterStudentColumns(data, 'student');

            expect(result.length).toBe(2);
            expect(result[0]).not.toHaveProperty('费用');
            expect(result[1]).not.toHaveProperty('费用');
        });
    });

    describe('filterTransportFee', () => {
        test('学生端完全隐藏交通费', () => {
            const result = PermissionFilter.filterTransportFee(20, 'student', 101, 201);

            expect(result).toBe('/');
        });

        test('管理员端显示所有交通费', () => {
            const result = PermissionFilter.filterTransportFee(20, 'admin', 101, 201);

            expect(result).toBe(20);
        });

        test('教师端显示所有交通费', () => {
            const result = PermissionFilter.filterTransportFee(20, 'teacher', 201, 201);

            expect(result).toBe(20);
        });

        test('班主任端显示所有交通费', () => {
            const result = PermissionFilter.filterTransportFee(20, 'homeroom_teacher', 201, 202);

            expect(result).toBe(20);
        });

        test('处理零值交通费', () => {
            expect(PermissionFilter.filterTransportFee(0, 'admin', 101, 201)).toBe(0);
            expect(PermissionFilter.filterTransportFee(0, 'student', 101, 201)).toBe('/');
        });

        test('处理null和undefined', () => {
            expect(PermissionFilter.filterTransportFee(null, 'admin', 101, 201)).toBe(null);
            expect(PermissionFilter.filterTransportFee(undefined, 'admin', 101, 201)).toBe(undefined);
            expect(PermissionFilter.filterTransportFee(null, 'student', 101, 201)).toBe('/');
        });
    });

    describe('removeFeeColumns', () => {
        test('学生端移除费用和周汇总列', () => {
            const data = [
                {
                    '日期': '2024-06-10',
                    '费用': 20,
                    '周汇总': 100,
                    '课程': '入户'
                }
            ];

            const result = PermissionFilter.removeFeeColumns(data, 'student');

            expect(result[0]).not.toHaveProperty('费用');
            expect(result[0]).not.toHaveProperty('周汇总');
            expect(result[0]).toHaveProperty('日期');
            expect(result[0]).toHaveProperty('课程');
        });

        test('非学生端不移除任何列', () => {
            const data = [
                {
                    '日期': '2024-06-10',
                    '费用': 20,
                    '周汇总': 100
                }
            ];

            const adminResult = PermissionFilter.removeFeeColumns(data, 'admin');
            const teacherResult = PermissionFilter.removeFeeColumns(data, 'teacher');

            expect(adminResult[0]).toHaveProperty('费用');
            expect(adminResult[0]).toHaveProperty('周汇总');
            expect(teacherResult[0]).toHaveProperty('费用');
            expect(teacherResult[0]).toHaveProperty('周汇总');
        });

        test('直接修改原始数据', () => {
            const data = [
                {
                    '日期': '2024-06-10',
                    '费用': 20,
                    '周汇总': 100
                }
            ];

            const result = PermissionFilter.removeFeeColumns(data, 'student');

            expect(result).toBe(data);
            expect(data[0]).not.toHaveProperty('费用');
        });

        test('处理空数组', () => {
            const result = PermissionFilter.removeFeeColumns([], 'student');

            expect(result).toEqual([]);
        });

        test('处理多行数据', () => {
            const data = [
                {
                    '日期': '2024-06-10',
                    '费用': 20,
                    '周汇总': 100
                },
                {
                    '日期': '2024-06-11',
                    '费用': 30,
                    '周汇总': 150
                }
            ];

            const result = PermissionFilter.removeFeeColumns(data, 'student');

            expect(result.length).toBe(2);
            expect(result[0]).not.toHaveProperty('费用');
            expect(result[1]).not.toHaveProperty('费用');
        });
    });

    describe('filterEmptyColumns', () => {
        test('过滤掉全空的列', () => {
            const data = [
                {
                    '姓名': '张三',
                    '试教': 5,
                    '入户': 3,
                    '评审': '/',
                    '集体活动': '/',
                    '咨询': '/'
                },
                {
                    '姓名': '李四',
                    '试教': 2,
                    '入户': 4,
                    '评审': '/',
                    '集体活动': '/',
                    '咨询': '/'
                }
            ];

            const result = PermissionFilter.filterEmptyColumns(data);

            expect(result[0]).toHaveProperty('试教');
            expect(result[0]).toHaveProperty('入户');
            expect(result[0]).not.toHaveProperty('评审');
            expect(result[0]).not.toHaveProperty('集体活动');
            expect(result[0]).not.toHaveProperty('咨询');
        });

        test('保留有数据的列', () => {
            const data = [
                {
                    '姓名': '张三',
                    '试教': 5,
                    '入户': 1,  // 改为非零值，因为0会被视为空
                    '评审': 1,
                    '集体活动': '/',
                    '咨询': null
                }
            ];

            const result = PermissionFilter.filterEmptyColumns(data);

            expect(result[0]).toHaveProperty('试教');
            expect(result[0]).toHaveProperty('入户');
            expect(result[0]).toHaveProperty('评审');
            expect(result[0]).not.toHaveProperty('集体活动');
            expect(result[0]).not.toHaveProperty('咨询');
        });

        test('处理不同的空值表示', () => {
            const data = [
                {
                    '姓名': '张三',
                    '试教': 0,        // 零值视为空
                    '入户': '/',      // "/" 视为空
                    '评审': '',       // 空字符串视为空
                    '集体活动': null, // null 视为空
                    '咨询': undefined // undefined 视为空
                }
            ];

            const result = PermissionFilter.filterEmptyColumns(data);

            expect(result[0]).not.toHaveProperty('试教');
            expect(result[0]).not.toHaveProperty('入户');
            expect(result[0]).not.toHaveProperty('评审');
            expect(result[0]).not.toHaveProperty('集体活动');
            expect(result[0]).not.toHaveProperty('咨询');
        });

        test('自定义检查的列', () => {
            const data = [
                {
                    '姓名': '张三',
                    '列A': 5,
                    '列B': '/',
                    '列C': 3
                }
            ];

            const result = PermissionFilter.filterEmptyColumns(data, ['列A', '列B', '列C']);

            expect(result[0]).toHaveProperty('列A');
            expect(result[0]).not.toHaveProperty('列B');
            expect(result[0]).toHaveProperty('列C');
        });

        test('不修改原始数据', () => {
            const data = [
                {
                    '姓名': '张三',
                    '试教': 5,
                    '入户': '/'
                }
            ];

            PermissionFilter.filterEmptyColumns(data);

            expect(data[0]).toHaveProperty('入户');
        });

        test('处理空数组', () => {
            const result = PermissionFilter.filterEmptyColumns([]);

            expect(result).toEqual([]);
        });

        test('处理null和undefined输入', () => {
            expect(PermissionFilter.filterEmptyColumns(null)).toBe(null);
            expect(PermissionFilter.filterEmptyColumns(undefined)).toBe(undefined);
        });

        test('只要有一行有数据就保留该列', () => {
            const data = [
                {
                    '姓名': '张三',
                    '试教': '/',
                    '入户': '/'
                },
                {
                    '姓名': '李四',
                    '试教': '/',
                    '入户': 2
                },
                {
                    '姓名': '王五',
                    '试教': '/',
                    '入户': '/'
                }
            ];

            const result = PermissionFilter.filterEmptyColumns(data);

            expect(result[0]).not.toHaveProperty('试教');
            expect(result[0]).toHaveProperty('入户');
            expect(result[1]).toHaveProperty('入户');
            expect(result[2]).toHaveProperty('入户');
        });

        test('不检查的列不会被删除', () => {
            const data = [
                {
                    '姓名': '张三',
                    '试教': '/',
                    '其他': '/'
                }
            ];

            const result = PermissionFilter.filterEmptyColumns(data, ['试教']);

            expect(result[0]).not.toHaveProperty('试教');
            expect(result[0]).toHaveProperty('其他'); // 不在检查列表中，不会被删除
        });
    });
});
