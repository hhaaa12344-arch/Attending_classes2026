'use strict';
// Manual, evidence-scoped, one-time correction. Never called during startup.
// Keep every original lesson and every original attendance row for auditability.
const {createHash}=require('node:crypto');
const {positiveInt,appError}=require('./integrity');
const KEY='aqeedah-stage4-season5-20261026-reviewed-v1';
// Important: NEVER infer attendance for a different lesson from a wrong classification.
const ATTENDANCE_POLICY='NO_TRANSFER_V2';
const CHAT='-1004311434262',STAGE=4,SS=5,SUBJECT=18;
const PAIRS=[
  {day:'2026-09-30',wrong:169,wrongMessage:70,right:193,rightMessage:72},
  {day:'2026-10-03',wrong:205,wrongMessage:84,right:293,rightMessage:86},
  {day:'2026-10-06',wrong:299,wrongMessage:122,right:360,rightMessage:124},
  {day:'2026-10-10',wrong:377,wrongMessage:148,right:429,rightMessage:150},
  {day:'2026-10-12',wrong:431,wrongMessage:172,right:496,rightMessage:174},
  {day:'2026-10-14',wrong:504,wrongMessage:198,right:593,rightMessage:200},
  {day:'2026-10-19',wrong:597,wrongMessage:235,right:661,rightMessage:237},
  {day:'2026-10-21',wrong:667,wrongMessage:259,right:729,rightMessage:261},
  {day:'2026-10-26',wrong:748,wrongMessage:284,right:null,rightMessage:286},
];
const ids=PAIRS.flatMap(p=>[p.wrong,...(p.right?[p.right]:[])]);
function dayOf(date){if(!date)return null;return date instanceof Date?date.toISOString().slice(0,10):String(date).slice(0,10);}
function mismatch(message){throw appError('تختلف قاعدة البيانات الحالية عن النسخة المفحوصة: '+message+'؛ أوقف التصحيح وراجع المستجدات.','CONFLICT',409);}
function createAqeedah20261026Repair(db){
  async function snapshot(client=db.pool){
    const linked=(await client.query(`SELECT ch.id,ss.is_active,ss.stage_id FROM channels ch JOIN stage_seasons ss ON ss.id=ch.stage_season_id
      WHERE ch.telegram_chat_id=$1 AND ch.stage_id=$2 AND ch.stage_season_id=$3`,[CHAT,STAGE,SS])).rows[0];
    if(!linked||!linked.is_active||Number(linked.stage_id)!==STAGE)mismatch('ربط القناة أو موسم المرحلة');
    const lessonRows=(await client.query(`SELECT l.*, (SELECT COUNT(*)::int FROM attendance a WHERE a.lesson_id=l.id) AS attendance_count
      FROM lessons l WHERE l.id=ANY($1::int[]) ORDER BY l.id`,[ids])).rows;
    const indexed=new Map(lessonRows.map(l=>[Number(l.id),l]));
    const postRows=(await client.query(`SELECT id,source_message_id,content_text,lesson_date,status,lesson_id,resolved_subject_id,title_message_id
      FROM pending_channel_lesson_posts WHERE telegram_chat_id=$1 AND stage_season_id=$2 AND source_message_id=ANY($3::bigint[])
      ORDER BY source_message_id`,[CHAT,SS,PAIRS.map(x=>x.rightMessage)])).rows;
    const posts=new Map(postRows.map(p=>[Number(p.source_message_id),p]));
    const corrections=(await client.query(`SELECT lesson_id FROM lesson_corrections WHERE lesson_id=ANY($1::int[])`,[ids])).rows;
    if(corrections.length)mismatch('سبق إجراء تصحيح على إحدى المحاضرات');
    const batch=(await client.query('SELECT key FROM lesson_repair_batches WHERE key=$1',[KEY])).rows[0];
    if(batch)mismatch('التصحيح طُبّق بالفعل');
    const {namedSubjects}=require('./lessonContent');
    const subject=(await client.query('SELECT id,name,hashtag FROM subjects WHERE id=$1 AND stage_id=$2',[SUBJECT,STAGE])).rows[0];
    if(!subject||!subject.name.includes('عقائد'))mismatch('تعريف العقائد');
    const stageSubjects=(await client.query('SELECT id,name,hashtag FROM subjects WHERE stage_id=$1',[STAGE])).rows;
    for(const pair of PAIRS){
      const extra=indexed.get(pair.wrong),right=pair.right?indexed.get(pair.right):null;
      if(!extra||Number(extra.subject_id)!==SUBJECT||Number(extra.stage_season_id)!==SS||String(extra.source_chat_id)!==CHAT||Number(extra.source_message_id)!==pair.wrongMessage||dayOf(extra.schedule_date)!==pair.day)
        mismatch('الدرس العام '+pair.wrong);
      if(pair.right&&(!right||Number(right.subject_id)!==SUBJECT||Number(right.stage_season_id)!==SS||String(right.source_chat_id)!==CHAT||Number(right.source_message_id)!==pair.rightMessage||dayOf(right.schedule_date)!==pair.day))
        mismatch('الدرس المسمّى '+pair.right);
      const post=posts.get(pair.rightMessage);
      if(!post||dayOf(post.lesson_date)!==pair.day||!post.content_text||namedSubjects(stageSubjects,post.content_text).length!==1||Number(namedSubjects(stageSubjects,post.content_text)[0].id)!==SUBJECT)
        mismatch('هوية منشور العقائد '+pair.rightMessage);
      if(pair.right&&Number(post.lesson_id)!==pair.right)mismatch('ارتباط المنشور '+pair.rightMessage);
      if(!pair.right&&(post.status!=='pending'||post.lesson_id))mismatch('المنشور 286 لم يعد معلقاً');
    }
    const todayPair=PAIRS.at(-1),todayPost=posts.get(todayPair.rightMessage);
    const todayTitle=(await client.query(`SELECT id,status,lesson_id FROM pending_channel_lesson_posts
      WHERE telegram_chat_id=$1 AND stage_season_id=$2 AND source_message_id=$3`,[CHAT,SS,285])).rows[0];
    if(!todayTitle||todayTitle.status!=='pending'||todayTitle.lesson_id)mismatch('حالة عنوان الدرس 11');
    const currentCount=Number((await client.query(`SELECT COUNT(*)::int AS n FROM effective_lessons WHERE subject_id=$1 AND stage_season_id=$2`,[SUBJECT,SS])).rows[0].n);
    if(currentCount!==19)mismatch('أصبح مجموع الدروس '+currentCount+' بدلاً من 19');
    const attendance=(await client.query(`SELECT student_id,lesson_id,listened_at,marking_kind,marked_by,admin_note
      FROM attendance WHERE lesson_id=ANY($1::int[]) ORDER BY lesson_id,student_id`,[ids])).rows;
    const impact=PAIRS.map(pair=>{
      const wrongStudents=new Set(attendance.filter(a=>Number(a.lesson_id)===pair.wrong).map(a=>String(a.student_id)));
      const rightStudents=new Set(pair.right?attendance.filter(a=>Number(a.lesson_id)===pair.right).map(a=>String(a.student_id)):[]);
      return {wrongLesson:pair.wrong,previousMarks:wrongStudents.size,withoutConfirmedMarkOnNamedLesson:[...wrongStudents].filter(id=>!rightStudents.has(id)).length};
    });
    const view={attendancePolicy:ATTENDANCE_POLICY,key:KEY,stageId:STAGE,stageSeasonId:SS,subjectId:SUBJECT,channel:CHAT,counts:{scheduled:11,effective:currentCount,extra:PAIRS.length,expectedAfter:11},
      pairs:PAIRS.map(p=>({date:p.day,wrongLesson:p.wrong,wrongPost:p.wrongMessage,originalAttendance:Number(indexed.get(p.wrong).attendance_count),
        correctLesson:p.right,correctPost:p.rightMessage,correctAttendance:p.right?Number(indexed.get(p.right).attendance_count):0})),
      attendanceReview:{originalMarksOnAmbiguousLessons:impact.reduce((n,p)=>n+p.previousMarks,0),marksWithoutConfirmedAttendanceOnNamedLessons:impact.reduce((n,p)=>n+p.withoutConfirmedMarkOnNamedLesson,0),addedToNamedLessons:0,byLesson:impact},
      warning:'آمن للحضور: لا نقل ولا نسخ ولا إنشاء لتأشيرات حضور. تُحفَظ سجلات الدروس العامة الأصلية للتدقيق، ولكن تُستبعد من عداد العقائد؛ بعض الطلاب قد يلزم مراجعة استحقاقهم يدوياً. افحص المنشورات العامة التسعة قبل التأكيد.'};
    const signature={linked,lessonRows,postRows,todayTitle,attendance,currentCount};
    // Invalidate preview tokens issued by the previous transfer-attendance implementation.
    const token=createHash('sha256').update(JSON.stringify({attendancePolicy:ATTENDANCE_POLICY,signature})).digest('hex');
    return {view,token,signature,todayPost,wrongToday:indexed.get(todayPair.wrong)};
  }
  async function preview(){const s=await snapshot();return {...s.view,token:s.token};}
  async function apply({token,actorId,confirmed=false}){
    if(!confirmed)throw appError('يجب التأكد يدوياً من المنشورات العامة قبل تنفيذ التصحيح.','CONFIRM_REQUIRED',409);
    actorId=positiveInt(actorId);
    const c=await db.pool.connect();
    try{
      await c.query('BEGIN');
      // Shared with attendance marking and all channel-publication paths.
      await c.query('SELECT pg_advisory_xact_lock(734221,1)');
      await c.query('SELECT pg_advisory_xact_lock(734225,$1)',[SS]);
      await c.query('SELECT id FROM lessons WHERE id=ANY($1::int[]) FOR UPDATE',[ids]);
      await c.query('SELECT id FROM pending_channel_lesson_posts WHERE telegram_chat_id=$1 AND stage_season_id=$2 AND source_message_id=ANY($3::bigint[]) FOR UPDATE',
        [CHAT,SS,[285,...PAIRS.map(p=>p.rightMessage)]]);
      const s=await snapshot(c);
      if(!token||token!==s.token)mismatch('تغيرت البيانات بعد المعاينة؛ أعد المعاينة قبل التطبيق');
      const before={...s.view,preservedRawAttendance:s.signature.attendance.length};
      const today=PAIRS.at(-1),post=s.todayPost;
      // Withdraw the anonymous channel file BEFORE activating the actual titled
      // Aqeedah lecture. This removes the wrong slot claim atomically.
      for(const pair of PAIRS){
        await c.query(`INSERT INTO lesson_corrections(lesson_id,canonical_lesson_id,reason,actor_id)
          VALUES($1,$2,$3,$4)`,[pair.wrong,null,
          'منشور بلا تسمية للمادة استُبعد من عداد العقائد بعد المراجعة؛ لم يُنقل أي حضور، والسجل الأصلي باقٍ للتدقيق.',actorId]);
      }
      const right=await db.activateLesson(SUBJECT,24,'channel_schedule_recovered',`https://t.me/c/4311434262/${today.rightMessage}`,
        CHAT,today.rightMessage,new Date(s.wrongToday.activated_at),{client:c,scheduleDate:today.day});
      if(!right||Number(right.source_message_id)!==today.rightMessage)throw appError('تعذر إنشاء درس العقائد 11 بصورة آمنة.','CONFLICT',409);
      // Preserve the original window rather than silently opening a new one.
      await c.query('UPDATE lessons SET active_until=$2,attendance_opened_at=$3 WHERE id=$1',
        [right.id,s.wrongToday.active_until,s.wrongToday.attendance_opened_at]);
      await c.query("UPDATE pending_channel_lesson_posts SET status='activated',lesson_id=$2,resolved_subject_id=$3,auto_match=false,resolved_at=now() WHERE id=$1",
        [post.id,right.id,SUBJECT]);
      await c.query("UPDATE pending_channel_lesson_posts SET status='duplicate',lesson_id=$2,resolved_subject_id=$3,auto_match=false,resolved_at=now() WHERE telegram_chat_id=$1 AND stage_season_id=$4 AND source_message_id=285",
        [CHAT,right.id,SUBJECT,SS]);
      // Never copy attendance from an ambiguous post to an explicitly named lesson.
      // Keep existing raw rows untouched; expire only queued reminder messages.
      for(const pair of PAIRS){
        await c.query(`UPDATE notification_outbox SET status='expired',expires_at=now()
          WHERE status='pending' AND (dedupe_key LIKE $1 OR dedupe_key LIKE $2 OR dedupe_key LIKE $3)`,
          [`lesson-reminder:${pair.wrong}:%`,`lesson-recovered:${pair.wrong}:%`,`lesson-republished:${pair.wrong}:%`]);
      }
      // New, correctly named lesson 11 must start with ZERO inferred attendance.
      const createdAttendance=Number((await c.query('SELECT COUNT(*)::int AS n FROM attendance WHERE lesson_id=$1',[right.id])).rows[0].n);
      if(createdAttendance!==0)throw appError('ظهر حضور غير متوقع في الدرس الجديد؛ أُلغيت العملية.','CONFLICT',409);
      // A live mark during execution must force a retry, never a silent overwrite.
      const preserved=(await c.query(`SELECT student_id,lesson_id,listened_at,marking_kind,marked_by,admin_note
        FROM attendance WHERE lesson_id=ANY($1::int[]) ORDER BY lesson_id,student_id`,[ids])).rows;
      if(JSON.stringify(preserved)!==JSON.stringify(s.signature.attendance))
        mismatch('تغيّرت تأشيرات الحضور أثناء الإصلاح');
      // Rebuild the cached aggregate, including the total lesson count, since
      // a plain refreshAdministrativeAttendance does not recalculate that column.
      await c.query(`UPDATE student_attendance_days d SET lesson_count=x.total,
        attended_on_time_count=x.attended,missed_lesson_count=GREATEST(0,x.total-x.attended),
        is_full_absence=(NOT d.is_excused_leave AND x.total>0 AND x.attended=0)
        FROM (SELECT d.id,COUNT(l.id)::int AS total,
          COUNT(a.id) FILTER (WHERE a.listened_at<=l.active_until OR a.marking_kind='admin_late')::int AS attended
        FROM student_attendance_days d JOIN enrollments en ON en.student_id=d.student_id AND en.stage_season_id=d.stage_season_id
        LEFT JOIN effective_lessons l ON l.stage_season_id=d.stage_season_id
          AND (COALESCE(l.attendance_opened_at,l.activated_at) AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Baghdad')::date=d.attendance_date
          AND COALESCE(l.attendance_opened_at,l.activated_at)>=en.started_at
          AND (en.ended_at IS NULL OR COALESCE(l.attendance_opened_at,l.activated_at)<=en.ended_at)
        LEFT JOIN attendance a ON a.lesson_id=l.id AND a.student_id=d.student_id
        WHERE d.stage_season_id=$1 GROUP BY d.id) x WHERE d.id=x.id`,[SS]);
      const studentIds=(await c.query('SELECT DISTINCT student_id FROM enrollments WHERE stage_season_id=$1',[SS])).rows.map(r=>r.student_id);
      if(studentIds.length)await require('./absence').refreshAdministrativeAttendance(c,studentIds,SS,'Asia/Baghdad');
      const afterCount=Number((await c.query('SELECT COUNT(*)::int AS n FROM effective_lessons WHERE subject_id=$1 AND stage_season_id=$2',[SUBJECT,SS])).rows[0].n);
      if(afterCount!==11)throw appError('لم يصل عدد العقائد إلى 11؛ تم إلغاء العملية كلها.','CONFLICT',409);
      const after={afterCount,attendancePolicy:ATTENDANCE_POLICY,correctedLessonId:right.id,originalAttendancePreserved:before.preservedRawAttendance,addedAttendance:0,copiedAttendance:0,attendanceNeedsManualReview:s.view.attendanceReview.marksWithoutConfirmedAttendanceOnNamedLessons};
      await c.query(`INSERT INTO lesson_repair_batches(key,actor_id,before_data,after_data) VALUES($1,$2,$3::jsonb,$4::jsonb)`,
        [KEY,actorId,JSON.stringify(before),JSON.stringify(after)]);
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,'repair_ambiguous_aqeedah_lessons','subject',$2,$3::jsonb,$4::jsonb)`,
        [actorId,SUBJECT,JSON.stringify(before),JSON.stringify(after)]);
      await c.query('COMMIT');return {applied:true,...after};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  return {preview,apply};
}
module.exports={createAqeedah20261026Repair,PAIRS,KEY};
