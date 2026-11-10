'use strict';
// درس إضافي لليوم من مادة معيّنة (مثلًا درسان لمادة واحدة في اليوم نفسه) من لوحة الإدارة.
// يفعّل درسًا مستقلًا بمهلة 24 ساعة وزر حضور خاص به، ويُبلَّغ الطلبة المسجّلون في المرحلة بالدرس الجديد.
const {positiveInt,appError}=require('./integrity');

function createExtraLessons(db,{tz='Asia/Baghdad'}={}) {
  const DAY="COALESCE(l.schedule_date,(l.activated_at AT TIME ZONE 'UTC' AT TIME ZONE $3)::date)";

  async function activate(subjectId,actorId) {
    subjectId=positiveInt(subjectId);actorId=positiveInt(actorId);
    const c=await db.pool.connect();
    try{
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(734221,2)');
      const subject=(await c.query(`SELECT sub.id,sub.name,sub.stage_id FROM subjects sub
        JOIN stages st ON st.id=sub.stage_id AND st.is_active=true
        JOIN stage_seasons ss ON ss.stage_id=sub.stage_id AND ss.is_active=true WHERE sub.id=$1`,[subjectId])).rows[0];
      if(!subject)throw appError('المادة غير موجودة أو مرحلتها مؤرشفة أو بلا موسم نشط.','NOT_FOUND',404);
      // منع الضغط المزدوج: لا درس إضافي لنفس المادة خلال دقيقة من درس يدوي سابق.
      const recent=(await c.query(`SELECT 1 FROM lessons WHERE subject_id=$1 AND source_type='manual_extra' AND activated_at>now()-interval '1 minute'`,[subjectId])).rowCount;
      if(recent)throw appError('فُعّل درس إضافي لهذه المادة قبل لحظات. تحقق من القائمة قبل التكرار.','CONFLICT',409);
      const lesson=await db.activateLesson(subjectId,24,'manual_extra',null,null,null,null,{client:c});
      if(!lesson)throw appError('تعذر التفعيل: المرحلة مؤرشفة أو لا يوجد لها موسم نشط.','ARCHIVED',409);
      const today=(await c.query(`SELECT COUNT(*)::int AS n FROM effective_lessons l WHERE l.subject_id=$1 AND l.stage_season_id=$2
        AND ${DAY}=(now() AT TIME ZONE $3)::date`,[subjectId,lesson.stage_season_id,tz])).rows[0].n;
      const text=`📚 درس جديد اليوم في مادة «${subject.name}»${today>1?` (الدرس رقم ${today} لهذه المادة اليوم)`:''}.\nسجّل استماعك قبل انتهاء المهلة (24 ساعة).`;
      const buttons=[[{text:'✅ تم الاستماع',callback_data:'attend:'+lesson.id}]];
      const notified=(await c.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,expires_at,priority)
        SELECT 'lesson-extra:'||$1||':'||st.id,st.telegram_id,$2::jsonb,$3,2 FROM students st
        JOIN enrollments e ON e.student_id=st.id AND e.stage_season_id=$4 AND e.status='active'
        WHERE st.stage_id=$5 AND st.is_active=true AND st.telegram_id IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM student_leaves sl WHERE sl.student_id=st.id AND sl.status='approved'
            AND (now() AT TIME ZONE $6)::date BETWEEN sl.start_date AND sl.end_date)
        ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
        [lesson.id,JSON.stringify([text,{reply_markup:{inline_keyboard:buttons}}]),lesson.active_until,lesson.stage_season_id,subject.stage_id,tz])).rowCount;
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,'activate_extra_lesson','lesson',$2,NULL,$3::jsonb)`,[actorId,lesson.id,JSON.stringify({subject_id:subjectId,lessons_today:today,notified})]);
      await c.query('COMMIT');
      return {lesson,subjectName:subject.name,lessonsToday:today,notified};
    }catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
  }
  return {activate};
}
module.exports={createExtraLessons};
