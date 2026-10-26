'use strict';
const {createHash}=require('node:crypto');
const {appError,positiveInt}=require('./integrity');
const KEY='one-time-lesson-cleanup-20261026-v1';
const BUTTON='🧹 إزالة الدروس المكررة لمرة واحدة';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function createOneTimeLessonCleanup(pool){
  async function completed(c=pool){return (await c.query('SELECT 1 FROM lesson_repair_batches WHERE key=$1',[KEY])).rowCount>0;}
  async function snapshot(c){
    const rows=(await c.query(`SELECT l.id,l.subject_id,l.stage_season_id,l.source_type,l.source_message_id,l.source_url,
      l.activated_at,l.schedule_date,ss.stage_id,ss.is_active AS season_active,st.name AS stage_name,sub.name AS subject_name,
      p.content_text,p.content_kind,
      COALESCE(p.lesson_date,l.schedule_date,(l.activated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Baghdad')::date)::text AS lecture_date,
      (SELECT COUNT(*)::int FROM attendance a WHERE a.lesson_id=l.id) AS attendance_count,
      (SELECT COUNT(*)::int FROM lesson_schedule_entries e WHERE e.stage_season_id=l.stage_season_id AND e.subject_id=l.subject_id
        AND e.lesson_date<=(now() AT TIME ZONE 'Asia/Baghdad')::date) AS scheduled_due
      FROM effective_lessons l JOIN subjects sub ON sub.id=l.subject_id
      JOIN stage_seasons ss ON ss.id=l.stage_season_id JOIN stages st ON st.id=ss.stage_id
      LEFT JOIN pending_channel_lesson_posts p ON p.telegram_chat_id=l.source_chat_id AND p.source_message_id=l.source_message_id
      ORDER BY l.stage_season_id,l.subject_id,l.activated_at,l.id`)).rows;
    const map=new Map(),subjects=new Map();
    for(const r of rows){
      const sk=r.stage_season_id+':'+r.subject_id;
      if(!subjects.has(sk))subjects.set(sk,{stageId:Number(r.stage_id),stageSeasonId:Number(r.stage_season_id),subjectId:Number(r.subject_id),stage:r.stage_name,subject:r.subject_name,before:0,scheduledDue:Number(r.scheduled_due)});
      subjects.get(sk).before++;
      const k=sk+':'+r.lecture_date;if(!map.has(k))map.set(k,[]);map.get(k).push(r);
    }
    const groups=[...map.entries()].filter(([,ls])=>ls.length>1).map(([key,ls])=>({key,stage:ls[0].stage_name,subject:ls[0].subject_name,date:ls[0].lecture_date,
      lessons:ls.map(r=>({...r,id:Number(r.id),recommended:r.season_active&&r.source_type==='schedule_fallback'&&!r.source_message_id&&ls.some(other=>other.source_message_id&&other.source_type!=='schedule_fallback')}))}));
    groups.sort((a,b)=>Number(b.lessons.some(l=>l.recommended))-Number(a.lessons.some(l=>l.recommended))||a.key.localeCompare(b.key));
    return {groups,subjects:[...subjects.values()],token:hash({key:KEY,rows})};
  }
  async function preview(){
    const c=await pool.connect();
    try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      if(await completed(c)){await c.query('COMMIT');return {available:false,completed:true};}
      const s=await snapshot(c);await c.query('COMMIT');return {available:true,completed:false,...s};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async function execute({token,lessonIds,confirmed=false},actorId){
    actorId=positiveInt(actorId);
    if(!confirmed||!Array.isArray(lessonIds)||!lessonIds.length||lessonIds.length>1000||new Set(lessonIds).size!==lessonIds.length||lessonIds.some(id=>!Number.isSafeInteger(id)||id<=0))throw appError('حدد السجلات المكررة وأكد مراجعتها.');
    const c=await pool.connect();
    try{await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(734221,1)');
      await c.query('SELECT pg_advisory_xact_lock(734227,1)');
      if(await completed(c))throw appError('استُخدم الزر لمرة واحدة سابقًا.','CONFLICT',409);
      // Same per-season lock used by the Telegram publisher and verified repair.
      const seasons=(await c.query('SELECT DISTINCT stage_season_id FROM lessons WHERE id=ANY($1::int[]) ORDER BY stage_season_id',[lessonIds])).rows;
      for(const s of seasons)await c.query('SELECT pg_advisory_xact_lock(734225,$1)',[s.stage_season_id]);
      await c.query('SELECT id FROM lessons WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',[lessonIds]);
      const s=await snapshot(c);if(s.token!==token)throw appError('تغيّرت البيانات؛ أعد المعاينة قبل التنفيذ.','STALE',409);
      const selected=new Set(lessonIds),eligible=s.groups.flatMap(g=>g.lessons);
      if(lessonIds.some(id=>!eligible.some(l=>l.id===id)))throw appError('اختيار خارج حالات التكرار المعروضة.');
      for(const g of s.groups)if(g.lessons.every(l=>selected.has(l.id)))throw appError('يجب إبقاء درس واحد على الأقل من كل مجموعة.');
      const marks=(await c.query('SELECT * FROM attendance WHERE lesson_id=ANY($1::int[]) ORDER BY id FOR UPDATE',[lessonIds])).rows;
      const attendanceHash=hash(marks);
      for(const id of lessonIds)await c.query(`INSERT INTO lesson_corrections(lesson_id,reason,actor_id)
        VALUES($1,'استبعاد سجل مكرر بعد مراجعة الأدمن لمرة واحدة؛ الحضور الأصلي محفوظ دون نقل',$2)`,[id,actorId]);
      await c.query(`UPDATE notification_outbox n SET status='expired',expires_at=now(),lease_until=NULL WHERE status='pending'
        AND EXISTS(SELECT 1 FROM unnest($1::int[]) x(id) WHERE n.dedupe_key LIKE 'lesson-reminder:'||x.id||':%'
          OR n.dedupe_key LIKE 'lesson-recovered:'||x.id||':%' OR n.dedupe_key LIKE 'lesson-republished:'||x.id||':%')`,[lessonIds]);
      const afterMarks=(await c.query('SELECT * FROM attendance WHERE lesson_id=ANY($1::int[]) ORDER BY id',[lessonIds])).rows;
      if(hash(afterMarks)!==attendanceHash)throw appError('تعذر التحقق من سلامة الحضور.');
      const subjects=s.subjects.map(sub=>({...sub,after:sub.before-eligible.filter(l=>selected.has(l.id)&&Number(l.stage_season_id)===sub.stageSeasonId&&Number(l.subject_id)===sub.subjectId).length}));
      const result={completed:true,removedFromCounting:lessonIds.length,preservedAttendance:marks.length,attendanceAdded:0,attendanceMoved:0,attendanceDeleted:0,subjects};
      await c.query('INSERT INTO lesson_repair_batches(key,actor_id,before_data,after_data) VALUES($1,$2,$3::jsonb,$4::jsonb)',
        [KEY,actorId,JSON.stringify({token,lessonIds,attendanceHash,lessons:eligible.filter(l=>selected.has(l.id))}),JSON.stringify(result)]);
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,'one_time_lesson_cleanup','institute',0,$2::jsonb,$3::jsonb)`,[actorId,JSON.stringify({lessonIds,attendanceHash}),JSON.stringify(result)]);
      await c.query('COMMIT');return result;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  return {preview,execute,completed};
}
module.exports={createOneTimeLessonCleanup,KEY,BUTTON};
