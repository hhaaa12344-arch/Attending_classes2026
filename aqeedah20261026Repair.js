'use strict';
// Evidence-scoped repair: the administrator verified the 9 numbered Telegram
// posts belong to "مسائل" (subject 19), while post 286 is "عقائد" (subject 18).
// NEVER change, copy, add or remove attendance rows. Do NOT merge fallback
// lessons without separate evidence that they are the same lecture.
const { createHash } = require('node:crypto');
const { positiveInt, appError } = require('./integrity');
const KEY='stage4-season5-verified-post-reclassification-20261026-v3';
const POLICY='RECLASSIFY_ONLY_NO_ATTENDANCE_TRANSFER_V3';
const CHAT='-1004311434262', STAGE=4, SS=5, AQEEDAH=18, MASAIL=19;
const PAIRS=[
  {day:'2026-09-30', wrong:169, message:70, named:193, namedMessage:72},
  {day:'2026-10-03', wrong:205, message:84, named:293, namedMessage:86},
  {day:'2026-10-06', wrong:299, message:122, named:360, namedMessage:124},
  {day:'2026-10-10', wrong:377, message:148, named:429, namedMessage:150},
  {day:'2026-10-12', wrong:431, message:172, named:496, namedMessage:174},
  {day:'2026-10-14', wrong:504, message:198, named:593, namedMessage:200},
  {day:'2026-10-19', wrong:597, message:235, named:661, namedMessage:237},
  {day:'2026-10-21', wrong:667, message:259, named:729, namedMessage:261},
  {day:'2026-10-26', wrong:748, message:284, named:null, namedMessage:286}
];
const WRONG=PAIRS.map(p=>p.wrong);
const ALL_LESSONS=PAIRS.flatMap(p=>p.named?[p.wrong,p.named]:[p.wrong]);
const MESSAGES=[...PAIRS.map(p=>p.message),285,286];
function fail(reason){throw appError('أُوقفت العملية بأمان: '+reason+'. أعد المعاينة قبل التصحيح.','CONFLICT',409);}
function dayOf(d){return d instanceof Date?d.toISOString().slice(0,10):String(d??'').slice(0,10);}
function hash(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function createAqeedah20261026Repair(db){
  async function snapshot(c=db.pool){
    const ch=(await c.query(`SELECT ch.id,ss.stage_id,ss.is_active FROM channels ch
      JOIN stage_seasons ss ON ss.id=ch.stage_season_id
      WHERE ch.telegram_chat_id=$1 AND ch.stage_id=$2 AND ch.stage_season_id=$3`,[CHAT,STAGE,SS])).rows[0];
    if(!ch||Number(ch.stage_id)!==STAGE||!ch.is_active)fail('ربط القناة أو الموسم مختلف');
    const sub=(await c.query('SELECT id,stage_id,name,hashtag FROM subjects WHERE id=ANY($1::int[]) ORDER BY id',[[AQEEDAH,MASAIL]])).rows;
    if(sub.length!==2||sub.some(s=>Number(s.stage_id)!==STAGE)||!sub.find(s=>Number(s.id)===AQEEDAH)?.name?.includes('عقائد')||!sub.find(s=>Number(s.id)===MASAIL)?.name?.includes('مسائل'))
      fail('معرّفات مواد العقائد والمسائل لم تعد متوافقة');
    const applied=(await c.query('SELECT key FROM lesson_repair_batches WHERE key=$1',[KEY])).rows[0];
    if(applied)fail('سبق تطبيق هذه الدفعة');
    const lessons=(await c.query(`SELECT id,subject_id,stage_season_id,source_type,source_chat_id,source_message_id,
      schedule_date,activated_at,active_until,attendance_opened_at,source_url
      FROM lessons WHERE id=ANY($1::int[]) ORDER BY id`,[ALL_LESSONS])).rows;
    const lm=new Map(lessons.map(l=>[Number(l.id),l]));
    if(lm.size!==ALL_LESSONS.length)fail('اختلفت قائمة الدروس الأصلية');
    const corrections=(await c.query('SELECT lesson_id FROM lesson_corrections WHERE lesson_id=ANY($1::int[])',[ALL_LESSONS])).rows;
    if(corrections.length)fail('يوجد تصحيح سابق لإحدى المحاضرات');
    const posts=(await c.query(`SELECT id,telegram_chat_id,stage_season_id,source_message_id,status,lesson_id,
      resolved_subject_id,title_message_id,content_text,lesson_date FROM pending_channel_lesson_posts
      WHERE telegram_chat_id=$1 AND stage_season_id=$2 AND (lesson_id=ANY($3::int[]) OR source_message_id=ANY($4::bigint[]))
      ORDER BY id`,[CHAT,SS,WRONG,MESSAGES])).rows;
    const pm=new Map(posts.map(p=>[Number(p.source_message_id),p]));
    for(const pair of PAIRS){
      const w=lm.get(pair.wrong), n=pair.named?lm.get(pair.named):null;
      if(!w||Number(w.subject_id)!==AQEEDAH||Number(w.stage_season_id)!==SS||String(w.source_chat_id)!==CHAT||Number(w.source_message_id)!==pair.message||dayOf(w.schedule_date)!==pair.day)
        fail('درس المسائل المرتبط بالخطأ '+pair.wrong);
      const p=pm.get(pair.message);
      if(!p||Number(p.lesson_id)!==pair.wrong||p.status!=='activated'||Number(p.resolved_subject_id)!==AQEEDAH||dayOf(p.lesson_date)!==pair.day)
        fail('ارتباط المنشور '+pair.message);
      if(pair.named && (!n||Number(n.subject_id)!==AQEEDAH||Number(n.stage_season_id)!==SS||String(n.source_chat_id)!==CHAT||Number(n.source_message_id)!==pair.namedMessage||dayOf(n.schedule_date)!==pair.day))
        fail('محاضرة العقائد الأصلية '+pair.namedMessage);
      const np=pm.get(pair.namedMessage);
      if(!np||dayOf(np.lesson_date)!==pair.day||!np.content_text)
        fail('تعذر تحديد منشور العقائد '+pair.namedMessage);
      const {namedSubjects}=require('./lessonContent');
      const matched=namedSubjects(sub.map(x=>({id:x.id,name:x.name,hashtag:x.hashtag||''})),np.content_text);
      if(matched.length!==1||Number(matched[0].id)!==AQEEDAH)fail('عنوان المنشور '+pair.namedMessage+' لا يُعرّف العقائد بصورة منفردة');
      if(pair.named && (np.status!=='activated'||Number(np.lesson_id)!==pair.named))
        fail('تغيّر وضع منشور العقائد '+pair.namedMessage);
      if(!pair.named && (np.status!=='pending'||np.lesson_id))
        fail('نُشر درس 286 بالفعل أو لم يعد معلقاً');
    }
    const title=pm.get(285);
    if(!title||title.status!=='pending'||title.lesson_id)fail('العنوان 285 لم يعد معلقاً');
    const todayExtra=(await c.query(`SELECT id,subject_id,source_message_id FROM lessons
      WHERE stage_season_id=$1 AND subject_id=$2 AND schedule_date=$3::date AND id<>$4
      AND NOT EXISTS (SELECT 1 FROM lesson_corrections r WHERE r.lesson_id=lessons.id)`,[SS,AQEEDAH,'2026-10-26',748])).rows;
    if(todayExtra.length)fail('ظهر درس عقائد آخر بتاريخ 26 أكتوبر؛ يلزم مراجعة جديدة');
    const counts=(await c.query(`SELECT subject_id,COUNT(*)::int AS n FROM effective_lessons
      WHERE stage_season_id=$1 AND subject_id=ANY($2::int[]) GROUP BY subject_id`,[SS,[AQEEDAH,MASAIL]])).rows;
    const beforeCounts=Object.fromEntries(counts.map(r=>[Number(r.subject_id),Number(r.n)]));
    if((beforeCounts[AQEEDAH]||0)!==19)fail('تغيّر عدد دروس العقائد عن 19');
    const planned=(await c.query(`SELECT subject_id,lesson_date FROM lesson_schedule_entries
      WHERE stage_season_id=$1 AND subject_id=ANY($2::int[]) ORDER BY subject_id,lesson_date`,[SS,[AQEEDAH,MASAIL]])).rows;
    const namedSchedule=planned.filter(p=>Number(p.subject_id)===AQEEDAH);
    if(namedSchedule.length!==11)fail('لم يعد جدول العقائد 11 موعداً');
    for(const pair of PAIRS)if(!planned.some(p=>Number(p.subject_id)===MASAIL&&dayOf(p.lesson_date)===pair.day))
      fail('المسائل غير مجدولة بتاريخ '+pair.day);
    const attendance=(await c.query(`SELECT lesson_id,COUNT(*)::int AS n FROM attendance WHERE lesson_id=ANY($1::int[])
      GROUP BY lesson_id ORDER BY lesson_id`,[WRONG])).rows;
    const attendanceCount=Object.fromEntries(attendance.map(r=>[Number(r.lesson_id),Number(r.n)]));
    const overlaps=(await c.query(`SELECT schedule_date::text AS day,id,source_type,source_message_id,
      (SELECT COUNT(*)::int FROM attendance a WHERE a.lesson_id=lessons.id) AS attendance_count
      FROM effective_lessons lessons
      WHERE stage_season_id=$1 AND subject_id=$2 AND schedule_date=ANY($3::date[])
      ORDER BY schedule_date,id`,[SS,MASAIL,PAIRS.map(p=>p.day)])).rows;
    const duplicates=PAIRS.map(p=>({date:p.day,verifiedPost:p.message,originalLessonId:p.wrong,
      attendanceUnchanged:attendanceCount[p.wrong]||0,alreadyExistingMasailLessons:overlaps.filter(l=>dayOf(l.day)===p.day).map(l=>({id:Number(l.id),kind:l.source_type,message:l.source_message_id,attendance:Number(l.attendance_count)}))}));
    const view={policy:POLICY,key:KEY,subjects:{aqeedah:AQEEDAH,masail:MASAIL},
      counts:{aqeedahBefore:beforeCounts[AQEEDAH],aqeedahAfter:11,masailBefore:beforeCounts[MASAIL]||0,masailAfter:(beforeCounts[MASAIL]||0)+9},
      attendance:{verifiedSourceRows:duplicates.reduce((n,d)=>n+d.attendanceUnchanged,0),added:0,copied:0,deleted:0,updated:0},
      posts:duplicates,
      warning:'التصحيح يغيّر مادة المنشورات التسعة ويحفظ كل تأشير حضور كما هو. لا يدمج الدروس الاحتياطية الموجودة للمسائل؛ ستظل هناك تكرارات تحتاج مراجعة مستقلة للحفاظ على حقوق الطلاب.'};
    const signature={lessons,posts,counts,planned,todayExtra,overlaps:overlaps.map(({attendance_count,...stable})=>stable)};
    return {view,token:hash({policy:POLICY,signature}),signature};
  }
  async function preview(){const s=await snapshot();return {...s.view,token:s.token};}
  async function apply({token,actorId=0,confirmed=false}){
    if(!confirmed)fail('تأكيد هوية المنشورات التسعة مطلوب');
    if(!token)fail('رمز معاينة مطلوب');
    actorId=actorId?positiveInt(actorId):0;
    const c=await db.pool.connect();
    try{
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(734221,1)');
      await c.query('SELECT pg_advisory_xact_lock(734225,$1)',[SS]);
      await c.query('SELECT id FROM lessons WHERE id=ANY($1::int[]) FOR UPDATE',[ALL_LESSONS]);
      await c.query(`SELECT id FROM pending_channel_lesson_posts
        WHERE telegram_chat_id=$1 AND stage_season_id=$2 AND (lesson_id=ANY($3::int[]) OR source_message_id=ANY($4::bigint[])) FOR UPDATE`,[CHAT,SS,WRONG,MESSAGES]);
      const s=await snapshot(c);
      if(s.token!==token)fail('تغيرت خريطة الدروس منذ المعاينة');
      const checkBefore=(await c.query('SELECT id,student_id,lesson_id,listened_at,marking_kind,marked_by,admin_note FROM attendance WHERE lesson_id=ANY($1::int[]) ORDER BY id',[WRONG])).rows;
      for(const pair of PAIRS){
        const updated=await c.query(`UPDATE lessons SET subject_id=$2 WHERE id=$1 AND subject_id=$3 RETURNING id`,[pair.wrong,MASAIL,AQEEDAH]);
        if(updated.rowCount!==1)fail('تغير الدرس '+pair.wrong);
      }
      // This also reclassifies associated caption/title posts by their lesson_id.
      await c.query(`UPDATE pending_channel_lesson_posts SET resolved_subject_id=$2,auto_match=false,
        resolved_at=COALESCE(resolved_at,now())
        WHERE telegram_chat_id=$3 AND stage_season_id=$4 AND lesson_id=ANY($1::int[])`,[WRONG,MASAIL,CHAT,SS]);
      const post=(await c.query(`SELECT * FROM pending_channel_lesson_posts
        WHERE telegram_chat_id=$1 AND stage_season_id=$2 AND source_message_id=286 FOR UPDATE`,[CHAT,SS])).rows[0];
      if(!post||post.status!=='pending'||post.lesson_id)fail('منشور العقائد 286 لم يعد معلقاً');
      const received=post.received_at instanceof Date?post.received_at:new Date(String(post.received_at).replace(' ','T')+'Z');
      // Use the actual publication timestamp for chronological ordering, while
      // allowing a 24-hour real attendance window from the repair execution.
      const inserted=await db.activateLesson(AQEEDAH,24,'channel_schedule_recovered',
        `https://t.me/c/4311434262/286`,CHAT,286,received,
        {client:c,scheduleDate:'2026-10-26',attendanceOpenedAt:new Date()});
      if(!inserted||Number(inserted.subject_id)!==AQEEDAH||Number(inserted.source_message_id)!==286)
        fail('تعذر تفعيل منشور العقائد 286');
      await c.query(`UPDATE pending_channel_lesson_posts SET status='activated',lesson_id=$2,
        resolved_subject_id=$3,auto_match=false,resolved_at=now() WHERE id=$1`,[post.id,inserted.id,AQEEDAH]);
      const titleUpdate=await c.query(`UPDATE pending_channel_lesson_posts SET status='duplicate',lesson_id=$2,
        resolved_subject_id=$3,auto_match=false,resolved_at=now()
        WHERE telegram_chat_id=$1 AND stage_season_id=$4 AND source_message_id=285 AND status='pending'`,[CHAT,inserted.id,AQEEDAH,SS]);
      if(titleUpdate.rowCount!==1)fail('تعذر ربط عنوان العقائد 285');
      // Only remove stale PENDING reminders that still mention the wrong subject.
      // No delivered historical records are changed.
      for(const pair of PAIRS)await c.query(`UPDATE notification_outbox SET status='expired',expires_at=now()
        WHERE status='pending' AND (dedupe_key LIKE $1 OR dedupe_key LIKE $2 OR dedupe_key LIKE $3)`,
        [`lesson-reminder:${pair.wrong}:%`,`lesson-recovered:${pair.wrong}:%`,`lesson-republished:${pair.wrong}:%`]);
      const checkAfter=(await c.query('SELECT id,student_id,lesson_id,listened_at,marking_kind,marked_by,admin_note FROM attendance WHERE lesson_id=ANY($1::int[]) ORDER BY id',[WRONG])).rows;
      if(JSON.stringify(checkBefore)!==JSON.stringify(checkAfter))fail('تغيّر حضور الدروس المنقولة أثناء التنفيذ');
      const newMarks=Number((await c.query('SELECT COUNT(*)::int AS n FROM attendance WHERE lesson_id=$1',[inserted.id])).rows[0].n);
      if(newMarks)fail('ظهر حضور غير متوقع في العقائد 11');
      const totals=(await c.query('SELECT subject_id,COUNT(*)::int AS n FROM effective_lessons WHERE stage_season_id=$1 AND subject_id=ANY($2::int[]) GROUP BY subject_id',[SS,[AQEEDAH,MASAIL]])).rows;
      const after=Object.fromEntries(totals.map(r=>[Number(r.subject_id),Number(r.n)]));
      if(after[AQEEDAH]!==11||after[MASAIL]!==s.view.counts.masailAfter)fail('تغيّر عدد الدروس بصورة غير متوقعة');
      // Preserve recorded attendance. Reconcile only existing cached day totals,
      // if 26 October has already been processed by the daily absence scheduler.
      const updatedDays=await c.query(`WITH counts AS (
        SELECT d.id,COUNT(l.id)::int AS total,
          COUNT(a.id) FILTER (WHERE a.listened_at<=l.active_until OR a.marking_kind='admin_late')::int AS attended
        FROM student_attendance_days d
        JOIN enrollments e ON e.stage_season_id=d.stage_season_id AND e.student_id=d.student_id
        LEFT JOIN effective_lessons l ON l.stage_season_id=d.stage_season_id
          AND ((COALESCE(l.attendance_opened_at,l.activated_at) AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Baghdad')::date=d.attendance_date
          AND COALESCE(l.attendance_opened_at,l.activated_at)>=e.started_at
          AND (e.ended_at IS NULL OR COALESCE(l.attendance_opened_at,l.activated_at)<=e.ended_at)
        LEFT JOIN attendance a ON a.lesson_id=l.id AND a.student_id=d.student_id
        WHERE d.stage_season_id=$1 AND d.attendance_date='2026-10-26'::date GROUP BY d.id
      ) UPDATE student_attendance_days d SET lesson_count=counts.total,
        attended_on_time_count=counts.attended,missed_lesson_count=GREATEST(0,counts.total-counts.attended),
        is_full_absence=(NOT d.is_excused_leave AND counts.total>0 AND counts.attended=0)
      FROM counts WHERE d.id=counts.id RETURNING d.student_id`,[SS]);
      if(updatedDays.rows.length)await require('./absence').refreshAdministrativeAttendance(c,updatedDays.rows.map(r=>r.student_id),SS,'Asia/Baghdad');
      const result={applied:true,policy:POLICY,lesson286:Number(inserted.id),aqeedah:after[AQEEDAH],
        masail:after[MASAIL],preservedAttendanceMarks:checkAfter.length,newAttendanceMarks:0,updatedDailyCacheRows:updatedDays.rows.length,
        note:'نُسبت المنشورات التسعة إلى المسائل، ولم تتغير سجلات حضور الطلاب. تكرار دروس المسائل الاحتياطية لم يُدمج.'};
      await c.query(`INSERT INTO lesson_repair_batches(key,actor_id,before_data,after_data)
        VALUES($1,$2,$3::jsonb,$4::jsonb)`,[KEY,actorId,JSON.stringify({...s.view,tokenHash:hash(token)}),JSON.stringify(result)]);
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,'reclassify_verified_telegram_lessons','subject',$2,$3::jsonb,$4::jsonb)`,
        [actorId,AQEEDAH,JSON.stringify(s.view),JSON.stringify(result)]);
      await c.query('COMMIT');
      return result;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  return {preview,apply};
}
module.exports={createAqeedah20261026Repair,PAIRS,KEY,POLICY};
