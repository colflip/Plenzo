/**
 * StatsAggregator 测试
 */

const StatsAggregator = require('../../../services/export/stats-aggregator');
const { differentTypeSchedules } = require('../../fixtures/export-test-data');

describe('StatsAggregator', () => {
    describe('aggregateTeacherStats', () => {
        test('正确聚合教师统计', () => {
            const options = {
                startDate: '2024-06-01',
                endDate: '2024-06-30'
            };

            const result = StatsAggregator.aggregateTeacherStats(differentTypeSchedules, options);

            expect(result.length).toBe(1);
            expect(result[0]['姓名']).toBe('赵老师');
        });

        test('统计各类型课程数量', () => {
            const options = {
                startDate: '2024-06-01',
                endDate: '2024-06-30'
            };

            const result = StatsAggregator.aggregateTeacherStats(differentTypeSchedules, options);

            expect(result[0]['试教']).toBe(1);
            expect(result[0]['入户']).toBe(2); // applyConversionFormula已应用: 1次入户 + 0.5次半次入户 + 0.5次评审记录 = 2
            expect(result[0]['评审']).toBe(3); // 1次评审 + 1次评审记录 + 1次集体活动（集体活动 1:1 并入评审）
            expect(result[0]['咨询']).toBe(1);
            // 集体活动已并入评审，恒为 0；键保留是为了让空列过滤能整列删掉
            expect(result[0]['集体活动']).toBe(0);
        });

        test('排除已取消的课程', () => {
            const data = [
                {
                    teacher_name: '李老师',
                    type_name: '入户',
                    status: 'confirmed'
                },
                {
                    teacher_name: '李老师',
                    type_name: '入户',
                    status: 'cancelled'
                }
            ];

            const options = {
                startDate: '2024-06-01',
                endDate: '2024-06-30'
            };

            const result = StatsAggregator.aggregateTeacherStats(data, options);

            expect(result[0]['入户']).toBe(1);
        });

        test('排除已调整的课程', () => {
            const data = [
                {
                    teacher_name: '李老师',
                    type_name: '入户',
                    status: 'confirmed'
                },
                {
                    teacher_name: '李老师',
                    type_name: '入户',
                    status: 'modified_away'
                }
            ];

            const options = {
                startDate: '2024-06-01',
                endDate: '2024-06-30'
            };

            const result = StatsAggregator.aggregateTeacherStats(data, options);

            expect(result[0]['入户']).toBe(1);
        });

        test('多个教师分别统计', () => {
            const data = [
                {
                    teacher_name: '李老师',
                    type_name: '入户',
                    status: 'confirmed'
                },
                {
                    teacher_name: '王老师',
                    type_name: '入户',
                    status: 'confirmed'
                },
                {
                    teacher_name: '李老师',
                    type_name: '评审',
                    status: 'confirmed'
                }
            ];

            const options = {
                startDate: '2024-06-01',
                endDate: '2024-06-30'
            };

            const result = StatsAggregator.aggregateTeacherStats(data, options);

            expect(result.length).toBe(2);
            const liTeacher = result.find(r => r['姓名'] === '李老师');
            const wangTeacher = result.find(r => r['姓名'] === '王老师');

            expect(liTeacher['入户']).toBe(1);
            expect(liTeacher['评审']).toBe(1);
            expect(wangTeacher['入户']).toBe(1);
        });

        test('生成正确的汇总文本', () => {
            const options = {
                startDate: '2024-06-01',
                endDate: '2024-06-30'
            };

            const result = StatsAggregator.aggregateTeacherStats(differentTypeSchedules, options);

            expect(result[0]['汇总']).toContain('入户');
            // 集体活动已 1:1 并入评审，汇总里不再单列
            expect(result[0]['汇总']).toContain('3次评审');
            expect(result[0]['汇总']).not.toContain('集体活动');
        });

        test('生成正确的备注文本', () => {
            const options = {
                startDate: '2024-06-01',
                endDate: '2024-06-30'
            };

            const result = StatsAggregator.aggregateTeacherStats(differentTypeSchedules, options);

            expect(result[0]['备注']).toContain('赵老师');
            expect(result[0]['备注']).toContain('2024-06-01');
            expect(result[0]['备注']).toContain('2024-06-30');
        });
    });

    describe('aggregateStudentStats', () => {
        test('正确聚合学生统计', () => {
            const options = {
                startDate: '2024-06-01',
                endDate: '2024-06-30'
            };

            const result = StatsAggregator.aggregateStudentStats(differentTypeSchedules, options);

            expect(result.length).toBe(1);
            expect(result[0]['姓名']).toBe('王五');
        });

        test('统计各类型课程数量', () => {
            const options = {
                startDate: '2024-06-01',
                endDate: '2024-06-30'
            };

            const result = StatsAggregator.aggregateStudentStats(differentTypeSchedules, options);

            expect(result[0]['试教']).toBe(1);
            expect(result[0]['入户']).toBe(2); // applyConversionFormula已应用: 1次入户 + 0.5次半次入户 + 0.5次评审记录 = 2
            expect(result[0]['评审']).toBe(3); // 1次评审 + 1次评审记录 + 1次集体活动（集体活动 1:1 并入评审）
            expect(result[0]['咨询']).toBe(1);
            expect(result[0]['集体活动']).toBe(0);
        });

        test('多个学生分别统计', () => {
            const data = [
                {
                    student_name: '张三',
                    type_name: '入户',
                    status: 'confirmed'
                },
                {
                    student_name: '李四',
                    type_name: '入户',
                    status: 'confirmed'
                },
                {
                    student_name: '张三',
                    type_name: '评审',
                    status: 'confirmed'
                }
            ];

            const options = {
                startDate: '2024-06-01',
                endDate: '2024-06-30'
            };

            const result = StatsAggregator.aggregateStudentStats(data, options);

            expect(result.length).toBe(2);
            const zhangStudent = result.find(r => r['姓名'] === '张三');
            const liStudent = result.find(r => r['姓名'] === '李四');

            expect(zhangStudent['入户']).toBe(1);
            expect(zhangStudent['评审']).toBe(1);
            expect(liStudent['入户']).toBe(1);
        });
    });

    describe('applyConversionFormula', () => {
        test('正确应用转换公式: finalVisit = 入户 + 半次*0.5 + 评审记录*0.5 + 咨询记录*0.5', () => {
            const stat = {
                '姓名': '测试',
                '试教': 0,
                '入户': 2,
                '半次入户': 2,
                '评审': 1,
                '评审记录': 2,
                '集体活动': 0,
                '咨询': 0,
                '咨询记录': 2
            };

            const result = StatsAggregator.applyConversionFormula(stat, '2024-06-01', '2024-06-30');

            // finalVisit = 2 + 2*0.5 + 2*0.5 + 2*0.5 = 2 + 1 + 1 + 1 = 5
            expect(result['入户']).toBe(5);
        });

        test('正确应用转换公式: finalReview = 评审 + 评审记录', () => {
            const stat = {
                '姓名': '测试',
                '试教': 0,
                '入户': 0,
                '半次入户': 0,
                '评审': 3,
                '评审记录': 2,
                '集体活动': 0,
                '咨询': 0,
                '咨询记录': 0
            };

            const result = StatsAggregator.applyConversionFormula(stat, '2024-06-01', '2024-06-30');

            // finalReview = 3 + 2 = 5
            expect(result['评审']).toBe(5);
        });

        test('正确应用转换公式: finalConsult = 咨询 + 咨询记录', () => {
            const stat = {
                '姓名': '测试',
                '试教': 0,
                '入户': 0,
                '半次入户': 0,
                '评审': 0,
                '评审记录': 0,
                '集体活动': 0,
                '咨询': 3,
                '咨询记录': 2
            };

            const result = StatsAggregator.applyConversionFormula(stat, '2024-06-01', '2024-06-30');

            // finalConsult = 3 + 2 = 5
            expect(result['咨询']).toBe(5);
        });

        test('试教取原值，集体活动 1:1 并入评审', () => {
            const stat = {
                '姓名': '测试',
                '试教': 5,
                '入户': 0,
                '半次入户': 0,
                '评审': 0,
                '评审记录': 0,
                '集体活动': 3,
                '咨询': 0,
                '咨询记录': 0
            };

            const result = StatsAggregator.applyConversionFormula(stat, '2024-06-01', '2024-06-30');

            expect(result['试教']).toBe(5);
            expect(result['评审']).toBe(3);
            expect(result['集体活动']).toBe(0);
        });

        test('生成正确的汇总文本', () => {
            const stat = {
                '姓名': '测试',
                '试教': 0,
                '入户': 2,
                '半次入户': 0,
                '评审': 1,
                '评审记录': 0,
                '集体活动': 1,
                '咨询': 1,
                '咨询记录': 0
            };

            const result = StatsAggregator.applyConversionFormula(stat, '2024-06-01', '2024-06-30');

            // 集体活动 1 次并入评审：评审 = 1 + 1 = 2
            expect(result['汇总']).toBe('2次入户、2次评审、1次咨询');
        });

        test('零值不出现在汇总中', () => {
            const stat = {
                '姓名': '测试',
                '试教': 0,
                '入户': 2,
                '半次入户': 0,
                '评审': 0,
                '评审记录': 0,
                '集体活动': 0,
                '咨询': 0,
                '咨询记录': 0
            };

            const result = StatsAggregator.applyConversionFormula(stat, '2024-06-01', '2024-06-30');

            expect(result['汇总']).toBe('2次入户');
            expect(result['汇总']).not.toContain('评审');
            expect(result['汇总']).not.toContain('咨询');
        });

        test('生成正确的备注文本格式', () => {
            const stat = {
                '姓名': '张三',
                '试教': 0,
                '入户': 2,
                '半次入户': 0,
                '评审': 1,
                '评审记录': 0,
                '集体活动': 0,
                '咨询': 0,
                '咨询记录': 0
            };

            const result = StatsAggregator.applyConversionFormula(stat, '2024-06-01', '2024-06-30');

            expect(result['备注']).toBe('在张三，2024-06-01-2024-06-30，2次入户，1次评审。');
        });

        test('没有课程时备注只有句号', () => {
            const stat = {
                '姓名': '张三',
                '试教': 0,
                '入户': 0,
                '半次入户': 0,
                '评审': 0,
                '评审记录': 0,
                '集体活动': 0,
                '咨询': 0,
                '咨询记录': 0
            };

            const result = StatsAggregator.applyConversionFormula(stat, '2024-06-01', '2024-06-30');

            expect(result['备注']).toBe('在张三，2024-06-01-2024-06-30。');
        });
    });

    describe('generateSummaryText', () => {
        test('生成正确的汇总文本', () => {
            const typeTotals = {
                '入户': 5,
                '评审': 3,
                '咨询': 2
            };

            const result = StatsAggregator.generateSummaryText(typeTotals);

            expect(result).toBe('5次入户、3次评审、2次咨询');
        });

        test('空对象返回 "/"', () => {
            const result = StatsAggregator.generateSummaryText({});

            expect(result).toBe('/');
        });

        test('单个类型', () => {
            const typeTotals = {
                '入户': 10
            };

            const result = StatsAggregator.generateSummaryText(typeTotals);

            expect(result).toBe('10次入户');
        });
    });

    describe('appendSummaryRow', () => {
        test('为数据添加汇总行', () => {
            const data = [
                {
                    '姓名': '张三',
                    '入户': 5,
                    '评审': 3,
                    '汇总': '5次入户、3次评审',
                    '备注': '测试'
                },
                {
                    '姓名': '李四',
                    '入户': 3,
                    '评审': 2,
                    '汇总': '3次入户、2次评审',
                    '备注': '测试'
                }
            ];

            const result = StatsAggregator.appendSummaryRow(data);

            expect(result.length).toBe(3);
            expect(result[2]._isSummaryRow).toBe(true);
            expect(result[2]['姓名']).toBe('/');
            expect(result[2]['入户']).toBe(8);
            expect(result[2]['评审']).toBe(5);
        });

        test('跳过指定的列', () => {
            const data = [
                {
                    '姓名': '张三',
                    '入户': 5,
                    '备注': '测试1',
                    '核对': '未核对'
                }
            ];

            const result = StatsAggregator.appendSummaryRow(data, ['备注', '核对']);

            expect(result[1]['备注']).toBe('/');
            expect(result[1]['核对']).toBe('/');
        });

        test('正确处理 "/" 值', () => {
            const data = [
                {
                    '姓名': '张三',
                    '入户': 5,
                    '评审': '/'
                },
                {
                    '姓名': '李四',
                    '入户': 3,
                    '评审': '/'
                }
            ];

            const result = StatsAggregator.appendSummaryRow(data);

            expect(result[2]['入户']).toBe(8);
            expect(result[2]['评审']).toBe('/');
        });

        test('空数据返回原数据', () => {
            const result = StatsAggregator.appendSummaryRow([]);

            expect(result).toEqual([]);
        });

        test('生成汇总行的汇总文本', () => {
            const data = [
                {
                    '姓名': '张三',
                    '入户': 5,
                    '评审': 3,
                    '汇总': ''
                }
            ];

            const result = StatsAggregator.appendSummaryRow(data);

            expect(result[1]['汇总']).toBe('5次入户、3次评审');
        });

        test('忽略以下划线开头的内部字段', () => {
            const data = [
                {
                    '姓名': '张三',
                    '入户': 5,
                    '_internal': 100
                }
            ];

            const result = StatsAggregator.appendSummaryRow(data);

            expect(result[1]).not.toHaveProperty('_internal');
        });
    });

    describe('generateTeacherSummarySheet', () => {
        test('生成教师汇总工作表', () => {
            const options = {
                startDate: '2024-06-01',
                endDate: '2024-06-30',
                userType: 'admin'
            };

            const result = StatsAggregator.generateTeacherSummarySheet(differentTypeSchedules, options);

            expect(result.length).toBeGreaterThan(0);
            expect(result[0]).toHaveProperty('教师姓名');
            expect(result[0]).toHaveProperty('试教');
            expect(result[0]).toHaveProperty('入户');
            expect(result[0]).toHaveProperty('评审');
            expect(result[0]).toHaveProperty('汇总');
            expect(result[0]).toHaveProperty('核对');
            expect(result[0]).toHaveProperty('备注');
        });

        test('最后一行核对列显示祝福语 - 教师端', () => {
            const options = {
                startDate: '2024-06-01',
                endDate: '2024-06-30',
                userType: 'teacher'
            };

            const result = StatsAggregator.generateTeacherSummarySheet(differentTypeSchedules, options);

            expect(result[result.length - 1]['核对']).toBe('Congratulations！🎉');
        });

        test('最后一行核对列显示祝福语 - 管理员端', () => {
            const options = {
                startDate: '2024-06-01',
                endDate: '2024-06-30',
                userType: 'admin'
            };

            const result = StatsAggregator.generateTeacherSummarySheet(differentTypeSchedules, options);

            expect(result[result.length - 1]['核对']).toBe('Congratulations！🎉');
        });

        test('最后一行核对列显示祝福语 - 其他用户', () => {
            const options = {
                startDate: '2024-06-01',
                endDate: '2024-06-30',
                userType: 'student'
            };

            const result = StatsAggregator.generateTeacherSummarySheet(differentTypeSchedules, options);

            expect(result[result.length - 1]['核对']).toBe('Good Luck！🎉');
        });

        test('零值显示为 "/"', () => {
            const data = [
                {
                    teacher_name: '李老师',
                    type_name: '入户',
                    status: 'confirmed'
                }
            ];

            const options = {
                startDate: '2024-06-01',
                endDate: '2024-06-30',
                userType: 'admin'
            };

            const result = StatsAggregator.generateTeacherSummarySheet(data, options);

            expect(result[0]['试教']).toBe('/');
            expect(result[0]['评审']).toBe('/');
        });
    });

    describe('generateStudentSummarySheet', () => {
        test('生成学生汇总工作表', () => {
            const options = {
                startDate: '2024-06-01',
                endDate: '2024-06-30'
            };

            const result = StatsAggregator.generateStudentSummarySheet(differentTypeSchedules, options);

            expect(result.length).toBeGreaterThan(0);
            expect(result[0]).toHaveProperty('学生姓名');
            expect(result[0]).toHaveProperty('试教');
            expect(result[0]).toHaveProperty('入户');
            expect(result[0]).toHaveProperty('评审');
            expect(result[0]).toHaveProperty('汇总');
            expect(result[0]).toHaveProperty('核对');
            expect(result[0]).toHaveProperty('备注');
        });

        test('最后一行核对列显示祝福语', () => {
            const options = {
                startDate: '2024-06-01',
                endDate: '2024-06-30'
            };

            const result = StatsAggregator.generateStudentSummarySheet(differentTypeSchedules, options);

            expect(result[result.length - 1]['核对']).toBe('Good Luck！🎉');
        });
    });

    describe('generateTeacherStatsSheet', () => {
        test('生成教师统计透视表', () => {
            const rawData = [
                {
                    teacher_id: 201,
                    teacher_name: '李老师',
                    type_id: 1,
                    course_id: 1,
                    status: 'confirmed'
                },
                {
                    teacher_id: 201,
                    teacher_name: '李老师',
                    type_id: 2,
                    course_id: 2,
                    status: 'confirmed'
                }
            ];

            const allTypes = [
                { id: 1, name: '入户', description: '入户' },
                { id: 2, name: '评审', description: '评审' }
            ];

            const result = StatsAggregator.generateTeacherStatsSheet(rawData, allTypes);

            expect(result.length).toBeGreaterThan(0);
            expect(result[0]).toHaveProperty('教师姓名');
            expect(result[0]).toHaveProperty('入户');
            expect(result[0]).toHaveProperty('评审');
            expect(result[0]).toHaveProperty('汇总');
        });

        test('按教师ID排序', () => {
            const rawData = [
                {
                    teacher_id: 203,
                    teacher_name: '赵老师',
                    type_id: 1,
                    status: 'confirmed'
                },
                {
                    teacher_id: 201,
                    teacher_name: '李老师',
                    type_id: 1,
                    status: 'confirmed'
                },
                {
                    teacher_id: 202,
                    teacher_name: '王老师',
                    type_id: 1,
                    status: 'confirmed'
                }
            ];

            const allTypes = [
                { id: 1, name: '入户', description: '入户' }
            ];

            const result = StatsAggregator.generateTeacherStatsSheet(rawData, allTypes);

            expect(result[0]['教师姓名']).toBe('李老师');
            expect(result[1]['教师姓名']).toBe('王老师');
            expect(result[2]['教师姓名']).toBe('赵老师');
        });

        test('零值显示为"/"', () => {
            const rawData = [
                {
                    teacher_id: 201,
                    teacher_name: '李老师',
                    type_id: 1,
                    status: 'confirmed'
                }
            ];

            const allTypes = [
                { id: 1, name: '入户', description: '入户' },
                { id: 2, name: '评审', description: '评审' }
            ];

            const result = StatsAggregator.generateTeacherStatsSheet(rawData, allTypes);

            expect(result[0]['入户']).toBe(1);
            expect(result[0]['评审']).toBe('/');
        });

        test('生成正确的汇总文本', () => {
            const rawData = [
                {
                    teacher_id: 201,
                    teacher_name: '李老师',
                    type_id: 1,
                    status: 'confirmed'
                },
                {
                    teacher_id: 201,
                    teacher_name: '李老师',
                    type_id: 1,
                    status: 'confirmed'
                },
                {
                    teacher_id: 201,
                    teacher_name: '李老师',
                    type_id: 2,
                    status: 'confirmed'
                }
            ];

            const allTypes = [
                { id: 1, name: '入户', description: '入户' },
                { id: 2, name: '评审', description: '评审' }
            ];

            const result = StatsAggregator.generateTeacherStatsSheet(rawData, allTypes);

            expect(result[0]['汇总']).toBe('2次入户、1次评审');
        });

        test('包含汇总行', () => {
            const rawData = [
                {
                    teacher_id: 201,
                    teacher_name: '李老师',
                    type_id: 1,
                    status: 'confirmed'
                }
            ];

            const allTypes = [
                { id: 1, name: '入户', description: '入户' }
            ];

            const result = StatsAggregator.generateTeacherStatsSheet(rawData, allTypes);

            expect(result[result.length - 1]._isSummaryRow).toBe(true);
        });
    });

    describe('generateStudentStatsSheet', () => {
        test('生成学生统计透视表', () => {
            const rawData = [
                {
                    student_id: 101,
                    student_name: '张三',
                    type_id: 1,
                    course_id: 1,
                    status: 'confirmed'
                },
                {
                    student_id: 101,
                    student_name: '张三',
                    type_id: 2,
                    course_id: 2,
                    status: 'confirmed'
                }
            ];

            const allTypes = [
                { id: 1, name: '入户', description: '入户' },
                { id: 2, name: '评审', description: '评审' }
            ];

            const result = StatsAggregator.generateStudentStatsSheet(rawData, allTypes);

            expect(result.length).toBeGreaterThan(0);
            expect(result[0]).toHaveProperty('学生姓名');
            expect(result[0]).toHaveProperty('入户');
            expect(result[0]).toHaveProperty('评审');
            expect(result[0]).toHaveProperty('汇总');
        });

        test('按学生ID排序', () => {
            const rawData = [
                {
                    student_id: 103,
                    student_name: '王五',
                    type_id: 1,
                    status: 'confirmed'
                },
                {
                    student_id: 101,
                    student_name: '张三',
                    type_id: 1,
                    status: 'confirmed'
                },
                {
                    student_id: 102,
                    student_name: '李四',
                    type_id: 1,
                    status: 'confirmed'
                }
            ];

            const allTypes = [
                { id: 1, name: '入户', description: '入户' }
            ];

            const result = StatsAggregator.generateStudentStatsSheet(rawData, allTypes);

            expect(result[0]['学生姓名']).toBe('张三');
            expect(result[1]['学生姓名']).toBe('李四');
            expect(result[2]['学生姓名']).toBe('王五');
        });

        test('处理未知类型', () => {
            const rawData = [
                {
                    student_id: 101,
                    student_name: '张三',
                    type_id: 999,
                    status: 'confirmed'
                }
            ];

            const allTypes = [
                { id: 1, name: '入户', description: '入户' }
            ];

            const result = StatsAggregator.generateStudentStatsSheet(rawData, allTypes);

            expect(result.length).toBeGreaterThan(0);
        });

        test('包含汇总行', () => {
            const rawData = [
                {
                    student_id: 101,
                    student_name: '张三',
                    type_id: 1,
                    status: 'confirmed'
                }
            ];

            const allTypes = [
                { id: 1, name: '入户', description: '入户' }
            ];

            const result = StatsAggregator.generateStudentStatsSheet(rawData, allTypes);

            expect(result[result.length - 1]._isSummaryRow).toBe(true);
        });
    });
});
