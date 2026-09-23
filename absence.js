'use strict';
async function processCompletedDays(pool,timeZone) {
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(734221,1)');
    // Group deadlines before expanding students. A later closed day never causes
    // an earlier still-open day to be permanently skipped by a global cursor.
    const inserted=await c.query(`WITH days AS (
      SELECT l.stage_season_id,((l.activated_at AT TIME ZONE 'UTC') AT TIME ZONE $1)::date AS day,
        MAX(l.active_until) AS deadline
      FROM lessons l JOIN stage_seasons ss ON ss.id=l.stage_season_id AND ss.is_active=true
      GROUP BY l.stage_season_id,((l.activated_at AT TIME ZONE 'UTC') AT TIME ZONE $1)::date
    ), pending AS (
      SELECT e.student_id,e.stage_season_id,e.started_at,e.ended_at,d.day
      FROM days d JOIN enrollments e ON e.stage_season_id=d.stage_season_id AND e.status='active'
      JOIN students st ON st.id=e.student_id AND st.is_active=true
      JOIN absence_monitoring_config cfg ON cfg.id=1
      WHERE d.deadline<=now()
        AND d.day>=((cfg.started_at AT TIME ZONE 'UTC') AT TIME ZONE $1)::date
        AND NOT EXISTS(SELECT 1 FROM student_attendance_days a WHERE a.student_id=e.student_id AND a.stage_season_id=e.stage_season_id AND a.attendance_date=d.day)
        -- Wait for earlier unfinished days before emitting a consecutive-streak alert.
        AND NOT EXISTS(SELECT 1 FROM days earlier WHERE earlier.stage_season_id=d.stage_season_id AND earlier.day<d.day
          AND earlier.day>=((e.started_at AT TIME ZONE 'UTC') AT TIME ZONE $1)::date AND earlier.deadline>now())
    ), totals AS (
      SELECT p.student_id,p.stage_season_id,p.day,COUNT(l.id)::int AS lesson_count,
        COUNT(a.id) FILTER(WHERE a.listened_at<=l.active_until OR a.marking_kind='admin_late')::int AS attended,
        EXISTS(SELECT 1 FROM student_leaves sl WHERE sl.student_id=p.student_id
          AND (sl.stage_season_id=p.stage_season_id OR sl.stage_season_id IS NULL)
          AND sl.status IN ('approved','ended') AND p.day BETWEEN sl.start_date AND sl.end_date) AS excused
      FROM pending p JOIN lessons l ON l.stage_season_id=p.stage_season_id
        AND ((l.activated_at AT TIME ZONE 'UTC') AT TIME ZONE $1)::date=p.day
        AND l.activated_at>=p.started_at AND (p.ended_at IS NULL OR l.activated_at<=p.ended_at)
      LEFT JOIN attendance a ON a.student_id=p.student_id AND a.lesson_id=l.id
      GROUP BY p.student_id,p.stage_season_id,p.day
    ) INSERT INTO student_attendance_days(student_id,stage_season_id,attendance_date,lesson_count,attended_on_time_count,
      missed_lesson_count,is_excused_leave,is_full_absence)
    SELECT student_id,stage_season_id,day,lesson_count,attended,lesson_count-attended,excused,NOT excused AND attended=0 FROM totals
    ON CONFLICT(student_id,stage_season_id,attendance_date) DO NOTHING RETURNING *`,[timeZone]);
    if(inserted.rows.length){
      await c.query(`INSERT INTO absence_dirty_students(student_id,stage_season_id)
        SELECT DISTINCT student_id,stage_season_id FROM jsonb_to_recordset($1::jsonb) AS x(student_id int,stage_season_id int)
        ON CONFLICT DO NOTHING`,[JSON.stringify(inserted.rows.map(x=>({student_id:x.student_id,stage_season_id:x.stage_season_id})))]);
    }
    await c.query(`WITH ordered AS (
      SELECT d.*,SUM(CASE WHEN NOT d.is_full_absence AND NOT d.is_excused_leave THEN 1 ELSE 0 END)
        OVER(PARTITION BY d.student_id,d.stage_season_id ORDER BY d.attendance_date) AS break_group
      FROM student_attendance_days d JOIN absence_dirty_students dirty
        ON dirty.student_id=d.student_id AND dirty.stage_season_id=d.stage_season_id
    ), streaks AS (
      SELECT id,CASE WHEN is_full_absence THEN COUNT(*) FILTER(WHERE is_full_absence)
        OVER(PARTITION BY student_id,stage_season_id,break_group ORDER BY attendance_date) ELSE 0 END::int AS streak FROM ordered
    ) UPDATE student_attendance_days d SET absence_streak=s.streak FROM streaks s WHERE s.id=d.id AND d.absence_streak<>s.streak`);
    await c.query('DELETE FROM absence_dirty_students');
    await c.query('COMMIT');return inserted.rows;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
// Called inside the admin transaction under the same advisory lock as the scheduler.
async function refreshAdministrativeAttendance(c,studentIds,seasonId,timeZone) {
  await c.query(`WITH counts AS (
    SELECT d.id,COUNT(a.id) FILTER (WHERE a.listened_at<=l.active_until OR a.marking_kind='admin_late')::int AS attended
    FROM student_attendance_days d JOIN enrollments en ON en.student_id=d.student_id AND en.stage_season_id=d.stage_season_id
    JOIN lessons l ON l.stage_season_id=d.stage_season_id
      AND ((l.activated_at AT TIME ZONE 'UTC') AT TIME ZONE $3)::date=d.attendance_date
      AND l.activated_at>=en.started_at AND (en.ended_at IS NULL OR l.activated_at<=en.ended_at)
    LEFT JOIN attendance a ON a.lesson_id=l.id AND a.student_id=d.student_id
    WHERE d.student_id=ANY($1::int[]) AND d.stage_season_id=$2 GROUP BY d.id
  ) UPDATE student_attendance_days d SET attended_on_time_count=counts.attended,
    missed_lesson_count=GREATEST(0,d.lesson_count-counts.attended),is_full_absence=(NOT d.is_excused_leave AND counts.attended=0)
    FROM counts WHERE d.id=counts.id`,[studentIds,seasonId,timeZone]);
  await c.query(`WITH ordered AS (
    SELECT d.*,SUM(CASE WHEN NOT d.is_full_absence AND NOT d.is_excused_leave THEN 1 ELSE 0 END)
      OVER(PARTITION BY d.student_id,d.stage_season_id ORDER BY d.attendance_date) AS break_group
    FROM student_attendance_days d WHERE student_id=ANY($1::int[]) AND stage_season_id=$2
  ), streaks AS (
    SELECT id,CASE WHEN is_full_absence THEN COUNT(*) FILTER(WHERE is_full_absence)
      OVER(PARTITION BY student_id,stage_season_id,break_group ORDER BY attendance_date) ELSE 0 END::int AS streak FROM ordered
  ) UPDATE student_attendance_days d SET absence_streak=s.streak FROM streaks s WHERE s.id=d.id`,[studentIds,seasonId]);
  // Withdraw pending snapshots; the existing scheduler can queue corrected notices.
  const withdrawn=await c.query(`DELETE FROM notification_outbox o WHERE o.status='pending' AND (
    (o.delivery_mark->>'kind'='student_absence' AND (o.delivery_mark->>'id')::bigint IN
      (SELECT id FROM student_attendance_days WHERE student_id=ANY($1::int[]) AND stage_season_id=$2))
    OR (o.delivery_mark->>'kind'='admin_absence' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(o.delivery_mark->'ids') item(id)
      JOIN student_attendance_days d ON d.id=item.id::bigint WHERE d.student_id=ANY($1::int[]) AND d.stage_season_id=$2)))
    RETURNING delivery_mark`,[studentIds,seasonId]);
  const resetIds=withdrawn.rows.flatMap(r=>r.delivery_mark?.kind==='admin_absence'?r.delivery_mark.ids:[]);
  if(resetIds.length)await c.query('UPDATE student_attendance_days SET admin_alert_queued_at=NULL WHERE id=ANY($1::bigint[]) AND admin_alert_sent_at IS NULL',[resetIds]);
}
module.exports={processCompletedDays,refreshAdministrativeAttendance};
