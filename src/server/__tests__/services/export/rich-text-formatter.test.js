/**
 * RichTextFormatter 测试
 */

const RichTextFormatter = require('../../../services/export/rich-text-formatter');
const { RICH_TEXT_COLORS } = require('../../../services/export/export-constants');

describe('RichTextFormatter', () => {
    describe('generateCourseText', () => {
        test('正常课程返回黑色文本', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '入户',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 'confirmed'
                }
            ];

            const { planParts } = RichTextFormatter.generateCourseText(schedules, true);

            expect(planParts[0].colorType).toBe('black');
            expect(planParts[0].dim).toBe(false);
            expect(RichTextFormatter.getTextColor(planParts[0])).toBe(RICH_TEXT_COLORS.BLACK);
        });

        test('已取消课程返回浅灰色斜体', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '入户',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 'cancelled'
                }
            ];

            const { planParts } = RichTextFormatter.generateCourseText(schedules, true);

            expect(planParts[0].dim).toBe(true);
            expect(planParts[0].text).toContain('入户');
            expect(RichTextFormatter.getTextColor(planParts[0])).toBe(RICH_TEXT_COLORS.BLACK_LIGHT);
        });

        test('已取消课程状态码为0', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '入户',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 0
                }
            ];

            const { planParts } = RichTextFormatter.generateCourseText(schedules, true);

            expect(planParts[0].dim).toBe(true);
        });

        test('已取消课程状态码为2', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '入户',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 2
                }
            ];

            const { planParts } = RichTextFormatter.generateCourseText(schedules, true);

            expect(planParts[0].dim).toBe(true);
        });

        test('modified_away 状态视为已取消', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '入户',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 'modified_away'
                }
            ];

            const { planParts } = RichTextFormatter.generateCourseText(schedules, true);

            expect(planParts[0].dim).toBe(true);
            expect(planParts[0].text).toContain('入户');
        });

        test('咨询课程返回红色文本', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '咨询',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 'confirmed'
                }
            ];

            const { planParts, hasColoredCourse } = RichTextFormatter.generateCourseText(schedules, true);

            expect(planParts[0].colorType).toBe('red');
            expect(hasColoredCourse).toBe(true);
            expect(RichTextFormatter.getTextColor(planParts[0])).toBe(RICH_TEXT_COLORS.RED);
        });

        test('评审课程返回红色文本', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '评审',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 'confirmed'
                }
            ];

            const { planParts, hasColoredCourse } = RichTextFormatter.generateCourseText(schedules, true);

            expect(planParts[0].colorType).toBe('red');
            expect(hasColoredCourse).toBe(true);
            expect(RichTextFormatter.getTextColor(planParts[0])).toBe(RICH_TEXT_COLORS.RED);
        });

        test('集体活动课程返回蓝色文本', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '集体活动',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 'confirmed'
                }
            ];

            const { planParts } = RichTextFormatter.generateCourseText(schedules, true);

            expect(planParts[0].colorType).toBe('blue');
            expect(RichTextFormatter.getTextColor(planParts[0])).toBe(RICH_TEXT_COLORS.BLUE);
        });

        test('大评审课程返回红色文本（含线上变体，不再掉成黑字）', () => {
            // DB 真实 slug 为 major-review / major-review_online；中文 description 为「大评审」
            [['大评审'], ['major-review'], ['(线上)大评审']].forEach(([typeDesc]) => {
                const schedules = [
                    {
                        student_name: '张三',
                        teacher_name: '李老师',
                        type_name: 'major-review',
                        type_desc: typeDesc,
                        start_time: '09:00:00',
                        end_time: '10:00:00',
                        status: 'confirmed'
                    }
                ];
                const { planParts } = RichTextFormatter.generateCourseText(schedules, true);
                expect(planParts[0].colorType).toBe('red');
                expect(RichTextFormatter.getTextColor(planParts[0])).toBe(RICH_TEXT_COLORS.RED);
            });
        });

        test('集体活动取消用浅蓝色', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '集体活动',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 'cancelled'
                }
            ];

            const { planParts } = RichTextFormatter.generateCourseText(schedules, true);

            expect(planParts[0].colorType).toBe('blue');
            expect(RichTextFormatter.getTextColor(planParts[0])).toBe(RICH_TEXT_COLORS.BLUE_LIGHT);
        });

        test('单学生模式显示教师名称', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '入户',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 'confirmed'
                }
            ];

            const { planParts } = RichTextFormatter.generateCourseText(schedules, true);

            expect(planParts[0].text).toContain('李老师');
            expect(planParts[0].text).not.toContain('[张三]');
        });

        test('多学生模式显示学生名称', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '入户',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 'confirmed'
                }
            ];

            const { planParts } = RichTextFormatter.generateCourseText(schedules, false);

            expect(planParts[0].text).toContain('[张三]');
            expect(planParts[0].text).toContain('李老师');
        });

        test('新增课程不出现在计划列', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '入户',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 'confirmed',
                    adjustment_type: 1
                }
            ];

            const { planParts } = RichTextFormatter.generateCourseText(schedules, true);

            expect(planParts.length).toBe(0);
        });

        test('新增课程出现在实际列，+ 为课程名前的独立上标 run', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '入户',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 'confirmed',
                    adjustment_type: 1
                }
            ];

            const { actualParts } = RichTextFormatter.generateCourseText(schedules, true);

            expect(actualParts.length).toBe(2);
            expect(actualParts[0]).toMatchObject({
                text: '+',
                isSuperscript: true,
                startsLine: true
            });
            expect(actualParts[1].text).toBe('入户(09:00-10:00)：李老师');
        });

        test('调整课程出现在实际列，~ 为课程名前的独立上标 run', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '入户',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 'confirmed',
                    adjustment_type: 2
                }
            ];

            const { actualParts } = RichTextFormatter.generateCourseText(schedules, true);

            expect(actualParts.length).toBe(2);
            expect(actualParts[0]).toMatchObject({
                text: '~',
                isSuperscript: true,
                startsLine: true
            });
            expect(actualParts[1].text).toBe('入户(09:00-10:00)：李老师');
        });

        test('已取消课程不出现在实际列', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '入户',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 'cancelled'
                }
            ];

            const { actualParts } = RichTextFormatter.generateCourseText(schedules, true);

            expect(actualParts.length).toBe(0);
        });

        test('已取消课程出现在计划列', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '入户',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 'cancelled'
                }
            ];

            const { planParts } = RichTextFormatter.generateCourseText(schedules, true);

            expect(planParts.length).toBe(1);
            expect(planParts[0].dim).toBe(true);
            expect(planParts[0].text).toContain('入户');
        });

        test('课程按时间从早到晚排序', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '入户',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 'confirmed'
                },
                {
                    student_name: '张三',
                    teacher_name: '王老师',
                    type_name: '咨询',
                    start_time: '14:00:00',
                    end_time: '15:00:00',
                    status: 'confirmed'
                },
                {
                    student_name: '张三',
                    teacher_name: '赵老师',
                    type_name: '评审',
                    start_time: '16:00:00',
                    end_time: '17:00:00',
                    status: 'confirmed'
                }
            ];

            const { planParts } = RichTextFormatter.generateCourseText(schedules, true);

            expect(planParts[0].text).toContain('入户');
            expect(planParts[1].text).toContain('咨询');
            expect(planParts[2].text).toContain('评审');
        });

        test('已取消的咨询用浅红色', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '咨询',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 'cancelled'
                }
            ];

            const { planParts } = RichTextFormatter.generateCourseText(schedules, true);

            expect(planParts[0].colorType).toBe('red');
            expect(planParts[0].dim).toBe(true);
            expect(RichTextFormatter.getTextColor(planParts[0])).toBe(RICH_TEXT_COLORS.RED_LIGHT);
        });

        test('已取消的评审用浅红色', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '评审',
                    start_time: '09:00:00',
                    end_time: '10:00:00',
                    status: 'cancelled'
                }
            ];

            const { planParts } = RichTextFormatter.generateCourseText(schedules, true);

            expect(planParts[0].colorType).toBe('red');
            expect(planParts[0].dim).toBe(true);
            expect(RichTextFormatter.getTextColor(planParts[0])).toBe(RICH_TEXT_COLORS.RED_LIGHT);
        });

        test('包含时间段信息', () => {
            const schedules = [
                {
                    student_name: '张三',
                    teacher_name: '李老师',
                    type_name: '入户',
                    start_time: '09:30:00',
                    end_time: '10:45:00',
                    status: 'confirmed'
                }
            ];

            const { planParts } = RichTextFormatter.generateCourseText(schedules, true);

            expect(planParts[0].text).toContain('09:30-10:45');
        });

        test('空数组返回空结果', () => {
            const { planParts, actualParts, hasColoredCourse } = RichTextFormatter.generateCourseText([], true);

            expect(planParts.length).toBe(0);
            expect(actualParts.length).toBe(0);
            expect(hasColoredCourse).toBe(false);
        });

        // ── 0711 真实数据用例 ──

        describe('0711 真实数据（宋林浩评审 7 条，迁移后：线上评审记录）', () => {
            // 迁移后：563、601 由 评审记录 → （线上）评审记录（review_record_online）
            // 因此实际列的 601 与线上评审 579/580 合并为一行
            const schedules = [
                { id:563, teacher_id:1, teacher_name:'周耀华', student_name:'宋林浩',
                  type_name:'review_record_online', type_desc:'（线上）评审记录',
                  start_time:'13:00:00', end_time:'15:00:00',
                  location:'新课堂', status:'modified_away', adjustment_type:0 },
                { id:564, teacher_id:5, teacher_name:'叶婷婷', student_name:'宋林浩',
                  type_name:'review', type_desc:'评审',
                  start_time:'13:00:00', end_time:'15:00:00',
                  location:'新课堂', status:'cancelled', adjustment_type:0 },
                { id:565, teacher_id:2, teacher_name:'金博', student_name:'宋林浩',
                  type_name:'review', type_desc:'评审',
                  start_time:'13:00:00', end_time:'15:00:00',
                  location:'新课堂', status:'modified_away', adjustment_type:0 },
                { id:568, teacher_id:3, teacher_name:'侯老师', student_name:'宋林浩',
                  type_name:'review', type_desc:'评审',
                  start_time:'13:00:00', end_time:'15:00:00',
                  location:'新课堂', status:'modified_away', adjustment_type:0 },
                { id:579, teacher_id:3, teacher_name:'侯老师', student_name:'宋林浩',
                  type_name:'review_online', type_desc:'（线上）评审',
                  start_time:'13:00:00', end_time:'15:00:00',
                  location:'新课堂', status:'completed', adjustment_type:2 },
                { id:580, teacher_id:2, teacher_name:'金博', student_name:'宋林浩',
                  type_name:'review_online', type_desc:'（线上）评审',
                  start_time:'13:00:00', end_time:'15:00:00',
                  location:'新课堂', status:'completed', adjustment_type:2 },
                { id:601, teacher_id:1, teacher_name:'周耀华', student_name:'宋林浩',
                  type_name:'review_record_online', type_desc:'（线上）评审记录',
                  start_time:'13:00:00', end_time:'15:00:00',
                  location:'新课堂', status:'completed', adjustment_type:2 },
            ];

            let planParts, actualParts, hasColoredCourse;

            beforeAll(() => {
                ({ planParts, actualParts, hasColoredCourse } =
                    RichTextFormatter.generateCourseText(schedules, true));
            });

            test('hasColoredCourse 为 true', () => {
                expect(hasColoredCourse).toBe(true);
            });

            test('计划列：同一时段的线上评审记录与线下评审归为一行', () => {
                const plainText = RichTextFormatter.textPartsToPlainText(planParts);
                const lines = plainText.split('\n');
                // 7 条记录同为 13:00-15:00：按时段归行 → 单行，
                // 两个类型段（(线上)评审记录、线下评审）以 '；' 分隔
                expect(lines.length).toBe(1);
                expect(lines[0]).toBe(
                    '(线上)评审(13:00-15:00)：周耀华（记录）；评审(13:00-15:00)：金博，侯老师，叶婷婷'
                );
            });

            test('计划列：合并行内保留两个类型段的全部老师', () => {
                const plainText = RichTextFormatter.textPartsToPlainText(planParts);
                expect(plainText).toContain('(线上)评审(13:00-15:00)：周耀华（记录）');
                expect(plainText).toContain('评审(13:00-15:00)：金博，侯老师，叶婷婷');
            });

            test('计划列：全部 dim，颜色为 RED_LIGHT', () => {
                planParts.forEach(p => {
                    expect(p.dim).toBe(true);
                    expect(RichTextFormatter.getTextColor(p)).toBe(RICH_TEXT_COLORS.RED_LIGHT);
                });
            });

            test('实际列：线上评审 + 线上评审记录 合并为一行', () => {
                const plainText = RichTextFormatter.textPartsToPlainText(actualParts);
                // 迁移后：601（线上评审记录）与 579/580（线上评审）同组合并
                const lines = plainText.split('\n');
                expect(lines.length).toBe(1);
                expect(plainText).toContain('(线上)评审(13:00-15:00)');
                expect(plainText).toContain('金博');
                expect(plainText).toContain('侯老师');
                expect(plainText).toContain('周耀华（记录）');
            });

            test('实际列：~ 为上标标记', () => {
                const sup = actualParts.find(p => p.isSuperscript);
                expect(sup).toBeDefined();
                expect(sup.text).toBe('~');
            });

            test('actualParts 无 dim', () => {
                actualParts.forEach(p => {
                    expect(p.dim || false).toBe(false);
                });
            });
        });

        // ── 同时段跨类型归行（逻辑行 = 时段）──

        describe('同时段跨类型归行', () => {
            const mk = (over) => Object.assign({
                student_id: 1, student_name: '宋林浩', location: '新课堂',
                status: 'completed', adjustment_type: 0
            }, over);

            test('同一时段的不同类型课程落在同一行，以 \'；\' 分隔', () => {
                const schedules = [
                    mk({ teacher_id:2, teacher_name:'金博', type_name:'review', type_desc:'评审',
                         start_time:'13:00:00', end_time:'15:00:00' }),
                    mk({ teacher_id:4, teacher_name:'王老师', type_name:'visit', type_desc:'入户',
                         start_time:'13:00:00', end_time:'15:00:00' })
                ];

                const { rows, planParts, actualParts } =
                    RichTextFormatter.generateCourseText(schedules, true);

                expect(rows.length).toBe(1);
                // 段序按 TYPE_PRIORITY（评审 2 < 入户 4）
                expect(RichTextFormatter.textPartsToPlainText(planParts))
                    .toBe('评审(13:00-15:00)：金博；入户(13:00-15:00)：王老师');
                expect(RichTextFormatter.textPartsToPlainText(actualParts))
                    .toBe('评审(13:00-15:00)：金博；入户(13:00-15:00)：王老师');
            });

            test('不同时段仍分行，按时段从早到晚', () => {
                const schedules = [
                    mk({ teacher_id:3, teacher_name:'侯老师', type_name:'review', type_desc:'评审',
                         start_time:'14:00:00', end_time:'15:00:00' }),
                    mk({ teacher_id:2, teacher_name:'金博', type_name:'visit', type_desc:'入户',
                         start_time:'09:00:00', end_time:'10:00:00' })
                ];

                const { rows } = RichTextFormatter.generateCourseText(schedules, true);

                expect(rows.map(r => r.rowKey)).toEqual(['09:00-10:00', '14:00-15:00']);
            });

            test('计划列与实际列按时段对齐：仅实际有内容的时段，计划列为空', () => {
                const schedules = [
                    mk({ teacher_id:2, teacher_name:'金博', type_name:'visit', type_desc:'入户',
                         start_time:'09:00:00', end_time:'10:00:00' }),
                    // 临时加课（adj=1）：只进实际列
                    mk({ teacher_id:3, teacher_name:'侯老师', type_name:'review', type_desc:'评审',
                         start_time:'14:00:00', end_time:'15:00:00', adjustment_type:1 })
                ];

                const { rows } = RichTextFormatter.generateCourseText(schedules, true);

                expect(rows.length).toBe(2);
                expect(RichTextFormatter.textPartsToPlainText(rows[0].planParts))
                    .toBe('入户(09:00-10:00)：金博');
                expect(RichTextFormatter.textPartsToPlainText(rows[0].actualParts))
                    .toBe('入户(09:00-10:00)：金博');
                expect(rows[1].planParts).toEqual([]);
                expect(RichTextFormatter.textPartsToPlainText(rows[1].actualParts))
                    .toBe('+评审(14:00-15:00)：侯老师');
            });

            test('多学生模式：同一时段按学生拆行', () => {
                const schedules = [
                    mk({ student_id:1, student_name:'宋林浩', teacher_id:2, teacher_name:'金博',
                         type_name:'review', type_desc:'评审',
                         start_time:'13:00:00', end_time:'15:00:00' }),
                    mk({ student_id:2, student_name:'李小明', teacher_id:4, teacher_name:'王老师',
                         type_name:'visit', type_desc:'入户',
                         start_time:'13:00:00', end_time:'15:00:00' })
                ];

                const { rows } = RichTextFormatter.generateCourseText(schedules, false);

                expect(rows.length).toBe(2);
                const texts = rows.map(r => RichTextFormatter.textPartsToPlainText(r.planParts));
                expect(texts).toContain('[宋林浩]评审(13:00-15:00)：金博');
                expect(texts).toContain('[李小明]入户(13:00-15:00)：王老师');
            });

            test('段间分隔符沿用前一段的颜色与 dim', () => {
                const schedules = [
                    // 评审（红）已取消 → dim
                    mk({ teacher_id:2, teacher_name:'金博', type_name:'review', type_desc:'评审',
                         start_time:'13:00:00', end_time:'15:00:00', status:'cancelled' }),
                    mk({ teacher_id:4, teacher_name:'王老师', type_name:'visit', type_desc:'入户',
                         start_time:'13:00:00', end_time:'15:00:00', status:'cancelled' })
                ];

                const { planParts } = RichTextFormatter.generateCourseText(schedules, true);
                const sepIndex = planParts.findIndex(p => p.text === '；');

                expect(sepIndex).toBeGreaterThan(-1);
                expect(planParts[sepIndex].dim).toBe(planParts[sepIndex - 1].dim);
                expect(planParts[sepIndex].colorType).toBe(planParts[sepIndex - 1].colorType);
            });

            test('仅首段首个 run 标记 startsLine', () => {
                const schedules = [
                    mk({ teacher_id:2, teacher_name:'金博', type_name:'review', type_desc:'评审',
                         start_time:'13:00:00', end_time:'15:00:00' }),
                    mk({ teacher_id:4, teacher_name:'王老师', type_name:'visit', type_desc:'入户',
                         start_time:'13:00:00', end_time:'15:00:00' })
                ];

                const { planParts } = RichTextFormatter.generateCourseText(schedules, true);

                expect(planParts[0].startsLine).toBe(true);
                expect(planParts.slice(1).every(p => p.startsLine === false)).toBe(true);
            });
        });

        // ── 合并组标记归并：全同标记提为整行前导 ──

        describe('合并组标记归并', () => {
            test('组内老师标记全为 ~ → 仅一个前导上标，老师前不重复', () => {
                const schedules = [
                    { teacher_id:2, teacher_name:'金博', student_name:'宋林浩', student_id:1,
                      type_name:'review', type_desc:'评审',
                      start_time:'13:00:00', end_time:'15:00:00', location:'新课堂',
                      status:'completed', adjustment_type:2 },
                    { teacher_id:3, teacher_name:'侯老师', student_name:'宋林浩', student_id:1,
                      type_name:'review', type_desc:'评审',
                      start_time:'13:00:00', end_time:'15:00:00', location:'新课堂',
                      status:'completed', adjustment_type:2 }
                ];

                const { actualParts } = RichTextFormatter.generateCourseText(schedules, true);

                const supers = actualParts.filter(p => p.isSuperscript);
                expect(supers.length).toBe(1);
                expect(supers[0].text).toBe('~');
                // 前导上标应为该行第一段
                expect(actualParts[0].isSuperscript).toBe(true);

                const plainText = RichTextFormatter.textPartsToPlainText(actualParts);
                expect(plainText.split('\n').length).toBe(1);
                expect(plainText).toContain('评审(13:00-15:00)');
                expect(plainText).toContain('金博');
                expect(plainText).toContain('侯老师');
            });

            test('组内老师标记全为 + → 仅一个前导上标', () => {
                const schedules = [
                    { teacher_id:2, teacher_name:'金博', student_name:'宋林浩', student_id:1,
                      type_name:'review', type_desc:'评审',
                      start_time:'13:00:00', end_time:'15:00:00', location:'新课堂',
                      status:'completed', adjustment_type:1 },
                    { teacher_id:3, teacher_name:'侯老师', student_name:'宋林浩', student_id:1,
                      type_name:'review', type_desc:'评审',
                      start_time:'13:00:00', end_time:'15:00:00', location:'新课堂',
                      status:'completed', adjustment_type:1 }
                ];

                const { actualParts } = RichTextFormatter.generateCourseText(schedules, true);

                const supers = actualParts.filter(p => p.isSuperscript);
                expect(supers.length).toBe(1);
                expect(supers[0].text).toBe('+');
                expect(actualParts[0].isSuperscript).toBe(true);
            });

            test('组内全员有标记且 +/~ 并列 → ~ 提到课程前，+ 跟对应老师', () => {
                const schedules = [
                    { teacher_id:2, teacher_name:'金博', student_name:'宋林浩', student_id:1,
                      type_name:'review', type_desc:'评审', start_time:'13:00:00', end_time:'15:00:00',
                      location:'新课堂', status:'completed', adjustment_type:2 },
                    { teacher_id:3, teacher_name:'侯老师', student_name:'宋林浩', student_id:1,
                      type_name:'review', type_desc:'评审', start_time:'13:00:00', end_time:'15:00:00',
                      location:'新课堂', status:'completed', adjustment_type:1 }
                ];

                const { actualParts } = RichTextFormatter.generateCourseText(schedules, true);
                expect(actualParts.map(p => p.text).join('')).toBe('~评审(13:00-15:00)：金博，+侯老师');
                expect(actualParts.filter(p => p.isSuperscript)).toEqual([
                    expect.objectContaining({ text: '~' }),
                    expect.objectContaining({ text: '+' })
                ]);
            });

            test('全学生模式全员调整 → 学生前缀保留在前，标识紧邻课程名', () => {
                const schedules = [
                    { teacher_id:2, teacher_name:'金博', student_name:'宋林浩', student_id:1,
                      type_name:'review', type_desc:'评审', start_time:'13:00:00', end_time:'15:00:00',
                      location:'新课堂', status:'completed', adjustment_type:2 },
                    { teacher_id:3, teacher_name:'侯老师', student_name:'宋林浩', student_id:1,
                      type_name:'review', type_desc:'评审', start_time:'13:00:00', end_time:'15:00:00',
                      location:'新课堂', status:'completed', adjustment_type:2 }
                ];

                const { actualParts } = RichTextFormatter.generateCourseText(schedules, false);
                expect(actualParts.map(p => p.text).join('')).toBe('[宋林浩]~评审(13:00-15:00)：金博，侯老师');
                expect(actualParts[0].text).toBe('[宋林浩]');
                expect(actualParts[1]).toMatchObject({ text: '~', isSuperscript: true });
            });

            test('单人临时加课 → 标记放在课程名前', () => {
                const schedules = [
                    { teacher_id:2, teacher_name:'金博', student_name:'宋林浩', student_id:1,
                      type_name:'visit', type_desc:'入户',
                      start_time:'13:00:00', end_time:'15:00:00', location:'新课堂',
                      status:'completed', adjustment_type:1 }
                ];

                const { actualParts } = RichTextFormatter.generateCourseText(schedules, true);
                expect(actualParts.map(p => p.text).join('')).toBe('+入户(13:00-15:00)：金博');
                expect(actualParts[0]).toMatchObject({ text: '+', isSuperscript: true, startsLine: true });
                expect(actualParts[1].text).toBe('入户(13:00-15:00)：金博');
            });

            test('组内调整占多数 → ~ 提到课程前，少数 + 跟对应老师', () => {
                const schedules = [
                    { teacher_id:2, teacher_name:'侯老师', student_name:'宋林浩', student_id:1,
                      type_name:'review', type_desc:'评审', start_time:'14:00:00', end_time:'16:00:00',
                      location:'新课堂', status:'completed', adjustment_type:2 },
                    { teacher_id:3, teacher_name:'金博', student_name:'宋林浩', student_id:1,
                      type_name:'review', type_desc:'评审', start_time:'14:00:00', end_time:'16:00:00',
                      location:'新课堂', status:'completed', adjustment_type:2 },
                    { teacher_id:4, teacher_name:'叶婷婷', student_name:'宋林浩', student_id:1,
                      type_name:'review', type_desc:'评审', start_time:'14:00:00', end_time:'16:00:00',
                      location:'新课堂', status:'completed', adjustment_type:2 },
                    { teacher_id:5, teacher_name:'高渊', student_name:'宋林浩', student_id:1,
                      type_name:'review', type_desc:'评审', start_time:'14:00:00', end_time:'16:00:00',
                      location:'新课堂', status:'completed', adjustment_type:1 },
                    { teacher_id:6, teacher_name:'周耀华', student_name:'宋林浩', student_id:1,
                      type_name:'review_record', type_desc:'评审记录', start_time:'14:00:00', end_time:'16:00:00',
                      location:'新课堂', status:'completed', adjustment_type:2 }
                ];

                const { actualParts } = RichTextFormatter.generateCourseText(schedules, true);
                expect(RichTextFormatter.textPartsToPlainText(actualParts)).toBe(
                    '~评审(14:00-16:00)：侯老师，金博，叶婷婷，+高渊，周耀华（记录）'
                );
            });

            test('组内临时加课占多数 → + 提到课程前，少数 ~ 跟对应老师', () => {
                const schedules = [
                    { teacher_id:2, teacher_name:'金博', student_name:'宋林浩', student_id:1,
                      type_name:'review', type_desc:'评审', start_time:'13:00:00', end_time:'15:00:00',
                      location:'新课堂', status:'completed', adjustment_type:1 },
                    { teacher_id:3, teacher_name:'侯老师', student_name:'宋林浩', student_id:1,
                      type_name:'review', type_desc:'评审', start_time:'13:00:00', end_time:'15:00:00',
                      location:'新课堂', status:'completed', adjustment_type:1 },
                    { teacher_id:4, teacher_name:'高渊', student_name:'宋林浩', student_id:1,
                      type_name:'review', type_desc:'评审', start_time:'13:00:00', end_time:'15:00:00',
                      location:'新课堂', status:'completed', adjustment_type:2 }
                ];

                const { actualParts } = RichTextFormatter.generateCourseText(schedules, true);
                expect(RichTextFormatter.textPartsToPlainText(actualParts)).toBe(
                    '+评审(13:00-15:00)：金博，侯老师，~高渊'
                );
            });

            test('组内标记混合（+ 与正常）→ 标记跟各自老师，不提前导', () => {
                const schedules = [
                    { teacher_id:2, teacher_name:'金博', student_name:'宋林浩', student_id:1,
                      type_name:'review', type_desc:'评审',
                      start_time:'13:00:00', end_time:'15:00:00', location:'新课堂',
                      status:'completed', adjustment_type:1 },
                    { teacher_id:3, teacher_name:'侯老师', student_name:'宋林浩', student_id:1,
                      type_name:'review', type_desc:'评审',
                      start_time:'13:00:00', end_time:'15:00:00', location:'新课堂',
                      status:'completed', adjustment_type:0 }
                ];

                const { actualParts } = RichTextFormatter.generateCourseText(schedules, true);

                const supers = actualParts.filter(p => p.isSuperscript);
                expect(supers.length).toBe(1);
                expect(supers[0].text).toBe('+');
                // 第一段应为前缀（评审...），而非上标
                expect(actualParts[0].isSuperscript).toBe(false);
                expect(actualParts[0].text).toContain('评审(13:00-15:00)');
                // 上标应紧邻带标记的老师（金博 id=2 排在前），出现在金博 run 前
                const supIdx = actualParts.findIndex(p => p.isSuperscript);
                expect(actualParts[supIdx + 1].text).toContain('金博');

                const plainText = RichTextFormatter.textPartsToPlainText(actualParts);
                expect(plainText.split('\n').length).toBe(1);
            });
        });
    });

    describe('textPartsToPlainText', () => {
        test('将文本片段转换为按 startsLine 换行的字符串', () => {
            const parts = [
                { text: '课程A', startsLine: true },
                { text: '课程B', startsLine: true },
                { text: '课程C', startsLine: true }
            ];

            const result = RichTextFormatter.textPartsToPlainText(parts);

            expect(result).toBe('课程A\n课程B\n课程C');
        });

        test('同行多段（startsLine=false）不换行', () => {
            const parts = [
                { text: '评审(13:00-15:00)：', startsLine: true },
                { text: '金博，', startsLine: false },
                { text: '周耀华（记录）', startsLine: false }
            ];

            const result = RichTextFormatter.textPartsToPlainText(parts);

            expect(result).toBe('评审(13:00-15:00)：金博，周耀华（记录）');
        });

        test('单个片段', () => {
            const parts = [
                { text: '课程A', startsLine: true }
            ];

            const result = RichTextFormatter.textPartsToPlainText(parts);

            expect(result).toBe('课程A');
        });

        test('空数组返回空字符串', () => {
            const result = RichTextFormatter.textPartsToPlainText([]);

            expect(result).toBe('');
        });

        test('忽略其他属性', () => {
            const parts = [
                { text: '课程A', colorType: 'red', startsLine: true },
                { text: '课程B', colorType: 'black', startsLine: true }
            ];

            const result = RichTextFormatter.textPartsToPlainText(parts);

            expect(result).toBe('课程A\n课程B');
        });
    });

    describe('getTextColor', () => {
        test('黑色 dim 返回浅灰色', () => {
            const part = { text: '测试', dim: true, colorType: 'black' };

            expect(RichTextFormatter.getTextColor(part)).toBe(RICH_TEXT_COLORS.BLACK_LIGHT);
        });

        test('红色课程返回红色', () => {
            const part = { text: '测试', dim: false, colorType: 'red' };

            expect(RichTextFormatter.getTextColor(part)).toBe(RICH_TEXT_COLORS.RED);
        });

        test('蓝色课程返回蓝色', () => {
            const part = { text: '测试', dim: false, colorType: 'blue' };

            expect(RichTextFormatter.getTextColor(part)).toBe(RICH_TEXT_COLORS.BLUE);
        });

        test('黑色课程返回黑色', () => {
            const part = { text: '测试', dim: false, colorType: 'black' };

            expect(RichTextFormatter.getTextColor(part)).toBe(RICH_TEXT_COLORS.BLACK);
        });

        test('红色 dim 用浅红色', () => {
            const part = { text: '测试', dim: true, colorType: 'red' };

            expect(RichTextFormatter.getTextColor(part)).toBe(RICH_TEXT_COLORS.RED_LIGHT);
        });

        test('蓝色 dim 用浅蓝色', () => {
            const part = { text: '测试', dim: true, colorType: 'blue' };

            expect(RichTextFormatter.getTextColor(part)).toBe(RICH_TEXT_COLORS.BLUE_LIGHT);
        });

        test('向下兼容 isCancelled', () => {
            const part = { text: '测试', isCancelled: true, colorType: 'red' };

            expect(RichTextFormatter.getTextColor(part)).toBe(RICH_TEXT_COLORS.RED_LIGHT);
        });

        test('向下兼容 isAdjusted', () => {
            const part = { text: '测试', isAdjusted: true, colorType: 'black' };

            expect(RichTextFormatter.getTextColor(part)).toBe(RICH_TEXT_COLORS.BLACK_LIGHT);
        });
    });
});
