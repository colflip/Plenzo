/**
 * CalendarGenerator 测试
 */

const CalendarGenerator = require('../../../services/export/calendar-generator');
const { standardSchedules, multiStudentSchedules } = require('../../fixtures/export-test-data');

describe('CalendarGenerator', () => {
    describe('generateDateRange', () => {
        test('生成完整日期序列', () => {
            const result = CalendarGenerator.generateDateRange('2024-06-10', '2024-06-12');

            expect(result).toEqual([
                '2024-06-10',
                '2024-06-11',
                '2024-06-12'
            ]);
        });

        test('单日期范围返回单个日期', () => {
            const result = CalendarGenerator.generateDateRange('2024-06-10', '2024-06-10');

            expect(result).toEqual(['2024-06-10']);
        });

        test('跨月日期范围', () => {
            const result = CalendarGenerator.generateDateRange('2024-05-30', '2024-06-02');

            expect(result).toEqual([
                '2024-05-30',
                '2024-05-31',
                '2024-06-01',
                '2024-06-02'
            ]);
        });

        test('跨年日期范围', () => {
            const result = CalendarGenerator.generateDateRange('2024-12-30', '2025-01-02');

            expect(result.length).toBe(4);
            expect(result[0]).toBe('2024-12-30');
            expect(result[3]).toBe('2025-01-02');
        });

        test('处理较长的日期范围', () => {
            const result = CalendarGenerator.generateDateRange('2024-06-01', '2024-06-30');

            expect(result.length).toBe(30);
            expect(result[0]).toBe('2024-06-01');
            expect(result[29]).toBe('2024-06-30');
        });
    });

    describe('getISOWeek', () => {
        test('正确计算ISO周次', () => {
            const date = new Date('2024-06-10');
            const result = CalendarGenerator.getISOWeek(date);

            expect(result).toMatch(/^2024-W\d{2}$/);
        });

        test('周一的日期', () => {
            const date = new Date('2024-06-10'); // 周一
            const result = CalendarGenerator.getISOWeek(date);

            expect(result).toBe('2024-W24');
        });

        test('周日的日期', () => {
            const date = new Date('2024-06-09'); // 周日
            const result = CalendarGenerator.getISOWeek(date);

            expect(result).toBe('2024-W23');
        });

        test('年初日期', () => {
            const date = new Date('2024-01-01');
            const result = CalendarGenerator.getISOWeek(date);

            expect(result).toMatch(/^202[34]-W\d{2}$/);
        });

        test('年末日期', () => {
            const date = new Date('2024-12-31');
            const result = CalendarGenerator.getISOWeek(date);

            expect(result).toMatch(/^202[45]-W\d{2}$/);
        });
    });

    describe('calculateFees', () => {
        test('单学生模式返回具体数值', () => {
            const dates = ['2024-06-10', '2024-06-11'];
            const rawData = [
                {
                    student_id: 101,
                    student_name: '张三',
                    teacher_name: '李老师',
                    date: '2024-06-10',
                    transport_fee: 20,
                    other_fee: 0
                }
            ];

            const { dailyFees, weeklyFees } = CalendarGenerator.calculateFees(rawData, dates, true);

            expect(dailyFees.get('2024-06-10')).toBe('20');
            expect(dailyFees.get('2024-06-11')).toBe('/');
        });

        test('单学生模式包含其他费用', () => {
            const dates = ['2024-06-10'];
            const rawData = [
                {
                    student_id: 101,
                    student_name: '张三',
                    teacher_name: '李老师',
                    date: '2024-06-10',
                    transport_fee: 20,
                    other_fee: 5
                }
            ];

            const { dailyFees } = CalendarGenerator.calculateFees(rawData, dates, true);

            expect(dailyFees.get('2024-06-10')).toBe('20，其他费用5');
        });

        // 费用列区分「没课」与「有课但零费用」：前者 '/'，后者 '0'。
        // （规则见 calendar-generator.js calculateFees 的注释）
        test('单学生模式有课零费用返回 "0"', () => {
            const dates = ['2024-06-10'];
            const rawData = [
                {
                    student_id: 101,
                    student_name: '张三',
                    teacher_name: '李老师',
                    date: '2024-06-10',
                    transport_fee: 0,
                    other_fee: 0
                }
            ];

            const { dailyFees } = CalendarGenerator.calculateFees(rawData, dates, true);

            expect(dailyFees.get('2024-06-10')).toBe('0');
        });

        test('部分待提交(draft)不隐藏已提交费用', () => {
            const dates = ['2024-06-10'];
            const rawData = [
                {
                    student_id: 101,
                    student_name: '张三',
                    teacher_name: '李老师',
                    date: '2024-06-10',
                    transport_fee: 20,
                    other_fee: 0,
                    fee_status: 'teacher_submitted'
                },
                {
                    student_id: 101,
                    student_name: '张三',
                    teacher_name: '王老师',
                    date: '2024-06-10',
                    transport_fee: 50,
                    other_fee: 0,
                    fee_status: 'draft'
                }
            ];

            const { dailyFees } = CalendarGenerator.calculateFees(rawData, dates, true);

            // 已提交的 20 正常显示；待提交的 50 不参与合计
            expect(dailyFees.get('2024-06-10')).toBe('20');
        });

        test('当天全部待提交(draft)显示 "-"', () => {
            const dates = ['2024-06-10'];
            const rawData = [
                {
                    student_id: 101,
                    student_name: '张三',
                    teacher_name: '李老师',
                    date: '2024-06-10',
                    transport_fee: 20,
                    other_fee: 0,
                    fee_status: 'draft'
                }
            ];

            const { dailyFees } = CalendarGenerator.calculateFees(rawData, dates, true);

            expect(dailyFees.get('2024-06-10')).toBe('-');
        });

        test('多学生模式按学生显示', () => {
            const dates = ['2024-06-10'];
            const rawData = [
                {
                    student_id: 101,
                    student_name: '张三',
                    teacher_name: '李老师',
                    date: '2024-06-10',
                    transport_fee: 20,
                    other_fee: 0
                },
                {
                    student_id: 102,
                    student_name: '李四',
                    teacher_name: '王老师',
                    date: '2024-06-10',
                    transport_fee: 25,
                    other_fee: 0
                }
            ];

            const { dailyFees } = CalendarGenerator.calculateFees(rawData, dates, false);

            const result = dailyFees.get('2024-06-10');
            expect(result).toContain('张三');
            expect(result).toContain('李四');
            expect(result).toContain('李老师20');
            expect(result).toContain('王老师25');
        });

        test('多学生模式同一学生多个教师', () => {
            const dates = ['2024-06-10'];
            const rawData = [
                {
                    student_id: 101,
                    student_name: '张三',
                    teacher_name: '李老师',
                    date: '2024-06-10',
                    transport_fee: 20,
                    other_fee: 0
                },
                {
                    student_id: 101,
                    student_name: '张三',
                    teacher_name: '王老师',
                    date: '2024-06-10',
                    transport_fee: 15,
                    other_fee: 0
                }
            ];

            const { dailyFees } = CalendarGenerator.calculateFees(rawData, dates, false);

            const result = dailyFees.get('2024-06-10');
            expect(result).toContain('张三');
            expect(result).toContain('李老师20');
            expect(result).toContain('王老师15');
        });

        test('正确计算周费用 - 单学生模式', () => {
            const dates = ['2024-06-10', '2024-06-11', '2024-06-12'];
            const rawData = [
                {
                    student_id: 101,
                    student_name: '张三',
                    teacher_name: '李老师',
                    date: '2024-06-10',
                    transport_fee: 20,
                    other_fee: 0
                },
                {
                    student_id: 101,
                    student_name: '张三',
                    teacher_name: '李老师',
                    date: '2024-06-11',
                    transport_fee: 15,
                    other_fee: 5
                }
            ];

            const { weeklyFees } = CalendarGenerator.calculateFees(rawData, dates, true);

            const weekNumber = CalendarGenerator.getISOWeek(new Date('2024-06-10'));
            expect(weeklyFees.get(weekNumber)).toBe('40');
        });

        test('正确计算周费用 - 多学生模式', () => {
            const dates = ['2024-06-10', '2024-06-11'];
            const rawData = [
                {
                    student_id: 101,
                    student_name: '张三',
                    teacher_name: '李老师',
                    date: '2024-06-10',
                    transport_fee: 20,
                    other_fee: 0
                },
                {
                    student_id: 102,
                    student_name: '李四',
                    teacher_name: '王老师',
                    date: '2024-06-10',
                    transport_fee: 25,
                    other_fee: 0
                }
            ];

            const { weeklyFees } = CalendarGenerator.calculateFees(rawData, dates, false);

            const weekNumber = CalendarGenerator.getISOWeek(new Date('2024-06-10'));
            const result = weeklyFees.get(weekNumber);
            expect(result).toContain('张三');
            expect(result).toContain('李四');
        });

        test('费用向上取整到小数点后两位', () => {
            const dates = ['2024-06-10'];
            const rawData = [
                {
                    student_id: 101,
                    student_name: '张三',
                    teacher_name: '李老师',
                    date: '2024-06-10',
                    transport_fee: 20.556,
                    other_fee: 0
                }
            ];

            const { dailyFees } = CalendarGenerator.calculateFees(rawData, dates, true);

            expect(dailyFees.get('2024-06-10')).toBe('20.56');
        });
    });

    describe('generateDailyScheduleSheet', () => {
        test('生成基本日历数据', () => {
            const options = {
                startDate: '2024-06-10',
                endDate: '2024-06-11',
                userType: 'admin'
            };

            const result = CalendarGenerator.generateDailyScheduleSheet(standardSchedules, options);

            expect(result.length).toBeGreaterThan(0);
            expect(result[0]).toHaveProperty('日期');
            expect(result[0]).toHaveProperty('星期');
            expect(result[0]).toHaveProperty('计划安排');
            expect(result[0]).toHaveProperty('实际安排');
        });

        test('管理员端包含费用和周汇总列', () => {
            const options = {
                startDate: '2024-06-10',
                endDate: '2024-06-11',
                userType: 'admin'
            };

            const result = CalendarGenerator.generateDailyScheduleSheet(standardSchedules, options);

            expect(result[0]).toHaveProperty('费用');
            expect(result[0]).toHaveProperty('周汇总');
        });

        test('学生端移除费用和周汇总列', () => {
            const options = {
                startDate: '2024-06-10',
                endDate: '2024-06-11',
                userType: 'student'
            };

            const result = CalendarGenerator.generateDailyScheduleSheet(standardSchedules, options);

            expect(result[0]).not.toHaveProperty('费用');
            expect(result[0]).not.toHaveProperty('周汇总');
        });

        test('正确生成日期和星期', () => {
            const options = {
                startDate: '2024-06-10',
                endDate: '2024-06-10',
                userType: 'admin'
            };

            const result = CalendarGenerator.generateDailyScheduleSheet(standardSchedules, options);

            expect(result[0]['日期']).toBe('2024-06-10');
            expect(result[0]['星期']).toBe('周一');
        });

        test('空数据日期也生成行', () => {
            const options = {
                startDate: '2024-06-10',
                endDate: '2024-06-12',
                userType: 'admin'
            };

            const emptyData = [];
            const result = CalendarGenerator.generateDailyScheduleSheet(emptyData, options);

            expect(result.length).toBe(3);
            expect(result[0]['计划安排']).toBe('');
            expect(result[0]['实际安排']).toBe('');
        });

        test('同一天多个时间段生成多行', () => {
            const data = [
                {
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
                    student_id: 101,
                    student_name: '张三',
                    teacher_id: 202,
                    teacher_name: '王老师',
                    type_name: '评审',
                    date: '2024-06-10',
                    start_time: '14:00:00',
                    end_time: '15:00:00',
                    status: 'confirmed',
                    transport_fee: 15,
                    other_fee: 0
                }
            ];

            const options = {
                startDate: '2024-06-10',
                endDate: '2024-06-10',
                userType: 'admin'
            };

            const result = CalendarGenerator.generateDailyScheduleSheet(data, options);

            // 同一天两个时间段应该生成两行
            const date0610Rows = result.filter(r => r['日期'] === '2024-06-10');
            expect(date0610Rows.length).toBe(2);
        });

        test('单学生模式正确识别', () => {
            const options = {
                startDate: '2024-06-10',
                endDate: '2024-06-11',
                studentId: 101,
                userType: 'admin'
            };

            const result = CalendarGenerator.generateDailyScheduleSheet(standardSchedules, options);

            expect(result.length).toBeGreaterThan(0);
        });

        test('包含内部标记字段', () => {
            const options = {
                startDate: '2024-06-10',
                endDate: '2024-06-10',
                userType: 'admin'
            };

            const result = CalendarGenerator.generateDailyScheduleSheet(standardSchedules, options);

            expect(result[0]).toHaveProperty('_weekNumber');
            expect(result[0]).toHaveProperty('_isSunday');
            expect(result[0]).toHaveProperty('_isRedRow');
            expect(result[0]).toHaveProperty('_planTextParts');
            expect(result[0]).toHaveProperty('_actualTextParts');
        });
    });
});

describe('CalendarGenerator.calculateFees —— 一趟一笔（多生场次不重复计费）', () => {
    test('一位老师同一场带 2 个学生 → 交通费只算一笔', () => {
        // 列表数据是「教师 pair × 学生 pair」的展开：同一趟随学生数重复出现
        const rawData = [
            { session_id: 100, teacher_uid: 't1', date: '2026-06-10', student_id: 1, student_name: 'A',
              teacher_name: 'T', transport_fee: 30, other_fee: 0, fee_status: 'admin_submitted' },
            { session_id: 100, teacher_uid: 't1', date: '2026-06-10', student_id: 2, student_name: 'B',
              teacher_name: 'T', transport_fee: 30, other_fee: 0, fee_status: 'admin_submitted' }
        ];
        const { dailyFees } = CalendarGenerator.calculateFees(rawData, ['2026-06-10'], false);
        const text = String(dailyFees.get('2026-06-10') || '');
        // 30 而不是 60
        expect(text).toMatch(/30/);
        expect(text).not.toMatch(/60/);
    });

    test('同一场 3 位老师各一笔 → 三笔之和，不是六笔', () => {
        const rawData = [];
        for (const uid of ['t1', 't2', 't3']) {
            for (const sid of [1, 2]) {
                rawData.push({
                    session_id: 200, teacher_uid: uid, date: '2026-06-11', student_id: sid,
                    student_name: `S${sid}`, teacher_name: `T${uid}`,
                    transport_fee: 10, other_fee: 0, fee_status: 'admin_submitted'
                });
            }
        }
        const { dailyFees } = CalendarGenerator.calculateFees(rawData, ['2026-06-11'], false);
        const text = String(dailyFees.get('2026-06-11') || '');
        // 明细按教师逐笔列出：三位老师各 10，没有任何一笔被翻倍成 20
        expect(text.match(/10/g)).toHaveLength(3);
        expect(text).not.toMatch(/20/);
    });
});
