'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
process.env.BOT_TOKEN='12345:OFFLINE_TEST_ONLY';process.env.DATABASE_URL='postgresql://localhost/attendance_test_unused';process.env.ADMIN_IDS='42';
const {Telegram}=require('telegraf');const original=Telegram.prototype.callApi;
let messages=[],messageId=100,db,studies,app,student,lesson,session,other,group,ss,subject;
Telegram.prototype.callApi=async function(method,payload){messages.push({method,...payload});return {message_id:messageId++,chat:{id:payload.chat_id,type:'private'}};};
const {testDatabase}=require('./helpers.cjs');
test.before(async()=>{
  ({db,studies}=await testDatabase());await require('../backups').initBackupSchema(db.pool);await require('../studentGuide').initStudentGuideSchema(db.pool);
  const stage=await db.addStage('مرحلة فصل الدروس والمباحثات');ss=(await db.listStageSeasons(stage.id))[0].id;
  subject=await db.addSubject(stage.id,'مادة اختبار الأزرار','routing');
  student=await db.createStudent(998877,'طالب اختبار حضور مباحثة',stage.id);
  await db.pool.query('UPDATE students SET official_confirmed_at=now() WHERE id=$1',[student.id]);
  group=await studies.createMubahathaGroup(subject.id,ss,{title:'مجموعة اختبار'});
  await studies.setParticipationMode(student.id,subject.id,ss,'mubahatha');await studies.assignStudentToGroup(student.id,subject.id,ss);
  await db.pool.query("UPDATE group_memberships SET assigned_at=now()-interval '1 hour' WHERE student_id=$1",[student.id]);
  await db.pool.query("UPDATE participation_modes SET joined_mubahatha_at=now()-interval '1 hour' WHERE student_id=$1",[student.id]);
  lesson=await db.activateLesson(subject.id,24);
  session=await studies.openSession(group.id,null,'مباحثة لها نفس رقم الدرس',1);
  assert.equal(session.id,lesson.id,'fixture must exercise colliding identifiers');
  other=await studies.openSession(group.id,null,'مباحثة بلا درس يحمل رقمها',1);
  await db.pool.query("UPDATE mubahatha_sessions SET opened_at=now()-interval '11 minutes',closes_at=now()+interval '49 minutes',end_opened_at=now(),end_closes_at=now()+interval '49 minutes'");
  app=require('../index');app.bot.botInfo={id:12345,is_bot:true,username:'AttendanceTestBot',first_name:'test'};
});
test.beforeEach(async()=>{messages=[];await db.pool.query('DELETE FROM attendance');await db.pool.query('DELETE FROM mubahatha_attendance');});
test.after(async()=>{Telegram.prototype.callApi=original;if(db)await db.pool.end();});
async function press(data){
  const from={id:Number(student.telegram_id),is_bot:false,first_name:'test'};
  await app.bot.handleUpdate({update_id:messageId++,callback_query:{id:'cb'+messageId,from,data,message:{message_id:messageId++,date:Math.floor(Date.now()/1000),chat:{id:from.id,type:'private'},text:'تسجيل الحضور'}}});
}
const rows=async table=>(await db.pool.query('SELECT * FROM '+table+' ORDER BY id')).rows;
test('discussion start works with no lesson sharing its number',async()=>{
  await press('mub_attend:'+other.id);
  assert.equal((await rows('mubahatha_attendance')).length,1);
  assert.equal((await rows('attendance')).length,0);
  assert.ok(messages.some(m=>m.text?.includes('تم تسجيل حضور البداية')));
  assert.ok(!messages.some(m=>m.text?.includes('الدرس')));
});
test('discussion start and end cannot write lesson attendance even when both identifiers match',async()=>{
  await press('mub_attend:'+session.id);await press('mub_end_attend:'+session.id);
  assert.deepEqual((await rows('mubahatha_attendance')).map(r=>r.phase),['start','end']);
  assert.equal((await rows('attendance')).length,0);
  await press('mub_attend:'+session.id);await press('mub_end_attend:'+session.id);
  assert.equal((await rows('mubahatha_attendance')).length,2);
});
test('lesson attendance still writes only its own table',async()=>{
  await press('attend:'+lesson.id);
  assert.equal((await rows('attendance')).length,1);
  assert.equal((await rows('mubahatha_attendance')).length,0);
});
test('malformed attendance callback prefixes and suffixes never write either kind',async()=>{
  for(const value of ['bad_attend:','bad_mub_attend:','bad_mub_end_attend:'])await press(value+session.id);
  for(const value of ['attend:','mub_attend:','mub_end_attend:'])await press(value+session.id+':extra');
  assert.equal((await rows('attendance')).length,0);assert.equal((await rows('mubahatha_attendance')).length,0);
});

test('reopened discussion uses one two-button notice, supports end-first and closes both paths after ten minutes',async()=>{
  const recovery=await studies.openSession(group.id,null,'استعادة حضور',1);
  // Simulate the previous version's extended deadline: the recovery window must override it.
  await db.pool.query("UPDATE mubahatha_sessions SET opened_at=now()-interval '20 minutes',closes_at=now()+interval '24 hours',end_opened_at=now(),end_closes_at=now()+interval '24 hours' WHERE id=$1",[recovery.id]);
  const data=require('../adminData').createAdminData(db,studies);
  const opened=await data.manageSession(recovery.id,'reopen',42);
  const scheduler=require('../scheduler').createScheduler({pool:db.pool,studies});
  assert.equal(await scheduler.queueSession(recovery.id,'start'),0);assert.equal(await scheduler.queueSession(recovery.id,'end'),0);
  assert.equal(await studies.openEndAttendance(recovery.id),undefined);
  const notices=(await db.pool.query('SELECT * FROM notification_outbox WHERE dedupe_key LIKE $1',['session:'+recovery.id+':%'])).rows;
  assert.equal(notices.length,1);assert.match(notices[0].payload[0],/10 دقائق/);
  assert.equal(opened.attendance_reopen_until-opened.attendance_reopened_at,600000);
  await press('mub_end_attend:'+recovery.id);
  const edit=messages.findLast(m=>m.method==='editMessageText');
  assert.equal(edit.reply_markup.inline_keyboard[0][0].callback_data,'mub_attend:'+recovery.id);
  await press('mub_attend:'+recovery.id);
  assert.match(messages.findLast(m=>m.method==='editMessageText').text,/اكتمل حضورك/);
  const saved=await rows('mubahatha_attendance');assert.deepEqual(saved.map(r=>r.phase),['end','start']);
  await db.pool.query('UPDATE mubahatha_sessions SET attendance_reopen_until=now() WHERE id=$1',[recovery.id]);
  messages=[];await press('mub_attend:'+recovery.id);await press('mub_end_attend:'+recovery.id);
  assert.equal(messages.filter(m=>m.method==='answerCallbackQuery'&&m.text.includes('انتهى')).length,2);
  assert.deepEqual(await rows('mubahatha_attendance'),saved);assert.equal((await rows('attendance')).length,0);
  await studies.initStudiesSchema();
  assert.deepEqual(await rows('mubahatha_attendance'),saved,'migration is safe to repeat');
});
test('discussion time and eligibility checks still reject early, expired and report-mode attendance',async()=>{
  const early=await studies.openSession(group.id,null,'لم يبدأ الحضور الأول',1);
  await press('mub_attend:'+early.id);assert.ok(messages.some(m=>m.text?.includes('لم يبدأ')));
  await db.pool.query("UPDATE mubahatha_sessions SET closes_at=now()-interval '1 second',end_closes_at=now()-interval '1 second' WHERE id=$1",[early.id]);
  await press('mub_end_attend:'+early.id);
  await studies.changeParticipationMode(student.id,subject.id,ss,'report',{actorId:42});
  await press('mub_attend:'+session.id);await press('mub_end_attend:'+session.id);
  assert.equal((await rows('attendance')).length,0);assert.equal((await rows('mubahatha_attendance')).length,0);
});
