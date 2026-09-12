'use strict';

function createAccess(pool) {
  async function teacherObject(teacherId, kind, id) {
    const table = { session: 'mubahatha_sessions', slot: 'schedule_slots', group: 'mubahatha_groups' }[kind];
    if (!table || !Number.isSafeInteger(Number(id))) return false;
    const join = kind === 'group' ? 'JOIN mubahatha_groups g ON g.id=o.id' : 'JOIN mubahatha_groups g ON g.id=o.group_id';
    const r = await pool.query(`SELECT 1 FROM ${table} o ${join}
      JOIN stage_seasons ss ON ss.id=g.stage_season_id AND ss.is_active=true
      JOIN teaching_assignments ta ON ta.subject_id=g.subject_id AND ta.stage_season_id=g.stage_season_id
      JOIN teachers t ON t.id=ta.teacher_id AND t.is_active=true
      WHERE o.id=$1 AND t.id=$2 AND g.is_active=true`, [id, teacherId]);
    return Boolean(r.rows[0]);
  }
  async function studentSubject(studentId, subjectId, seasonId) {
    const r = await pool.query(`SELECT 1 FROM students st JOIN enrollments e ON e.student_id=st.id
      JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
      JOIN subjects sub ON sub.stage_id=ss.stage_id
      WHERE st.id=$1 AND sub.id=$2 AND ss.id=$3 AND st.is_active=true AND e.status='active'`,
    [studentId, subjectId, seasonId]);
    return Boolean(r.rows[0]);
  }
  async function reportMatches(reportId, studentId, subjectId, seasonId) {
    const r = await pool.query(`SELECT 1 FROM student_reports
      WHERE id=$1 AND student_id=$2 AND subject_id=$3 AND stage_season_id=$4`,
    [reportId, studentId, subjectId, seasonId]);
    return Boolean(r.rows[0]);
  }
  return { teacherObject, studentSubject, reportMatches };
}
module.exports = { createAccess };
