'use strict';
// إصلاح اتساق التسجيل: يجب أن يطابق تسجيل الطالب النشط مرحلته الحالية (students.stage_id).
// إن بقي تسجيل نشط في مرحلة أخرى (مثلًا تغيّرت مرحلته دون إغلاق تسجيله القديم) فسيرى مواد مرحلته السابقة.
// قاعدة البيانات تسمح بتسجيل نشط واحد فقط للطالب، لذلك نغلق القديم أولًا ثم ننشئ التسجيل الصحيح.
async function repairEnrollments(pool) {
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    const closed=(await c.query(`UPDATE enrollments e SET status='moved',ended_at=COALESCE(e.ended_at,now())
      FROM stage_seasons ss,students st
      WHERE ss.id=e.stage_season_id AND st.id=e.student_id AND e.status='active' AND ss.stage_id<>st.stage_id
        AND EXISTS(SELECT 1 FROM stage_seasons cur WHERE cur.stage_id=st.stage_id AND cur.is_active=true)
      RETURNING e.student_id`)).rows.map((r)=>r.student_id);
    let created=0;
    if(closed.length)created=(await c.query(`INSERT INTO enrollments(student_id,stage_season_id,status)
      SELECT st.id,ss.id,'active' FROM students st
      JOIN stage_seasons ss ON ss.stage_id=st.stage_id AND ss.is_active=true
      WHERE st.id=ANY($1::int[]) AND st.is_active=true
      ON CONFLICT(student_id,stage_season_id) DO UPDATE SET status='active',ended_at=NULL,started_at=now()
      RETURNING student_id`,[closed])).rowCount;
    await c.query('COMMIT');
    return {closed:closed.length,created};
  } catch(err){await c.query('ROLLBACK');throw err;} finally{c.release();}
}
module.exports={repairEnrollments};
