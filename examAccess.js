'use strict';
// All callers use database time and a half-open interval: start <= now < end.
// Arguments are internal SQL aliases/expressions, never request input.
function examWindowSql(exam,student) {
  return `((${exam}.opens_at <= now() AND ${exam}.closes_at > now()) OR EXISTS (
    SELECT 1 FROM exam_student_windows ew WHERE ew.exam_id=${exam}.id AND ew.student_id=${student}
      AND ew.opens_at <= now() AND ew.closes_at > now()))`;
}
const enrollmentSql = `en.status='active' AND en.started_at<=now() AND (en.ended_at IS NULL OR en.ended_at>now())
  AND st.is_active=true AND st.stage_id=ss.stage_id AND ss.is_active=true`;
module.exports={examWindowSql,enrollmentSql};
