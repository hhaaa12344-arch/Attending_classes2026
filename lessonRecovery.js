'use strict';
const {positiveInt,appError}=require('./integrity');
function createLessonRecovery(db){
  async function notice(c,lesson,subject,stageId,prefix='lesson-recovered'){
    const text=`📚 أُتيح درس «${subject}» لمدة 24 ساعة.\nافتح الدرس ثم سجّل الاستماع. الحضور السابق محفوظ.`;
    const buttons=[];
    if(/^https:\/\//i.test(lesson.source_url||''))buttons.push([{text:'فتح الدرس',url:lesson.source_url}]);
    buttons.push([{text:'✅ تم الاستماع',callback_data:'attend:'+lesson.id}]);
    return (await c.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,expires_at,priority)
      SELECT $6||':'||$1||':'||st.id,st.telegram_id,$2::jsonb,$3,2 FROM students st
      JOIN enrollments e ON e.student_id=st.id AND e.stage_season_id=$4 AND e.status='active'
      WHERE st.stage_id=$5 AND st.is_active=true AND NOT EXISTS(SELECT 1 FROM student_leaves sl WHERE sl.student_id=st.id
        AND sl.status='approved' AND (now() AT TIME ZONE 'Asia/Baghdad')::date BETWEEN sl.start_date AND sl.end_date)
      ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,[lesson.id,JSON.stringify([text,{reply_markup:{inline_keyboard:buttons}}]),lesson.active_until,lesson.stage_season_id,stageId,prefix])).rows.length;
  }
  function publicationDate(value){
    if(!value)return null;
    return require('./adminOverrides').windowDates({opensAt:value,closesAt:'9999-12-31T23:59:59Z'}).start;
  }
  async function restoreExisting(id,{expectedSubjectId}={},actorId){
    id=positiveInt(id);expectedSubjectId=positiveInt(expectedSubjectId);
    const c=await db.pool.connect();
    try{
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(734221,1)');
      const before=(await c.query(`SELECT l.*,sub.name AS subject_name,sub.stage_id,ss.is_active AS season_active,st.is_active AS stage_active
        FROM effective_lessons l JOIN subjects sub ON sub.id=l.subject_id JOIN stage_seasons ss ON ss.id=l.stage_season_id JOIN stages st ON st.id=sub.stage_id
        WHERE l.id=$1 FOR UPDATE OF l FOR SHARE OF ss,st`,[id])).rows[0];
      if(!before)throw appError('الدرس غير موجود.','NOT_FOUND',404);
      if(!before.season_active||!before.stage_active)throw appError('الموسم مؤرشف.','ARCHIVED',409);
      if(before.subject_id!==expectedSubjectId)throw appError('تغيرت مادة الدرس. حدّث الصفحة.','CONFLICT',409);
      if(before.republished_at){await c.query('COMMIT');return {lesson:before,created:false};}
      if(!(await c.query('SELECT 1 FROM effective_lessons WHERE id=$1 AND activated_at<=now() AND active_until<=now()',[id])).rows.length)throw appError('إعادة النشر متاحة للدرس المنتهي فقط.','NOT_EXPIRED',409);
      const lesson=(await c.query(`UPDATE lessons SET republished_at=now(),active_until=now()+interval '24 hours',reminder_sent=false WHERE id=$1 RETURNING *`,[id])).rows[0];
      const queued=await notice(c,lesson,before.subject_name,before.stage_id,'lesson-republished');
      const students=(await c.query('SELECT student_id FROM enrollments WHERE stage_season_id=$1',[lesson.stage_season_id])).rows.map(r=>r.student_id);
      await require('./absence').refreshAdministrativeAttendance(c,students,lesson.stage_season_id,process.env.ATTENDANCE_TIME_ZONE||'Asia/Baghdad');
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,'republish_lesson','lesson',$2,$3::jsonb,$4::jsonb)`,[positiveInt(actorId),id,JSON.stringify(before),JSON.stringify(lesson)]);
      await c.query('COMMIT');return {lesson,created:true,queued};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async function restore(id,subjectId,{scheduleDate=null,actorId=null,originalPublishedAt=null,targetScheduleDate=null}={}){
    id=positiveInt(id);subjectId=positiveInt(subjectId);
    const original=publicationDate(originalPublishedAt);
    if(targetScheduleDate&&!/^\d{4}-\d{2}-\d{2}$/.test(targetScheduleDate))throw appError('تاريخ الجدول غير صالح.');
    if((original||targetScheduleDate)&&!actorId)throw appError('يتطلب التصحيح قرار الإدارة.');
    if(scheduleDate&&!/^\d{4}-\d{2}-\d{2}$/.test(scheduleDate))throw appError('تاريخ الجدول غير صالح.');
    const c=await db.pool.connect();
    try{
      await c.query('BEGIN');
      const pendingSeason=(await c.query('SELECT stage_season_id FROM pending_channel_lesson_posts WHERE id=$1',[id])).rows[0];
      if(pendingSeason)await c.query('SELECT pg_advisory_xact_lock(734225,$1)',[pendingSeason.stage_season_id]);
      const p=(await c.query(`SELECT p.*,ss.is_active AS season_active,st.is_active AS stage_active
        FROM pending_channel_lesson_posts p JOIN stage_seasons ss ON ss.id=p.stage_season_id
        JOIN stages st ON st.id=p.stage_id WHERE p.id=$1 FOR UPDATE OF p FOR SHARE OF ss,st`,[id])).rows[0];
      if(!p)throw appError('المنشور المعلّق غير موجود.','NOT_FOUND',404);
      if(!p.season_active||!p.stage_active)throw appError('لا يمكن استرجاع درس في مرحلة أو موسم مؤرشف.','ARCHIVED',409);
      const subject=(await c.query('SELECT * FROM subjects WHERE id=$1 AND stage_id=$2 FOR SHARE',[subjectId,p.stage_id])).rows[0];
      if(!subject)throw appError('اختر مادة من مرحلة المنشور نفسه.');
      const existing=(await c.query('SELECT * FROM effective_lessons WHERE source_chat_id=$1 AND source_message_id=$2',[p.telegram_chat_id,p.source_message_id])).rows[0];
      if(existing){
        await c.query("UPDATE pending_channel_lesson_posts SET status='duplicate',lesson_id=$2,resolved_subject_id=$3,resolved_at=now() WHERE id=$1 AND status='pending'",[id,existing.id,existing.subject_id]);
        await c.query('COMMIT');return {lesson:existing,created:false};
      }
      if(p.status!=='pending')throw appError('عولج المنشور سابقًا.','CONFLICT',409);
      if(!(await c.query('SELECT 1 FROM channels WHERE telegram_chat_id=$1 AND stage_id=$2 AND stage_season_id=$3',[p.telegram_chat_id,p.stage_id,p.stage_season_id])).rows[0])throw appError('تغيّر ربط القناة؛ راجع المرحلة قبل استرجاع المنشور.','CHANNEL_CHANGED',409);
      let resolvedScheduleDate=targetScheduleDate||scheduleDate||null;
      if(scheduleDate){
        const publicationDay=p.lesson_date instanceof Date?p.lesson_date.toISOString().slice(0,10):String(p.lesson_date).slice(0,10);
        if(!p.auto_match)throw appError('المنشور القديم يحتاج ربطًا صريحًا بالمادة.','REVIEW_REQUIRED',409);
        if(publicationDay!==scheduleDate){
          const subjects=(await c.query('SELECT id,name,hashtag FROM subjects WHERE stage_id=$1',[p.stage_id])).rows;
          const matched=require('./lessonContent').namedSubjects(subjects,p.content_text);
          let identified=matched.length===1&&matched[0].id===subjectId;
          if(!matched.length){
            const available=await db.getPendingScheduledSubjectsForDate(p.stage_season_id,scheduleDate,c);
            const oldAudio=(await c.query(`SELECT id FROM pending_channel_lesson_posts WHERE stage_season_id=$1 AND status='pending' AND auto_match=true
              AND lesson_date<$2::date AND content_kind IN ('voice','audio','audio_document','document')`,[p.stage_season_id,scheduleDate])).rows;
            identified=available.length===1&&available[0].id===subjectId&&oldAudio.length===1&&Number(oldAudio[0].id)===Number(p.id);
          }
          if(!identified)throw appError('لا يمكن نقل ملف يوم سابق إلى مادة بالتخمين.','REVIEW_REQUIRED',409);
          if(!(await c.query('SELECT 1 FROM lesson_schedule_entries WHERE stage_season_id=$1 AND subject_id=$2 AND lesson_date=$3',[p.stage_season_id,subjectId,scheduleDate])).rows.length){await c.query('COMMIT');return {created:false,skipped:true};}
          resolvedScheduleDate=publicationDay;
        }else if(!(await db.getPendingScheduledSubjectsForDate(p.stage_season_id,scheduleDate,c)).some(x=>x.id===subjectId)){
          await c.query('COMMIT');return {created:false,skipped:true};
        }
      }

      if(targetScheduleDate&&!(await c.query('SELECT 1 FROM lesson_schedule_entries WHERE stage_season_id=$1 AND subject_id=$2 AND lesson_date=$3',[p.stage_season_id,subjectId,targetScheduleDate])).rows.length)throw appError('تغير الجدول. حدّث الصفحة.','CONFLICT',409);
      const now=(await c.query('SELECT now() AS at')).rows[0].at;
      if(new Date(original||p.received_at)>new Date(now))throw appError('تاريخ نشر الدرس لم يحن بعد.');
      const lesson=await db.activateLesson(subjectId,24,'channel_schedule_recovered',p.source_url,
        p.telegram_chat_id,p.source_message_id,original||p.received_at,{client:c,attendanceOpenedAt:now,scheduleDate:resolvedScheduleDate});
      if(!lesson)throw appError('لم تعد المرحلة متاحة.','ARCHIVED',409);
      await c.query("UPDATE pending_channel_lesson_posts SET status='activated',lesson_id=$2,resolved_subject_id=$3,resolved_at=now() WHERE id=$1",[id,lesson.id,subjectId]);
      if(p.title_message_id)await c.query("UPDATE pending_channel_lesson_posts SET status='duplicate',lesson_id=$3,resolved_subject_id=$4,resolved_at=now() WHERE telegram_chat_id=$1 AND source_message_id=$2",[p.telegram_chat_id,p.title_message_id,lesson.id,subjectId]);
      await c.query(`UPDATE channel_post_activity SET last_outcome='activated_after_schedule',last_detail='استُرجع الدرس مع حفظ تاريخ نشره وإتاحة الحضور 24 ساعة من الاسترجاع',last_lesson_id=$3
        WHERE telegram_chat_id=$1 AND last_message_id=$2`,[p.telegram_chat_id,p.source_message_id,lesson.id]);
      const notices=await notice(c,lesson,subject.name,p.stage_id);
      if(actorId)await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,'restore_pending_lesson','lesson',$2,$3::jsonb,$4::jsonb)`,[positiveInt(actorId),lesson.id,JSON.stringify(p),JSON.stringify(lesson)]);
      await c.query('COMMIT');return {lesson,created:true,queued:notices};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  return {restore,restoreExisting};
}
module.exports={createLessonRecovery};
