'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PAIRS,createAqeedah20261026Repair}=require('../aqeedah20261026Repair');
const CHAT='-1004311434262';let db,repair;
test.before(async()=>{
  ({db}=await require('./helpers.cjs').testDatabase());
  await db.pool.query("INSERT INTO seasons(id,name) VALUES(1,'موسم اختبار'); INSERT INTO stages(id,name) VALUES(4,'مرحلة اختبار التصحيح'); INSERT INTO stage_seasons(id,stage_id,season_id) VALUES(5,4,1);");
  await db.pool.query("INSERT INTO subjects(id,stage_id,name,hashtag) VALUES(18,4,'عقائد الباب الحادي عشر','العقائد'),(19,4,'مسائل معاملات','الفقه'); INSERT INTO channels(stage_id,stage_season_id,telegram_chat_id) VALUES(4,5,-1004311434262)");
  const student=await db.createStudent(980001,'طالب اختبار الأدلة',4);
  async function lesson(id,subject,message,date,kind='channel_schedule'){
    await db.pool.query(`INSERT INTO lessons(id,subject_id,stage_season_id,source_chat_id,source_message_id,source_type,schedule_date,activated_at,active_until)
      VALUES($1,$2,5,$3,$4,$5,$6,$6::date+interval '5 hours',$6::date+interval '29 hours')`,[id,subject,message?CHAT:null,message,kind,date]);
  }
  async function post(message,date,lessonId,text,titleId=null){
    const p=await db.queuePendingChannelLessonPost({chatId:CHAT,messageId:message,stageId:4,stageSeasonId:5,lessonDate:date,contentKind:'audio',contentText:text,titleMessageId:titleId,receivedAt:new Date(date+'T05:00:00Z'),autoMatch:true});
    if(lessonId)await db.resolvePendingChannelLessonPost(p.id,lessonId,18,'activated');
  }
  for(const [i,p] of PAIRS.entries()){
    await lesson(p.wrong,18,p.message,p.day);await post(p.message,p.day,p.wrong,'تسجيل صوتي '+i+'.mp3');
    await db.pool.query('INSERT INTO attendance(student_id,lesson_id,listened_at) VALUES($1,$2,$3)',[student.id,p.wrong,p.day+'T06:00:00Z']);
    if(p.named)await lesson(p.named,18,p.namedMessage,p.day,'channel_schedule_recovered');
    await post(p.namedMessage,p.day,p.named,'عقائد الباب الحادي عشر - الدرس '+(i+3),p.namedMessage-1);
    await lesson(800+i,19,null,p.day,'schedule_fallback');
    await db.pool.query('INSERT INTO attendance(student_id,lesson_id,listened_at) VALUES($1,$2,$3)',[student.id,800+i,p.day+'T06:30:00Z']);
    await db.pool.query('INSERT INTO lesson_schedule_entries(stage_season_id,subject_id,lesson_date) VALUES(5,18,$1),(5,19,$1)',[p.day]);
  }
  await post(285,'2026-10-26',null,'عقائد الباب الحادي عشر - الدرس 11');
  for(const [id,date,msg] of [[900,'2026-09-26',28],[901,'2026-09-27',38]]){
    await lesson(id,18,msg,date);await db.pool.query('INSERT INTO lesson_schedule_entries(stage_season_id,subject_id,lesson_date) VALUES(5,18,$1)',[date]);
  }
  await db.pool.query("SELECT setval('lessons_id_seq',1000)");repair=createAqeedah20261026Repair(db);
});
test.after(async()=>db.pool.end());
test('verified repair includes post 72, refuses drift, rolls back on audit failure and preserves every attendance row through apply and undo',async()=>{
  const raw=async()=> (await db.pool.query('SELECT * FROM attendance ORDER BY id')).rows;
  const before=await raw(),preview=await repair.preview();
  assert.equal(preview.counts.aqeedahBefore,19);assert.equal(preview.counts.aqeedahAfter,11);
  assert.equal(preview.posts.length,9);assert.equal(preview.attendance.added,0);
  await assert.rejects(repair.apply({token:preview.token,actorId:42,confirmed:false}),{code:'CONFLICT'});
  await db.pool.query("UPDATE attendance SET admin_note='new evidence' WHERE id=$1",[before[0].id]);
  await assert.rejects(repair.apply({token:preview.token,actorId:42,confirmed:true}),{code:'CONFLICT'});
  await db.pool.query('UPDATE attendance SET admin_note=$2 WHERE id=$1',[before[0].id,before[0].admin_note]);
  const failDb={...db,pool:{...db.pool,connect:async()=>{const c=await db.pool.connect();return {release:c.release,query:(sql,args)=>sql.includes('INSERT INTO admin_audit_log')?Promise.reject(Error('injected audit failure')):c.query(sql,args)};}}};
  await assert.rejects(createAqeedah20261026Repair(failDb).apply({token:preview.token,actorId:42,confirmed:true}),/injected audit/);
  assert.deepEqual(await raw(),before);assert.equal((await repair.preview()).token,preview.token);
  const applied=await repair.apply({token:preview.token,actorId:42,confirmed:true});assert.equal(applied.aqeedah,11);assert.equal(applied.newAttendanceMarks,0);
  assert.equal(Number((await db.getLessonById(applied.lesson286)).lesson_number),11);assert.deepEqual(await raw(),before);
  assert.equal((await db.pool.query('SELECT subject_id FROM lessons WHERE id=169')).rows[0].subject_id,19);
  assert.equal((await db.pool.query('SELECT lesson_id FROM attendance WHERE id=$1',[before[0].id])).rows[0].lesson_id,before[0].lesson_id);
  await assert.rejects(repair.apply({token:preview.token,actorId:42,confirmed:true}),{code:'CONFLICT'});
  await db.pool.query("UPDATE attendance SET admin_note='later attendance edit' WHERE id=$1",[before[0].id]);
  await assert.rejects(repair.rollback({token:preview.token,actorId:42,confirmed:true}),{code:'CONFLICT'});
  await db.pool.query('UPDATE attendance SET admin_note=$2 WHERE id=$1',[before[0].id,before[0].admin_note]);
  const undo=await repair.rollback({token:preview.token,actorId:42,confirmed:true});assert.ok(undo.reverted);assert.deepEqual(await raw(),before);
  assert.equal((await db.pool.query('SELECT COUNT(*)::int AS n FROM effective_lessons WHERE subject_id=18')).rows[0].n,19);
  assert.equal((await db.pool.query('SELECT COUNT(*)::int AS n FROM lessons WHERE id=$1',[applied.lesson286])).rows[0].n,1);
  assert.equal((await db.pool.query("SELECT COUNT(*)::int AS n FROM admin_audit_log WHERE action IN ('reclassify_verified_telegram_lessons','rollback_verified_telegram_lessons')")).rows[0].n,2);
});
