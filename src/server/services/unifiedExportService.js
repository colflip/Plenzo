/**
 * 统一导出服务
 * 整合前端 export-manager.js 的所有导出逻辑到后端
 * 为管理员、教师、学生三端提供统一的导出接口
 */

const enhancedExcel = require('./enhancedExcelService');
const { ExportError } = require('../middleware/exportErrorHandler');

// 导入模块化组件
const {
    STATUS_MAP,
    FAMILY_MAP,
    CACHE_CONFIG,
    EXPORT_LIMITS,
    BATCH_CONFIG
} = require('./export/ExportConstants');
const DataTransformer = require('./export/DataTransformer');
const CalendarGenerator = require('./export/CalendarGenerator');
const StatsAggregator = require('./export/StatsAggregator');
const PermissionFilter = require('./export/PermissionFilter');

class UnifiedExportService {
    constructor() {
        // schedule_types 缓存
        this._scheduleTypesCache = null;
        this._cacheExpiry = 0;
        this.CACHE_TTL = CACHE_CONFIG.TTL;

        // 名称映射缓存（性能优化）
        this._teacherNameCache = new Map();
        this._studentNameCache = new Map();
        this._nameCacheExpiry = 0;
        this.NAME_CACHE_TTL = 10 * 60 * 1000; // 10分钟
    }

    /**
     * 获取 schedule_types 数据（带缓存）
     * @returns {Promise<Array>} schedule_types 数组
     */
    async getScheduleTypes() {
        const now = Date.now();

        // 检查缓存是否有效
        if (this._scheduleTypesCache && now < this._cacheExpiry) {
            return this._scheduleTypesCache;
        }

        // 缓存失效或不存在，重新查询
        const db = require('../db/db');
        const result = await db.query(
            `SELECT id, name, description FROM schedule_types ORDER BY id ASC`
        );

        this._scheduleTypesCache = result.rows;
        this._cacheExpiry = now + this.CACHE_TTL;

        return this._scheduleTypesCache;
    }

    /**
     * 批量缓存教师名称（减少数据库查询）
     * @param {Array} teacherIds - 教师 ID 数组
     */
    async _cacheTeacherNames(teacherIds) {
        const now = Date.now();

        // 检查缓存是否过期
        if (now > this._nameCacheExpiry) {
            this._teacherNameCache.clear();
            this._studentNameCache.clear();
            this._nameCacheExpiry = now + this.NAME_CACHE_TTL;
        }

        // 过滤未缓存的 ID
        const uncachedIds = teacherIds.filter(id => !this._teacherNameCache.has(id));

        if (uncachedIds.length === 0) return;

        // 批量查询
        const db = require('../db/db');
        const result = await db.query(
            'SELECT id, name FROM teachers WHERE id = ANY($1)',
            [uncachedIds]
        );

        // 更新缓存
        result.rows.forEach(row => {
            this._teacherNameCache.set(row.id, row.name);
        });
    }

    /**
     * 批量缓存学生名称
     * @param {Array} studentIds - 学生 ID 数组
     */
    async _cacheStudentNames(studentIds) {
        const now = Date.now();

        if (now > this._nameCacheExpiry) {
            this._teacherNameCache.clear();
            this._studentNameCache.clear();
            this._nameCacheExpiry = now + this.NAME_CACHE_TTL;
        }

        const uncachedIds = studentIds.filter(id => !this._studentNameCache.has(id));

        if (uncachedIds.length === 0) return;

        const db = require('../db/db');
        const result = await db.query(
            'SELECT id, name FROM students WHERE id = ANY($1)',
            [uncachedIds]
        );

        result.rows.forEach(row => {
            this._studentNameCache.set(row.id, row.name);
        });
    }

    /**
     * 预加载名称缓存（性能优化）
     * @param {Array} rawData - 原始数据
     */
    async _preloadNameCache(rawData) {
        const teacherIds = [...new Set(rawData.map(r => r.teacher_id).filter(Boolean))];
        const studentIds = [...new Set(rawData.map(r => r.student_id).filter(Boolean))];

        await Promise.all([
            this._cacheTeacherNames(teacherIds),
            this._cacheStudentNames(studentIds)
        ]);
    }

    /**
     * 主入口：生成完整的多Sheet导出数据
     * @param {Array} rawData - 原始排课数据
     * @param {Object} options - 导出选项
     * @returns {Object} { sheets: {...}, filename: string }
     */
    async generateCompleteExport(rawData, options) {
        const startTime = Date.now();

        try {
            // 更新记录数量限制
            if (rawData && rawData.length > EXPORT_LIMITS.MAX) {
                throw new ExportError(
                    `导出记录数量超过限制（最大${EXPORT_LIMITS.MAX}条），请缩小日期范围`,
                    400,
                    'EXPORT_LIMIT_EXCEEDED'
                );
            }

            if (!rawData || rawData.length === 0) {
                throw new ExportError(
                    '该时间段内无可导出的数据',
                    404,
                    'EXPORT_NO_DATA'
                );
            }

            // 注意：rawData 已通过 SQL JOIN 包含 teacher_name 和 student_name，无需额外查询

            // 判断是否需要分批处理
            const generateStartTime = Date.now();
            let result;
            if (rawData.length > BATCH_CONFIG.THRESHOLD) {
                result = await this._generateMultiBatch(rawData, options);
            } else {
                result = await this._generateSingleBatch(rawData, options);
            }
            const generateTime = Date.now() - generateStartTime;

            const totalTime = Date.now() - startTime;
            console.log(`[Performance] 导出性能统计 - 总记录数: ${rawData.length}, 生成耗时: ${generateTime}ms, 总耗时: ${totalTime}ms`);

            return result;
        } catch (error) {
            console.error('导出生成失败:', error);

            // 如果已经是 ExportError，直接抛出
            if (error instanceof ExportError) {
                throw error;
            }

            // 包装为 ExportError
            throw new ExportError(
                `导出失败: ${error.message}`,
                500,
                'EXPORT_GENERATION_FAILED'
            );
        }
    }

    /**
     * 单批处理生成（小数据量）
     * @param {Array} rawData - 原始排课数据
     * @param {Object} options - 导出选项
     * @returns {Object} { sheets: {...}, filename: string }
     */
    async _generateSingleBatch(rawData, options) {
        // 预先聚合数据，避免重复计算
        const aggregateStartTime = Date.now();
        const allTypes = await this.getScheduleTypes();
        const [teacherStatsData, studentStatsData] = await Promise.all([
            Promise.resolve(StatsAggregator.aggregateTeacherStats(rawData, options)),
            Promise.resolve(StatsAggregator.aggregateStudentStats(rawData, options))
        ]);
        const aggregateTime = Date.now() - aggregateStartTime;

        // 并行生成所有工作表
        const sheetStartTime = Date.now();
        const [
            dailySheet,
            teacherSummary,
            teacherStats,
            studentSummary,
            studentStats,
            rawRecords
        ] = await Promise.all([
            // 1. 每日排课明细
            Promise.resolve(CalendarGenerator.generateDailyScheduleSheet(rawData, options)),

            // 2. 教师授课汇总（使用预聚合数据，避免重复聚合）
            Promise.resolve(this._generateTeacherSummaryFromStats(teacherStatsData, options)),

            // 3. 教师授课统计（直接使用原始数据）
            Promise.resolve(StatsAggregator.generateTeacherStatsSheet(rawData, allTypes)),

            // 4. 学生上课汇总（使用预聚合数据，避免重复聚合）
            Promise.resolve(this._generateStudentSummaryFromStats(studentStatsData, options)),

            // 5. 学生上课统计（直接使用原始数据）
            Promise.resolve(StatsAggregator.generateStudentStatsSheet(rawData, allTypes)),

            // 6. 排课原始记录
            Promise.resolve(this.generateRawRecordsSheet(rawData, options))
        ]);
        const sheetTime = Date.now() - sheetStartTime;

        console.log(`[Performance] 单批生成 - 聚合耗时: ${aggregateTime}ms, 工作表生成: ${sheetTime}ms`);

        // 配置工作表选项
        const sheets = {
            '每日排课明细': dailySheet,
            '教师授课汇总': teacherSummary,
            '学生上课汇总': studentSummary,
            '教师授课统计': teacherStats,
            '学生上课统计': studentStats,
            '排课原始记录': rawRecords
        };

        sheets._worksheetOptions = {
            '每日排课明细': {
                mergeDateColumns: true,
                mergeFeeColumn: true,
                mergeWeekSummaryColumn: true,
                applyRichText: true,
                applyRowColors: true,
                applyColumnColors: true,
                kind: 'detail'
            },
            '教师授课汇总': { kind: 'summary' },
            '教师授课统计': { kind: 'stats' },
            '排课原始记录': { kind: 'raw' },
            '学生上课汇总': { kind: 'summary' },
            '学生上课统计': { kind: 'stats' }
        };

        // 生成文件名
        const filename = this.generateFilename(options);

        return {
            sheets,
            filename
        };
    }

    /**
     * 分批处理生成（大数据量）
     * @param {Array} rawData - 原始排课数据
     * @param {Object} options - 导出选项
     * @returns {Object} { sheets: {...}, filename: string }
     */
    async _generateMultiBatch(rawData, options) {
        const BATCH_SIZE = BATCH_CONFIG.SIZE;
        const batches = [];

        // 分批
        for (let i = 0; i < rawData.length; i += BATCH_SIZE) {
            batches.push(rawData.slice(i, i + BATCH_SIZE));
        }

        console.log(`[UnifiedExportService] 分批处理: ${batches.length} 批, 每批 ${BATCH_SIZE} 条, 总计 ${rawData.length} 条`);

        // 1. 每日排课明细 - 分批追加
        const dailyRows = [];
        for (const batch of batches) {
            const batchRows = CalendarGenerator.generateDailyScheduleSheet(batch, options);
            dailyRows.push(...batchRows);
        }

        // 2. 教师授课汇总 - 分批聚合后合并
        const teacherStatsArray = [];
        for (const batch of batches) {
            const batchStats = StatsAggregator.aggregateTeacherStats(batch, options);
            teacherStatsArray.push(...batchStats);
        }
        const mergedTeacherStats = this._mergeTeacherStats(teacherStatsArray);
        const teacherSummary = this._generateTeacherSummaryFromStats(mergedTeacherStats, options);

        // 3. 学生上课汇总 - 分批聚合后合并
        const studentStatsArray = [];
        for (const batch of batches) {
            const batchStats = StatsAggregator.aggregateStudentStats(batch, options);
            studentStatsArray.push(...batchStats);
        }
        const mergedStudentStats = this._mergeStudentStats(studentStatsArray);
        const studentSummary = this._generateStudentSummaryFromStats(mergedStudentStats, options);

        // 4-6. 其他工作表（统计和原始记录）
        const allTypes = await this.getScheduleTypes();
        const teacherStats = this._generateTeacherStatsFromAggregated(rawData, allTypes);
        const studentStats = this._generateStudentStatsFromAggregated(rawData, allTypes);
        const rawRecords = this.generateRawRecordsSheet(rawData, options);

        // 配置工作表选项
        const sheets = {
            '每日排课明细': dailyRows,
            '教师授课汇总': teacherSummary,
            '学生上课汇总': studentSummary,
            '教师授课统计': teacherStats,
            '学生上课统计': studentStats,
            '排课原始记录': rawRecords
        };

        sheets._worksheetOptions = {
            '每日排课明细': {
                mergeDateColumns: true,
                mergeFeeColumn: true,
                mergeWeekSummaryColumn: true,
                applyRichText: true,
                applyRowColors: true,
                applyColumnColors: true,
                kind: 'detail'
            },
            '教师授课汇总': { kind: 'summary' },
            '教师授课统计': { kind: 'stats' },
            '排课原始记录': { kind: 'raw' },
            '学生上课汇总': { kind: 'summary' },
            '学生上课统计': { kind: 'stats' }
        };

        return {
            sheets,
            filename: this.generateFilename(options)
        };
    }

    /**
     * 合并教师统计数据
     * @param {Array} statsArray - 统计数据数组
     * @returns {Array} 合并后的统计数据
     */
    _mergeTeacherStats(statsArray) {
        const merged = {};

        for (const stat of statsArray) {
            const key = stat['姓名'];

            if (!merged[key]) {
                merged[key] = { ...stat };
            } else {
                // 累加各类型计数
                ['试教', '咨询', '入户', '评审', '集体活动', '半次入户', '评审记录', '咨询记录'].forEach(type => {
                    merged[key][type] = (merged[key][type] || 0) + (stat[type] || 0);
                });
            }
        }

        return Object.values(merged);
    }

    /**
     * 合并学生统计数据
     * @param {Array} statsArray - 统计数据数组
     * @returns {Array} 合并后的统计数据
     */
    _mergeStudentStats(statsArray) {
        const merged = {};

        for (const stat of statsArray) {
            const key = stat['姓名'];

            if (!merged[key]) {
                merged[key] = { ...stat };
            } else {
                // 累加各类型计数
                ['试教', '咨询', '入户', '评审', '集体活动', '半次入户', '评审记录', '咨询记录'].forEach(type => {
                    merged[key][type] = (merged[key][type] || 0) + (stat[type] || 0);
                });
            }
        }

        return Object.values(merged);
    }

    /**
     * 从聚合的统计数据生成教师汇总表
     * @param {Array} mergedStats - 合并后的统计数据
     * @param {Object} options - 导出选项
     * @returns {Array} 教师汇总数据
     */
    _generateTeacherSummaryFromStats(mergedStats, options) {
        const { startDate, endDate } = options;

        // 应用转换公式
        const processedStats = mergedStats.map(stat => {
            return StatsAggregator.applyConversionFormula(stat, startDate, endDate);
        });

        // 构建课程类型统计文本（用于问询列）
        const typeOrder = ['试教', '入户', '评审', '集体活动', '咨询'];

        const summary = processedStats.map(stat => {
            const name = stat['姓名'];
            const namePrefix = name ? name.charAt(0) : '';
            const typeTexts = [];
            typeOrder.forEach(type => {
                const count = stat[type] || 0;
                if (count > 0) {
                    typeTexts.push(`${count}次${type}`);
                }
            });
            const inquiryText = typeTexts.length > 0
                ? `${namePrefix}老师好！${startDate} 至 ${endDate}期间，您在[${name}]处入户等相关数据为 ：${typeTexts.join('、')}。请问是否正确？`
                : '';

            return {
                '教师姓名': name,
                '试教': stat['试教'] === 0 ? '/' : stat['试教'],
                '入户': stat['入户'] === 0 ? '/' : stat['入户'],
                '评审': stat['评审'] === 0 ? '/' : stat['评审'],
                '集体活动': stat['集体活动'] === 0 ? '/' : stat['集体活动'],
                '咨询': stat['咨询'] === 0 ? '/' : stat['咨询'],
                '汇总': stat['汇总'] || '/',
                '核对': '未核对',
                '问询': inquiryText,
                '备注': ''
            };
        });

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

        // 教师端（非班主任）和学生端不显示问询列
        if (userType === 'teacher' || userType === 'student') {
            summary.forEach(row => delete row['问询']);
        }

        // 过滤空列
        return PermissionFilter.filterEmptyColumns(summary, ['集体活动', '咨询']);
    }

    /**
     * 从聚合的统计数据生成学生汇总表
     * @param {Array} mergedStats - 合并后的统计数据
     * @param {Object} options - 导出选项
     * @returns {Array} 学生汇总数据
     */
    _generateStudentSummaryFromStats(mergedStats, options) {
        const { startDate, endDate } = options;

        // 应用转换公式
        const processedStats = mergedStats.map(stat => {
            return StatsAggregator.applyConversionFormula(stat, startDate, endDate);
        });

        // 构建课程类型统计文本（用于问询列）
        const typeOrder = ['试教', '入户', '评审', '集体活动', '咨询'];

        const summary = processedStats.map(stat => {
            const name = stat['姓名'];
            const namePrefix = name ? name.charAt(0) : '';
            const typeTexts = [];
            typeOrder.forEach(type => {
                const count = stat[type] || 0;
                if (count > 0) {
                    typeTexts.push(`${count}次${type}`);
                }
            });
            const inquiryText = typeTexts.length > 0
                ? `${namePrefix}同学好！${startDate} 至 ${endDate}期间，您在[${name}]处入户等相关数据为 ：${typeTexts.join('、')}。请问是否正确？`
                : '';

            return {
                '学生姓名': name,
                '试教': stat['试教'] === 0 ? '/' : stat['试教'],
                '入户': stat['入户'] === 0 ? '/' : stat['入户'],
                '评审': stat['评审'] === 0 ? '/' : stat['评审'],
                '集体活动': stat['集体活动'] === 0 ? '/' : stat['集体活动'],
                '咨询': stat['咨询'] === 0 ? '/' : stat['咨询'],
                '汇总': stat['汇总'] || '/',
                '核对': '未核对',
                '问询': inquiryText,
                '备注': ''
            };
        });

        // 添加汇总行
        StatsAggregator.appendSummaryRow(summary);

        // 最后一行核对列显示祝福语
        if (summary.length > 0) {
            summary[summary.length - 1]['核对'] = 'Good Luck！🎉';
        }

        // 教师端（非班主任）和学生端不显示问询列
        const userType = options.userType || 'admin';
        if (userType === 'teacher' || userType === 'student') {
            summary.forEach(row => delete row['问询']);
        }

        // 过滤空列
        return PermissionFilter.filterEmptyColumns(summary, ['集体活动', '咨询']);
    }

    /**
     * 从原始数据生成教师统计表（用于分批处理）
     * @param {Array} rawData - 原始数据
     * @param {Array} allTypes - 所有课程类型
     * @returns {Array} 教师统计数据
     */
    _generateTeacherStatsFromAggregated(rawData, allTypes) {
        return StatsAggregator.generateTeacherStatsSheet(rawData, allTypes);
    }

    /**
     * 从原始数据生成学生统计表（用于分批处理）
     * @param {Array} rawData - 原始数据
     * @param {Array} allTypes - 所有课程类型
     * @returns {Array} 学生统计数据
     */
    _generateStudentStatsFromAggregated(rawData, allTypes) {
        return StatsAggregator.generateStudentStatsSheet(rawData, allTypes);
    }


    /**
     * 生成排课原始记录工作表（21列）
     */
    generateRawRecordsSheet(rawData, options) {
        const { userType = 'admin', userId } = options;
        const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

        return rawData.map(row => {
            const dateStr = DataTransformer.formatLocaleDate(row.date || row.class_date || row.arr_date);
            const dateObj = new Date(dateStr);
            const weekStr = WEEKDAYS[dateObj.getDay()];

            const startTime = row.start_time || '';
            const endTime = row.end_time || '';
            const timeStr = (startTime && endTime)
                ? `${String(startTime).substring(0, 5)}-${String(endTime).substring(0, 5)}`
                : '';

            // 交通费权限过滤
            let transportFee = DataTransformer.formatFee(row.transport_fee);
            if (userType === 'student') {
                transportFee = '/';
            }

            const otherFee = DataTransformer.formatFee(row.other_fee);

            const result = {
                '日期': dateStr,
                '星期': weekStr,
                '教师名称': row.teacher_name || '',
                '学生名称': row.student_name || '',
                '类型': row.type_desc || row.type_name || row.type || '',
                '时间段': timeStr,
                '状态': STATUS_MAP[row.status] || row.status || '',
                '上课地点': row.location || '',
                '创建时间': DataTransformer.formatTimestamp(row.created_at),
                '更新时间': DataTransformer.formatTimestamp(row.updated_at),
                '课程状态自动更新时间': DataTransformer.formatTimestamp(row.last_auto_update),
                '排课 ID': row.schedule_id || row.id || '',
                '教师 ID': row.teacher_id || '',
                '学生 ID': row.student_id || '',
                'admin ID': row.created_by || '',
                '家庭参加人员': FAMILY_MAP[row.family_participants] || '',
                '教师评分': row.teacher_rating || '',
                '教师评价内容': row.teacher_comment || '',
                '学生评分': row.student_rating || '',
                '学生评价内容': row.student_comment || '',
                '交通费': transportFee,
                '其他费用': otherFee,
                '备注': '',
                // 内部样式字段（用于复用第1工作表的颜色/斜体/周末背景）
                '_type_name': row.type_name || row.type_desc || row.type || '',
                '_status': row.status || '',
                '_isWeekend': dateObj.getDay() === 0
            };

            // 学生端隐藏敏感列
            if (userType === 'student') {
                delete result['学生名称'];
                delete result['交通费'];
                delete result['其他费用'];
            }

            return result;
        });
    }

    /**
     * 生成导出文件名（统一文件名生成逻辑）
     * @param {Object} options - 导出选项
     * @returns {string} 文件名
     */
    generateFilename(options) {
        const {
            userType,
            userName,
            studentName,
            teacherName,
            startDate,
            endDate
        } = options;

        const sanitize = DataTransformer.sanitizeFilename;
        const timestamp = DataTransformer.generateTimestamp();

        // 格式化日期范围 (YYYYMMDD_YYYYMMDD)
        const dateRange = `${startDate.replace(/-/g, '')}_${endDate.replace(/-/g, '')}`;

        // 根据用户类型生成文件名
        if (userType === 'admin') {
            const student = sanitize(studentName || '全部学生');
            const teacher = sanitize(teacherName || '全部教师');
            const admin = sanitize(userName || 'admin');
            return `排课记录[${student}][${teacher}][${dateRange}][${admin}]_${timestamp}.xlsx`;
        } else if (userType === 'teacher') {
            const name = sanitize(userName || '教师');
            return `[${name}]授课记录[${dateRange}]_${timestamp}.xlsx`;
        } else if (userType === 'teacher_homeroom') {
            const name = sanitize(studentName || '学生');
            return `[${name}]入户记录明细及统计[${dateRange}]_${timestamp}.xlsx`;
        } else if (userType === 'student') {
            const name = sanitize(studentName || '学生');
            return `[${name}]学习记录[${dateRange}]_${timestamp}.xlsx`;
        }

        // 默认文件名
        return `导出数据_${timestamp}.xlsx`;
    }
}

module.exports = UnifiedExportService;
