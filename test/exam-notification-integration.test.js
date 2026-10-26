'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db;
test.before(async()=>{({db}=await testDatabase());});
test.after(async()=>{if(db)await db.pool.end();});
test('real SQL queues normal and extended exam deadlines once without aborting the scheduler',async()=>{
  const stage=await db.addStage('مرحلة اختبار إشعارات الامتحان');
  const ss=(await db.listStageSeasons(stage.id))[0].id;
  const sub=await db.addSubject(stage.id,'مادة اختبار الإشعارات','اشعارات');
  const a=await db.createStudent(937001,'طالب الإشعار الأول',stage.id);
  const b=await db.createStudent(937002,'طالب الفرصة الإضافية',stage.id);
  const ends=new Date(Date.now()+20*60000),extended=new Date(Date.now()+50*60000);
  const exam=(await db.pool.query(`INSERT INTO exams(subject_id,stage_season_id,exam_number,opens_at,available_hours,closes_at,status)
    VALUES($1,$2,1,now()-interval '1 hour',2,$3,'published') RETURNING id`,[sub.id,ss,ends])).rows[0];
  await db.pool.query(`INSERT INTO exam_student_windows(exam_id,student_id,opens_at,closes_at,note,created_by)
    VALUES($1,$2,now()-interval '1 minute',$3,'اختبار',42)`,[exam.id,b.id,extended]);
  const notices=require('../examNotifications').createExamNotifications(db.pool);
  assert.equal(await notices.tick(),4);
  assert.equal(await notices.tick(),0);
  const rows=(await db.pool.query(`SELECT dedupe_key,chat_id,EXTRACT(EPOCH FROM expires_at)::double precision AS deadline
    FROM notification_outbox ORDER BY dedupe_key`)).rows;
  assert.equal(rows.length,4);
  assert.equal(rows.filter(r=>Number(r.chat_id)===Number(a.telegram_id)).length,2);
  for(const r of rows)assert.ok(Math.abs(Number(r.deadline)*1000-(Number(r.chat_id)===Number(a.telegram_id)?ends:extended).getTime())<2);
});
