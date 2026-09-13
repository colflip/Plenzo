/**
 * 统计聚合器
 * 负责教师和学生的统计汇总、统计表生成
 */

const DataTransformer = require('./data-transformer');
const PermissionFilter = require('./permission-filter');
const logger = require('../../utils/logger');
// 折算唯一实现（与浏览页统计、教师酬劳共用同一份规则）
const TypeConversion = require('../../../../public/js/utils/type-conversion');

// 规范类型键 → 本模块统计对象的列名
const TOKEN_TO_STAT_LABEL = {
    trial: '试教',
    visit: '入户',
    half_visit: '半次入户',
    review: '评审',
    review_record: '评审记录',
    group_activity: '集体活动',
    consultation: '咨询',
    consultation_record: '咨询记录'
};

// 未识别类型只告警一次，避免刷日志；同时让"新增课程类型忘了登记"立刻可见
const reportedUnknownTypes = new Set();

function resolveStatLabel(rawType) {
    const key = TypeConversion.normalizeTypeKey(rawType);
    if (!key) return null;
    return TOKEN_TO_STAT_LABEL[key] || null;
}

function reportUnknownType(rawType) {
    const name = String(rawType == null ? '' : rawType).trim();
    if (!name || reportedUnknownTypes.has(name)) return;
    reportedUnknownTypes.add(name);
    logger.warn(`[export] 无法归类的课程类型「${name}」已计入「未归类」列，请按命名约定（review/visit/trial/group/advisory…）调整 schedule_types.name，或在 public/js/utils/type-conversion.js 的 TYPE_ALIASES 中补别名`);
}

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
                    _id: row.teacher_id != null ? row.teacher_id : 999999,
                    '试教': 0,
                    '入户': 0,
                    '半次入户': 0,
                    '评审': 0,
                    '评审记录': 0,
                    '集体活动': 0,
                    '咨询': 0,
                    '咨询记录': 0,
                    // 兜底列：无法归类的类型也计数，保证任何课程都不会从汇总里消失
                    '未归类': 0
                });
            }

            const stat = stats.get(teacherName);
            // 归一化 + 折算口径见 public/js/utils/type-conversion.js（唯一实现）
            const rawType = row.type || row.type_name || row.schedule_type;
            const label = resolveStatLabel(rawType);
            if (label) {
                stat[label]++;
            } else {
                stat['未归类'] = (stat['未归类'] || 0) + 1;
                reportUnknownType(rawType);
            }
        });

        // 按 id 升序排序，再应用计算公式并生成汇总文本
        const result = Array.from(stats.values())
            .sort((a, b) => a._id - b._id)
            .map(stat => {
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
                    _id: row.student_id != null ? row.student_id : 999999,
                    '试教': 0,
                    '入户': 0,
                    '半次入户': 0,
                    '评审': 0,
                    '评审记录': 0,
                    '集体活动': 0,
                    '咨询': 0,
                    '咨询记录': 0,
                    '未归类': 0
                });
            }

            const stat = stats.get(studentName);
            // 归一化 + 折算口径见 public/js/utils/type-conversion.js（唯一实现）
            const rawType = row.type || row.type_name || row.schedule_type;
            const label = resolveStatLabel(rawType);
            if (label) {
                stat[label]++;
            } else {
                stat['未归类'] = (stat['未归类'] || 0) + 1;
                reportUnknownType(rawType);
            }
        });

        // 按 id 升序排序，再应用计算公式并生成汇总文本
        const result = Array.from(stats.values())
            .sort((a, b) => a._id - b._id)
            .map(stat => {
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
        // 折算口径唯一实现：public/js/utils/type-conversion.js
        //   入户 = 入户 + 半次入户×0.5 + 评审记录×0.5 + 咨询记录×0.5
        //   评审 = 评审 + 评审记录（大评审 已归入 评审） 咨询 = 咨询 + 咨询记录
        //   试教 / 集体活动 取原值
        // 该实现对「已折算过的对象」是幂等的（半次入户/评审记录/咨询记录 中间列已不存在），
        // sheet-builder 的「先 aggregate 再 applyConversionFormula」链路依赖这一性质。
        // 内部一律走 Number.isFinite 守卫，避免 undefined/null 产生 NaN 写坏 Excel 数字单元格。
        const totals = TypeConversion.accumulateConvertedColumns(
            TypeConversion.createConvertedTotals(),
            stat
        );
        const finalTrial = totals.trial;
        const finalVisit = totals.visit;
        const finalReview = totals.review;
        const finalGroup = totals.group_activity;
        const finalConsult = totals.consultation;
        // 兜底口径：无法归类的类型不会被丢弃，显式出现在「汇总」与「备注」里
        const finalUncategorized = Number(totals.uncategorized) || 0;

        const parts = [];
        if (finalTrial > 0) parts.push(`${finalTrial}次试教`);
        if (finalVisit > 0) parts.push(`${finalVisit}次入户`);
        if (finalReview > 0) parts.push(`${finalReview}次评审`);
        if (finalGroup > 0) parts.push(`${finalGroup}次集体活动`);
        if (finalConsult > 0) parts.push(`${finalConsult}次咨询`);
        if (finalUncategorized > 0) parts.push(`${finalUncategorized}次未归类`);

        const details = parts.length > 0 ? `，${parts.join('，')}。` : '。';

        return {
            '姓名': stat['姓名'],
            '试教': finalTrial,
            '入户': finalVisit,
            '评审': finalReview,
            '集体活动': finalGroup,
            '咨询': finalConsult,
            '未归类': finalUncategorized,
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
