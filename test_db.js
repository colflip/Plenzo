const db = require('./src/server/db/db');

async function checkFees() {
    try {
        console.log("Connecting database...");
        const result = await db.query(`
            SELECT id, date, arr_date, class_date, teacher_id, student_id, start_time, transport_fee, other_fee 
            FROM course_arrangement 
            WHERE arr_date >= '2026-02-23' OR class_date >= '2026-02-23' OR date >= '2026-02-23' 
            ORDER BY date ASC 
            LIMIT 10
        `);
        console.log("Recent schedules:", result.rows);
    } catch(err) {
        console.error("DB Error:", err);
    } finally {
        process.exit(0);
    }
}
checkFees();
