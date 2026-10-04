'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db,studies,scheduler,group,st;
test.before(async()=>{
  ({db,studies}=await testDatabase());scheduler=require('../scheduler').createScheduler({pool:db.pool,studies});
  const stage=await db.addStage('اختبار إنهاء المباحثات'),ss=(await db.listStageSeasons(stage.id))[0].id,sub=await db.addSubject(stage.id,'مادة الإنهاء','finish');
  group=await studies.createMubahathaGroup(sub.id,ss,{title:'مجموعة الإنهاء'});st=await db.createStudent(887900,'طالب اختبار إنهاء مباحثة',stage.id);
  await studies.setParticipationMode(st.id,sub.id,ss,'mubahatha');await studies.assignStudentToGroup(st.id,sub.id,ss);
  await db.pool.query("UPDATE group_memberships SET assigned_at=now()-interval '1 day' WHERE student_id=$1",[st.id]);
  await db.pool.query("UPDATE participation_modes SET joined_mubahatha_at=now()-interval '1 day' WHERE student_id=$1",[st.id]);
});
test.after(async()=>{await db.pool.end();});
test('teacher finishes after a delayed scheduler; repeat finish neither duplicates notices nor extends the deadline',async()=>{
  const s=await studies.openSession(group.id,null,'إنهاء عند تأخر الجدولة',1);
  await db.pool.query("UPDATE mubahatha_sessions SET opened_at=now()-interval '12 minutes',closes_at=now()+interval '48 minutes' WHERE id=$1",[s.id]);
  const opened=await scheduler.openEnd(s.id);assert.equal(opened.status,'opened');assert.equal(opened.notified,1);
  assert.ok(await studies.markSessionAttendance(s.id,st.id,'start'));assert.ok(await studies.markSessionAttendance(s.id,st.id,'end'));
  const again=await scheduler.openEnd(s.id);assert.equal(again.status,'already_open');assert.equal(again.notified,0);assert.equal(again.closesAt.getTime(),opened.closesAt.getTime());
  assert.equal((await db.pool.query('SELECT * FROM notification_outbox WHERE dedupe_key LIKE $1',[`session:${s.id}:end:%`])).rows.length,1);
});
test('early, expired and missing sessions return distinct explanations',async()=>{
  const s=await studies.openSession(group.id,null,'وقت مبكر',1);
  assert.match((await scheduler.openEnd(s.id)).message,/بعد بدء حضور البداية/);
  await db.pool.query("UPDATE mubahatha_sessions SET closes_at=now()-interval '1 minute' WHERE id=$1",[s.id]);
  assert.match((await scheduler.openEnd(s.id)).message,/انتهت مهلة/);assert.match((await scheduler.openEnd(999999)).message,/غير موجودة/);
});
test('expected Telegram edit and expired callback errors never become misleading generic failures',async()=>{
  const {editDiscussionMessage,answerDiscussionCallback}=require('../discussionFlow');let replied=false;
  await editDiscussionMessage({editMessageText:async()=>{throw {description:'Bad Request: message is not modified'};}},'نفس الرد');
  await editDiscussionMessage({editMessageText:async()=>{throw {description:'Bad Request: message to edit not found'};},reply:async()=>{replied=true;}},'نتيجة محفوظة');assert.equal(replied,true);
  await answerDiscussionCallback({answerCbQuery:async()=>{throw {description:'Bad Request: query is too old and response timeout expired or query ID is invalid'};}});
  await assert.rejects(()=>editDiscussionMessage({editMessageText:async()=>{throw Error('real failure');}},'رد'),/real failure/);
});
