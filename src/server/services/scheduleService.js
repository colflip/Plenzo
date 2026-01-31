/**
 * 智能排课服务 (Schedule Service)
 * @description 处理排课核心业务逻辑，包括时间冲突检测、智能匹配、排课创建与状态管理
 * @module services/scheduleService
 */

const db = require('../db/db');
const { AppError } = require('../middleware/error');

// 辅助函数：根据时间段返回 [start, end]
function slotToRange(slot) {
    switch (slot) {
        case 'morning': return ['08:00', '12:00'];
        case 'afternoon': return ['13:00', '17:00'];
        case 'evening': return ['18:00', '24:00'];
        default: return [null, null];
    }
}

/**
 * 动态获取日期列表达式
 * @description 兼容不同数据库 schema 版本
 */
let caDateExprCache = null;
async function getCaDateExpr() {
    if (caDateExprCache) return caDateExprCache;
    try {
        const r = await db.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='course_arrangement' AND column_name IN ('arr_date','class_date','date')
        `);
        const cols = new Set((r.rows || []).map(x => x.column_name));
        const parts = [];
        if (cols.has('arr_date')) parts.push('arr_date');
        if (cols.has('class_date')) parts.push('class_date');
        if (cols.has('date')) parts.push('date');
        const expr = parts.length > 1 ? `COALESCE(${parts.join(', ')})` : (parts[0] || 'date');
        caDateExprCache = expr;
        return expr;
    } catch (_) {
        caDateExprCache = 'date';
        return caDateExprCache;
    }
}

class ScheduleService {
    /**
     * 获取可用教师列表
     * @param {string} date - 日期
     * @param {string} timeSlot - 时段 (morning/afternoon/evening)
     * @param {string} startTime - 自定义开始时间 (HH:mm)
     * @param {string} endTime - 自定义结束时间 (HH:mm)
     */
    async getAvailableTeachers(date, timeSlot, startTime, endTime) {
        const [slotStart, slotEnd] = timeSlot ? slotToRange(timeSlot) : [null, null];
        const qStart = startTime || slotStart;
        const qEnd = endTime || slotEnd;

        if (!qStart || !qEnd) {
            throw new AppError('必须指定时段或具体起止时间', 400);
        }

        const queryFn = `
            SELECT DISTINCT t.*
            FROM teachers t
            JOIN teacher_daily_availability ta ON t.id = ta.teacher_id
            WHERE ta.date = $1
            AND ta.status = 'available'
            AND (ta.start_time, ta.end_time) OVERLAPS ($2::time, $3::time)
            AND NOT EXISTS (
                SELECT 1
                FROM course_arrangement ca
                WHERE ca.teacher_id = t.id
                AND COALESCE(ca.arr_date, ca.class_date, ca.date) = $1
                AND (ca.start_time, ca.end_time) OVERLAPS ($2::time, $3::time)
                AND ca.status != 'cancelled'
            )
        `;

        const result = await db.query(queryFn, [date, qStart, qEnd]);
        return result.rows;
    }

    /**
     * 获取可用学生列表
     * @param {string} date
     * @param {string} timeSlot
     * @param {string} startTime
     * @param {string} endTime
     */
    async getAvailableStudents(date, timeSlot, startTime, endTime) {
        const [slotStart, slotEnd] = timeSlot ? slotToRange(timeSlot) : [null, null];
        const qStart = startTime || slotStart;
        const qEnd = endTime || slotEnd;

        if (!qStart || !qEnd) {
            throw new AppError('必须指定时段或具体起止时间', 400);
        }

        const queryFn = `
            SELECT DISTINCT s.*
            FROM students s
            JOIN student_daily_availability sa ON s.id = sa.student_id
            WHERE sa.date = $1
            AND sa.status = 'available'
            AND (sa.start_time, sa.end_time) OVERLAPS ($2::time, $3::time)
            AND NOT EXISTS (
                SELECT 1
                FROM course_arrangement ca
                WHERE ca.student_id = s.id
                AND COALESCE(ca.arr_date, ca.class_date, ca.date) = $1
                AND (ca.start_time, ca.end_time) OVERLAPS ($2::time, $3::time)
                AND ca.status != 'cancelled'
            )
        `;

        const result = await db.query(queryFn, [date, qStart, qEnd]);
        return result.rows;
    }

    /**
     * 检查冲突 (原子性检查)
     * @description 用于事务内部或单独调用
     */
    async checkConflicts(teacherId, studentId, date, timeSlot, startTime, endTime, client = null) {
        const [slotStart, slotEnd] = timeSlot ? slotToRange(timeSlot) : [null, null];
        const qStart = startTime || slotStart;
        const qEnd = endTime || slotEnd;

        const caDateExpr = await getCaDateExpr();
        const executeQuery = client ? client.query.bind(client) : db.query.bind(db);

        // 1. 完全重复检查
        const dupRes = await executeQuery(
            `SELECT id, teacher_id, student_id, course_id, ${caDateExpr} as date, start_time, end_time, status, location
             FROM course_arrangement
             WHERE teacher_id = $1 AND student_id = $2 AND ${caDateExpr} = $3
               AND start_time = $4 AND end_time = $5 AND status != 'cancelled'
             LIMIT 1`,
            [teacherId, studentId, date, qStart, qEnd]
        );
        if (dupRes.rows.length > 0) {
            return { hasConflicts: true, type: 'duplicate', message: '存在完全重复的排课记录', existing: dupRes.rows[0] };
        }

        // 2. 教师时间冲突
        const teacherConflict = await executeQuery(
            `SELECT id, teacher_id, student_id, course_id, ${caDateExpr} as date, start_time, end_time, status, location
             FROM course_arrangement 
             WHERE teacher_id = $1 
               AND ${caDateExpr} = $2 
               AND (start_time, end_time) OVERLAPS ($3::time, $4::time) 
               AND status != 'cancelled'
             LIMIT 1`,
            [teacherId, date, qStart, qEnd]
        );
        if (teacherConflict.rows.length > 0) {
            return { hasConflicts: true, type: 'overlap_teacher', message: '教师时间段与现有排课重叠', existing: teacherConflict.rows[0] };
        }

        // 3. 学生时间冲突
        const studentConflict = await executeQuery(
            `SELECT id, teacher_id, student_id, course_id, ${caDateExpr} as date, start_time, end_time, status, location
             FROM course_arrangement 
             WHERE student_id = $1 
               AND ${caDateExpr} = $2 
               AND (start_time, end_time) OVERLAPS ($3::time, $4::time) 
               AND status != 'cancelled'
             LIMIT 1`,
            [studentId, date, qStart, qEnd]
        );
        if (studentConflict.rows.length > 0) {
            return { hasConflicts: true, type: 'overlap_student', message: '学生时间段与现有排课重叠', existing: studentConflict.rows[0] };
        }

        return { hasConflicts: false };
    }

    /**
     * 创建课程安排 (支持多学生批量)
     */
    async createSchedule(data, userId) {
        const { teacherId, studentIds, date, timeSlot, startTime, endTime, scheduleTypes, location } = data;

        // 参数归一化
        const courseId = Array.isArray(scheduleTypes) ? scheduleTypes[0] : scheduleTypes;
        if (!courseId) throw new AppError('缺少课程类型', 400);

        const createdIds = [];

        // 使用事务
        await db.runInTransaction(async (client) => {
            // 逐个学生检查冲突并插入
            for (const studentId of studentIds) {
                const conflict = await this.checkConflicts(
                    teacherId, studentId, date, timeSlot, startTime, endTime, client
                );

                if (conflict.hasConflicts) {
                    throw new AppError(conflict.message, 400, { type: conflict.type, existing: conflict.existing });
                }

                const insertQuery = `
                    INSERT INTO course_arrangement 
                    (teacher_id, student_id, course_id, arr_date, start_time, end_time, location, status, created_by)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
                    RETURNING id
                `;

                const res = await client.query(insertQuery, [
                    teacherId, studentId, courseId, date, startTime, endTime, location || null, userId
                ]);
                createdIds.push(res.rows[0].id);
            }
        });

        return { ids: createdIds };
    }

    /**
     * 获取所有课程类型
     */
    async getScheduleTypes() {
        const result = await db.query('SELECT * FROM schedule_types ORDER BY name');
        return result.rows;
    }

    /**
     * 确认排课状态
     */
    async confirmSchedule(scheduleId, operatorId, isOperatorAdmin) {
        // 1. 检查排课是否存在
        const checkRes = await db.query('SELECT teacher_id, status FROM course_arrangement WHERE id = $1', [scheduleId]);
        if (checkRes.rows.length === 0) {
            throw new AppError('课程不存在', 404);
        }

        const schedule = checkRes.rows[0];

        // 2. 权限检查: 只有授课教师本人或管理员可确认
        if (!isOperatorAdmin && schedule.teacher_id !== operatorId) {
            throw new AppError('无权操作此课程', 403);
        }

        // 3. 更新状态
        await db.query(
            "UPDATE course_arrangement SET status = 'confirmed' WHERE id = $1",
            [scheduleId]
        );

        return { success: true };
    }
}

module.exports = new ScheduleService();
