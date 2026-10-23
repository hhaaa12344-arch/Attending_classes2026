'use strict';
// All exam deadlines are stored as UTC in TIMESTAMP WITHOUT TIME ZONE columns.
// The PostgreSQL session is pinned to UTC in db.js; do not use the host clock timezone.
function createExamNotifications(pool){
  async function tick(){
    const exams=(await pool.query(`SELECT e.id,e.title,e.exam_number,e.opens_at,e.closes_at,
      e.stage_season_id,sub.name AS subject_name FROM exams e
      JOIN subjects sub ON sub.id=e.subject_id
      JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
      WHERE e.status='published' AND (
         (e.opens_at<=now() AND e.closes_at>now())
         OR EXISTS(SELECT 1 FROM exam_student_windows w WHERE w.exam_id=e.id
              AND w.opens_at<=now() AND w.closes_at>now()))
      ORDER BY e.id LIMIT 150`)).rows;
    let total=0;
    for(const e of exams){
      const label=`«${e.title||'الشهري '+e.exam_number}» في مادة «${e.subject_name}»`;
      const extra={reply_markup:{inline_keyboard:[[{text:'📝 أداء الامتحان الآن',callback_data:`stex_start:${e.id}`}]]}};
      const normalEnd=new Date(e.closes_at).toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad',hour12:false});
      for(const phase of ['start','reminder']){
        const text=phase==='start'?`🟢 بدأ الآن الامتحان ${label}.\nيمكنك الدخول بواسطة الزر.\nموعد الإغلاق: ${normalEnd} بتوقيت بغداد.`:
          `⏰ بقي أقل من ساعة على انتهاء الامتحان ${label}.\nإذا لم تؤدِّه بعد، اضغط الزر الآن.\nالإغلاق: ${normalEnd} بتوقيت بغداد.`;
        const r=await pool.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,expires_at)
          SELECT $1||':'||st.id::text,st.telegram_id,$2::jsonb,$3
          FROM enrollments en JOIN students st ON st.id=en.student_id AND st.is_active=true
          WHERE en.stage_season_id=$4 AND en.status='active' AND en.started_at<=now()
            AND (en.ended_at IS NULL OR en.ended_at>now())
            AND st.telegram_id IS NOT NULL
            AND $7::boolean AND NOT EXISTS (SELECT 1 FROM exam_attempts a
              WHERE a.exam_id=$5 AND a.student_id=st.id AND a.submitted_at IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM exam_student_windows w
              WHERE w.exam_id=$5 AND w.student_id=st.id AND w.closes_at>($3::timestamp))
            AND ($6::boolean=false OR $3::timestamp<=now()+interval '1 hour')
          ON CONFLICT(dedupe_key) DO NOTHING`,[
          `exam-${phase}:${e.id}`,JSON.stringify([text,extra]),e.closes_at,e.stage_season_id,e.id,phase==='reminder',new Date(e.closes_at)>new Date()]);
        total+=r.rowCount;
      }
      // Individual extensions after the original exam; versioned by window update
      // so an adjusted window can generate a new notice but not duplicate an old one.
      const windows=(await pool.query(`SELECT w.student_id,w.opens_at,w.closes_at,w.updated_at,
          st.telegram_id FROM exam_student_windows w
          JOIN students st ON st.id=w.student_id AND st.is_active=true
          JOIN enrollments en ON en.student_id=st.id AND en.stage_season_id=$2
            AND en.status='active' AND en.started_at<=now()
            AND (en.ended_at IS NULL OR en.ended_at>now())
          WHERE w.exam_id=$1 AND w.opens_at<=now() AND w.closes_at>now()
            AND NOT EXISTS (SELECT 1 FROM exam_attempts a
              WHERE a.exam_id=w.exam_id AND a.student_id=w.student_id AND a.submitted_at IS NOT NULL)
          ORDER BY w.student_id LIMIT 2000`,[e.id,e.stage_season_id])).rows;
      for(const w of windows){
        const version=new Date(w.updated_at).getTime();
        const closes=new Date(w.closes_at).toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad',hour12:false});
        for(const phase of ['start','reminder']){
          if(phase==='reminder'&&new Date(w.closes_at).getTime()-Date.now()>3600000)continue;
          const text=phase==='start'?`🟢 فُتح لك الامتحان ${label} بفرصة إضافية.\nالإغلاق: ${closes} بتوقيت بغداد.\nاضغط الزر للدخول.`:
            `⏰ بقي أقل من ساعة على إغلاق فرصتك الإضافية للامتحان ${label}.\nالإغلاق: ${closes} بتوقيت بغداد.`;
          const r=await pool.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,expires_at)
            VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(dedupe_key) DO NOTHING`,[
            `exam-window-${phase}:${e.id}:${w.student_id}:${version}`,w.telegram_id,JSON.stringify([text,extra]),w.closes_at]);
          total+=r.rowCount;
        }
      }
    }
    return total;
  }
  return {tick};
}
module.exports={createExamNotifications};
