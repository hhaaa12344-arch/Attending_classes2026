'use strict';
const {positiveInt,appError}=require('./integrity');
function createLessonRecovery(db){
  async function restore(id,subjectId,{scheduleDate=null,actorId=null}={}){
    id=positiveInt(id);subjectId=positiveInt(subjectId);
    if(scheduleDate&&!/^\d{4}-\d{2}-\d{2}$/.test(scheduleDate))throw appError('تاريخ الجدول غير صالح.');
    const c=await db.pool.connect();
    try{
      await c.query('BEGIN');
      const p=(await c.query(`SELECT p.*,ss.is_active AS season_active,st.is_active AS stage_active
        FROM pending_channel_lesson_posts p JOIN stage_seasons ss ON ss.id=p.stage_season_id
        JOIN stages st ON st.id=p.stage_id WHERE p.id=$1 FOR UPDATE OF p FOR SHARE OF ss,st`,[id])).rows[0];
      if(!p)throw appError('المنشور المعلّق غير موجود.','NOT_FOUND',404);
      if(!p.season_active||!p.stage_active)throw appError('لا يمكن استرجاع درس في مرحلة أو موسم مؤرشف.','ARCHIVED',409);
      const subject=(await c.query('SELECT * FROM subjects WHERE id=$1 AND stage_id=$2 FOR SHARE',[subjectId,p.stage_id])).rows[0];
      if(!subject)throw appError('اختر مادة من مرحلة المنشور نفسه.');
      const existing=(await c.query('SELECT * FROM lessons WHERE source_chat_id=$1 AND source_message_id=$2',[p.telegram_chat_id,p.source_message_id])).rows[0];
      if(existing){
        await c.query("UPDATE pending_channel_lesson_posts SET status='duplicate',lesson_id=$2,resolved_subject_id=$3,resolved_at=now() WHERE id=$1 AND status='pending'",[id,existing.id,existing.subject_id]);
        await c.query('COMMIT');return {lesson:existing,created:false};
      }
      if(p.status!=='pending')throw appError('عولج المنشور سابقًا.','CONFLICT',409);
      if(!(await c.query('SELECT 1 FROM channels WHERE telegram_chat_id=$1 AND stage_id=$2 AND stage_season_id=$3',[p.telegram_chat_id,p.stage_id,p.stage_season_id])).rows[0])throw appError('تغيّر ربط القناة؛ راجع المرحلة قبل استرجاع المنشور.','CHANNEL_CHANGED',409);
      if(scheduleDate){
        await c.query('SELECT pg_advisory_xact_lock(734225,$1)',[p.stage_season_id]);
        if(!(await db.getPendingScheduledSubjectsForDate(p.stage_season_id,scheduleDate,c)).some(x=>x.id===subjectId)){
          await c.query('COMMIT');return {created:false,skipped:true};
        }
      }
      const now=(await c.query('SELECT now() AS at')).rows[0].at;
      if(new Date(p.received_at)>new Date(now))throw appError('تاريخ نشر الدرس لم يحن بعد.');
      const lesson=await db.activateLesson(subjectId,24,'channel_schedule_recovered',p.source_url,
        p.telegram_chat_id,p.source_message_id,p.received_at,{client:c,attendanceOpenedAt:now,scheduleDate:scheduleDate||null});
      if(!lesson)throw appError('لم تعد المرحلة متاحة.','ARCHIVED',409);
      await c.query("UPDATE pending_channel_lesson_posts SET status='activated',lesson_id=$2,resolved_subject_id=$3,resolved_at=now() WHERE id=$1",[id,lesson.id,subjectId]);
      await c.query(`UPDATE channel_post_activity SET last_outcome='activated_after_schedule',last_detail='استُرجع الدرس مع حفظ تاريخ نشره وإتاحة الحضور 24 ساعة من الاسترجاع',last_lesson_id=$3
        WHERE telegram_chat_id=$1 AND last_message_id=$2`,[p.telegram_chat_id,p.source_message_id,lesson.id]);
      const text=`📚 استُرجع درس «${subject.name}» المنشور في ${new Date(p.received_at).toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad'})}.\nالحضور متاح حتى ${new Date(lesson.active_until).toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad'})}.\nافتح الدرس ثم سجّل الاستماع بعد إتمامه.`;
      const buttons=[];
      if(/^https:\/\//i.test(p.source_url||''))buttons.push([{text:'فتح الدرس',url:p.source_url}]);
      buttons.push([{text:'✅ تم الاستماع',callback_data:'attend:'+lesson.id}]);
      const payload=JSON.stringify([text,{reply_markup:{inline_keyboard:buttons}}]);
      const notices=(await c.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,expires_at)
        SELECT 'lesson-recovered:'||$1||':'||st.id,st.telegram_id,$2::jsonb,$3 FROM students st
        JOIN enrollments e ON e.student_id=st.id AND e.stage_season_id=$4 AND e.status='active'
        WHERE st.stage_id=$5 AND st.is_active=true AND NOT EXISTS(SELECT 1 FROM student_leaves sl
          WHERE sl.student_id=st.id AND sl.status='approved' AND (now() AT TIME ZONE 'Asia/Baghdad')::date BETWEEN sl.start_date AND sl.end_date)
        ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,[lesson.id,payload,lesson.active_until,p.stage_season_id,p.stage_id])).rows.length;
      if(actorId)await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,'restore_pending_lesson','lesson',$2,$3::jsonb,$4::jsonb)`,[positiveInt(actorId),lesson.id,JSON.stringify(p),JSON.stringify(lesson)]);
      await c.query('COMMIT');return {lesson,created:true,queued:notices};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  return {restore};
}
module.exports={createLessonRecovery};
