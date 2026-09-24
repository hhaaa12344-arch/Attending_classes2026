'use strict';
async function queueDailyLessons(pool,{stageId,onDate,text,extra={},excluded=[],expiresAt}) {
  if(!expiresAt)throw new Error('وقت انتهاء تسجيل الحضور مطلوب.');
  await pool.query(`UPDATE notification_outbox SET expires_at=GREATEST(expires_at,$3::timestamptz)
    WHERE dedupe_key LIKE 'daily:'||$1::text||':'||$2::text||':%' AND status IN ('pending','sent')
      AND deleted_at IS NULL`,[stageId,onDate,expiresAt]);
  const r=await pool.query(`WITH eligible AS (
    SELECT st.id,st.telegram_id FROM students st JOIN enrollments e ON e.student_id=st.id AND e.status='active'
    JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true AND ss.stage_id=$1
    WHERE st.stage_id=$1 AND st.is_active=true AND NOT(st.id=ANY($4::int[]))
      AND NOT EXISTS(SELECT 1 FROM student_leaves sl WHERE sl.student_id=st.id AND sl.status='approved'
        AND sl.stage_season_id=ss.id AND $2::date BETWEEN sl.start_date AND sl.end_date)
  ), claimed AS (
    INSERT INTO student_daily_lesson_notifications(student_id,stage_id,notification_date)
    SELECT id,$1,$2::date FROM eligible ON CONFLICT DO NOTHING RETURNING student_id
  ) INSERT INTO notification_outbox(dedupe_key,chat_id,payload,priority,expires_at)
    SELECT 'daily:'||$1::text||':'||$2::text||':'||e.id::text,e.telegram_id,$3::jsonb,9,
      $5::timestamptz
    FROM eligible e JOIN claimed c ON c.student_id=e.id ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
  [stageId,onDate,JSON.stringify([text,extra]),excluded,expiresAt]);
  return {queued:r.rowCount,total:r.rowCount,delivered:0};
}
module.exports={queueDailyLessons};
