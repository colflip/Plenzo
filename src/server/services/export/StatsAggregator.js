/**
 * 统计聚合器
 * 负责教师和学生的统计汇总、统计表生成
 */

const DataTransformer = require('./DataTransformer');
const PermissionFilter = require('./PermissionFilter');

class StatsAggregator {
    /**
     * 聚合教师统计数据
     * @param {Array} rawData - 原始数据
     * @param {Object} options - 选项
     * @returns {Array} 教师统计数据
     */
    static aggregateTeacherStats(rawData, options) {
        const { startDate, endDate } = options;
        const stats = new Map();

        rawData.forEach(row => {
            if (!DataTransformer.isCountableSchedule(row)) return;

            const teacherName = row.teacher_name || '未知';
            if (!stats.has(teacherName)) {
                stats.set(teacherName, {
                    '姓名': teacherName,
                    '试教': 0,
                    '入户': 0,
                    '半次入户': 0,
                    '评审': 0,
                    '评审记录': 0,
                    '集体活动': 0,
                    '咨询': 0,
                    '咨询记录': 0
                });
            }

            const stat = stats.get(teacherName);
            const normalizedType = DataTransformer.normalizeTypeKey(
                row.type || row.type_name || row.schedule_type
            );

            // 累加统计
            if (normalizedType === 'trial' || normalizedType === '试教') {
                stat['试教']++;
            } else if (normalizedType === 'visit' || normalizedType === '入户' || normalizedType === '入户课') {
                stat['入户']++;
            } else if (normalizedType === 'half_visit' || normalizedType === '半次入户') {
                stat['半次入户']++;
            } else if (normalizedType === 'review' || normalizedType === '评审') {
                stat['评审']++;
            } else if (normalizedType === 'review_record' || normalizedType === '评审记录') {
                stat['评审记录']++;
            } else if (normalizedType === 'group_activity' || normalizedType === '集体活动') {
                stat['集体活动']++;
            } else if (normalizedType === 'consultation' || normalizedType === '咨询') {
                stat['咨询']++;
            } else if (normalizedType === 'consultation_record' || normalizedType === '咨询记录') {
                stat['咨询记录']++;
            }
        });

        // 应用计算公式并生成汇总文本
        const result = Array.from(stats.values()).map(stat => {
            return StatsAggregator.applyConversionFormula(stat, startDate, endDate);
        });

        return result;
    }

    /**
     * 聚合学生统计数据
     * @param {Array} rawData - 原始数据
     * @param {Object} options - 选项
     * @returns {Array} 学生统计数据
     */
    static aggregateStudentStats(rawData, options) {
        const { startDate, endDate } = options;
        const stats = new Map();

        rawData.forEach(row => {
            if (!DataTransformer.isCountableSchedule(row)) return;

            const studentName = row.student_name || '未知';
            if (!stats.has(studentName)) {
                stats.set(studentName, {
                    '姓名': studentName,
                    '试教': 0,
                    '入户': 0,
                    '半次入户': 0,
                    '评审': 0,
                    '评审记录': 0,
                    '集体活动': 0,
                    '咨询': 0,
                    '咨询记录': 0
                });
            }

            const stat = stats.get(studentName);
            const normalizedType = DataTransformer.normalizeTypeKey(
                row.type || row.type_name || row.schedule_type
            );

            // 累加统计
            if (normalizedType === 'trial' || normalizedType === '试教') {
                stat['试教']++;
            } else if (normalizedType === 'visit' || normalizedType === '入户' || normalizedType === '入户课') {
                stat['入户']++;
            } else if (normalizedType === 'half_visit' || normalizedType === '半次入户') {
                stat['半次入户']++;
            } else if (normalizedType === 'review' || normalizedType === '评审') {
                stat['评审']++;
            } else if (normalizedType === 'review_record' || normalizedType === '评审记录') {
                stat['评审记录']++;
            } else if (normalizedType === 'group_activity' || normalizedType === '集体活动') {
                stat['集体活动']++;
            } else if (normalizedType === 'consultation' || normalizedType === '咨询') {
                stat['咨询']++;
            } else if (normalizedType === 'consultation_record' || normalizedType === '咨询记录') {
                stat['咨询记录']++;
            }
        });

        // 应用计算公式并生成汇总文本
        const result = Array.from(stats.values()).map(stat => {
            return StatsAggregator.applyConversionFormula(stat, startDate, endDate);
        });

        return result;
    }

    /**
     * 应用转换公式并生成汇总文本
     * @param {Object} stat - 统计数据对象
     * @param {string} startDate - 开始日期
     * @param {string} endDate - 结束日期
     * @returns {Object} 转换后的统计数据
     */
    static applyConversionFormula(stat, startDate, endDate) {
        // 强制转换为数字，防止 undefined/null 导致 NaN（NaN 写入数字单元格会损坏 Excel 文件）
        const num = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : 0;
        };

        const finalVisit = num(stat['入户']) +
                          (num(stat['半次入户']) * 0.5) +
                          (num(stat['评审记录']) * 0.5) +
                          (num(stat['咨询记录']) * 0.5);
        const finalReview = num(stat['评审']) + num(stat['评审记录']);
        const finalConsult = num(stat['咨询']) + num(stat['咨询记录']);
        const finalTrial = num(stat['试教']);
        const finalGroup = num(stat['集体活动']);

        const parts = [];
        if (finalTrial > 0) parts.push(`${finalTrial}次试教`);
        if (finalVisit > 0) parts.push(`${finalVisit}次入户`);
        if (finalReview > 0) parts.push(`${finalReview}次评审`);
        if (finalGroup > 0) parts.push(`${finalGroup}次集体活动`);
        if (finalConsult > 0) parts.push(`${finalConsult}次咨询`);

        const details = parts.length > 0 ? `，${parts.join('，')}。` : '。';

        return {
            '姓名': stat['姓名'],
            '试教': finalTrial,
            '入户': finalVisit,
            '评审': finalReview,
            '集体活动': finalGroup,
            '咨询': finalConsult,
            '汇总': parts.join('、'),
            '备注': `在${stat['姓名']}，${startDate}-${endDate}${details}`
        };
    }

    /**
     * 生成汇总文本（用于汇总列）
     * @param {Object} typeTotals - 类型统计对象
     * @returns {string} 汇总文本
     */
    static generateSummaryText(typeTotals) {
        const details = [];
        Object.keys(typeTotals).forEach(type => {
            details.push(`${typeTotals[type]}次${type}`);
        });
        return details.length > 0 ? details.join('、') : '/';
    }

    /**
     * 生成教师授课汇总工作表
     * @param {Array} rawData - 原始数据
     * @param {Object} options - 选项
     * @returns {Array} 教师汇总数据
     */
    static generateTeacherSummarySheet(rawData, options) {
        const stats = StatsAggregator.aggregateTeacherStats(rawData, options);
        const summary = stats.map(stat => ({
            '教师姓名': stat['姓名'],
            '试教': stat['试教'] === 0 ? '/' : stat['试教'],
            '入户': stat['入户'] === 0 ? '/' : stat['入户'],
            '评审': stat['评审'] === 0 ? '/' : stat['评审'],
            '集体活动': stat['集体活动'] === 0 ? '/' : stat['集体活动'],
            '咨询': stat['咨询'] === 0 ? '/' : stat['咨询'],
            '汇总': stat['汇总'] || '/',
            '核对': '未核对',
            '备注': stat['备注'] || ''
        }));

        // 添加汇总行
        StatsAggregator.appendSummaryRow(summary);

        // 最后一行核对列显示祝福语
        const userType = options.userType || 'admin';
        const blessingText = (userType === 'teacher' || userType === 'admin')
            ? 'Congratulations！🎉'
            : 'Good Luck！🎉';
        if (summary.length > 0) {
            summary[summary.length - 1]['核对'] = blessingText;
        }

        // 过滤空列
        return PermissionFilter.filterEmptyColumns(summary, ['集体活动', '咨询']);
    }

    /**
     * 生成学生上课汇总工作表
     * @param {Array} rawData - 原始数据
     * @param {Object} options - 选项
     * @returns {Array} 学生汇总数据
     */
    static generateStudentSummarySheet(rawData, options) {
        const stats = StatsAggregator.aggregateStudentStats(rawData, options);
        const summary = stats.map(stat => ({
            '学生姓名': stat['姓名'],
            '试教': stat['试教'] === 0 ? '/' : stat['试教'],
            '入户': stat['入户'] === 0 ? '/' : stat['入户'],
            '评审': stat['评审'] === 0 ? '/' : stat['评审'],
            '集体活动': stat['集体活动'] === 0 ? '/' : stat['集体活动'],
            '咨询': stat['咨询'] === 0 ? '/' : stat['咨询'],
            '汇总': stat['汇总'] || '/',
            '核对': '未核对',
            '备注': stat['备注'] || ''
        }));

        // 添加汇总行
        StatsAggregator.appendSummaryRow(summary);

        // 最后一行核对列显示祝福语
        if (summary.length > 0) {
            summary[summary.length - 1]['核对'] = 'Good Luck！🎉';
        }

        // 过滤空列
        return PermissionFilter.filterEmptyColumns(summary, ['集体活动', '咨询']);
    }

    /**
     * 生成教师授课统计工作表（透视表）
     * @param {Array} rawData - 原始数据
     * @param {Array} allTypes - 所有课程类型
     * @returns {Array} 教师统计数据
     */
    static generateTeacherStatsSheet(rawData, allTypes) {
        const typeHeaders = allTypes.map(t => t.description || t.name);
        const typeIdToHeader = {};
        allTypes.forEach(t => {
            typeIdToHeader[t.id] = t.description || t.name;
        });

        // 按教师分组统计
        const statsMap = new Map();

        rawData.forEach(row => {
            if (!DataTransformer.isCountableSchedule(row)) return;

            const teacherName = row.teacher_name || '未知';
            const teacherId = row.teacher_id || 999999;
            const typeId = row.course_id || row.type_id;
            const typeHeader = typeIdToHeader[typeId] || '其他';

            if (!statsMap.has(teacherName)) {
                statsMap.set(teacherName, {
                    name: teacherName,
                    id: teacherId,
                    types: {}
                });
            }

            const entry = statsMap.get(teacherName);
            entry.types[typeHeader] = (entry.types[typeHeader] || 0) + 1;
        });

        // 转换为数组并排序
        const sortedEntries = Array.from(statsMap.values())
            .sort((a, b) => a.id - b.id);

        // 构建表格数据
        const data = sortedEntries.map(entry => {
            const row = { '教师姓名': entry.name };

            // 动态添加类型列
            typeHeaders.forEach(header => {
                const count = entry.types[header] || 0;
                row[header] = count === 0 ? '/' : count;
            });

            // 汇总列
            const parts = [];
            typeHeaders.forEach(header => {
                const count = entry.types[header] || 0;
                if (count > 0) {
                    parts.push(`${count}次${header}`);
                }
            });
            row['汇总'] = parts.join('、') || '/';

            return row;
        });

        // 添加汇总行
        return StatsAggregator.appendSummaryRow(data, ['备注', '核对']);
    }

    /**
     * 生成学生上课统计工作表（透视表）
     * @param {Array} rawData - 原始数据
     * @param {Array} allTypes - 所有课程类型
     * @returns {Array} 学生统计数据
     */
    static generateStudentStatsSheet(rawData, allTypes) {
        const typeHeaders = allTypes.map(t => t.description || t.name);
        const typeIdToHeader = {};
        allTypes.forEach(t => {
            typeIdToHeader[t.id] = t.description || t.name;
        });

        // 按学生分组统计
        const statsMap = new Map();

        rawData.forEach(row => {
            if (!DataTransformer.isCountableSchedule(row)) return;

            const studentName = row.student_name || '未知';
            const studentId = row.student_id || 999999;
            const typeId = row.course_id || row.type_id;
            const typeHeader = typeIdToHeader[typeId] || '其他';

            if (!statsMap.has(studentName)) {
                statsMap.set(studentName, {
                    name: studentName,
                    id: studentId,
                    types: {}
                });
            }

            const entry = statsMap.get(studentName);
            entry.types[typeHeader] = (entry.types[typeHeader] || 0) + 1;
        });

        // 转换为数组并排序
        const sortedEntries = Array.from(statsMap.values())
            .sort((a, b) => a.id - b.id);

        // 构建表格数据
        const data = sortedEntries.map(entry => {
            const row = { '学生姓名': entry.name };

            // 动态添加类型列
            typeHeaders.forEach(header => {
                const count = entry.types[header] || 0;
                row[header] = count === 0 ? '/' : count;
            });

            // 汇总列
            const parts = [];
            typeHeaders.forEach(header => {
                const count = entry.types[header] || 0;
                if (count > 0) {
                    parts.push(`${count}次${header}`);
                }
            });
            row['汇总'] = parts.join('、') || '/';

            return row;
        });

        // 添加汇总行
        return StatsAggregator.appendSummaryRow(data, ['备注', '核对']);
    }

    /**
     * 为数据添加汇总行
     * @param {Array} data - 数据数组
     * @param {Array} skipKeys - 跳过的列名
     * @returns {Array} 添加汇总行后的数据
     */
    static appendSummaryRow(data, skipKeys = ['备注', '核对']) {
        if (!data || data.length === 0) return data;

        const summary = { _isSummaryRow: true };
        const firstRow = data[0];
        const typeTotals = {};

        Object.keys(firstRow).forEach(key => {
            if (key.startsWith('_')) return;

            if (key === '姓名' || key === '学生姓名' || key === '教师姓名') {
                summary[key] = '/';
            } else if (skipKeys.includes(key)) {
                summary[key] = '/';
            } else if (key === '汇总') {
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

        // 生成汇总文本
        summary['汇总'] = StatsAggregator.generateSummaryText(typeTotals);

        data.push(summary);
        return data;
    }
}

module.exports = StatsAggregator;
