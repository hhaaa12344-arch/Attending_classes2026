'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createScheduledPublication,baghdadDay}=require('../scheduledPublication');
let db,studies,publisher,recovery,admin,seq=1500000;
test.before(async()=>{
  ({db,studies}=await require('./helpers.cjs').testDatabase());
  publisher=createScheduledPublication(db);recovery=require('../lessonRecovery').createLessonRecovery(db);
  admin=require('../adminData').createAdminData(db,studies);
});
test.after(async()=>db.pool.end());
async function fixture(){
  const stage=await db.addStage('مرحلة النشر '+(++seq)),ss=(await db.listStageSeasons(stage.id))[0].id;
  const a=await db.addSubject(stage.id,'مسائل المعاملات','مسائل'+seq),b=await db.addSubject(stage.id,'العقائد','عقائد'+seq);
  const student=await db.createStudent(++seq,'طالب اختبار النشر',stage.id),chat=-1000000000-seq;
  await db.linkChannel(stage.id,chat,'قناة الاختبار');
  const channel=await db.getChannelByChatId(chat),day=baghdadDay(new Date());
  await db.pool.query("INSERT INTO lesson_schedule_entries(stage_season_id,subject_id,lesson_date,created_at) VALUES($1,$2,$4,now()-interval '3 minutes'),($1,$3,$4,now()-interval '3 minutes')",[ss,a.id,b.id,day]);
  return {stage,ss,a,b,student,chat,channel,day};
}
function post(f,id,extra={}){return {channel:f.channel,sourceUrl:`https://t.me/c/1/${id}`,contentKind:'audio',message:{audio:{file_id:'offline',duration:60},chat:{id:f.chat},message_id:id,date:Math.floor(Date.now()/1000),...extra}};}

test('backup midnight timestamp consumes September 27 slot in Baghdad instead of repeatedly picking المسائل',async()=>{
  const f=await fixture(),day='2026-09-27';
  await db.pool.query('INSERT INTO lesson_schedule_entries(stage_season_id,subject_id,lesson_date) VALUES($1,$2,$4),($1,$3,$4) ON CONFLICT DO NOTHING',[f.ss,f.a.id,f.b.id,day]);
  await db.activateLesson(f.a.id,24,'channel_schedule',null,f.chat,27,new Date('2026-09-26T21:24:31.595Z'));
  assert.equal(baghdadDay(new Date('2026-09-26T21:24:31.595Z')),day);
  assert.deepEqual((await db.getPendingScheduledSubjectsForDate(f.ss,day)).map(s=>s.id),[f.b.id]);
});

test('simultaneous files consume distinct scheduled subjects, duplicate updates create nothing, stages stay isolated',async()=>{
  const f=await fixture(),other=await fixture();
  const results=await Promise.all([publisher.publish(post(f,10,{caption:f.a.name})),publisher.publish(post(f,11,{caption:f.b.name}))]);
  assert.ok(results.every(r=>r.created));assert.deepEqual(results.map(r=>r.lesson.subject_id),[f.a.id,f.b.id]);
  assert.equal((await publisher.publish(post(f,10))).created,false);
  assert.equal((await publisher.publish(post(f,12))).created,false);
  assert.equal((await publisher.publish(post(other,10,{caption:other.a.name}))).lesson.subject_id,other.a.id);
  assert.equal((await db.getPendingScheduledSubjectsForDate(f.ss,f.day)).length,0);
  assert.ok(results.every(r=>baghdadDay(r.lesson.activated_at)===f.day));
});

test('old edited media and companion links cannot steal today slots; a named العقائد media selects العقائد',async()=>{
  const f=await fixture(),old=post(f,25,{date:Math.floor(Date.now()/1000)-86400});old.edited=true;
  assert.equal((await publisher.publish(old)).created,false);
  const link=post(f,26,{text:'https://example.test/lesson'});link.contentKind='link';delete link.message.audio;
  assert.equal((await publisher.publish(link)).created,false);
  const r=await publisher.publish(post(f,27,{caption:'درس العقائد'}));assert.equal(r.lesson.subject_id,f.b.id);
  assert.equal((await publisher.publish(post(f,28))).lesson.subject_id,f.a.id);
  assert.equal(await db.getLessonBySource(f.chat,25),undefined);
  assert.equal(await db.getLessonBySource(f.chat,26),undefined);
});

test('a second file naming an already used subject stays pending instead of becoming a different subject',async()=>{
  const f=await fixture();
  assert.equal((await publisher.publish(post(f,50,{caption:'مسائل المعاملات'}))).lesson.subject_id,f.a.id);
  assert.equal((await publisher.publish(post(f,51,{caption:'مسائل المعاملات'}))).created,false);
  assert.deepEqual((await db.getPendingScheduledSubjectsForDate(f.ss,f.day)).map(s=>s.id),[f.b.id]);
});

test('a named file whose subject is not scheduled yet waits without taking another slot or blocking later unnamed files',async()=>{
  const f=await fixture(),extra=await db.addSubject(f.stage.id,'التفسير','تفسير'+(++seq));
  const waiting=await publisher.publish(post(f,60,{caption:'درس التفسير'}));
  assert.equal(waiting.created,false);
  const next=await publisher.publish(post(f,61));
  assert.equal(next.lesson.subject_id,f.a.id);
  await db.pool.query("INSERT INTO lesson_schedule_entries(stage_season_id,subject_id,lesson_date,created_at) VALUES($1,$2,$3,now()-interval '3 minutes')",[f.ss,extra.id,f.day]);
  assert.deepEqual((await db.getPendingScheduledSubjectsForDate(f.ss,f.day)).map(s=>s.id).sort((x,y)=>x-y),[f.b.id,extra.id].sort((x,y)=>x-y));
});

test('schedule-only rows appear in lesson management without fabricated attendance, then explicit old publication becomes first',async()=>{
  const f=await fixture(),original=new Date(Date.now()-2*86400000),recorded=new Date(Date.now()-3600000);
  let screen=await admin.managedItems('lessons',{stageId:f.stage.id});
  assert.equal(screen.scheduledRows.length,2);assert.equal(screen.rows.length,0);
  const newer=await publisher.publish(post(f,100,{caption:f.a.name}));await db.markAttendance(f.student.id,newer.lesson.id);
  const saved=(await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1',[newer.lesson.id])).rows;
  const p=await db.queuePendingChannelLessonPost({chatId:f.chat,messageId:99,stageId:f.stage.id,stageSeasonId:f.ss,lessonDate:f.day,receivedAt:recorded,contentKind:'audio'});
  const r=await recovery.restore(p.id,f.a.id,{actorId:42,targetScheduleDate:f.day,originalPublishedAt:original.toISOString()});
  assert.equal(r.lesson.activated_at.getTime(),original.getTime());
  assert.equal(Number((await db.getLessonById(r.lesson.id)).lesson_number),1);
  assert.equal(Number((await db.getLessonById(newer.lesson.id)).lesson_number),2);
  assert.deepEqual((await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1',[newer.lesson.id])).rows,saved);
  screen=await admin.managedItems('lessons',{stageId:f.stage.id});
  assert.deepEqual(screen.scheduledRows.map(s=>s.subject_id),[f.b.id]);
});

test('republish keeps lesson ID, publication, prior attendance and discussion rows, grants exactly 24h once and queues notice',async()=>{
  const f=await fixture(),old=new Date(Date.now()-3*86400000);
  const l=await db.activateLesson(f.a.id,24,'channel_schedule',null,f.chat,300,old);
  await db.pool.query('INSERT INTO attendance(student_id,lesson_id,listened_at) VALUES($1,$2,$3)',[f.student.id,l.id,old]);
  const attendance=(await db.pool.query('SELECT * FROM attendance ORDER BY id')).rows;
  const discussions=(await db.pool.query('SELECT * FROM mubahatha_attendance ORDER BY id')).rows;
  await assert.rejects(recovery.restoreExisting(l.id,{expectedSubjectId:f.b.id},42),{code:'CONFLICT'});
  const result=await recovery.restoreExisting(l.id,{expectedSubjectId:f.a.id},42);
  assert.equal(result.lesson.id,l.id);assert.deepEqual(result.lesson.activated_at,l.activated_at);
  assert.equal(result.lesson.attendance_opened_at,null,'republish does not move historical attendance day');
  assert.equal(result.lesson.active_until-result.lesson.republished_at,86400000);
  assert.deepEqual((await db.pool.query('SELECT * FROM attendance ORDER BY id')).rows,attendance);
  assert.deepEqual((await db.pool.query('SELECT * FROM mubahatha_attendance ORDER BY id')).rows,discussions);
  const again=await recovery.restoreExisting(l.id,{expectedSubjectId:f.a.id},42);
  assert.equal(again.created,false);assert.deepEqual(again.lesson.active_until,result.lesson.active_until);
  const notices=(await db.pool.query("SELECT * FROM notification_outbox WHERE dedupe_key LIKE $1",[`lesson-republished:${l.id}:%`])).rows;
  assert.equal(notices.length,1);assert.equal(notices[0].payload[1].reply_markup.inline_keyboard.at(-1)[0].callback_data,'attend:'+l.id);
  assert.deepEqual((await db.reopenLesson(l.id)).active_until,result.lesson.active_until);
  await db.initSchema();assert.deepEqual((await db.getLessonById(l.id)).republished_at,result.lesson.republished_at);
});

test('attendance during republishing refreshes an existing absence summary without changing its original day',async()=>{
  const f=await fixture(),old=new Date(Date.now()-3*86400000);
  await db.pool.query("UPDATE enrollments SET started_at=now()-interval '5 days' WHERE student_id=$1",[f.student.id]);
  await db.pool.query("UPDATE absence_monitoring_config SET started_at=now()-interval '10 days' WHERE id=1");
  const l=await db.activateLesson(f.a.id,24,'channel_schedule',null,f.chat,400,old);
  await require('../absence').processCompletedDays(db.pool,'Asia/Baghdad');
  const before=(await db.pool.query('SELECT * FROM student_attendance_days WHERE student_id=$1',[f.student.id])).rows[0];
  assert.equal(before.missed_lesson_count,1);
  await recovery.restoreExisting(l.id,{expectedSubjectId:f.a.id},42);
  assert.ok(await db.markAttendance(f.student.id,l.id));
  const after=(await db.pool.query('SELECT * FROM student_attendance_days WHERE student_id=$1',[f.student.id])).rows[0];
  assert.deepEqual(after.attendance_date,before.attendance_date);assert.equal(after.id,before.id);
  assert.equal(after.missed_lesson_count,0);assert.equal(after.attended_on_time_count,1);
});
