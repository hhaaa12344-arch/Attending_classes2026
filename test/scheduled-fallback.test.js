'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createScheduledFallback,graceFromEnv}=require('../scheduledFallback');
const {baghdadDay}=require('../scheduledPublication');
let db,ss,a,b,stage,today,fallback;
test.before(async()=>{
  ({db}=await require('./helpers.cjs').testDatabase());
  stage=await db.addStage('مرحلة مراجعة الجدول');ss=(await db.listStageSeasons(stage.id))[0].id;
  a=await db.addSubject(stage.id,'المادة الأولى','a');b=await db.addSubject(stage.id,'المادة الثانية','b');today=baghdadDay(new Date());
  await db.pool.query('INSERT INTO lesson_schedule_entries(stage_season_id,subject_id,lesson_date) VALUES($1,$2,$4),($1,$3,$4)',[ss,a.id,b.id,today]);
  fallback=createScheduledFallback(db,{graceMinutes:0});
});
test.after(async()=>db.pool.end());
test('automatic timetable activation stays disabled even when legacy grace is explicitly zero',async()=>{
  assert.equal(graceFromEnv(undefined),null);assert.equal(graceFromEnv('0'),0);assert.equal(graceFromEnv('off'),null);assert.throws(()=>graceFromEnv('abc'));
  await db.activateLesson(b.id,24,'channel_schedule',null,-1001,1,null,{scheduleDate:today});
  const before=(await db.pool.query('SELECT * FROM lessons ORDER BY id')).rows;
  assert.deepEqual((await fallback.sweepDate(ss,today)).created,[]);assert.deepEqual(await fallback.sweepToday(),{created:0});
  assert.deepEqual((await db.pool.query('SELECT * FROM lessons ORDER BY id')).rows,before);
});
test('manual reviewed activation requires actor, audits once and never creates attendance',async()=>{
  await assert.rejects(fallback.activateManually({stageSeasonId:ss,subjectId:a.id,scheduleDate:today}));
  const r=await fallback.activateManually({stageSeasonId:ss,subjectId:a.id,scheduleDate:today,actorId:42});
  assert.equal(r.lesson.source_type,'schedule_fallback');assert.equal((await db.pool.query('SELECT * FROM attendance')).rows.length,0);
  assert.equal((await db.pool.query("SELECT * FROM admin_audit_log WHERE action='activate_scheduled_lesson'")).rows.length,1);
  await assert.rejects(fallback.activateManually({stageSeasonId:ss,subjectId:a.id,scheduleDate:today,actorId:42}),{code:'CONFLICT'});
});
test('a later publication does not silently adopt an attended fallback by matching subject and date',async()=>{
  const old=(await db.pool.query("SELECT * FROM lessons WHERE subject_id=$1 AND source_type='schedule_fallback'",[a.id])).rows[0];
  const student=await db.createStudent(998811,'طالب اختبار حفظ المحاضرة',stage.id);
  await db.pool.query('INSERT INTO attendance(student_id,lesson_id) VALUES($1,$2)',[student.id,old.id]);
  const marks=(await db.pool.query('SELECT * FROM attendance')).rows;
  const actual=await db.activateLesson(a.id,24,'channel_schedule',null,-1001,2,null,{scheduleDate:today});
  assert.notEqual(actual.id,old.id);assert.equal((await db.pool.query('SELECT source_message_id FROM lessons WHERE id=$1',[old.id])).rows[0].source_message_id,null);
  assert.deepEqual((await db.pool.query('SELECT * FROM attendance')).rows,marks);
  assert.equal((await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1',[actual.id])).rows.length,0);
  assert.equal((await db.activateLesson(a.id,24,'channel_schedule',null,-1001,2,null,{scheduleDate:today})).id,actual.id);
});
