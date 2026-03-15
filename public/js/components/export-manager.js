// ==========================================
// Export Data Manager
// Handles data transformations and Excel generation
// ==========================================

/**
 * 标准化类型键：将线上类型映射到基础类型
 * @param {string} typeKey - 类型英文标识
 * @returns {string} 标准化后的类型英文标识
 */
function normalizeTypeKey(typeKey) {
    const lower = String(typeKey || '').toLowerCase().trim();
    // 线上评审 → 评审
    if (lower === 'review_online' || lower === 'online_review') return 'review';
    // 线上入户 → 入户
    if (lower === 'visit_online' || lower === 'online_visit') return 'visit';
    // 线上咨询 → 咨询
    if (lower === 'consultation_online' || lower === 'online_consultation' || lower === 'advisory_online' || lower === 'online_advisory') return 'consultation';
    // 线上评审记录 → 评审记录
    if (lower === 'review_record_online' || lower === 'online_review_record') return 'review_record';
    // 线上咨询记录 → 咨询记录
    if (lower === 'consultation_record_online' || lower === 'online_consultation_record') return 'consultation_record';
    return lower;
}

/**
 * 辅助函数：为数据添加汇总行
 * @param {Array} data 数据数组
 * @param {Array} skipKeys 跳过统计的键
 */
function appendSummaryRow(data, skipKeys = ['备注', '核对']) {
    if (!data || data.length === 0) return data;
    const summary = { _isSummaryRow: true };
    const firstRow = data[0];

    // 统计各类型的总数，用于生成最终的“汇总”列
    const typeTotals = {};

    Object.keys(firstRow).forEach(key => {
        if (key.startsWith('_')) return;

        // 姓名列保持显示为 /
        if (key === '姓名' || key === '学生姓名' || key === '教师姓名') {
            summary[key] = '/';
        } else if (skipKeys.includes(key)) {
            summary[key] = '/';
        } else if (key === '汇总') {
            // 先占位，后面根据 typeTotals 生成
            summary[key] = '';
        } else {
            let sum = 0;
            let isNumeric = false;
            data.forEach(row => {
                const val = row[key];
                if (val !== undefined && val !== null && val !== '/' && val !== '') {
                    const num = parseFloat(val);
                    if (!isNaN(num)) {
                        sum += num;
                        isNumeric = true;
                    }
                }
            });
            if (isNumeric && sum > 0) {
                summary[key] = sum;
                typeTotals[key] = sum;
            } else {
                summary[key] = '/';
            }
        }
    });

    // 处理特殊的“汇总”列逻辑：按类型进行的汇总字符串
    const details = [];
    Object.keys(typeTotals).forEach(type => {
        details.push(`${typeTotals[type]}次${type}`);
    });
    summary['汇总'] = details.length > 0 ? details.join('、') : '/';

    data.push(summary);
    return data;
}

/**
 * 辅助函数：过滤掉全空的课程类型列
 * @param {Array} data 数据数组
 * @param {Array} columnsToCheck 需要检查的列名
 * @returns {Array} 过滤后的数据
 */
function filterEmptyColumns(data, columnsToCheck = ['试教', '入户', '评审', '集体活动', '咨询']) {
    if (!data || data.length === 0) return data;

    // 检查哪些列确实有有效数据 (排除 summary 行，或检查 summary 行是否为 /)
    const columnsWithData = new Set();
    data.forEach(row => {
        // 如果是汇总行，我们需要看汇总行本身是否有数值（非 /）
        columnsToCheck.forEach(col => {
            const val = row[col];
            // 只要有一个非空值（非 0, 非 /, 非空串），则该列保留
            if (val !== undefined && val !== null && val !== '/' && val !== 0 && val !== '0' && val !== '') {
                columnsWithData.add(col);
            }
        });
    });

    const columnsToRemove = columnsToCheck.filter(col => !columnsWithData.has(col));
    if (columnsToRemove.length === 0) return data;

    return data.map(row => {
        const newRow = { ...row };
        columnsToRemove.forEach(col => delete newRow[col]);
        return newRow;
    });
}

/**
 * 转换导出数据：映射列名，格式化类型和状态
 * @param {Array} originalData 原始数据数组
 * @returns {Array|Object} 转换后的数据数组或多 Sheet 对象
 */
// 生成日历排课表数据
function transformToCalendarData(originalData, startDate, endDate, studentId) {
    if (!startDate || !endDate) return [];

    const formatLocalDate = (d) => {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    // 1. 生成完整日期序列
    const fullDateList = [];
    let curr = new Date(startDate);
    const end = new Date(endDate);
    while (curr <= end) {
        fullDateList.push(formatLocalDate(curr));
        curr.setDate(curr.getDate() + 1);
    }

    // 2. 预处理数据 & 按日期分组
    const dataByDate = {}; // date -> rows
    if (Array.isArray(originalData)) {
        originalData.forEach(row => {
            let dateStr = row.date || row.arr_date || row.class_date || row['日期'] || '';
            if (dateStr) {
                const d = new Date(dateStr);
                if (!isNaN(d.getTime())) {
                    const year = d.getFullYear();
                    const month = String(d.getMonth() + 1).padStart(2, '0');
                    const day = String(d.getDate()).padStart(2, '0');
                    dateStr = `${year}-${month}-${day}`;
                } else if (dateStr.includes('T')) {
                    dateStr = dateStr.split('T')[0];
                }
            }
            if (!dateStr) return;

            if (!dataByDate[dateStr]) dataByDate[dateStr] = [];

            // 解析时间
            let sTime = row.start_time || row.startTime || row.begin_time;
            let eTime = row.end_time || row.endTime || row.finish_time;
            if ((!sTime || !eTime)) {
                const range = row['时间段'] || row.time_range;
                if (range && range.includes('-')) {
                    [sTime, eTime] = range.split('-');
                }
            }
            const fmtMeta = (t) => {
                if (!t) return '';
                const match = String(t).match(/(\d{1,2}:\d{2})/);
                return match ? match[1].padStart(5, '0') : String(t);
            };
            sTime = fmtMeta(sTime);
            eTime = fmtMeta(eTime);
            const timeRange = (sTime && eTime) ? `${sTime} -${eTime} ` : (row['时间段'] || row.time_range || '全天');

            // 解析并汉化类型（保持原始显示，如"（线上）评审"）
            let typeName = row.type || row.type_name || row['类型'] || '';
            const lowerType = String(typeName).toLowerCase();
            if (lowerType === 'review_record' || lowerType === 'review record') typeName = '评审记录';
            else if (lowerType === 'advisory') typeName = '咨询';
            else if (lowerType === 'review') typeName = '评审';
            else if (lowerType === 'review_online' || lowerType === 'online_review') typeName = '（线上）评审';
            else if (lowerType === 'trial') typeName = '试教';
            else if (lowerType === 'visit') typeName = '入户';
            else if (lowerType === 'visit_online' || lowerType === 'online_visit') typeName = '（线上）入户';
            else if (lowerType === 'half_visit' || lowerType === 'half visit') typeName = '半次入户';
            else if (lowerType === 'group' || lowerType === 'group activity' || lowerType === 'group_activity') typeName = '集体活动';

            let groupType = 'normal';
            if (typeName.includes('评审') || typeName.includes('咨询') || typeName.includes('集体')) {
                groupType = 'review_group';
            }

            dataByDate[dateStr].push({
                ...row,
                _parsedDate: dateStr,
                _parsedTimeRange: timeRange,
                _typeName: typeName,
                _groupType: groupType,
                _sTime: sTime // 用于排序
            });
        });
    }

    // 辅助函数：计算ISO周次
    const getISOWeekNumber = (d) => {
        const date = new Date(d.getTime());
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
        const week1 = new Date(date.getFullYear(), 0, 4);
        return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
    };

    // --- 预计算每周与每日的费用聚合 ---
    const weeklyFees = {};
    const dailyFees = {};

    fullDateList.forEach(date => {
        const dayRows = dataByDate[date] || [];
        const isSingleStudent = !!studentId && studentId !== 'all-std';

        // 1. 数据分类与预处理
        const groups = {}; // { sName: { teacherTransports: { tName: number }, otherSum: number } }
        let dailyHasCompletedOrCancelled = false;
        let dailyHasAllCompletedOrCancelled = true; // 默认 true，若有一个不是则为 false
        let dayTotal = 0;

        dayRows.forEach(item => {
            const sName = item.student_name || item['学生名称'] || item.name || '未知学生';
            const tName = item.teacher_name || item.name || item['教师名称'] || '未知老师';
            const tFee = Number(item.transport_fee || item['交通费'] || item._transport_fee || 0);
            const oFee = Number(item.other_fee || item['其他费用'] || item._other_fee || 0);

            const statusVal = String(item.status || item['状态']).toLowerCase();
            const isFin = ['已完成', 'completed', '已取消', 'cancelled', '2', '0'].includes(statusVal);
            if (isFin) {
                dailyHasCompletedOrCancelled = true;
            } else {
                dailyHasAllCompletedOrCancelled = false;
            }

            if (!groups[sName]) {
                groups[sName] = { teacherTransports: {}, otherFees: {}, otherSum: 0 };
            }

            if (!groups[sName].teacherTransports[tName]) {
                groups[sName].teacherTransports[tName] = 0;
                groups[sName].otherFees[tName] = 0;
            }
            groups[sName].teacherTransports[tName] += tFee;
            groups[sName].otherFees[tName] += oFee;
            groups[sName].otherSum += oFee;

            dayTotal += (tFee + oFee);
        });

        // 如果某天没有课程，不能说“全部课程已完成/取消”
        if (dayRows.length === 0) dailyHasAllCompletedOrCancelled = false;

        const formatFee = (val) => {
            const num = Number(val) || 0;
            if (num === 0) return '';
            return String(Math.ceil(num * 100) / 100);
        };

        let dailyFeeStr = '';
        const studentNames = Object.keys(groups);

        if (studentNames.length > 0) {
            const studentPortions = [];

            studentNames.forEach(sName => {
                const g = groups[sName];
                // 获取所有授课老师（不管有没有费用）
                const allTeachers = Object.keys(g.teacherTransports);
                // 获取有交通费用的老师（费用>0）
                const tNamesWithFee = allTeachers.filter(tn => g.teacherTransports[tn] > 0);
                
                // 计算其他费用：每个老师的其他费用用+号连接
                const otherFees = [];
                allTeachers.forEach(tn => {
                    const of = formatFee(g.otherFees[tn]);
                    if (of) otherFees.push(of);
                });
                const otherFeeStr = otherFees.length > 0 ? `其他费用${otherFees.join('+')}` : '';
                
                const p = [];
                // 判断是单老师还是多老师（基于当天所有授课老师数量）
                const isSingleTeacher = allTeachers.length === 1;

                if (isSingleStudent) {
                    // 单学生模式
                    if (isSingleTeacher) {
                        // 单老师（当天只有1个老师授课）：不显示姓名
                        if (tNamesWithFee.length > 0) {
                            const tf = formatFee(g.teacherTransports[tNamesWithFee[0]]);
                            if (tf) p.push(tf);
                        }
                        if (otherFeeStr) p.push(otherFeeStr);
                    } else {
                        // 多老师（当天有多个老师授课）：必须显示姓名
                        // 显示有费用的老师姓名+费用
                        tNamesWithFee.forEach(tn => {
                            const tf = formatFee(g.teacherTransports[tn]);
                            if (tf) p.push(`${tn}${tf}`);
                        });
                        if (otherFeeStr) p.push(otherFeeStr);
                    }
                } else {
                    // 全体学生模式：按学生聚合
                    if (tNamesWithFee.length > 0) {
                        tNamesWithFee.forEach(tn => {
                            const tf = formatFee(g.teacherTransports[tn]);
                            if (tf) p.push(`${tn}${tf}`);
                        });
                    }
                    if (otherFeeStr) p.push(otherFeeStr);
                }

                if (p.length > 0) {
                    if (isSingleStudent) {
                        studentPortions.push(p.join('，'));
                    } else {
                        studentPortions.push(`${sName}：${p.join('，')}`);
                    }
                }
            });

            if (studentPortions.length > 0) {
                dailyFeeStr = studentPortions.join('\n');
            }
        }

        // 需求 1：单学生姓名输出时，如果课程状态全部是已完成或已取消，且费用和为0，则填入“/”
        // 需求 2：全体学生模式下，如果当天的费用和为0且课程状态符合，也填入“/”
        if (dailyHasAllCompletedOrCancelled && dayTotal === 0) {
            dailyFeeStr = '/';
        }
        dailyFees[date] = dailyFeeStr;

        const dObj = new Date(date);
        const weekNumber = getISOWeekNumber(dObj);
        const weekKey = `${dObj.getFullYear()}-W${weekNumber}`;

        if (!weeklyFees[weekKey]) {
            weeklyFees[weekKey] = { total: 0, hasValidStatus: false, studentGroups: {} };
        }

        weeklyFees[weekKey].total += dayTotal;
        if (dailyHasCompletedOrCancelled) weeklyFees[weekKey].hasValidStatus = true;

        studentNames.forEach(sName => {
            const g = groups[sName];
            if (!weeklyFees[weekKey].studentGroups[sName]) weeklyFees[weekKey].studentGroups[sName] = 0;
            weeklyFees[weekKey].studentGroups[sName] += (Object.values(g.teacherTransports).reduce((a, b) => a + b, 0) + g.otherSum);
        });
    });

    // 3. 组装结果 (Row Splitting Logic)
    const resultRows = [];
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const isSingleStudent = !!studentId && studentId !== 'all-std';

    fullDateList.forEach(date => {
        const dObj = new Date(date);
        const weekStr = days[dObj.getDay()];
        const isSunday = dObj.getDay() === 0;
        const weekNumber = getISOWeekNumber(dObj);
        const weekKey = `${dObj.getFullYear()}-W${weekNumber}`;

        const feeStr = dailyFees[date] || '';

        const weekData = weeklyFees[weekKey] || { total: 0, hasValidStatus: false, studentGroups: {} };
        let weekSumStr = '';

        if (isSingleStudent) {
            if (weekData.total > 0) {
                weekSumStr = String(Math.ceil(weekData.total * 100) / 100);
            } else if (weekData.hasValidStatus) {
                weekSumStr = '/';
            }
        } else {
            // 全体学生模式：周汇总按学生展示
            const sNames = Object.keys(weekData.studentGroups).filter(sn => weekData.studentGroups[sn] > 0);
            if (sNames.length > 0) {
                const weekPortions = [];
                sNames.forEach(sn => {
                    const val = weekData.studentGroups[sn];
                    // 最终格式：张三：40
                    weekPortions.push(`${sn}：${Math.ceil(val * 100) / 100}`);
                });
                weekSumStr = weekPortions.join('\n');
            } else if (weekData.hasValidStatus) {
                weekSumStr = '/';
            }
        }

        const dayRows = dataByDate[date] || [];

        // 如果当天无数据，也输出一行占位
        if (dayRows.length === 0) {
            const emptyRow = {
                '日期': date,
                '星期': weekStr,
                '计划安排': '',
                '实际安排': '',
                '费用': feeStr,
                '周汇总': weekSumStr,
                '_isRedRow': false,
                '_isSunday': isSunday,
                '_weekNumber': weekNumber,
                '_isSingleStudent': isSingleStudent
            };
            resultRows.push(emptyRow);
            return;
        }

        // 按时间排序
        dayRows.sort((a, b) => (a._sTime || '').localeCompare(b._sTime || ''));

        const baseRow = {
            '日期': date,
            '星期': weekStr,
            '费用': feeStr,
            '周汇总': weekSumStr,
            '_isRedRow': false,
            '_isSunday': isSunday,
            '_weekNumber': weekNumber,
            '_isSingleStudent': isSingleStudent
        };

        // 分组聚合
        const timeSlots = {};
        dayRows.forEach(item => {
            const key = item._parsedTimeRange;
            if (!timeSlots[key]) timeSlots[key] = { reviewItems: [], normalItems: [] };
            if (item._groupType === 'review_group') timeSlots[key].reviewItems.push(item);
            else timeSlots[key].normalItems.push(item);
        });

        // Flatten Logic: Each event becomes a separate row
        // We will just process them in order and push them.
        // Merging happens in generateExcelFile
        Object.keys(timeSlots).sort().forEach(time => {
            const group = timeSlots[time];
            const allItems = [...group.reviewItems, ...group.normalItems];

            const itemsByStudentAndLoc = {};
            allItems.forEach(item => {
                const sName = item.student_name || item['学生名称'] || item.name || 'Unknown';
                const loc = item.location || item['地点'] || '';
                const key = `${sName}|||${loc}`;
                if (!itemsByStudentAndLoc[key]) itemsByStudentAndLoc[key] = [];
                itemsByStudentAndLoc[key].push(item);
            });

            Object.keys(itemsByStudentAndLoc).forEach(key => {
                const items = itemsByStudentAndLoc[key];
                const [sName, loc] = key.split('|||');

                let allCancelled = true;
                const normalGroups = {};
                const cancelledGroups = {};

                items.forEach(r => {
                    const status = r.status || r['状态'];
                    const isCancelled = (status === 'cancelled' || status === '已取消');
                    if (!isCancelled) allCancelled = false;

                    let typeName = r._typeName;
                    const isRecord = typeName.includes('记录') && (typeName.includes('评审') || typeName.includes('咨询'));
                    const mainType = isRecord ? typeName.replace('记录', '') : typeName;

                    const tid = r.teacher_id || r.id || r['教师ID'] || 0;
                    const tName = r.teacher_name || r.name || r['教师名称'] || '-';
                    const keyId = tid ? tid : tName;

                    const targetGroup = isCancelled ? cancelledGroups : normalGroups;
                    if (!targetGroup[mainType]) {
                        targetGroup[mainType] = { teachers: new Map(), recorders: new Map() };
                    }
                    if (isRecord) {
                        targetGroup[mainType].recorders.set(keyId, { id: tid, name: tName });
                    } else {
                        targetGroup[mainType].teachers.set(keyId, { id: tid, name: tName });
                    }
                });

                const timeStr = time ? `(${time})` : '';

                // 构建分组字符串的辅助函数
                const buildTypeStrings = (groupDict) => {
                    const typeStrings = [];
                    Object.keys(groupDict).forEach(mainType => {
                        const g = groupDict[mainType];
                        const sortedTeachers = Array.from(g.teachers.values()).sort((a, b) => Number(a.id) - Number(b.id));
                        const sortedRecorders = Array.from(g.recorders.values()).sort((a, b) => Number(a.id) - Number(b.id));

                        const detailParts = [];
                        const teachStr = sortedTeachers.map(t => t.name).join('，');
                        if (teachStr) detailParts.push(teachStr);
                        const recStr = sortedRecorders.map(t => `${t.name} (记录)`).join('，');
                        if (recStr) detailParts.push(recStr);

                        const detailContent = detailParts.join('，');
                        if (detailContent) {
                            typeStrings.push(`${mainType}${timeStr}：${detailContent}`);
                        } else {
                            typeStrings.push(`${mainType}${timeStr}`);
                        }
                    });
                    return typeStrings;
                };

                const normalTypeStrings = buildTypeStrings(normalGroups);
                const cancelledTypeStrings = buildTypeStrings(cancelledGroups);

                const shouldShowStudent = !isSingleStudent && sName !== 'Unknown';
                const displayName = sName === 'all-std' ? '全体学生' : sName;
                const prefix = shouldShowStudent ? `[${displayName}]` : '';

                // 将所有计划安排整合显示（包含取消的）
                const planGroups = {};
                items.forEach(r => {
                    let typeName = r._typeName;
                    const isRecord = typeName.includes('记录') && (typeName.includes('评审') || typeName.includes('咨询'));
                    const mainType = isRecord ? typeName.replace('记录', '') : typeName;
                    const tid = r.teacher_id || r.id || r['教师ID'] || 0;
                    const tName = r.teacher_name || r.name || r['教师名称'] || '-';
                    const keyId = tid ? tid : tName;
                    
                    if (!planGroups[mainType]) {
                        planGroups[mainType] = { teachers: new Map(), recorders: new Map() };
                    }
                    if (isRecord) {
                        planGroups[mainType].recorders.set(keyId, { id: tid, name: tName });
                    } else {
                        planGroups[mainType].teachers.set(keyId, { id: tid, name: tName });
                    }
                });
                const allPlanTypeStringsArray = buildTypeStrings(planGroups);
                const planLine = `${prefix}${allPlanTypeStringsArray.join('；')}`;
                
                let isRedRow = false;
                if (planLine.includes('评审') || planLine.includes('咨询')) {
                    isRedRow = true;
                }

                // 分解行输出逻辑
                if (normalTypeStrings.length > 0 && cancelledTypeStrings.length === 0) {
                    // 全是正常课程，单独一行
                    const rowToPush = {
                        '日期': date,
                        '星期': weekStr,
                        '计划安排': planLine,
                        '实际安排': `${prefix}${normalTypeStrings.join('；')}`,
                        '费用': feeStr,
                        '周汇总': weekSumStr,
                        '_isRedRow': isRedRow,
                        '_isSunday': isSunday,
                        '_weekNumber': weekNumber,
                        '_isSingleStudent': isSingleStudent
                    };
                    resultRows.push(rowToPush);
                } else if (normalTypeStrings.length === 0 && cancelledTypeStrings.length > 0) {
                    // 全是取消课程，单独一行，标记日期变动
                    const rowToPush = {
                        '日期': date,
                        '星期': weekStr,
                        '计划安排': planLine,
                        '实际安排': `${prefix}已取消[${cancelledTypeStrings.join('；')}]`,
                        '费用': feeStr,
                        '周汇总': weekSumStr,
                        '_isRedRow': isRedRow,
                        '_isSunday': isSunday,
                        '_weekNumber': weekNumber,
                        '_isSingleStudent': isSingleStudent,
                        '_isModifiedDate': true
                    };
                    resultRows.push(rowToPush);
                } else if (normalTypeStrings.length > 0 && cancelledTypeStrings.length > 0) {
                    // 既有正常也有取消课程，拆分为两行输出
                    // 1. 正常课程行（计划安排只在此行显示，标记日期有变动）
                    const normalRowPush = {
                        '日期': date,
                        '星期': weekStr,
                        '计划安排': planLine,
                        '实际安排': `${prefix}${normalTypeStrings.join('；')}`,
                        '费用': feeStr,
                        '周汇总': weekSumStr,
                        '_isRedRow': isRedRow,
                        '_isSunday': isSunday,
                        '_weekNumber': weekNumber,
                        '_isSingleStudent': isSingleStudent,
                        '_isModifiedDate': true
                    };
                    resultRows.push(normalRowPush);

                    // 2. 取消课程行
                    // 为了合并和显示，日期、星期保持不变，计划安排留空（让上面的一行去显示），也标记日期有变动
                    const cancelledRowPush = {
                        '日期': date,
                        '星期': weekStr,
                        '计划安排': '',
                        '实际安排': `${prefix}已取消[${cancelledTypeStrings.join('；')}]`,
                        '费用': '',
                        '周汇总': '',
                        '_isRedRow': isRedRow,
                        '_isSunday': isSunday,
                        '_weekNumber': weekNumber,
                        '_isSingleStudent': isSingleStudent,
                        '_isModifiedDate': true,
                        '_isSubRowOfMixed': true // 给后面渲染留个记号，避免生成多余边框或跨行合并出错
                    };
                    resultRows.push(cancelledRowPush);
                }
            });
        });
    });

    return resultRows;
}
/**
 * 数据转换处理函数
 * @param {Array} originalData 原始数据
 * @param {string} studentId 学生ID (可选)
 * @param {string} studentName 学生姓名 (可选)
 * @param {string} userType 用户类型 (通过调用方显式传入，默认 undefined)
 */
function transformExportData(originalData, studentId, studentName = '全部学生', passedUserType, passedState, passedExportTypes) {
    // 使用传入的参数，提供默认值避免后续代码报错
    const state = passedState || { startDate: null, endDate: null, selectedType: null };
    const EXPORT_TYPES = passedExportTypes || { TEACHER_SCHEDULE: 'teacher_schedule', STUDENT_SCHEDULE: 'student_schedule' };
    // 如果后端已经返回了多 Sheet 格式（对象且非数组），则直接原样返回（由 generateExcelFile 处理）词词词
    if (originalData && typeof originalData === 'object' && !Array.isArray(originalData)) {
        return originalData;
    }

    if (!Array.isArray(originalData)) return [];

    // 状态映射
    const statusMap = {
        1: '正常',
        0: '已取消',
        2: '已完成',
        'pending': '待确认',
        'confirmed': '已确认',
        'completed': '已完成',
        'cancelled': '已取消'
    };

    // 优先使用传入的 userType，否则尝试从全局获取，最后默认为 'admin'
    const currentUser = window.currentUser || {};
    const userType = passedUserType || currentUser.userType || 'admin';

    // 核心助手：格式化本地日期 (解决时区偏置)
    const formatLocaleDate = (val) => {
        if (!val) return '';
        const d = new Date(val);
        if (isNaN(d.getTime())) return String(val);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    // 获取类型名称的辅助函数
    const getTypeName = (typeIdOrName) => {
        if (!typeIdOrName) return '';
        // 如果是数字ID，尝试查找
        if (window.ScheduleTypesStore) {
            const type = window.ScheduleTypesStore.getById(typeIdOrName);
            if (type) return type.name || type.description;
        }
        return String(typeIdOrName);
    };

    // 转换基础数据（第一张表：排课明细）
    const baseData = originalData.map(row => {
        // 解析日期和时间
        let dateStr = row.date || row.arr_date || row.class_date || row['日期'] || '';
        if (dateStr) {
            dateStr = formatLocaleDate(dateStr);
        }

        // 计算星期
        let weekStr = '';
        if (dateStr) {
            const date = new Date(dateStr);
            if (!isNaN(date.getTime())) {
                const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
                weekStr = days[date.getDay()];
            }
        }

        // 3. 类型: 中文 (英文)
        // 后端返回的 Keys 中包含 '类型' (值为英文 name, e.g. 'visit')
        const rawTypeVal = row['类型'] || row.course_id || row.courseId || row.type || row.schedule_type || row.type_id;
        let typeKey = '';
        let typeDesc = '未知';

        // 尝试从 Store 获取
        if (window.ScheduleTypesStore && typeof window.ScheduleTypesStore.getAll === 'function') {
            const allTypes = window.ScheduleTypesStore.getAll();
            let t = null;

            // 1. 尝试通过 name 匹配 (e.g. rawTypeVal === 'visit')
            t = allTypes.find(item => item.name === rawTypeVal);

            // 2. 如果没找到，尝试通过 ID 匹配
            if (!t) {
                t = allTypes.find(item => String(item.id) === String(rawTypeVal));
            }

            if (t) {
                typeKey = t.name || '';         // e.g. visit, review_online
                typeDesc = t.description || '未知'; // e.g. 入户, （线上）评审
            }
        }

        // 如果 Store 查找失败，但有原始值
        if (typeDesc === '未知' && rawTypeVal) {
            typeKey = String(rawTypeVal);
        }

        // 使用"中文 (英文)"格式显示
        const typeStr = (typeDesc !== '未知' || (typeKey && typeKey !== '0')) ? `${typeDesc} (${typeKey})` : '未知';

        // 4. 时间段 start_time-end_time
        // 后端返回的 Keys 中包含 '时间'，或尝试 start_time
        let timeStr = '';

        // 优先检查 start_time / end_time (以防后端修正后返回这些字段)
        let sTime = row.start_time || row.startTime || row.begin_time;
        let eTime = row.end_time || row.endTime || row.finish_time;

        if (sTime && eTime) {
            const fmt = (t) => {
                if (!t) return '';
                const match = String(t).match(/(\d{1,2}:\d{2})/);
                return match ? match[1].padStart(5, '0') : String(t);
            };
            timeStr = `${fmt(sTime)} -${fmt(eTime)} `;
        } else if (row['时间']) {
            // 如果后端直接返回 '时间' 字段
            timeStr = row['时间'];
        } else if (row['时间段']) {
            // 兼容高级导出中已映射为中文 Key 的 '时间段'
            timeStr = row['时间段'];
        } else if (row.time_range && row.time_range !== 'undefined-undefined') {
            timeStr = row.time_range;
        }

        // 格式化创建时间
        let createdAtStr = row.created_at || row['创建时间'] || '';
        if (createdAtStr) {
            if (String(createdAtStr).includes('-') && String(createdAtStr).includes(':')) {
                // 可能是已经格式化的，不做处理
            } else {
                try {
                    const d = new Date(createdAtStr);
                    if (!isNaN(d.getTime())) {
                        createdAtStr = d.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
                    }
                } catch (e) { }
            }
        }

        const statusVal = row.status || row['状态'];

        return {
            '教师名称': row.teacher_name || row.name || row['教师名称'] || '',
            '学生名称': row.student_name || row['学生名称'] || '',
            '类型': typeStr,
            '日期': dateStr,
            '星期': weekStr,
            '时间段': timeStr,
            '状态': statusMap[statusVal] || statusVal || '未知',
            '创建时间': createdAtStr,
            '排课ID': row.id || row.schedule_id || row['排课ID'] || '',
            '教师ID': row.teacher_id || row['教师ID'] || '',
            '学生ID': row.student_id || row['学生ID'] || '',
            '备注': row.remark || row.notes || row['备注'] || '',
            '_transport_fee': parseFloat(row.transport_fee) || 0,
            '_other_fee': parseFloat(row.other_fee) || 0
        };
    });

    // ============ 管理员/班主任教师角色导出逻辑 (4个工作表深度重构) ============
    if (userType === 'admin' || userType === 'teacher' || userType === 'student') {
        const isTeacher = userType === 'teacher';
        const isStudent = userType === 'student';
        const studentStats = aggregateStudentStats(originalData, state);
        const teacherStats = aggregateTeacherStats(originalData, studentName, state);
        const studentStatsForStudent = isStudent ? aggregateStudentStatsForStudent(originalData, state) : [];
        const calendarData = transformToCalendarData(originalData, state.startDate, state.endDate, studentId);

        // 1. 每日排课明细 (Sheet 1) - 已按要求移除“周汇总”列
        const sheet1Data = calendarData.map(row => {
            const newRow = { ...row };
            if (isStudent) {
                delete newRow['费用'];
                delete newRow['周汇总'];
            }
            return newRow;
        });

        // 2. 工作汇总 (Sheet 2)
        let sheet2Data = [];
        const fz = (v) => (v === 0 || v === '0' || !v) ? '/' : v;
        if (isStudent) {
            // 学生端：按教师分行输出，删除“核对”列，增加汇总行
            sheet2Data = studentStatsForStudent.map(stat => ({
                '教师姓名': stat['教师姓名'],
                '试教': fz(stat['试教']),
                '入户': fz(stat['入户']),
                '评审': fz(stat['评审']),
                '集体活动': fz(stat['集体活动']),
                '咨询': fz(stat['咨询']),
                '汇总': fz(stat['汇总'])
            }));
            appendSummaryRow(sheet2Data, ['备注', '核对']);
        } else if (state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE) {
            if (isTeacher) {
                // 教师端：按学生分行输出，删除"核对"列，增加汇总行
                sheet2Data = teacherStats.map(stat => ({
                    '教师姓名': stat['姓名'],
                    '试教': fz(stat['试教']),
                    '入户': fz(stat['入户']),
                    '评审': fz(stat['评审']),
                    '集体活动': fz(stat['集体活动']),
                    '咨询': fz(stat['咨询']),
                    '汇总': fz(stat['汇总'])
                }));
                appendSummaryRow(sheet2Data, ['备注', '核对']);
            } else {
                // 管理员端导出教师授课记录：增加汇总行
                sheet2Data = teacherStats.map(stat => ({
                    '教师姓名': stat['姓名'],
                    '试教': fz(stat['试教']),
                    '入户': fz(stat['入户']),
                    '评审': fz(stat['评审']),
                    '集体活动': fz(stat['集体活动']),
                    '咨询': fz(stat['咨询']),
                    '汇总': fz(stat['汇总']),
                    '核对': '未核对'
                }));
                appendSummaryRow(sheet2Data);
            }
        } else {
            sheet2Data = studentStats.map(stat => ({
                '学生姓名': stat['姓名'],
                '试教': fz(stat['试教']),
                '入户': fz(stat['入户']),
                '评审': fz(stat['评审']),
                '集体活动': fz(stat['集体活动']),
                '咨询': fz(stat['咨询']),
                '汇总': fz(stat['汇总']),
                '核对': '未核对'
            }));
        }

        // 教师端/学生端：在 Sheet2 的汇总行右侧添加祝福语（无列名）
        if (isTeacher || isStudent) {
            if (sheet2Data.length > 0) {
                const lastRow = sheet2Data[sheet2Data.length - 1];
                const keys = Object.keys(lastRow);
                // 动态获取祝福语文本
                const blessingText = isTeacher ? 'Congratulations！🎉' : 'Good Luck！🎉';
                
                // 查找一个不在原 keys 中的临时键名（不会显示在标题行）
                let hiddenKey = '_blessing_text';
                // 我们在 JSON 转换为 Sheet 时会过滤掉下划线开头的键，
                // 但为了能正常渲染样式，我们暂时使用一个普通键名，并在后续样式处理中特殊处理。
                // 实际上我们可以直接在 generateExcelFile 中通过判断单元格内容来应用样式。
                lastRow['  '] = `    ${blessingText}    `; // 使用空格键名模拟无标题，并增加文本前后间距
            }
        }

        // 管理员端：确保移除任何可能存在的祝福语列
        if (userType === 'admin') {
            sheet2Data = sheet2Data.map(row => {
                const newRow = { ...row };
                delete newRow['祝福语'];
                Object.keys(newRow).forEach(key => {
                    if (key.startsWith('祝福语')) {
                        delete newRow[key];
                    }
                });
                return newRow;
            });
        }

        // 3. 排课原始记录 (Sheet 3 - 21个列精准映射)
        // 预处理：找出同一天有多位老师授课的日期（包含已取消的课程）
        const dateTeacherMap = new Map();
        originalData.forEach(row => {
            const dateStr = formatLocaleDate(row.date || row.class_date || row['日期']);
            const teacherName = row.teacher_name || '';
            if (!dateStr || !teacherName) return;
            
            if (!dateTeacherMap.has(dateStr)) {
                dateTeacherMap.set(dateStr, new Map());
            }
            const teacherMap = dateTeacherMap.get(dateStr);
            if (!teacherMap.has(teacherName)) {
                teacherMap.set(teacherName, []);
            }
            teacherMap.get(teacherName).push(row);
        });
        
        // 标记有多个老师的日期
        const multiTeacherDates = new Set();
        dateTeacherMap.forEach((teacherMap, dateStr) => {
            if (teacherMap.size > 1) {
                multiTeacherDates.add(dateStr);
            }
        });
        
        let sheet3Data = originalData.map(row => {
            const dateStr = formatLocaleDate(row.date || row.class_date || row['日期']);
            const d = new Date(dateStr);
            const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
            // 重要：基于格式化后的 dateStr 重新解析，确保星期同步
            const weekStr = dateStr ? weekDays[new Date(dateStr).getDay()] : '';

            const startTime = row.start_time || '';
            const endTime = row.end_time || '';
            const timeStr = (startTime && endTime) ? `${String(startTime).substring(0, 5)}-${String(endTime).substring(0, 5)}` : '';

            const familyMap = {
                0: '无人', 1: '妈', 2: '爸', 3: '爸妈', 4: '多人',
                10: '学生', 11: '学生+妈', 12: '学生+爸', 13: '学生+爸妈', 14: '学生+多人'
            };

            const statusMap = {
                'pending': '待确认', 'confirmed': '已确认', 'cancelled': '已取消', 'completed': '已完成'
            };

            // 格式化时间函数
            const fmt = (val) => {
                if (!val) return '';
                const date = new Date(val);
                return isNaN(date.getTime()) ? String(val) : date.toLocaleString('zh-CN', { hour12: false });
            };

            // 费用 0 处理：仅已完成(completed/2)、已取消(cancelled/0)状态显示为 /
            const sVal = String(row.status || '').toLowerCase();
            const isFinalStatus = ['completed', '2', 'cancelled', '0'].includes(sVal);

            // 费用处理逻辑优化：改回按单行记录显示。取消原有的 multiTeacherDates 汇总字符串逻辑。
            // 交通费处理
            let tFeeRaw = row.transport_fee !== undefined ? row.transport_fee : (row['交通费'] || '');
            let tFeeStr = '';
            
            if (tFeeRaw === '' || tFeeRaw === null || Number(tFeeRaw) === 0) {
                tFeeStr = '\\'; // 零值或空值显示 \
            } else {
                tFeeStr = String(tFeeRaw);
            }

            // 其他费用处理
            let oFeeRaw = row.other_fee !== undefined ? row.other_fee : (row['其他费用'] || '');
            let oFeeStr = '';
            if (oFeeRaw === '' || oFeeRaw === null || Number(oFeeRaw) === 0) {
                oFeeStr = '\\';
            } else {
                oFeeStr = String(oFeeRaw);
            }

            // 构建有序对象
            return {
                '日期': dateStr,
                '星期': weekStr,
                '教师名称': row.teacher_name || '',
                '学生名称': row.student_name || '',
                '类型': row.type_desc || row.type_name || row['类型'] || '',
                '时间段': timeStr,
                '状态': statusMap[row.status] || row.status || '',
                '上课地点': row.location || '',
                '创建时间': fmt(row.created_at),
                '更新时间': fmt(row.updated_at),
                '课程状态自动更新时间': fmt(row.last_auto_update),
                '排课 ID': row.schedule_id || row.id || '',
                '教师 ID': row.teacher_id || '',
                '学生 ID': row.student_id || '',
                'admin ID': row.created_by || '',
                '家庭参加人员': familyMap[row.family_participants] !== undefined ? familyMap[row.family_participants] : (row.family_participants || ''),
                '教师评分': row.teacher_rating || '',
                '教师评价内容': row.teacher_comment || '',
                '学生评分': row.student_rating || '',
                '学生评价内容': row.student_comment || '',
                '交通费': tFeeStr,
                '其他费用': oFeeStr,
                '备注': ''
            };
        });

        // 学生端移除敏感列
        if (isStudent) {
            sheet3Data = sheet3Data.map(row => {
                const newRow = { ...row };
                delete newRow['学生名称'];
                delete newRow['交通费'];
                delete newRow['其他费用'];
                return newRow;
            });
        }

        // 管理员端：交通费用数据权限控制 - 仅显示当前管理员的交通费用
        if (userType === 'admin' && currentUser.id) {
            const currentAdminId = currentUser.id;
            sheet3Data = sheet3Data.map(row => {
                const newRow = { ...row };
                // 仅当记录的 created_by 与当前管理员ID匹配时才显示交通费，否则显示 "/"
                if (newRow['admin ID'] !== currentAdminId) {
                    newRow['交通费'] = '/';
                }
                return newRow;
            });
        }

        // 管理员端：交通费用格式设置 - 纯数字，保留两位小数，null/空/0 显示 "/"
        if (userType === 'admin') {
            sheet3Data = sheet3Data.map(row => {
                const newRow = { ...row };
                const feeValue = newRow['交通费'];
                // 处理交通费格式：如果是有效数字则保留两位小数，否则显示 "/"
                if (feeValue !== '/' && feeValue !== '' && feeValue !== null && feeValue !== undefined) {
                    const num = parseFloat(feeValue);
                    if (!isNaN(num) && num !== 0) {
                        newRow['交通费'] = Number(num.toFixed(2));
                    } else {
                        newRow['交通费'] = '/';
                    }
                }
                return newRow;
            });
        }

        // 4. 教师授课/学生上课统计 (Sheet 4 - 动态透视结构)
        // 获取全量课程类型列表 (从 Store 获取描述)
        let allTypeConfigs = [];
        if (window.ScheduleTypesStore) {
            allTypeConfigs = window.ScheduleTypesStore.getAll() || [];
        }
        // 按 ID 排序以保证列顺序稳定
        allTypeConfigs.sort((a, b) => Number(a.id) - Number(b.id));

        const typeHeaders = allTypeConfigs.map(t => t.description || t.name);
        const typeIdToHeader = {};
        allTypeConfigs.forEach(t => {
            typeIdToHeader[t.id] = t.description || t.name;
        });

        let dateRangeStr = '';
        if (state.startDate && state.endDate) {
            const s = state.startDate.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
            const e = state.endDate.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
            dateRangeStr = `${s} 至 ${e}`;
        }

        const dynamicStatsMap = new Map();

        originalData.forEach(row => {
            const statusVal = row.status || '';
            if (String(statusVal).toLowerCase() === '已取消' || statusVal === 'cancelled' || statusVal === '0') return;

            let name = '';
            let personId = 999999;
            if (isStudent) {
                name = row.teacher_name || row['教师名称'] || '';
                personId = row.teacher_id || row['教师ID'] || 999999;
            } else if (isTeacher && state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE) {
                // 教师端班主任导出教师授课记录：使用教师视角
                name = row.teacher_name || '';
                personId = row.teacher_id || row.id || row['教师ID'] || 999999;
            } else if (state.selectedType !== EXPORT_TYPES.TEACHER_SCHEDULE) {
                // 非教师授课记录类型，使用学生视角
                name = row.student_name || '';
                personId = row.student_id || row.id || row['学生ID'] || 999999;
            } else {
                name = row.teacher_name || '';
                personId = row.teacher_id || row.id || row['教师ID'] || 999999;
            }

            if (!dynamicStatsMap.has(name)) {
                dynamicStatsMap.set(name, {
                    姓名: name,
                    _id: personId,  // 添加ID字段用于排序
                    types: {},
                    total: 0
                });
            }
            const entry = dynamicStatsMap.get(name);

            // 使用关联 ID 匹配表头，如果匹配不到则使用 type_desc
            const typeId = row.course_id || row.type_id;
            const header = typeIdToHeader[typeId] || row.type_desc || row.type_name || '其他';

            entry.types[header] = (entry.types[header] || 0) + 1;
            entry.total++;
        });

        const statsForRemarks = (state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE) ? teacherStats : (isStudent ? studentStatsForStudent : studentStats);

        // 转换为数组并按ID排序
        const sortedEntries = Array.from(dynamicStatsMap.values())
            .sort((a, b) => Number(a._id) - Number(b._id));

        const sheet4Data = sortedEntries.map(entry => {
            const row = {};
            if (isStudent) {
                row['教师姓名'] = entry.姓名;
            } else if (isTeacher && state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE) {
                // 教师端班主任导出教师授课记录：使用教师视角
                row['教师姓名'] = entry.姓名;
            } else if (state.selectedType !== EXPORT_TYPES.TEACHER_SCHEDULE) {
                row['学生姓名'] = entry.姓名;
            } else {
                row['教师姓名'] = entry.姓名;
            }
            // 2 到 n 列：显示所有课程类型名称
            typeHeaders.forEach(header => {
                const val = entry.types[header] || 0;
                row[header] = val === 0 ? '/' : val;
            });

            // n+1 列：汇总 - 仅基于本工作表内的数据直接汇总计算
            // 格式：1次入户，2次评审
            const parts = [];
            typeHeaders.forEach(header => {
                const count = entry.types[header] || 0;
                if (count > 0) parts.push(`${count}次${header}`);
            });
            let sumStr = parts.join('，');
            row['汇总'] = sumStr || '/';

            // n+2 列：备注 (教师端/学生端要求删除)
            // 仅管理员端显示备注
            if (!isTeacher && !isStudent && state.selectedType !== EXPORT_TYPES.TEACHER_SCHEDULE) {
                row['备注'] = '';
            }
            return row;
        });

        if (isTeacher || isStudent || state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE) {
            appendSummaryRow(sheet4Data, ['备注', '核对']);
        }

        const sheetNames = state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE ?
            ['每日排课明细', '教师授课汇总', '排课原始记录', '教师授课统计'] :
            ['每日排课明细', '学生上课汇总', '排课原始记录', '学生上课统计'];

        if (isStudent) {
            sheetNames[1] = '学习统计';
            sheetNames[3] = '教师统计汇总';
        }

        return {
            [sheetNames[0]]: sheet1Data,
            [sheetNames[1]]: sheet2Data,
            [sheetNames[2]]: sheet3Data,
            [sheetNames[3]]: sheet4Data
        };
    }

    // ============ 教师/学生角色导出逻辑 (保持原有) ============
    if (state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE) {
        const statsData = aggregateTeacherStatsForTeacher(originalData, studentName, state);
        const calendarData = transformToCalendarData(originalData, state.startDate, state.endDate, studentId);
        return {
            '每日排课明细': calendarData,
            '授课统计': statsData,
            '排课原始记录': baseData
        };
    }

    // 如果是学生排课记录导出
    if (state.selectedType === EXPORT_TYPES.STUDENT_SCHEDULE) {
        // 1. 交换第一列和第二列 (学生名称 <-> 教师名称)
        const reorderedBaseData = baseData.map(row => {
            // 创建新对象以保证键的顺序
            return {
                '学生名称': row['学生名称'],
                '教师名称': row['教师名称'],
                ...row // 展开剩余属性，注意：后续同名属性会覆盖前面的，但这里我们主要为了调整前两个 keys 的顺序
            };
            // 上面的写法其实不能保证 Key 的顺序（JS对象的Key是无序的，但在大多数导出库中，可能依赖 Key 添加顺序或者 columns定义）
            // 为了保险起见，我们重新构造对象
            const newRow = {};
            newRow['学生名称'] = row['学生名称'];
            newRow['教师名称'] = row['教师名称'];
            Object.keys(row).forEach(k => {
                if (k !== '学生名称' && k !== '教师名称') {
                    newRow[k] = row[k];
                }
            });
            return newRow;
        });

        // 2. 生成学生统计表
        const statsData = aggregateStudentStats(originalData, state);

        return {
            '总览表': reorderedBaseData,
            '分学生明细表': statsData
        };
    }

    return baseData;
}
/**
 * 聚合学生统计数据 (第二张表)
 * 逻辑：
 * 1. 按学生汇总
 * 2. 入户/评审 去重逻辑：同一日期和时间(start_time)的n个老师授课/评审，当作一次。
 */
function aggregateStudentStats(rawData, state = {}) {
    const statsMap = new Map();

    rawData.forEach(row => {
        // 排除已取消的记录
        const statusVal = row.status || row['状态'] || '';
        const status = String(statusVal).toLowerCase();
        if (status === '0' || status === 'cancelled' || status === '已取消') {
            return;
        }

        const studentName = row.student_name || row['学生名称'] || '未知学生';
        const studentId = row.student_id || row.id || row['学生ID'] || 999999;  // 收集学生ID,默认值为大数字

        if (!statsMap.has(studentName)) {
            statsMap.set(studentName, {
                name: studentName,
                student_id: studentId,  // 添加学生ID字段
                trial: 0,        // 试教
                home_visit: 0,   // 入户
                half_visit: 0,   // 半次入户
                review: 0,       // 评审
                review_record: 0,// 评审记录
                consultation: 0, // 咨询/advisory
                consultation_record: 0, // 咨询记录
                group_activity: 0, // 集体活动
                others: 0,
                dates: new Set() // 用于记录日期范围
            });
        }

        const stat = statsMap.get(studentName);

        // 记录日期
        let dateStr = row.date || row.arr_date || row.class_date || row['日期'] || '';
        if (dateStr && dateStr.includes('T')) dateStr = dateStr.split('T')[0];
        if (dateStr) stat.dates.add(dateStr);

        // 统计类型
        let typeKey = ''; // english key: visit, review, etc.
        const typeVal = row.course_id || row.type || row.schedule_type || row['类型'];

        if (window.ScheduleTypesStore && window.ScheduleTypesStore.getById) {
            const t = window.ScheduleTypesStore.getById(typeVal);
            typeKey = t ? t.name : String(typeVal); // name is usually the english key
        } else {
            // Fallback if store not loaded
            typeKey = String(typeVal || '');
        }

        // 标准化处理：线上类型 → 基础类型 (review_online → review, visit_online → visit)
        typeKey = normalizeTypeKey(typeKey);

        // Strict matching based on schedule_types table (image provided by user)
        if (typeKey === 'visit') stat.home_visit++;
        else if (typeKey === 'half_visit') stat.half_visit++;
        else if (typeKey === 'review') stat.review++;
        else if (typeKey === 'review_record') stat.review_record++;
        else if (typeKey === 'trial') stat.trial++;
        else if (typeKey === 'consultation' || typeKey === 'advisory') stat.consultation++;
        else if (typeKey === 'consultation_record') stat.consultation_record++;
        else if (typeKey === 'group_activity') stat.group_activity++;
        else {
            // Regex fallbacks only if strict match fails
            if (/half_visit/i.test(typeKey)) stat.half_visit++;
            else if (/visit/i.test(typeKey)) stat.home_visit++;
            else if (/review_record/i.test(typeKey)) stat.review_record++;
            else if (/review/i.test(typeKey)) stat.review++;
            else if (/trial/i.test(typeKey)) stat.trial++;
            else if (/consultation|advisory/i.test(typeKey)) stat.consultation++;
            else if (/consultation_record/i.test(typeKey)) stat.consultation_record++;
            else if (/group/i.test(typeKey)) stat.group_activity++;
            else stat.others++;
        }
    });

    const result = [];
    // 转换 Map 为数组并可以计算衍生字段
    statsMap.forEach(stat => {
        // 计算日期范围字符串
        let dateRangeStr = '';
        if (state.startDate && state.endDate) {
            const s = state.startDate.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
            const e = state.endDate.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
            dateRangeStr = `${s}至${e} `;
        } else {
            const sortedDates = Array.from(stat.dates).sort();
            if (sortedDates.length > 0) {
                dateRangeStr = sortedDates.length === 1 ? sortedDates[0] : `${sortedDates[0]}至${sortedDates[sortedDates.length - 1]} `;
            }
        }

        // ============ 核心计算逻辑修正 (合并公式) ============
        // 1. 入户 = 线下入户 + 线上入户 + 0.5 * 半次入户 + 0.5 * 评审记录 + 0.5 * 咨询记录
        const finalVisit = stat.home_visit + (stat.half_visit * 0.5) + (stat.review_record * 0.5) + (stat.consultation_record * 0.5);

        // 2. 评审 = 线下评审 + 线上评审 + 1.0 * 评审记录
        const finalReview = stat.review + stat.review_record;

        // 3. 咨询 = 线下咨询 + 线上咨询 + 1.0 * 咨询记录
        const finalConsult = stat.consultation + stat.consultation_record;

        // 4. 试教 / 集体活动
        const finalTrial = stat.trial;
        const finalGroup = stat.group_activity;

        let cleanDateRange = dateRangeStr.trim().replace('至', ' 至 ');

        const details = [];
        if (finalTrial > 0) details.push(`${finalTrial}次试教`);
        if (finalVisit > 0) details.push(`${finalVisit}次入户`);
        if (finalReview > 0) details.push(`${finalReview}次评审`);
        if (finalGroup > 0) details.push(`${finalGroup}次集体活动`);
        if (finalConsult > 0) details.push(`${finalConsult}次咨询`);

        const detailsStr = details.length > 0 ? details.join('、') : '无';

        let teacherText = state.teacherName || '所有老师';
        const remarks = `${stat.name}同学好！${cleanDateRange} 期间，您在[${teacherText}]处入户等相关数据为 ：${detailsStr}。请问是否正确？`;

        result.push({
            '姓名': stat.name,
            '_student_id': stat.student_id,  // 内部字段用于排序
            '试教': finalTrial,
            '入户': finalVisit,
            '评审': finalReview,
            '集体活动': finalGroup,
            '咨询': finalConsult,
            '汇总': detailsStr,
            '核对': '确定', // 默认为确定，管理员可手动微调
            '备注': remarks
        });
    });

    // 按学生ID从小到大排序
    result.sort((a, b) => Number(a._student_id) - Number(b._student_id));

    return result;
}
/**
 * 聚合老师统计数据 (第二张表)
 * @param {Array} rawData 原始数据
 * @param {string} studentName 学生名称（用于备注）
 */
function aggregateTeacherStats(rawData, studentName = '全部学生', state = {}) {
    const statsMap = new Map();

    rawData.forEach(row => {
        // 排除已取消的记录
        const statusVal = row.status || row['状态'] || '';
        const status = String(statusVal).toLowerCase();
        if (status === '0' || status === 'cancelled' || status === '已取消') {
            return;
        }

        const teacherName = row.teacher_name || row.name || row['教师名称'] || '未知老师';
        const teacherId = row.teacher_id || row.id || row['教师ID'] || 999999;  // 收集教师ID,默认值为大数字

        if (!statsMap.has(teacherName)) {
            statsMap.set(teacherName, {
                name: teacherName,
                teacher_id: teacherId,  // 添加教师ID字段
                trial: 0,        // 试教
                home_visit: 0,   // 入户
                half_visit: 0,   // 半次入户
                review: 0,       // 评审
                review_record: 0,// 评审记录
                consultation: 0, // 咨询/advisory
                consultation_record: 0, // 咨询记录
                group_activity: 0, // 集体活动
                others: 0,
                dates: new Set() // 用于记录日期范围
            });
        }

        const stat = statsMap.get(teacherName);

        // 记录日期
        let dateStr = row.date || row.arr_date || row.class_date || row['日期'] || '';
        if (dateStr && dateStr.includes('T')) dateStr = dateStr.split('T')[0];
        if (dateStr) stat.dates.add(dateStr);

        // 统计类型
        let typeKey = ''; // english key: visit, review, etc.
        // let typeName = ''; // localized name

        const typeVal = row.course_id || row.type || row.schedule_type || row['类型'];

        if (window.ScheduleTypesStore && window.ScheduleTypesStore.getById) {
            const t = window.ScheduleTypesStore.getById(typeVal);
            typeKey = t ? t.name : String(typeVal); // name is usually the english key
        } else {
            // Fallback if store not loaded
            typeKey = String(typeVal || '');
        }

        // 标准化处理：线上类型 → 基础类型 (review_online → review, visit_online → visit)
        typeKey = normalizeTypeKey(typeKey);

        // Strict matching based on schedule_types table (image provided by user)
        if (typeKey === 'visit') stat.home_visit++;
        else if (typeKey === 'half_visit') stat.half_visit++;
        else if (typeKey === 'review') stat.review++;
        else if (typeKey === 'review_record') stat.review_record++;
        else if (typeKey === 'trial') stat.trial++;
        else if (typeKey === 'consultation' || typeKey === 'advisory') stat.consultation++;
        else if (typeKey === 'consultation_record') stat.consultation_record++;
        else if (typeKey === 'group_activity') stat.group_activity++;
        else {
            // Regex fallbacks only if strict match fails
            if (/half_visit/i.test(typeKey)) stat.half_visit++;
            else if (/visit/i.test(typeKey)) stat.home_visit++;
            else if (/review_record/i.test(typeKey)) stat.review_record++;
            else if (/review/i.test(typeKey)) stat.review++;
            else if (/trial/i.test(typeKey)) stat.trial++;
            else if (/consultation|advisory/i.test(typeKey)) stat.consultation++;
            else if (/consultation_record/i.test(typeKey)) stat.consultation_record++;
            else if (/group/i.test(typeKey)) stat.group_activity++;
            else stat.others++;
        }
    });

    const result = [];
    // 转换 Map 为数组并可以计算衍生字段
    statsMap.forEach(stat => {
        // 计算日期范围字符串
        let dateRangeStr = '';
        if (state.startDate && state.endDate) {
            const s = state.startDate.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
            const e = state.endDate.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
            dateRangeStr = `${s}至${e} `;
        } else {
            const sortedDates = Array.from(stat.dates).sort();
            if (sortedDates.length > 0) {
                dateRangeStr = sortedDates.length === 1 ? sortedDates[0] : `${sortedDates[0]}至${sortedDates[sortedDates.length - 1]} `;
            }
        }

        // ============ 核心计算逻辑修正 (合并公式) ============
        // 1. 入户 = 线下入户 + 线上入户 + 0.5 * 半次入户 + 0.5 * 评审记录 + 0.5 * 咨询记录
        const finalVisit = stat.home_visit + (stat.half_visit * 0.5) + (stat.review_record * 0.5) + (stat.consultation_record * 0.5);

        // 2. 评审 = 线下评审 + 线上评审 + 1.0 * 评审记录
        const finalReview = stat.review + stat.review_record;

        // 3. 咨询 = 线下咨询 + 线上咨询 + 1.0 * 咨询记录
        const finalConsult = stat.consultation + stat.consultation_record;

        // 4. 试教 / 集体活动
        const finalTrial = stat.trial;
        const finalGroup = stat.group_activity;

        let cleanDateRange = dateRangeStr.trim().replace('至', ' 至 ');

        const details = [];
        if (finalTrial > 0) details.push(`${finalTrial}次试教`);
        if (finalVisit > 0) details.push(`${finalVisit}次入户`);
        if (finalReview > 0) details.push(`${finalReview}次评审`);
        if (finalGroup > 0) details.push(`${finalGroup}次集体活动`);
        if (finalConsult > 0) details.push(`${finalConsult}次咨询`);

        const detailsStr = details.length > 0 ? details.join('、') : '无';
        const remarks = `${stat.name}老师好！${cleanDateRange} 期间，在[${studentName}]处入户相关数据为 ：${detailsStr}。请问是否正确？`;

        result.push({
            '姓名': stat.name,
            '_teacher_id': stat.teacher_id,  // 内部字段用于排序
            '试教': finalTrial,
            '入户': finalVisit,
            '评审': finalReview,
            '集体活动': finalGroup,
            '咨询': finalConsult,
            '汇总': detailsStr,
            '核对': '确定', // 默认为确定，管理员可手动微调
            '备注': remarks
        });
    });

    // 按教师ID从小到大排序
    result.sort((a, b) => Number(a._teacher_id) - Number(b._teacher_id));

    return result;
}
/**
 * 教师端导出专用：聚合学生统计数据 (授课统计表)
 * 列名称：学生姓名，入户，试教，评审，评审记录，半次入户，集体活动，咨询，(线上)评审，(线上)入户，(线上)咨询，咨询记录，汇总，备注
 * @param {Array} rawData 原始数据
 * @param {string} teacherName 教师名称（用于备注）
 */
function aggregateTeacherStatsForTeacher(rawData, teacherName = '全部学生', state = {}) {
    const statsMap = new Map();

    rawData.forEach(row => {
        const statusVal = row.status || row['状态'] || '';
        const status = String(statusVal).toLowerCase();
        if (status === '0' || status === 'cancelled' || status === '已取消') {
            return;
        }

        const studentName = row.student_name || row['学生名称'] || '未知学生';
        const studentId = row.student_id || row['学生ID'] || 999999;

        if (!statsMap.has(studentName)) {
            statsMap.set(studentName, {
                name: studentName,
                student_id: studentId,
                home_visit: 0,
                trial: 0,
                review: 0,
                review_record: 0,
                half_visit: 0,
                group_activity: 0,
                consultation: 0,
                review_online: 0,
                visit_online: 0,
                consultation_online: 0,
                consultation_record: 0,
                dates: new Set()
            });
        }

        const stat = statsMap.get(studentName);

        let dateStr = row.date || row.arr_date || row.class_date || row['日期'] || '';
        if (dateStr && dateStr.includes('T')) dateStr = dateStr.split('T')[0];
        if (dateStr) stat.dates.add(dateStr);

        let typeKey = '';
        const typeVal = row.course_id || row.type || row.schedule_type || row['类型'];

        if (window.ScheduleTypesStore && window.ScheduleTypesStore.getById) {
            const t = window.ScheduleTypesStore.getById(typeVal);
            typeKey = t ? t.name : String(typeVal);
        } else {
            typeKey = String(typeVal || '');
        }

        const lower = String(typeKey).toLowerCase().trim();

        // 统一合并逻辑
        if (lower === 'visit' || lower === 'visit_online' || lower === 'online_visit') stat.home_visit++;
        else if (lower === 'half_visit' || /half_visit/i.test(typeKey)) stat.half_visit++;
        else if (lower === 'review' || lower === 'review_online' || lower === 'online_review') stat.review++;
        else if (lower === 'trial' || /trial/i.test(typeKey)) stat.trial++;
        else if (lower === 'consultation' || lower === 'advisory' || lower === 'consultation_online' || lower === 'online_consultation') stat.consultation++;
        else if (lower === 'group_activity' || /group/i.test(typeKey)) stat.group_activity++;
        else if (lower === 'review_record' || /review_record/i.test(typeKey)) stat.review_record++;
        else if (lower === 'consultation_record' || /consultation_record/i.test(typeKey)) stat.consultation_record++;
    });

    const result = [];
    statsMap.forEach(stat => {
        let dateRangeStr = '';
        if (state.startDate && state.endDate) {
            const s = formatLocalDateString(state.startDate);
            const e = formatLocalDateString(state.endDate);
            dateRangeStr = `${s}至${e}`;
        } else {
            const sortedDates = Array.from(stat.dates).sort();
            if (sortedDates.length > 0) {
                dateRangeStr = sortedDates.length === 1 ? sortedDates[0] : `${sortedDates[0]}至${sortedDates[sortedDates.length - 1]}`;
            }
        }

        // 计算逻辑 (合并公式)：
        // 1. 入户 = 线下入户 + 线上入户 + 0.5 * 半次入户 + 0.5 * 评审记录 + 0.5 * 咨询记录
        const finalVisit = stat.home_visit + (stat.half_visit * 0.5) + (stat.review_record * 0.5) + (stat.consultation_record * 0.5);

        // 2. 评审 = 线下评审 + 线上评审 + 1.0 * 评审记录
        const finalReview = stat.review + stat.review_record;

        // 3. 咨询 = 线下咨询 + 线上咨询 + 1.0 * 咨询记录
        const finalConsult = stat.consultation + stat.consultation_record;

        // 4. 试教 / 集体活动
        const finalTrial = stat.trial;
        const finalGroup = stat.group_activity;

        const details = [];
        if (finalTrial > 0) details.push(`${finalTrial}次试教`);
        if (finalVisit > 0) details.push(`${finalVisit}次入户`);
        if (finalReview > 0) details.push(`${finalReview}次评审`);
        if (finalGroup > 0) details.push(`${finalGroup}次集体活动`);
        if (finalConsult > 0) details.push(`${finalConsult}次咨询`);

        const summaryStr = details.join('、') || '/';

        const fz = (v) => (v === 0 || v === '0' || !v) ? '/' : v;

        result.push({
            '学生姓名': stat.name,
            '_student_id': stat.student_id,
            '试教': fz(finalTrial),
            '入户': fz(finalVisit),
            '评审': fz(finalReview),
            '集体活动': fz(finalGroup),
            '咨询': fz(finalConsult),
            '汇总': summaryStr,
            '备注': ''
        });
    });

    result.sort((a, b) => Number(a._student_id) - Number(b._student_id));
    return result;
}

/**
 * 聚合学生统计 (学生视角，按教师分组) - 供生成高级导出文件使用
 */
function aggregateStudentStatsForStudent(rawData, state = {}) {
    const statsMap = new Map();

    rawData.forEach(row => {
        const statusVal = row.status || row['状态'] || '';
        const status = String(statusVal).toLowerCase();
        if (status === '0' || status === 'cancelled' || status === '已取消') {
            return;
        }

        const teacherName = row.teacher_name || row['教师名称'] || row['教师姓名'] || '未知教师';
        const teacherId = row.teacher_id || row['教师ID'] || 999999;

        if (!statsMap.has(teacherName)) {
            statsMap.set(teacherName, {
                name: teacherName,
                teacher_id: teacherId,
                home_visit: 0,
                trial: 0,
                review: 0,
                review_record: 0,
                half_visit: 0,
                group_activity: 0,
                consultation: 0,
                consultation_record: 0,
                dates: new Set()
            });
        }

        const stat = statsMap.get(teacherName);

        let dateStr = row.date || row.arr_date || row.class_date || row['日期'] || '';
        if (dateStr && dateStr.includes('T')) dateStr = dateStr.split('T')[0];
        if (dateStr) stat.dates.add(dateStr);

        let typeKey = '';
        const typeVal = row.course_id || row.type || row.schedule_type || row['类型'];

        if (window.ScheduleTypesStore && window.ScheduleTypesStore.getById) {
            const t = window.ScheduleTypesStore.getById(typeVal);
            typeKey = t ? t.name : String(typeVal);
        } else {
            typeKey = String(typeVal || '');
        }

        const lower = String(typeKey).toLowerCase().trim();

        // 统一合并逻辑
        if (lower === 'visit' || lower === 'visit_online' || lower === 'online_visit') stat.home_visit++;
        else if (lower === 'half_visit' || /half_visit/i.test(typeKey)) stat.half_visit++;
        else if (lower === 'review' || lower === 'review_online' || lower === 'online_review') stat.review++;
        else if (lower === 'trial' || /trial/i.test(typeKey)) stat.trial++;
        else if (lower === 'consultation' || lower === 'advisory' || lower === 'consultation_online' || lower === 'online_consultation') stat.consultation++;
        else if (lower === 'group_activity' || /group/i.test(typeKey)) stat.group_activity++;
        else if (lower === 'review_record' || /review_record/i.test(typeKey)) stat.review_record++;
        else if (lower === 'consultation_record' || /consultation_record/i.test(typeKey)) stat.consultation_record++;
    });

    const result = [];
    statsMap.forEach(stat => {
        // 计算逻辑 (合并公式)：
        // 1. 入户 = 线下入户 + 线上入户 + 0.5 * 半次入户 + 0.5 * 评审记录 + 0.5 * 咨询记录
        const finalVisit = stat.home_visit + (stat.half_visit * 0.5) + (stat.review_record * 0.5) + (stat.consultation_record * 0.5);

        // 2. 评审 = 线下评审 + 线上评审 + 1.0 * 评审记录
        const finalReview = stat.review + stat.review_record;

        // 3. 咨询 = 线下咨询 + 线上咨询 + 1.0 * 咨询记录
        const finalConsult = stat.consultation + stat.consultation_record;

        // 4. 试教 / 集体活动
        const finalTrial = stat.trial;
        const finalGroup = stat.group_activity;

        const details = [];
        if (finalTrial > 0) details.push(`${finalTrial}次试教`);
        if (finalVisit > 0) details.push(`${finalVisit}次入户`);
        if (finalReview > 0) details.push(`${finalReview}次评审`);
        if (finalGroup > 0) details.push(`${finalGroup}次集体活动`);
        if (finalConsult > 0) details.push(`${finalConsult}次咨询`);

        const summaryStr = details.join('、') || '/';
        const fz = (v) => (v === 0 || v === '0' || !v) ? '/' : v;

        result.push({
            '教师姓名': stat.name,
            '_teacher_id': stat.teacher_id,
            '试教': fz(finalTrial),
            '入户': fz(finalVisit),
            '评审': fz(finalReview),
            '集体活动': fz(finalGroup),
            '咨询': fz(finalConsult),
            '汇总': summaryStr
        });
    });

    result.sort((a, b) => Number(a._teacher_id) - Number(b._teacher_id));
    return result;
}
function formatLocalDateString(date) {
    if (!date) return '';
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return String(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
/**
 * 生成 Excel 文件
 * @param {Object|Array} exportData - 导出数据 (支持 { sheetName: [], ... } 多 Sheet 结构)
 * @param {string} filename - 文件名 (可选)
 */
async function generateExcelFile(exportData, filename, userType) {
    // 确保 XLSX 库已加载
    if (typeof XLSX === 'undefined') {
        await loadXLSXLibrary();
    }

    const wb = XLSX.utils.book_new();

    // 统一处理成 { SheetName: DataArray } 格式
    let sheets = {};
    if (Array.isArray(exportData)) {
        sheets['数据'] = exportData;
    } else if (exportData && typeof exportData === 'object' && !exportData.data) {
        sheets = exportData;
    } else if (exportData && typeof exportData === 'object' && exportData.data) {
        const innerData = exportData.data;
        if (Array.isArray(innerData) && innerData.length > 0) {
            sheets['数据'] = innerData;
        } else if (Array.isArray(innerData) && innerData.length === 0) {
            sheets['数据'] = [];
        } else if (typeof innerData === 'object' && !Array.isArray(innerData)) {
            sheets = innerData;
        } else {
            sheets['数据'] = [];
        }
    } else {
        sheets['数据'] = [];
    }

    let hasData = false;

    // 助手函数：解析 <b> 标签并返回 ExcelJS RichText 数组
    const parseRichText = (str) => {
        if (typeof str !== 'string' || !str.includes('<b>')) return str;
        const parts = [];
        const regex = /<b>(.*?)<\/b>/g;
        let lastIndex = 0;
        let match;
        while ((match = regex.exec(str)) !== null) {
            if (match.index > lastIndex) {
                parts.push({ text: str.substring(lastIndex, match.index) });
            }
            parts.push({ text: match[1], font: { bold: true, name: '宋体', sz: 11 } });
            lastIndex = regex.lastIndex;
        }
        if (lastIndex < str.length) {
            parts.push({ text: str.substring(lastIndex) });
        }
        return { richText: parts };
    };

    Object.keys(sheets).forEach((sheetName, sheetIndex) => {
        const rawDataList = sheets[sheetName];
        if (Array.isArray(rawDataList) && rawDataList.length > 0) {
            // Remove internal flags before converting to sheet
            const cleanData = rawDataList.map(row => {
                const newRow = { ...row };
                delete newRow._isRedRow;
                delete newRow._sTime;
                delete newRow._parsedDate;
                delete newRow._parsedTimeRange;
                delete newRow._typeName;
                delete newRow._groupType;
                delete newRow._isSunday;
                delete newRow._weekNumber;
                delete newRow._isSingleStudent;
                delete newRow._student_id;
                delete newRow._teacher_id;
                delete newRow._isSummaryRow;
                delete newRow._isModifiedDate;
                delete newRow._isSubRowOfMixed;
                return newRow;
            });

            const ws = XLSX.utils.json_to_sheet(cleanData);

            // --- 1. 计算列宽 ---
            const colWidths = [];
            const headers = Object.keys(cleanData[0]);

            // 预设宽度
            const minWidths = {
                '时间段': 15,
                '备注': 30,
                '创建时间': 20,
                '日期': 12,
                '类型': 15,
                '星期': 6
            };

            headers.forEach((key, i) => {
                let maxLength = minWidths[key] || 10;
                const sampleSize = Math.min(cleanData.length, 50);
                for (let r = 0; r < sampleSize; r++) {
                    const val = cleanData[r][key];
                    if (val) {
                        const strVal = String(val);
                        // 针对多行内容，按最长的一行计算宽度
                        const lines = strVal.split('\n');
                        lines.forEach(line => {
                            let len = 0;
                            for (let k = 0; k < line.length; k++) {
                                len += (line.charCodeAt(k) > 255 ? 2 : 1);
                            }
                            if (len > maxLength) maxLength = len;
                        });
                    }
                }
                if (key === '星期') {
                    colWidths[i] = { wch: 8 }; // 放宽列宽以防拥挤
                } else {
                    let wch = maxLength + 2;
                    // 1. 基础财务列缩放 (针对 Sheet 2/3/4 的基础比例)
                    if (sheetIndex !== 0) {
                        if (key === '费用') wch *= 0.5;
                        else if (key === '周汇总' || key === '汇总') wch *= 0.45;
                    }

                    // 2. 精细化调整 (满足用户对 Sheet 1 的空隙和对齐需求)
                    if (sheetIndex === 0) {
                        // 移除固定倍率，改用“最大长度 + 适当留白”的自适应策略
                        // 用户要求周汇总列宽比费用列更小一些：周汇总 +4, 费用 +8
                        const gap = (key === '周汇总') ? 4 : 8;
                        wch = Math.max(maxLength + gap, 15);
                    } else if (key === '  ') {
                        // 祝福语列：使用 Apple Chancery 艺术字体，笔锋较长，需要极宽间距以确保单行完整
                        // 尤其在不换行模式下，给予 +25 的强力补偿
                        wch = maxLength + 25;
                    } else if ((sheetIndex === 1 || sheetIndex === 3) && key === '汇总') {
                        wch *= 2.24; 
                    } else if (sheetIndex === 3 && key === '备注') {
                        wch *= 1.86;
                    }

                    colWidths[i] = { wch: Math.min(Math.max(wch, 10), 80) };
                }
            });
            ws['!cols'] = colWidths;

            // --- 2. 冻结所有工作表的首行 (增强版兼容性) ---
            // 同时应用两种标准，确保在微软 Office 和 WPS 中均生效
            ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
            ws['!views'] = [{
                state: 'frozen',
                xSplit: 0,
                ySplit: 1,
                topLeftCell: 'A2',
                activePane: 'bottomLeft',
                sel: 'A2'
            }];

            // --- 3. 合并单元格 (Merge Logic for Sheet 0) ---
            if (sheetIndex === 0) {
                if (!ws['!merges']) ws['!merges'] = [];
                // We need to find consecutive rows with same Date/Week
                // rawDataList matches cleanData index 1:1

                let dateStartRow = 1; // 0 is header, data starts at 1
                let weekStartRow = 1;

                // Column Indices for Date and Week
                const dateColIdx = headers.indexOf('日期');
                const weekColIdx = headers.indexOf('星期');

                if (dateColIdx !== -1 && weekColIdx !== -1) {
                    for (let i = 1; i < rawDataList.length; i++) {
                        const prev = rawDataList[i - 1];
                        const curr = rawDataList[i];
                        const currentRowIdx = i + 1; // logical row index in Excel (0-based)

                        // Check Date Change
                        if (curr['日期'] !== prev['日期']) {
                            // Merge previous block if > 1 row
                            if ((i) - dateStartRow > 0) {
                                ws['!merges'].push({ s: { r: dateStartRow, c: dateColIdx }, e: { r: i, c: dateColIdx } });
                                ws['!merges'].push({ s: { r: dateStartRow, c: weekColIdx }, e: { r: i, c: weekColIdx } });
                            }
                            dateStartRow = currentRowIdx;
                        }
                    }
                    // Merge last block
                    if (rawDataList.length - dateStartRow > 0) {
                        ws['!merges'].push({ s: { r: dateStartRow, c: dateColIdx }, e: { r: rawDataList.length, c: dateColIdx } });
                        ws['!merges'].push({ s: { r: dateStartRow, c: weekColIdx }, e: { r: rawDataList.length, c: weekColIdx } });
                    }
                }

                // --- 费用列与周汇总列合并（按日期和周次）---
                const feeColIdx = headers.indexOf('费用');
                const weekSumColIdx = headers.indexOf('周汇总');

                // 费用列按“日期”合并 (无论是否单选学生)
                if (feeColIdx !== -1) {
                    let feeStartRow = 1;
                    for (let i = 1; i < rawDataList.length; i++) {
                        const prev = rawDataList[i - 1];
                        const curr = rawDataList[i];
                        const currentRowIdx = i + 1;
                        if (curr['日期'] !== prev['日期']) {
                            if ((i) - feeStartRow > 0) {
                                ws['!merges'].push({ s: { r: feeStartRow, c: feeColIdx }, e: { r: i, c: feeColIdx } });
                            }
                            feeStartRow = currentRowIdx;
                        }
                    }
                    if (rawDataList.length - feeStartRow > 0) {
                        ws['!merges'].push({ s: { r: feeStartRow, c: feeColIdx }, e: { r: rawDataList.length, c: feeColIdx } });
                    }
                }

                // 周汇总列按“周次”合并 (无论是否单选学生)
                if (weekSumColIdx !== -1) {
                    let weekStartRow = 1;
                    for (let i = 1; i < rawDataList.length; i++) {
                        const prev = rawDataList[i - 1];
                        const curr = rawDataList[i];
                        const currentRowIdx = i + 1;
                        if (curr._weekNumber !== prev._weekNumber) {
                            if ((i) - weekStartRow > 0) {
                                ws['!merges'].push({ s: { r: weekStartRow, c: weekSumColIdx }, e: { r: i, c: weekSumColIdx } });
                            }
                            weekStartRow = currentRowIdx;
                        }
                    }
                    if (rawDataList.length - weekStartRow > 0) {
                        ws['!merges'].push({ s: { r: weekStartRow, c: weekSumColIdx }, e: { r: rawDataList.length, c: weekSumColIdx } });
                    }
                }

                // --- 计划安排列合并（对于因为包含取消课程而被拆分的行） ---
                const planColIdx = headers.indexOf('计划安排');
                if (planColIdx !== -1) {
                    for (let i = 1; i < rawDataList.length; i++) {
                        const curr = rawDataList[i];
                        if (curr._isSubRowOfMixed) {
                            ws['!merges'].push({ s: { r: i, c: planColIdx }, e: { r: i + 1, c: planColIdx } });
                        }
                    }
                }
            }

            // --- 4. 应用样式 ---
            const range = XLSX.utils.decode_range(ws['!ref']);
            // Helper: Check if string is English/Num
            const isEnglishOrNum = (str) => /^[\x00-\x7F]*$/.test(String(str));

            for (let R = range.s.r; R <= range.e.r; ++R) {
                // Check flags from raw data (R-1 because R=0 is header)
                const dataRow = (R > 0) ? rawDataList[R - 1] : null;
                const isRedRow = dataRow ? dataRow._isRedRow : false;
                const isSunday = dataRow ? (dataRow['星期'] === '周日') : false;
                const isSummaryRow = dataRow ? dataRow._isSummaryRow : false;
                
                // 判断当前行是否包含已被取消的内容
                let isCancelledRow = false;
                if (dataRow) {
                    if (dataRow['实际安排'] && String(dataRow['实际安排']).includes('已取消')) {
                        isCancelledRow = true;
                    } else if (dataRow['状态'] && (String(dataRow['状态']).includes('已取消') || String(dataRow['状态']).toLowerCase() === 'cancelled')) {
                        isCancelledRow = true;
                    }
                }

                for (let C = range.s.c; C <= range.e.c; ++C) {
                    const cellAddress = XLSX.utils.encode_cell({ c: C, r: R });
                    // Ensure cell exists even if empty (essential for merged cells styling)
                    if (!ws[cellAddress]) {
                        // Only recreate if it's within data range (might be needed for borders on merged cells)
                        // For simple usage, we only style existing cells usually, 
                        // but merged cells usually only keep top-left content. Use top-left for style?
                        // XLSX-style library handles border on merged cells often by applying to top-left.
                        continue;
                    }

                    const cell = ws[cellAddress];
                    const value = cell.v || '';
                    const strValue = String(value);

                    // Base Style
                    cell.s = {
                        font: { name: '宋体', sz: 11 },
                        alignment: { vertical: 'center', wrapText: true, horizontal: 'center' },
                        border: {
                            top: { style: 'thin', color: { rgb: "D4D4D4" } },
                            bottom: { style: 'thin', color: { rgb: "D4D4D4" } },
                            left: { style: 'thin', color: { rgb: "D4D4D4" } },
                            right: { style: 'thin', color: { rgb: "D4D4D4" } }
                        }
                    };

                    if (isEnglishOrNum(value)) {
                        cell.s.font.name = 'Times New Roman';
                    }
                    
                    if (isCancelledRow) {
                        // 获取当前列的表头来判断是否是费用列
                        const cancelHeaderRef = XLSX.utils.encode_cell({ c: C, r: 0 });
                        const cancelHeaderCell = ws[cancelHeaderRef];
                        const cancelHeaderVal = cancelHeaderCell ? String(cancelHeaderCell.v) : '';
                        
                        // 费用列不使用斜体，保持正常字体
                        if (cancelHeaderVal !== '费用') {
                            cell.s.font.italic = true;
                        }
                    }

                    // 如果该行有特殊的日期变动标记，且当前列为“日期”或“星期”，则设为斜体
                    if (dataRow && dataRow._isModifiedDate) {
                        const headerRef = XLSX.utils.encode_cell({ c: C, r: 0 });
                        const headerCell = ws[headerRef];
                        const headerVal = headerCell ? String(headerCell.v) : '';
                        if (headerVal === '日期' || headerVal === '星期') {
                            cell.s.font.italic = true;
                        }
                    }

                    // --- 汇总行样式重构 (根据新需求) ---
                    if (isSummaryRow) {
                        const headerRef = XLSX.utils.encode_cell({ c: C, r: 0 });
                        const headerCell = ws[headerRef];
                        const headerVal = headerCell ? String(headerCell.v) : '';

                        if (headerVal === '汇总') {
                            // 汇总行与汇总列相交的单元格：增加边框 (宽度降低50% 即改为 thin)
                            cell.s.font.bold = true;
                            cell.s.border = {
                                top: { style: 'thin', color: { rgb: "000000" } },
                                bottom: { style: 'thin', color: { rgb: "000000" } },
                                left: { style: 'thin', color: { rgb: "000000" } },
                                right: { style: 'thin', color: { rgb: "000000" } }
                            };

                            // 仅在第2个工作表(sheetIndex === 1)的汇总行写入祝福语（非管理员）
                            if (sheetIndex === 1 && isSummaryRow && userType !== 'admin') {
                                // 之前的逻辑是直接写入 nextCell，现在已经在转换阶段处理了。
                                // 这里我们只需要确保祝福语单元格样式正确。
                            }
                        }
                    }

                    if (R === 0) {
                        // Header Style
                        cell.s.font.sz = 12;
                        cell.s.font.bold = true;
                        cell.s.font.name = '宋体';
                        cell.s.fill = { fgColor: { rgb: "F2F2F2" } };
                        
                        // 如果是空格列头（祝福语列），清除内容但不删除单元格以保持边框
                        if (String(value).trim() === '') {
                            cell.v = '';
                        }
                    } else {
                        // Content

                        // Horizontal Align
                        // Sheet 3 (Index 2) always center, others left-align long text
                        if (sheetIndex !== 2 && strValue.length > 10) {
                            cell.s.alignment.horizontal = 'left';
                        }

                        // 2. 通用条件样式 (所有 Sheet)
                        const headerRef = XLSX.utils.encode_cell({ c: C, r: 0 });
                        const headerCell = ws[headerRef];
                        const headerVal = headerCell ? String(headerCell.v) : '';

                        // a. 日期列 -> 浅绿色
                        if (headerVal.includes('日期')) {
                            cell.s.fill = { fgColor: { rgb: "E2EFDA" } };
                        }

                        // b. 周日行 -> 浅蓝色
                        if (isSunday) {
                            cell.s.fill = { fgColor: { rgb: "DDEBF7" } };
                        }

                        // c. 评审/咨询类 -> 红色文字 (仅限工作表1)
                        const isCoreField = headerVal.includes('计划安排') || headerVal.includes('实际安排') || headerVal.includes('类型');

                        if (sheetIndex === 0) {
                            if (isCoreField && isRedRow) {
                                cell.s.font.color = { rgb: "FF0000" };
                            } else {
                                cell.s.font.color = { rgb: "000000" };
                            }
                        } else {
                            // Sheet 2, 3, 4 全部使用黑色
                            cell.s.font.color = { rgb: "000000" };
                        }

                        // d. 费用/汇总/统计列特殊对齐 (右对齐 + 底部对齐)
                        const s2RightBottom = ['试教', '入户', '评审', '集体活动', '咨询', '汇总'];
                        const s4RightBottom = ['入户', '试教', '评审', '评审记录', '半次入户', '集体活动', '咨询', '(线上)评审', '(线上)入户', '(线上)咨询', '咨询记录', '汇总'];

                        const isFinanceHeader = headerVal === '费用' || headerVal === '周汇总' || headerVal === '汇总';
                        const needsRightBottom = isFinanceHeader ||
                            (sheetIndex === 1 && s2RightBottom.includes(headerVal)) ||
                            (sheetIndex === 3 && s4RightBottom.includes(headerVal));

                        if (needsRightBottom) {
                            // 统一所有财务/统计列为：右对齐 + 底部对齐 + 自动换行
                            cell.s.alignment = { horizontal: 'right', vertical: 'bottom', wrapText: true };

                            // 清理可能残留的标签并取消加粗
                            if (typeof value === 'string') {
                                cell.v = value.replace(/<b>/g, '').replace(/<\/b>/g, '');
                            }
                            cell.s.font.bold = false;

                            // Sheet 1 费用列和周汇总列缩进处理
                            if (sheetIndex === 0 && (headerVal === '费用' || headerVal === '周汇总')) {
                                const cellValue = strValue;
                                // 判断是否包含多个教师/学生（通过检测换行符 \n）
                                const hasMultipleEntries = cellValue.includes('\n');
                                
                                if (!hasMultipleEntries && cellValue !== '/') {
                                    // 单行非空信息：右侧对齐，通过缩进在左侧产生呼吸感
                                    cell.s.alignment.indent = 1;
                                }
                            }
                        }

                        // e. 祝福语列样式处理（识别内容）
                        if (strValue.includes('Congratulations！') || strValue.includes('Good Luck！')) {
                            // 强制单行显示，黑色艺术字体（Apple Chancery）居中加粗，字号调小一号(11)
                            cell.s.alignment = { horizontal: 'center', vertical: 'center', wrapText: false };
                            cell.s.font = { name: 'Apple Chancery', sz: 11, bold: true, color: { rgb: "000000" } };
                        }
                    }
                }
            }

            XLSX.utils.book_append_sheet(wb, ws, sheetName);
            hasData = true;
        }
    });

    if (!hasData) throw new Error('没有可导出的数据');
    const finalFilename = filename || `export_${Date.now()}.xlsx`;
    XLSX.writeFile(wb, finalFilename);
}
async function loadXLSXLibrary() {
    return new Promise((resolve, reject) => {
        if (typeof XLSX !== 'undefined') {
            resolve();
            return;
        }

        const script = document.createElement('script');
        // 使用支持样式的 xlsx-js-style 库 (bundle version contains everything)
        script.src = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

// Global exposure for non-ESM contexts (if needed)
window.ExportManager = {
    transformToCalendarData,
    transformExportData,
    aggregateTeacherStats,
    aggregateTeacherStatsForTeacher,
    aggregateStudentStatsForStudent,
    formatLocalDateString,
    generateExcelFile,
    loadXLSXLibrary
};
