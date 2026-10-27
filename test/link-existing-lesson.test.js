'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
let db,studies,admin,fallback,seq=1800000;
test.before(async()=>{
  ({db,studies}=await require('./helpers.cjs').testDatabase());
  admin=require('../adminData').createAdminData(db,studies);
  fallback=require('../scheduledFallback').createScheduledFallback(db);
});
test.after(async()=>db.pool.end());
const day=async n=>(await db.pool.query("SELECT ((now() AT TIME ZONE 'Asia/Baghdad')::date-$1::int)::text AS d",[n])).rows[0].d;
test('a lesson published under a different date is offered for linking, and linking never touches its attendance',async()=>{
  const stage=await db.addStage('مرحلة الربط '+(++seq)),ss=(await db.listStageSeasons(stage.id))[0].id;
  const sub=await db.addSubject(stage.id,'مسائل منتخبة',`م${seq}`),other=await db.addSubject(stage.id,'مادة أخرى',`ع${seq}`);
  const student=await db.createStudent(++seq,'طالب الربط',stage.id);
  const entry=await day(5),stray=await day(4),later=await day(1);
  for(const d of [entry,later])await db.pool.query("INSERT INTO lesson_schedule_entries(stage_season_id,subject_id,lesson_date) VALUES($1,$2,$3)",[ss,sub.id,d]);
  // درس 27 أيلول فُعّل بتاريخ مجاور لا موعد له، وسُجّل عليه حضور
  const lesson=await db.activateLesson(sub.id,24,'channel_schedule','https://t.me/c/1/1',-1001,11,null,{scheduleDate:stray});
  await db.pool.query('INSERT INTO attendance(student_id,lesson_id) VALUES($1,$2)',[student.id,lesson.id]);
  const covered=await db.activateLesson(sub.id,24,'channel_schedule','https://t.me/c/1/2',-1001,12,null,{scheduleDate:later});
  const before=(await db.pool.query('SELECT * FROM attendance ORDER BY id')).rows;
  const list=await admin.managedItems('lessons',{stageId:stage.id});
  const row=list.scheduledRows.find(x=>x.lesson_date===entry);assert.ok(row,'الموعد يظهر غير مفعّل');
  assert.deepEqual(row.candidates.map(x=>x.id),[lesson.id]);assert.equal(row.candidates[0].attended,1);
  assert.equal(list.scheduledRows.some(x=>x.lesson_date===later),false);
  await assert.rejects(fallback.linkExisting({stageSeasonId:ss,subjectId:sub.id,scheduleDate:entry,lessonId:covered.id,actorId:42}),{code:'CONFLICT'});
  await assert.rejects(fallback.linkExisting({stageSeasonId:ss,subjectId:other.id,scheduleDate:entry,lessonId:lesson.id,actorId:42}));
  await fallback.linkExisting({stageSeasonId:ss,subjectId:sub.id,scheduleDate:entry,lessonId:lesson.id,actorId:42});
  assert.deepEqual((await db.pool.query('SELECT * FROM attendance ORDER BY id')).rows,before);
  assert.equal((await db.pool.query('SELECT COUNT(*)::int n FROM effective_lessons WHERE stage_season_id=$1',[ss])).rows[0].n,2);
  assert.equal((await admin.managedItems('lessons',{stageId:stage.id})).scheduledRows.length,0);
  assert.equal((await db.pool.query("SELECT COUNT(*)::int n FROM admin_audit_log WHERE action='link_lesson_to_schedule'")).rows[0].n,1);
  await assert.rejects(fallback.linkExisting({stageSeasonId:ss,subjectId:sub.id,scheduleDate:entry,lessonId:lesson.id,actorId:42}),{code:'CONFLICT'});
});
test('a lesson whose original post date equals the timetable date already counts as covering it',async()=>{
  const stage=await db.addStage('مرحلة تاريخ المنشور '+(++seq)),ss=(await db.listStageSeasons(stage.id))[0].id;
  const sub=await db.addSubject(stage.id,'مادة المنشور',`ن${seq}`),entry=await day(6),recovered=await day(2);
  await db.pool.query("INSERT INTO lesson_schedule_entries(stage_season_id,subject_id,lesson_date) VALUES($1,$2,$3)",[ss,sub.id,entry]);
  await db.activateLesson(sub.id,24,'channel_schedule_recovered','https://t.me/c/1/3',-1002,33,null,{scheduleDate:recovered});
  assert.equal((await admin.managedItems('lessons',{stageId:stage.id})).scheduledRows.length,1);
  await db.pool.query(`INSERT INTO pending_channel_lesson_posts(telegram_chat_id,source_message_id,stage_id,stage_season_id,lesson_date,status)
    VALUES(-1002,33,$1,$2,$3,'activated')`,[stage.id,ss,entry]);
  assert.equal((await admin.managedItems('lessons',{stageId:stage.id})).scheduledRows.length,0);
});
