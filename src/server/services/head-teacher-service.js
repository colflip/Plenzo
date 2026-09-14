/**
 * 班主任（head-teacher / homeroom）服务
 * @description 班主任关联学生的查询、详情、信息更新，以及教师列表（导出筛选用）。
 *              统计/总览（stats）与排课（schedules）逻辑分别在 schedule-service；
 *              班主任学生数据导出（流式 xlsx）保留在控制器，归 D1-10 export 域。
 *
 * 返回契约（D1）：只返回领域数据；业务错误抛 AppError，由 controller 统一封装 HTTP 响应。
 * 未识别的异常原样向上抛，交给全局 errorHandler 归类（数据库不可用 → 503）。
 * @module services/headTeacherService
 */

const db = require('../db/db');
const { AppError } = require('../middleware/error');

class HeadTeacherService {
    /**
     * 获取班主任绑定的学生 ID 列表（teachers.student_ids 为逗号分隔字符串）
     * @param {number|string} teacherId - 班主任 ID
     * @returns {Promise<{found: boolean, studentIds: number[]}>} found=false 表示教师记录不存在
     */
    async getBoundStudentIds(teacherId) {
        const result = await db.query('SELECT student_ids FROM teachers WHERE id = $1', [teacherId]);
        if (result.rows.length === 0) {
            return { found: false, studentIds: [] };
        }

        const studentIds = String(result.rows[0].student_ids || '')
            .split(',')
            .map(s => parseInt(s.trim(), 10))
            .filter(n => !isNaN(n));

        return { found: true, studentIds };
    }

    /**
     * 获取教师关联/有排课记录的学生列表
     * @description scope=homeroom 时按班主任绑定学生取交集（跨全部授课教师）；
     *              否则传入 startDate/endDate 查该时段内本人授课的学生；无日期参数返回绑定学生（向下兼容）
     */
    async getAssociatedStudents(req) {
        const teacherId = req.user.id;
        const { startDate, endDate, scope } = req.query;
        const isHomeroomScope = scope === 'homeroom';

        // 班主任范围：绑定学生 ∩（可选）该时段内有排课记录的学生，不限授课教师
        if (isHomeroomScope) {
            const { found, studentIds } = await this.getBoundStudentIds(teacherId);
            if (!found) {
                throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到教师信息' });
            }
            if (studentIds.length === 0) {
                return [];
            }

            if (startDate && endDate) {
                // 一批学生 id 的重叠查询：派生列 student_ids && $1 一个谓词走 GIN 索引，
                // 比把几十个 id 拼成 jsonpath 分支既短也快。
                const studentsResult = await db.query(`
                    SELECT DISTINCT s.id, s.name
                    FROM course_sessions cs
                    JOIN students s ON s.id = ANY(cs.student_ids)
                    WHERE cs.student_ids && $1::int[]
                      AND s.id = ANY($1::int[])
                      AND cs.class_date BETWEEN $2 AND $3
                    ORDER BY s.name
                `, [studentIds, startDate, endDate]);
                return studentsResult.rows;
            }

            const studentsResult = await db.query(
                'SELECT id, name FROM students WHERE id = ANY($1::int[]) ORDER BY name',
                [studentIds]
            );
            return studentsResult.rows;
        }

        // 有日期参数：查询该时间段内有排课记录的学生
        if (startDate && endDate) {
            // 本人授课过的学生：teacher_ids 粗筛 + 展开学生 pair 取名
            const studentsResult = await db.query(`
                SELECT DISTINCT s.id, s.name
                FROM course_sessions cs
                JOIN students s ON s.id = ANY(cs.student_ids)
                WHERE cs.teacher_ids @> ARRAY[$1::int]
                  AND cs.class_date BETWEEN $2 AND $3
                ORDER BY s.name
            `, [teacherId, startDate, endDate]);
            return studentsResult.rows;
        }

        // 无日期参数：返回绑定的学生列表（向下兼容）
        const { found, studentIds } = await this.getBoundStudentIds(teacherId);
        if (!found) {
            throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到教师信息' });
        }

        if (studentIds.length === 0) {
            return [];
        }

        const studentsResult = await db.query(
            'SELECT id, name FROM students WHERE id = ANY($1::int[]) ORDER BY name',
            [studentIds]
        );
        return studentsResult.rows;
    }

    /**
     * 获取关联学生详细信息列表
     */
    async getAssociatedStudentsDetail(req) {
        const teacherId = req.user.id;
        const { found, studentIds } = await this.getBoundStudentIds(teacherId);
        if (!found) {
            throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到教师信息' });
        }

        if (studentIds.length === 0) {
            return [];
        }

        const studentsResult = await db.query(
            `SELECT id, username, name, profession, contact, visit_location, home_address, status, last_login
             FROM students WHERE id = ANY($1::int[]) ORDER BY name`,
            [studentIds]
        );
        return studentsResult.rows;
    }

    /**
     * 更新关联学生信息（仅限班主任绑定的学生）
     */
    async updateAssociatedStudent(req) {
        const teacherId = req.user.id;
        const studentId = req.params.id;
        const { name, profession, contact, visit_location, home_address, status } = req.body;

        if (!studentId) {
            throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '缺少学生ID' });
        }

        const { found, studentIds } = await this.getBoundStudentIds(teacherId);
        if (!found) {
            throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到教师信息' });
        }

        if (!studentIds.includes(parseInt(studentId))) {
            throw new AppError({ code: 'FORBIDDEN', statusCode: 403, message: '无权修改该学生信息' });
        }

        let sets = ['name = $1', 'profession = $2', 'contact = $3', 'visit_location = $4', 'home_address = $5'];
        let values = [name, profession, contact, visit_location, home_address];
        let vi = 6;
        if (typeof status !== 'undefined') {
            const s = Number(status);
            if (![-1, 0, 1].includes(s)) {
                throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '非法状态值' });
            }
            sets.push(`status = $${vi++}`);
            values.push(s);
        }
        values.push(parseInt(studentId));

        const result = await db.query(
            `UPDATE students
            SET ${sets.join(', ')}
            WHERE id = $${vi}
            RETURNING id, username, name, profession, contact, visit_location, home_address, status`,
            values
        );

        if (result.rows.length === 0) {
            throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到学生信息' });
        }

        return result.rows[0];
    }

    /**
     * 获取所有教师列表（用于班主任导出筛选）
     */
    async getAllTeachers(req) {
        const result = await db.query(
            `SELECT id, name FROM teachers WHERE status != -1 ORDER BY name`
        );
        return result.rows;
    }
}

module.exports = new HeadTeacherService();
