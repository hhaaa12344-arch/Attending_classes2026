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
      // This legacy plan copied attendance between lessons. It is read-only now;
      // previously applied batches remain visible but cannot be replayed.
      throw appError('أداة التصحيح القديمة متوقفة: تتطلب مراجعة مستقلة لأدلة المحاضرات دون نسخ الحضور.','REVIEW_REQUIRED',409);
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  return {preview,apply};
}
module.exports={createHistoricalLessonRepair};
