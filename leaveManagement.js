'use strict';
const {appError}=require('./integrity');
const {enqueueNotification}=require('./outbox');
const {refreshAdministrativeAttendance}=require('./absence');
const day=value=>new Date(value).toISOString().slice(0,10);

// Called under the absence advisory lock and the student's row lock.
async function refreshLeaveAttendance(c,leave) {
  const seasons=(await c.query(`WITH revised AS (SELECT d.id,
    EXISTS(SELECT 1 FROM student_leaves l WHERE l.student_id=d.student_id
      AND (l.stage_season_id=d.stage_season_id OR l.stage_season_id IS NULL)
      AND l.status IN ('approved','ended') AND d.attendance_date BETWEEN l.start_date AND l.end_date) AS excused
    FROM student_attendance_days d WHERE d.student_id=$1 AND ($2::int IS NULL OR d.stage_season_id=$2))
    UPDATE student_attendance_days d SET is_excused_leave=r.excused,
      is_full_absence=(NOT r.excused AND d.attended_on_time_count=0) FROM revised r WHERE r.id=d.id
    RETURNING d.stage_season_id`,[leave.student_id,leave.stage_season_id])).rows;
  for(const seasonId of new Set(seasons.map(r=>r.stage_season_id))) {
    await refreshAdministrativeAttendance(c,[leave.student_id],seasonId,process.env.ATTENDANCE_TIME_ZONE||'Asia/Baghdad');
  }
}

function createLeaveManagement(pool) {
  async function adjustLeave(leaveId,{cancel=false,days,expectedDays,expectedStatus},actorId) {
    if(typeof cancel!=='boolean')throw appError('حدد إجراء الإجازة.');
    if(!cancel&&(!Number.isInteger(Number(days))||Number(days)<1))throw appError('أدخل عددًا صحيحًا موجبًا للأيام.');
    if(!Number.isInteger(Number(expectedDays))||!['pending','approved','ended'].includes(expectedStatus))throw appError('حدّث بيانات الإجازة قبل تعديلها.','CONFLICT',409);
    const c=await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(734221,1)');
      await c.query('SELECT id FROM students WHERE id=(SELECT student_id FROM student_leaves WHERE id=$1) FOR UPDATE',[leaveId]);
      const before=(await c.query('SELECT * FROM student_leaves WHERE id=$1 FOR UPDATE',[leaveId])).rows[0];
      if(!before)throw appError('الإجازة غير موجودة.','NOT_FOUND',404);
      if(before.days!==Number(expectedDays)||before.status!==expectedStatus)throw appError('تغيّرت الإجازة. حدّث الصفحة قبل تعديلها.','CONFLICT',409);
      if(!cancel&&Number(days)>=before.days)throw appError('العدد الجديد يجب أن يكون أقل من عدد الأيام الحالي.');
      const after=(await c.query(`UPDATE student_leaves SET
        status=CASE WHEN $2 THEN 'cancelled' ELSE status END,
        days=CASE WHEN $2 THEN days ELSE $3::int END,
        end_date=CASE WHEN $2 THEN end_date ELSE start_date+($3::int-1) END,
        decided_at=now(),decided_by=$4,backlog_notified=false WHERE id=$1 RETURNING *`,[leaveId,cancel,cancel?before.days:Number(days),actorId])).rows[0];
      await refreshLeaveAttendance(c,after);
      await c.query(`UPDATE notification_outbox SET status='expired' WHERE status='pending'
        AND (dedupe_key=$1 OR dedupe_key LIKE $2)`,[`leave:${leaveId}:decision`,`leave:${leaveId}:adjust:%`]);
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,$2,'leave',$3,$4::jsonb,$5::jsonb)`,[actorId,cancel?'cancel_leave':'reduce_leave',leaveId,JSON.stringify(before),JSON.stringify(after)]);
      const st=(await c.query('SELECT telegram_id FROM students WHERE id=$1',[after.student_id])).rows[0];
      await enqueueNotification(c,{key:`leave:${leaveId}:adjust:${before.status}:${before.days}:${cancel?'cancel':after.days}`,chatId:st.telegram_id,
        text:cancel?`ألغت الإدارة إجازتك (${day(before.start_date)} → ${day(before.end_date)}). لم تعد هذه الفترة معفاة من الغياب بسبب هذه الإجازة.`:
          `عدّلت الإدارة إجازتك إلى ${after.days} يومًا (${day(after.start_date)} → ${day(after.end_date)}).`+(after.status==='pending'?' الطلب ما زال قيد المراجعة.':' الإعفاء من الغياب يقتصر على الفترة المعدلة.')});
      await c.query('COMMIT');return after;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  return {adjustLeave};
}
module.exports={createLeaveManagement,refreshLeaveAttendance};
