'use strict';
const {createHash}=require('node:crypto');
const {appError,positiveInt}=require('./integrity');
const CHAT='-1003488013652',KEY='channel-3488013652-20260926-27-v1';
// This repair is deliberately limited to the channel and publications reviewed
// with the administrator. It is previewed, never run by startup or the scheduler.
const PLAN=[
  {message:25,tag:'المنطق',day:'2026-09-26',at:'2026-09-26T05:55:00Z',aliases:[24]},
  {message:27,tag:'الفقه',day:'2026-09-26',at:'2026-09-26T05:55:00Z',aliases:[26]},
  {message:28,tag:'النحو',day:'2026-09-26',at:'2026-09-26T05:55:00Z',aliases:[29],media:29},
  {message:30,tag:'العقائد',day:'2026-09-26',at:'2026-09-26T07:21:00Z',aliases:[31],media:31},
  {message:40,tag:'الفقه',day:'2026-09-27',at:'2026-09-27T05:33:00Z',aliases:[39],create:true},
  {message:42,tag:'التفسير',day:'2026-09-27',at:'2026-09-27T05:33:00Z',aliases:[41],create:true},
  {message:44,tag:'المنطق',day:'2026-09-27',at:'2026-09-27T05:33:00Z',aliases:[43],create:true},
];
const ANNOUNCEMENTS=[21,22,23,36,37,38];
function createHistoricalLessonRepair(db){
  async function snapshot(c,stageId){
    const channel=(await c.query(`SELECT ch.*,ss.is_active AS season_active FROM channels ch JOIN stage_seasons ss ON ss.id=ch.stage_season_id WHERE ch.telegram_chat_id=$1 AND ch.stage_id=$2`,[CHAT,positiveInt(stageId)])).rows[0];
    if(!channel||!channel.season_active)throw appError('التصحيح المحدد لا يخص هذه المرحلة أو أن موسمها مؤرشف.','NOT_FOUND',404);
    const subjects=(await c.query('SELECT id,name,hashtag FROM subjects WHERE stage_id=$1 ORDER BY id',[stageId])).rows;
    const lessons=(await c.query(`SELECT l.*, (SELECT COUNT(*)::int FROM attendance a WHERE a.lesson_id=l.id) AS attendance_count
      FROM lessons l WHERE l.source_chat_id=$1 AND l.stage_season_id=$2 ORDER BY l.id`,[CHAT,channel.stage_season_id])).rows;
    const pending=(await c.query('SELECT * FROM pending_channel_lesson_posts WHERE telegram_chat_id=$1 AND stage_season_id=$2 ORDER BY id',[CHAT,channel.stage_season_id])).rows;
    const applied=(await c.query('SELECT * FROM lesson_repair_batches WHERE key=$1',[KEY])).rows[0];
    const plan=PLAN.map(p=>{const subject=subjects.find(s=>s.hashtag===p.tag);if(!subject)throw appError('تغير تعريف مادة مطلوبة للتصحيح.');return {...p,subjectId:subject.id,subject:subject.name,url:`https://t.me/c/3488013652/${p.media||p.message}`};});
    const token=createHash('sha256').update(JSON.stringify({channel,subjects,lessons:lessons.map(({id,subject_id,source_message_id,activated_at,active_until})=>({id,subject_id,source_message_id,activated_at,active_until})),pending:pending.map(({id,status,lesson_id,source_message_id})=>({id,status,lesson_id,source_message_id}))})).digest('hex');
    return {channel,lessons,pending,plan,applied,token};
  }
  async function preview(stageId){
    const s=await snapshot(db.pool,stageId);
    return {stageId:Number(stageId),token:s.token,applied:!!s.applied,plan:s.plan,
      excluded:s.lessons.filter(l=>ANNOUNCEMENTS.includes(Number(l.source_message_id))).map(l=>({id:l.id,message:l.source_message_id,attendance:l.attendance_count,url:l.source_url})),
      merged:s.lessons.filter(l=>Number(l.source_message_id)===26).map(l=>({id:l.id,attendance:l.attendance_count})),
      beforeCount:s.lessons.length,afterCount:s.lessons.length-s.lessons.filter(l=>ANNOUNCEMENTS.includes(Number(l.source_message_id))||Number(l.source_message_id)===26).length+s.plan.filter(p=>!s.lessons.some(l=>Number(l.source_message_id)===p.message)).length};
  }
  async function apply(stageId,token,actorId){
    const c=await db.pool.connect();
    try{
      await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(734221,1)');
      const ch=(await c.query('SELECT stage_season_id FROM channels WHERE telegram_chat_id=$1 AND stage_id=$2',[CHAT,positiveInt(stageId)])).rows[0];
      if(!ch)throw appError('القناة غير مرتبطة بالمرحلة.');
      await c.query('SELECT pg_advisory_xact_lock(734225,$1)',[ch.stage_season_id]);
      await c.query('SELECT id FROM lessons WHERE source_chat_id=$1 FOR UPDATE',[CHAT]);
      await c.query('SELECT id FROM pending_channel_lesson_posts WHERE telegram_chat_id=$1 FOR UPDATE',[CHAT]);
      const s=await snapshot(c,stageId);
      if(s.applied){await c.query('COMMIT');return {applied:false,alreadyApplied:true};}
      if(typeof token!=='string'||token!==s.token)throw appError('تغيرت البيانات بعد المعاينة؛ افتح المعاينة مجددًا.','CONFLICT',409);
      const rawAttendance=(await c.query('SELECT a.* FROM attendance a JOIN lessons l ON l.id=a.lesson_id WHERE l.source_chat_id=$1 ORDER BY a.id',[CHAT])).rows;
      const corrections=(await c.query('SELECT * FROM lesson_corrections WHERE lesson_id=ANY($1::int[])',[s.lessons.map(l=>l.id)])).rows;
      if(corrections.length)throw appError('يوجد تصحيح آخر لهذه السجلات؛ يلزم مراجعته أولًا.','CONFLICT',409);
      const now=(await c.query('SELECT now() AS at')).rows[0].at,ids=[];
      for(const p of s.plan){
        let lesson=s.lessons.find(l=>Number(l.source_message_id)===p.message);
        if(!lesson&&!p.create)throw appError('أحد الدروس الأصلية غير موجود؛ لم يُنفذ أي تغيير.','CONFLICT',409);
        if(lesson){
          lesson=(await c.query(`UPDATE lessons SET subject_id=$2,activated_at=$3,source_url=$4,schedule_date=$5,
            attendance_opened_at=COALESCE(attendance_opened_at,activated_at) WHERE id=$1 RETURNING *`,[lesson.id,p.subjectId,p.at,p.url,p.day])).rows[0];
        }else{
          if(!s.pending.some(x=>Number(x.source_message_id)===p.message&&x.status==='pending'))throw appError('الملف المطلوب ليس ضمن المنشورات المحفوظة؛ لم يُنفذ أي تغيير.','CONFLICT',409);
          lesson=await db.activateLesson(p.subjectId,24,'channel_schedule_recovered',p.url,CHAT,p.message,p.at,{client:c,attendanceOpenedAt:now,scheduleDate:p.day});
        }
        ids.push(lesson.id);
        for(const message of p.aliases){
          const duplicate=s.lessons.find(l=>Number(l.source_message_id)===message);
          if(duplicate){
            // Copy missing attendance into the canonical lesson, retaining every
            // original row in its original lesson for traceability.
            await c.query(`INSERT INTO attendance(student_id,lesson_id,listened_at,marking_kind,marked_by,admin_note)
              SELECT student_id,$2,listened_at,marking_kind,marked_by,admin_note FROM attendance WHERE lesson_id=$1
              ON CONFLICT(student_id,lesson_id) DO NOTHING`,[duplicate.id,lesson.id]);
            await c.query('INSERT INTO lesson_corrections(lesson_id,canonical_lesson_id,reason,actor_id) VALUES($1,$2,$3,$4)',[duplicate.id,lesson.id,'الرابط والصوت يمثلان المحاضرة نفسها',positiveInt(actorId)]);
          }
        }
        await c.query("UPDATE pending_channel_lesson_posts SET status='duplicate',auto_match=false,lesson_id=$3,resolved_subject_id=$4,resolved_at=now() WHERE telegram_chat_id=$1 AND source_message_id=ANY($2::bigint[])",[CHAT,[p.message,...p.aliases],lesson.id,p.subjectId]);
      }
      for(const l of s.lessons.filter(x=>ANNOUNCEMENTS.includes(Number(x.source_message_id)))){
        await c.query('INSERT INTO lesson_corrections(lesson_id,reason,actor_id) VALUES($1,$2,$3)',[l.id,'إعلان أو تعليمات وليست محاضرة؛ سجل الحضور الأصلي محفوظ',positiveInt(actorId)]);
        await c.query("UPDATE notification_outbox SET status='expired',expires_at=now() WHERE status='pending' AND (dedupe_key LIKE $1 OR dedupe_key LIKE $2 OR dedupe_key LIKE $3)",[`lesson-reminder:${l.id}:%`,`lesson-recovered:${l.id}:%`,`lesson-republished:${l.id}:%`]);
      }
      await c.query("UPDATE pending_channel_lesson_posts SET status='duplicate',auto_match=false,resolved_at=now() WHERE telegram_chat_id=$1 AND source_message_id=ANY($2::bigint[])",[CHAT,ANNOUNCEMENTS]);
      const correctedMessages=new Set([...ANNOUNCEMENTS,...PLAN.flatMap(p=>[p.message,...p.aliases])]);
      for(const l of s.lessons.filter(l=>correctedMessages.has(Number(l.source_message_id))))await c.query(
        "UPDATE notification_outbox SET status='expired',expires_at=now() WHERE status='pending' AND (dedupe_key LIKE $1 OR dedupe_key LIKE $2 OR dedupe_key LIKE $3)",
        [`lesson-reminder:${l.id}:%`,`lesson-recovered:${l.id}:%`,`lesson-republished:${l.id}:%`]);
      // Recompute cached absence counts against the corrected lessons. Raw
      // attendance, including the excluded announcements, is never deleted.
      await c.query(`UPDATE student_attendance_days d SET lesson_count=x.total,attended_on_time_count=x.attended,
        missed_lesson_count=x.total-x.attended,is_full_absence=(NOT d.is_excused_leave AND x.total>0 AND x.attended=0)
        FROM (SELECT d.id,COUNT(l.id)::int AS total,COUNT(a.id) FILTER(WHERE a.listened_at<=l.active_until OR a.marking_kind='admin_late')::int AS attended
        FROM student_attendance_days d JOIN enrollments e ON e.student_id=d.student_id AND e.stage_season_id=d.stage_season_id
        LEFT JOIN effective_lessons l ON l.stage_season_id=d.stage_season_id AND (COALESCE(l.attendance_opened_at,l.activated_at) AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Baghdad')::date=d.attendance_date
          AND COALESCE(l.attendance_opened_at,l.activated_at)>=e.started_at AND (e.ended_at IS NULL OR COALESCE(l.attendance_opened_at,l.activated_at)<=e.ended_at)
        LEFT JOIN attendance a ON a.lesson_id=l.id AND a.student_id=d.student_id WHERE d.stage_season_id=$1 GROUP BY d.id) x WHERE d.id=x.id`,[ch.stage_season_id]);
      const students=(await c.query('SELECT student_id FROM enrollments WHERE stage_season_id=$1',[ch.stage_season_id])).rows.map(x=>x.student_id);
      await require('./absence').refreshAdministrativeAttendance(c,students,ch.stage_season_id,'Asia/Baghdad');
      const after={lessonIds:ids,excluded:ANNOUNCEMENTS,merged:26};
      await c.query('INSERT INTO lesson_repair_batches(key,actor_id,before_data,after_data) VALUES($1,$2,$3::jsonb,$4::jsonb)',[KEY,positiveInt(actorId),JSON.stringify({lessons:s.lessons,pending:s.pending,attendance:rawAttendance}),JSON.stringify(after)]);
      await c.query("INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,'repair_channel_publications','channel',$2,$3::jsonb,$4::jsonb)",[actorId,s.channel.id,JSON.stringify(s.lessons),JSON.stringify(after)]);
      const payload=JSON.stringify(['📚 صُحح ربط دروس يومي 26 و27 سبتمبر بموادها، وأُتيحت الملفات التي لم تُفعّل لمدة 24 ساعة. حضور المحاضرات السابق محفوظ. افتح «دروسي» لعرض القائمة الصحيحة.',{reply_markup:{inline_keyboard:[[{text:'📚 دروسي',callback_data:'menu_today'}]]}}]);
      // Use the same callback as the bot's lesson menu (validated by integration tests).
      await c.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,expires_at,priority)
        SELECT $1||':'||st.id,st.telegram_id,$2::jsonb,now()+interval '24 hours',2 FROM students st JOIN enrollments e ON e.student_id=st.id
        WHERE e.stage_season_id=$3 AND e.status='active' AND st.is_active=true AND st.stage_id=$4 ON CONFLICT DO NOTHING`,[KEY,payload,ch.stage_season_id,stageId]);
      await c.query('COMMIT');return {applied:true,lessons:ids.length};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  return {preview,apply};
}
module.exports={createHistoricalLessonRepair};
