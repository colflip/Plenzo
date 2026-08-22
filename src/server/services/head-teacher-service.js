/**
 * 班主任（head-teacher / homeroom）服务
 * @description 班主任关联学生的查询、详情、信息更新，以及教师列表（导出筛选用）。
 *              统计/总览（stats）与排课（schedules）逻辑分别在 schedule-service；
 *              班主任学生数据导出（流式 xlsx）保留在控制器，归 D1-10 export 域。
 * @module services/headTeacherService
 */

const db = require('../db/db');
const SchemaHelper = require('../utils/schema-helper');
const logger = require('../utils/logger');
const { standardResponse } = require('../middleware/validation');

class HeadTeacherService {
    /**
     * 获取教师关联/有排课记录的学生列表
     * @description 传入 startDate/endDate 时查该时段内有排课的学生；否则返回班主任绑定学生（向下兼容）
     */
    async getAssociatedStudents(req) {
        try {
            const teacherId = req.user.id;
            const { startDate, endDate } = req.query;

            // 有日期参数：查询该时间段内有排课记录的学生
            if (startDate && endDate) {
                const dateExpr = await SchemaHelper.getDateExpr('ca');
                const studentsResult = await db.query(`
                    SELECT DISTINCT s.id, s.name
                    FROM course_arrangement ca
                    JOIN students s ON ca.student_id = s.id
                    WHERE ca.teacher_id = $1
                      AND ${dateExpr}::date BETWEEN $2 AND $3
                    ORDER BY s.name
                `, [teacherId, startDate, endDate]);
                return { status: 200, body: standardResponse(true, studentsResult.rows, '获取学生列表成功') };
            }

            // 无日期参数：返回绑定的学生列表（向下兼容）
            const teacherResult = await db.query('SELECT student_ids FROM teachers WHERE id = $1', [teacherId]);
            if (teacherResult.rows.length === 0) {
                return { status: 404, body: standardResponse(false, null, '未找到教师信息') };
            }

            const studentIdsStr = teacherResult.rows[0].student_ids || '';
            const studentIds = studentIdsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

            if (studentIds.length === 0) {
                return { status: 200, body: standardResponse(true, [], '未绑定学生') };
            }

            const studentsResult = await db.query(
                'SELECT id, name FROM students WHERE id = ANY($1::int[]) ORDER BY name',
                [studentIds]
            );
            return { status: 200, body: standardResponse(true, studentsResult.rows, '获取学生列表成功') };
        } catch (error) {
            logger.error('获取学生列表错误:', error);
            return { status: 500, body: standardResponse(false, null, '服务器错误') };
        }
    }

    /**
     * 获取关联学生详细信息列表
     */
    async getAssociatedStudentsDetail(req) {
        try {
            const teacherId = req.user.id;
            const teacherResult = await db.query('SELECT student_ids FROM teachers WHERE id = $1', [teacherId]);
            if (teacherResult.rows.length === 0) {
                return { status: 404, body: standardResponse(false, null, '未找到教师信息') };
            }

            const studentIdsStr = teacherResult.rows[0].student_ids || '';
            const studentIds = studentIdsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

            if (studentIds.length === 0) {
                return { status: 200, body: standardResponse(true, [], '未绑定学生') };
            }

            const studentsResult = await db.query(
                `SELECT id, username, name, profession, contact, visit_location, home_address, status, last_login 
                 FROM students WHERE id = ANY($1::int[]) ORDER BY name`,
                [studentIds]
            );
            return { status: 200, body: standardResponse(true, studentsResult.rows, '获取学生详细信息成功') };
        } catch (error) {
            logger.error('获取关联学生详细信息错误:', error);
            return { status: 500, body: standardResponse(false, null, '服务器错误') };
        }
    }

    /**
     * 更新关联学生信息（仅限班主任绑定的学生）
     */
    async updateAssociatedStudent(req) {
        try {
            const teacherId = req.user.id;
            const studentId = req.params.id;
            const { name, profession, contact, visit_location, home_address, status } = req.body;

            if (!studentId) {
                return { status: 400, body: standardResponse(false, null, '缺少学生ID') };
            }

            const teacherResult = await db.query('SELECT student_ids FROM teachers WHERE id = $1', [teacherId]);
            if (teacherResult.rows.length === 0) {
                return { status: 404, body: standardResponse(false, null, '未找到教师信息') };
            }

            const studentIdsStr = teacherResult.rows[0].student_ids || '';
            const studentIds = studentIdsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

            if (!studentIds.includes(parseInt(studentId))) {
                return { status: 403, body: standardResponse(false, null, '无权修改该学生信息') };
            }

            let sets = ['name = $1', 'profession = $2', 'contact = $3', 'visit_location = $4', 'home_address = $5'];
            let values = [name, profession, contact, visit_location, home_address];
            let vi = 6;
            if (typeof status !== 'undefined') {
                const s = Number(status);
                if (![-1, 0, 1].includes(s)) {
                    return { status: 400, body: standardResponse(false, null, '非法状态值') };
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
                return { status: 404, body: standardResponse(false, null, '未找到学生信息') };
            }

            return { status: 200, body: standardResponse(true, result.rows[0], '学生信息更新成功') };
        } catch (error) {
            logger.error('更新关联学生信息错误:', error);
            return { status: 500, body: standardResponse(false, null, '服务器错误') };
        }
    }

    /**
     * 获取所有教师列表（用于班主任导出筛选）
     */
    async getAllTeachers(req) {
        try {
            const result = await db.query(
                `SELECT id, name FROM teachers WHERE status != -1 ORDER BY name`
            );
            return { status: 200, body: standardResponse(true, result.rows, '获取教师列表成功') };
        } catch (error) {
            logger.error('获取教师列表错误:', error);
            return { status: 500, body: standardResponse(false, null, '服务器错误') };
        }
    }
}

module.exports = new HeadTeacherService();
