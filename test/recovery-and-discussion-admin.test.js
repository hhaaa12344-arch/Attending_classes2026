'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
process.env.BOT_TOKEN='12345:OFFLINE_TEST_ONLY';process.env.DATABASE_URL='postgresql://localhost/attendance_test_unused';process.env.ADMIN_IDS='42';
const {Telegram}=require('telegraf');const original=Telegram.prototype.callApi;
Telegram.prototype.callApi=async(method,p)=>({message_id:1,chat:{id:p.chat_id,type:'private'}});
let db,studies,recovery,attendance,app,seq=1200000;
test.before(async()=>{
  ({db,studies}=await require('./helpers.cjs').testDatabase());
  await require('../backups').initBackupSchema(db.pool);await require('../studentGuide').initStudentGuideSchema(db.pool);
  recovery=require('../lessonRecovery').createLessonRecovery(db);attendance=require('../discussionAttendance').createDiscussionAttendance(db.pool);
  app=require('../index');app.bot.botInfo={id:12345,is_bot:true,username:'TestBot',first_name:'test'};
});
test.after(async()=>{Telegram.prototype.callApi=original;await db.pool.end();});
async function fixture(){
  const stage=await db.addStage('مرحلة '+(++seq)),ss=(await db.listStageSeasons(stage.id))[0].id;
  const a=await db.addSubject(stage.id,'المادة الأولى','a'+seq),b=await db.addSubject(stage.id,'المادة الثانية','b'+seq);
  const student=await db.createStudent(++seq,'طالب اختبار استرجاع إداري',stage.id),chat=-1000000000-seq;
  await db.linkChannel(stage.id,chat,'قناة المرحلة');return {stage,ss,a,b,student,chat};
}
async function pending(f,messageId,daysAgo=2){
  const at=new Date(Date.now()-daysAgo*86400000),date=at.toISOString().slice(0,10);
  return db.queuePendingChannelLessonPost({chatId:f.chat,messageId,stageId:f.stage.id,stageSeasonId:f.ss,lessonDate:date,receivedAt:at,sourceUrl:`https://t.me/c/${-f.chat}/${messageId}`,contentKind:'voice'});
}
test('restored old lesson becomes number one, today becomes two, attendance survives and restoration opens 24 hours once',async()=>{
  const f=await fixture(),p=await pending(f,1),newer=await db.activateLesson(f.a.id,24,'channel','https://t.me/c/1/2',f.chat,2);
  await db.markAttendance(f.student.id,newer.id);
  const saved=(await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1',[newer.id])).rows;
  assert.equal(Number((await db.getLessonById(newer.id)).lesson_number),1);
  const restored=await recovery.restore(p.id,f.a.id,{actorId:42});assert.equal(restored.created,true);
  assert.equal(restored.lesson.activated_at.getTime(),p.received_at.getTime());
  assert.equal(restored.lesson.active_until-restored.lesson.attendance_opened_at,86400000);
  assert.equal(Number((await db.getLessonById(restored.lesson.id)).lesson_number),1);
  assert.equal(Number((await db.getLessonById(newer.id)).lesson_number),2);
  assert.ok(await db.markAttendance(f.student.id,restored.lesson.id));
  assert.deepEqual((await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1',[newer.id])).rows,saved);
  const twice=await recovery.restore(p.id,f.a.id,{actorId:42});assert.equal(twice.created,false);
  assert.deepEqual(twice.lesson.active_until,restored.lesson.active_until);
  assert.equal((await db.pool.query('SELECT * FROM notification_outbox WHERE dedupe_key LIKE $1',[`lesson-recovered:${restored.lesson.id}:%`])).rows.length,1);
  assert.deepEqual((await db.reopenLesson(restored.lesson.id)).active_until,restored.lesson.active_until);
});
test('yesterday backlog takes the first scheduled slot before new posts and is isolated for every stage',async()=>{
  const today=app.currentDateInTimeZone('Asia/Baghdad'),fixtures=[await fixture(),await fixture()];
  for(const f of fixtures){
    const old=await pending(f,10,1);
    await db.pool.query("INSERT INTO lesson_schedule_entries(stage_season_id,subject_id,lesson_date,created_at) VALUES($1,$2,$4,now()-interval '3 minutes'),($1,$3,$4,now()-interval '3 minutes')",[f.ss,f.a.id,f.b.id,today]);
    await app.bot.handleUpdate({update_id:++seq,channel_post:{message_id:11,date:Math.floor(Date.now()/1000),chat:{id:f.chat,type:'channel',title:'قناة المرحلة'},voice:{file_id:'offline',file_unique_id:'voice'+f.chat,duration:60}}});
    assert.equal(await db.getLessonBySource(f.chat,11),undefined,'new publication waits behind yesterday backlog');
    assert.equal((await db.getPendingChannelLessonPosts(f.ss,today)).length,2);
    assert.equal(Number(old.stage_season_id),f.ss);
  }
  const result=await app.recoverPendingChannelLessonsForDate(today);assert.equal(result.recovered,4);
  for(const f of fixtures){
    const old=await db.getLessonBySource(f.chat,10),newer=await db.getLessonBySource(f.chat,11);
    assert.equal(old.subject_id,f.a.id);assert.equal(newer.subject_id,f.b.id);
    assert.equal(old.stage_season_id,f.ss);assert.equal(newer.stage_season_id,f.ss);
    assert.equal((await db.getPendingScheduledSubjectsForDate(f.ss,today)).length,0);
    assert.equal((await db.getPendingChannelLessonPosts(f.ss,today)).length,0);
  }
  assert.equal((await app.recoverPendingChannelLessonsForDate(today)).recovered,0);
});
test('manual recovery rejects another stage and archived seasons; repeating schema preserves restored data',async()=>{
  const a=await fixture(),b=await fixture(),p=await pending(a,20);
  await assert.rejects(recovery.restore(p.id,b.a.id,{actorId:42}));
  await db.pool.query('UPDATE stage_seasons SET is_active=false WHERE id=$1',[a.ss]);
  await assert.rejects(recovery.restore(p.id,a.a.id),{code:'ARCHIVED'});
  await db.initSchema();assert.ok(await db.getLessonBySource(a.chat,20)===undefined);
  assert.equal((await db.pool.query('SELECT status FROM pending_channel_lesson_posts WHERE id=$1',[p.id])).rows[0].status,'pending');
});
test('selected discussion marking adds only missing phases and never writes lesson attendance even with colliding IDs',async()=>{
  const f=await fixture(),g=await studies.createMubahathaGroup(f.a.id,f.ss,{title:'مجموعة التحضير'});
  const other=await db.createStudent(++seq,'طالب ثان للتحضير الإداري',f.stage.id);
  for(const st of [f.student,other]){await studies.setParticipationMode(st.id,f.a.id,f.ss,'mubahatha');await studies.assignStudentToGroup(st.id,f.a.id,f.ss);}
  await db.pool.query("UPDATE group_memberships SET assigned_at=now()-interval '1 day' WHERE group_id=$1",[g.id]);
  await db.pool.query("UPDATE participation_modes SET joined_mubahatha_at=now()-interval '1 day' WHERE subject_id=$1",[f.a.id]);
  const session=await studies.openSession(g.id,null,'اختبار الحضور الإداري',1);
  assert.ok((await db.pool.query('SELECT id FROM lessons WHERE id=$1',[session.id])).rows.length,'session number also identifies a real lesson');
  await db.pool.query("INSERT INTO mubahatha_attendance(session_id,student_id,phase) VALUES($1,$2,'start')",[session.id,f.student.id]);
  const existing=(await db.pool.query('SELECT * FROM mubahatha_attendance WHERE session_id=$1',[session.id])).rows[0];
  const lessonsBefore=(await db.pool.query('SELECT * FROM attendance ORDER BY id')).rows;
  const result=await attendance.mark(session.id,{subjectId:f.a.id,studentIds:[f.student.id,other.id],note:'تعذر التسجيل'},42);
  assert.deepEqual(result,{added:2,records:3,existing:0});
  assert.deepEqual((await db.pool.query('SELECT * FROM attendance ORDER BY id')).rows,lessonsBefore);
  assert.deepEqual((await db.pool.query('SELECT * FROM mubahatha_attendance WHERE id=$1',[existing.id])).rows[0],existing);
  const added=(await db.pool.query('SELECT * FROM mubahatha_attendance WHERE session_id=$1 AND id<>$2',[session.id,existing.id])).rows;
  assert.ok(added.every(x=>x.marked_by==='admin:42'&&x.admin_note==='تعذر التسجيل'));
  assert.deepEqual(await attendance.mark(session.id,{subjectId:f.a.id,studentIds:[f.student.id,other.id]},42),{added:0,records:0,existing:2});
  const outsider=await db.createStudent(++seq,'طالب خارج مجموعة المباحثة',f.stage.id);
  await assert.rejects(attendance.mark(session.id,{subjectId:f.a.id,studentIds:[f.student.id,outsider.id]},42),{code:'NOT_ELIGIBLE'});
  await assert.rejects(attendance.mark(session.id,{subjectId:f.b.id,studentIds:[f.student.id]},42),{code:'CONFLICT'});
  assert.equal((await attendance.options(session.id)).total,2);
  await studies.changeParticipationMode(other.id,f.a.id,f.ss,'report',{actorId:42});
  assert.equal((await attendance.options(session.id)).total,1);
  await assert.rejects(attendance.mark(session.id,{subjectId:f.a.id,studentIds:[other.id]},42),{code:'NOT_ELIGIBLE'});
});

test('absence monitoring uses recovery availability day while lesson numbering retains publication day',async()=>{
  const f=await fixture(),p=await pending(f,30,3),r=await recovery.restore(p.id,f.a.id);
  // Simulate completion of the new attendance window without changing original publication.
  await db.pool.query("UPDATE enrollments SET started_at=now()-interval '5 days' WHERE student_id=$1",[f.student.id]);
  await db.pool.query("UPDATE absence_monitoring_config SET started_at=now()-interval '10 days' WHERE id=1");
  await db.pool.query("UPDATE lessons SET attendance_opened_at=now()-interval '24 hours',active_until=now()-interval '1 second' WHERE id=$1",[r.lesson.id]);
  await db.pool.query("INSERT INTO attendance(student_id,lesson_id,listened_at) VALUES($1,$2,now()-interval '1 hour')",[f.student.id,r.lesson.id]);
  await require('../absence').processCompletedDays(db.pool,'Asia/Baghdad');
  const days=(await db.pool.query("SELECT to_char(attendance_date,'YYYY-MM-DD') AS day,lesson_count,attended_on_time_count FROM student_attendance_days WHERE student_id=$1",[f.student.id])).rows;
  const lesson=(await db.pool.query("SELECT to_char(attendance_opened_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Baghdad','YYYY-MM-DD') AS available,to_char(activated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Baghdad','YYYY-MM-DD') AS published FROM lessons WHERE id=$1",[r.lesson.id])).rows[0];
  assert.notEqual(lesson.available,lesson.published);assert.deepEqual(days,[{day:lesson.available,lesson_count:1,attended_on_time_count:1}]);
});
