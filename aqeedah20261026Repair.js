'use strict';
// Evidence-scoped repair: the administrator verified the 9 numbered Telegram
// posts belong to "مسائل" (subject 19), while post 286 is "عقائد" (subject 18).
// NEVER change, copy, add or remove attendance rows. Do NOT merge fallback
// lessons without separate evidence that they are the same lecture.
const { createHash } = require('node:crypto');
const { positiveInt, appError } = require('./integrity');
const KEY='stage4-season5-verified-post-reclassification-20261026-v4';
const POLICY='RECLASSIFY_ONLY_NO_ATTENDANCE_TRANSFER_V4';
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
const MESSAGES=[...new Set(PAIRS.flatMap(p=>[p.message,p.namedMessage]).concat(285))];
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
    const posts=(await c.query(`SELECT * FROM pending_channel_lesson_posts
      WHERE telegram_chat_id=$1 AND stage_season_id=$2 AND (lesson_id=ANY($3::int[]) OR source_message_id=ANY($4::bigint[]))
      ORDER BY id`,[CHAT,SS,ALL_LESSONS,MESSAGES])).rows;
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
    const affectedAttendance=(await c.query(`SELECT a.* FROM attendance a WHERE a.lesson_id IN
      (SELECT id FROM lessons WHERE stage_season_id=$1 AND subject_id=ANY($2::int[])) ORDER BY a.id`,[SS,[AQEEDAH,MASAIL]])).rows;
    const affectedStudents=[...new Set(affectedAttendance.filter(a=>WRONG.includes(Number(a.lesson_id))).map(a=>Number(a.student_id)))].sort((a,b)=>a-b);
    const unmatched=PAIRS.flatMap(p=>affectedAttendance.filter(a=>Number(a.lesson_id)===p.wrong&&
      !affectedAttendance.some(n=>Number(n.lesson_id)===p.named&&Number(n.student_id)===Number(a.student_id)))
      .map(a=>({attendanceId:a.id,studentId:a.student_id,lessonId:a.lesson_id,messageId:p.message})));
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
      affectedStudents,unconfirmedAqeedahAttendance:unmatched,
      posts:duplicates,
      warning:'التصحيح يغيّر مادة المنشورات التسعة ويحفظ كل تأشير حضور كما هو. لا يدمج الدروس الاحتياطية الموجودة للمسائل؛ ستظل هناك تكرارات تحتاج مراجعة مستقلة للحفاظ على حقوق الطلاب.'};
    const signature={lessons,posts,counts,planned,todayExtra,overlaps,affectedAttendance};
    return {view,token:hash({policy:POLICY,signature}),signature};
  }
  async function preview(){
    const c=await db.pool.connect();
    try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const s=await snapshot(c);await c.query('COMMIT');return {...s.view,token:s.token};}
    catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async function apply({token,actorId=0,confirmed=false}){
    if(!confirmed)fail('تأكيد هوية المنشورات التسعة مطلوب');
    if(!token)fail('رمز معاينة مطلوب');
    actorId=positiveInt(actorId);
    const c=await db.pool.connect();
    try{
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(734221,1)');
      await c.query('SELECT pg_advisory_xact_lock(734225,$1)',[SS]);
      await c.query('SELECT id FROM lessons WHERE stage_season_id=$1 AND subject_id=ANY($2::int[]) ORDER BY id FOR UPDATE',[SS,[AQEEDAH,MASAIL]]);
      await c.query(`SELECT id FROM pending_channel_lesson_posts
        WHERE telegram_chat_id=$1 AND stage_season_id=$2 AND (lesson_id=ANY($3::int[]) OR source_message_id=ANY($4::bigint[])) FOR UPDATE`,[CHAT,SS,ALL_LESSONS,MESSAGES]);
      const s=await snapshot(c);
      if(s.token!==token)fail('تغيرت خريطة الدروس منذ المعاينة');
      const checkBefore=s.signature.affectedAttendance;
      const cacheBefore=(await c.query('SELECT * FROM student_attendance_days WHERE stage_season_id=$1 ORDER BY id FOR UPDATE',[SS])).rows;
      const remindersBefore=(await c.query(`SELECT id,status,expires_at,lease_until FROM notification_outbox WHERE status='pending'
        AND EXISTS(SELECT 1 FROM unnest($1::int[]) x(id) WHERE dedupe_key LIKE 'lesson-reminder:'||x.id||':%'
          OR dedupe_key LIKE 'lesson-recovered:'||x.id||':%' OR dedupe_key LIKE 'lesson-republished:'||x.id||':%') ORDER BY id FOR UPDATE`,[WRONG])).rows;
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
      const openedAt=(await c.query('SELECT now() AS at')).rows[0].at;
      const inserted=await db.activateLesson(AQEEDAH,24,'channel_schedule_recovered',
        `https://t.me/c/4311434262/286`,CHAT,286,received,
        {client:c,scheduleDate:'2026-10-26',attendanceOpenedAt:openedAt});
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
      const checkAfter=(await c.query(`SELECT a.* FROM attendance a WHERE a.lesson_id IN
        (SELECT id FROM lessons WHERE stage_season_id=$1 AND subject_id=ANY($2::int[])) ORDER BY a.id`,[SS,[AQEEDAH,MASAIL]])).rows;
      if(JSON.stringify(checkBefore)!==JSON.stringify(checkAfter))fail('تغيّر حضور الدروس المنقولة أثناء التنفيذ');
      const newMarks=Number((await c.query('SELECT COUNT(*)::int AS n FROM attendance WHERE lesson_id=$1',[inserted.id])).rows[0].n);
      if(newMarks)fail('ظهر حضور غير متوقع في العقائد 11');
      const totals=(await c.query('SELECT subject_id,COUNT(*)::int AS n FROM effective_lessons WHERE stage_season_id=$1 AND subject_id=ANY($2::int[]) GROUP BY subject_id',[SS,[AQEEDAH,MASAIL]])).rows;
      const after=Object.fromEntries(totals.map(r=>[Number(r.subject_id),Number(r.n)]));
      if(after[AQEEDAH]!==11||after[MASAIL]!==s.view.counts.masailAfter)fail('تغيّر عدد الدروس بصورة غير متوقعة');
      // Opening a real lecture is not permission to rewrite saved absence or
      // grades. The normal scheduler waits for its attendance window to close.
      const result={applied:true,policy:POLICY,lesson286:Number(inserted.id),aqeedah:after[AQEEDAH],
        masail:after[MASAIL],preservedAttendanceMarks:checkAfter.length,newAttendanceMarks:0,updatedDailyCacheRows:0,
        note:'نُسبت المنشورات التسعة إلى المسائل، ولم تتغير سجلات حضور الطلاب. تكرار دروس المسائل الاحتياطية لم يُدمج.'};
      const undo={lessons:s.signature.lessons,posts:s.signature.posts,cache:cacheBefore,reminders:remindersBefore,
        attendanceHash:hash(checkAfter),createdLesson:inserted};
      const afterState=await rollbackState(c,inserted.id);
      await c.query(`INSERT INTO lesson_repair_batches(key,actor_id,before_data,after_data)
        VALUES($1,$2,$3::jsonb,$4::jsonb)`,[KEY,actorId,JSON.stringify({...s.view,undo,tokenHash:hash(token)}),JSON.stringify({...result,stateHash:hash(afterState)})]);
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,'reclassify_verified_telegram_lessons','subject',$2,$3::jsonb,$4::jsonb)`,
        [actorId,AQEEDAH,JSON.stringify(s.view),JSON.stringify(result)]);
      await c.query('COMMIT');
      return result;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async function rollbackState(c,createdId){
    return {
      lessons:(await c.query('SELECT * FROM lessons WHERE stage_season_id=$1 AND subject_id=ANY($2::int[]) ORDER BY id',[SS,[AQEEDAH,MASAIL]])).rows,
      posts:(await c.query('SELECT * FROM pending_channel_lesson_posts WHERE telegram_chat_id=$1 AND stage_season_id=$2 ORDER BY id',[CHAT,SS])).rows,
      cache:(await c.query('SELECT * FROM student_attendance_days WHERE stage_season_id=$1 ORDER BY id',[SS])).rows,
      attendance:(await c.query(`SELECT a.* FROM attendance a JOIN lessons l ON l.id=a.lesson_id
        WHERE l.stage_season_id=$1 AND l.subject_id=ANY($2::int[]) ORDER BY a.id`,[SS,[AQEEDAH,MASAIL]])).rows,
      reminders:(await c.query(`SELECT id,status,expires_at,lease_until FROM notification_outbox WHERE
        EXISTS(SELECT 1 FROM unnest($1::int[]) x(id) WHERE dedupe_key LIKE 'lesson-reminder:'||x.id||':%'
          OR dedupe_key LIKE 'lesson-recovered:'||x.id||':%' OR dedupe_key LIKE 'lesson-republished:'||x.id||':%') ORDER BY id`,[WRONG])).rows,
      corrections:(await c.query('SELECT * FROM lesson_corrections WHERE lesson_id=ANY($1::int[]) ORDER BY lesson_id',[[...ALL_LESSONS,createdId]])).rows
    };
  }
  async function rollback({token,actorId,confirmed=false}){
    if(!confirmed)fail('يلزم تأكيد التراجع');actorId=positiveInt(actorId);
    const c=await db.pool.connect();
    try{
      await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(734221,1)');await c.query('SELECT pg_advisory_xact_lock(734225,$1)',[SS]);
      const batch=(await c.query('SELECT * FROM lesson_repair_batches WHERE key=$1 FOR UPDATE',[KEY])).rows[0];
      if(!batch||batch.after_data.reverted)fail('لا توجد دفعة قابلة للتراجع');
      if(hash(token)!==batch.before_data.tokenHash)fail('رمز المعاينة غير مطابق');
      await c.query('SELECT id FROM lessons WHERE stage_season_id=$1 AND subject_id=ANY($2::int[]) ORDER BY id FOR UPDATE',[SS,[AQEEDAH,MASAIL]]);
      await c.query('SELECT id FROM pending_channel_lesson_posts WHERE telegram_chat_id=$1 AND stage_season_id=$2 FOR UPDATE',[CHAT,SS]);
      await c.query('SELECT id FROM student_attendance_days WHERE stage_season_id=$1 FOR UPDATE',[SS]);
      const undo=batch.before_data.undo,createdId=Number(batch.after_data.lesson286);
      if(hash(await rollbackState(c,createdId))!==batch.after_data.stateHash)fail('تغيرت البيانات بعد التصحيح؛ لا يمكن استبدال حضور أو تعديلات أحدث');
      for(const l of undo.lessons)await c.query('UPDATE lessons SET subject_id=$2 WHERE id=$1',[l.id,l.subject_id]);
      for(const p of undo.posts)await c.query(`UPDATE pending_channel_lesson_posts SET status=$2,lesson_id=$3,resolved_subject_id=$4,
        auto_match=$5,resolved_at=$6 WHERE id=$1`,[p.id,p.status,p.lesson_id,p.resolved_subject_id,p.auto_match,p.resolved_at]);
      // Keep the newly created lesson as an audited withdrawn row, with no attendance.
      await c.query('INSERT INTO lesson_corrections(lesson_id,reason,actor_id) VALUES($1,$2,$3)',[createdId,'التراجع عن دفعة التصحيح '+KEY,actorId]);
      for(const n of undo.reminders)await c.query('UPDATE notification_outbox SET status=$2,expires_at=$3,lease_until=$4 WHERE id=$1',[n.id,n.status,n.expires_at,n.lease_until]);
      for(const d of undo.cache)await c.query(`UPDATE student_attendance_days SET lesson_count=$2,attended_on_time_count=$3,
        missed_lesson_count=$4,is_full_absence=$5 WHERE id=$1`,[d.id,d.lesson_count,d.attended_on_time_count,d.missed_lesson_count,d.is_full_absence]);
      const result={reverted:true,attendanceChanged:0,withdrawnLesson:createdId};
      await c.query("UPDATE lesson_repair_batches SET after_data=after_data||$2::jsonb WHERE key=$1",[KEY,JSON.stringify(result)]);
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,'rollback_verified_telegram_lessons','subject',$2,$3::jsonb,$4::jsonb)`,[actorId,AQEEDAH,JSON.stringify(batch.after_data),JSON.stringify(result)]);
      await c.query('COMMIT');return result;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  return {preview,apply,rollback};
}
module.exports={createAqeedah20261026Repair,PAIRS,KEY,POLICY};
