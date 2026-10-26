'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db,cleanup,fixtures=[];
test.before(async()=>{
  ({db}=await testDatabase());cleanup=require('../oneTimeLessonCleanup').createOneTimeLessonCleanup(db.pool);
  for(let n=0;n<2;n++){
    const stage=await db.addStage('مرحلة تنظيف اختبار '+n),sub=await db.addSubject(stage.id,'مادة '+n,'مادة'+n);
    const ss=(await db.listStageSeasons(stage.id))[0].id,student=await db.createStudent(939001+n,'طالب تنظيف '+n,stage.id);
    const real=(await db.pool.query(`INSERT INTO lessons(subject_id,stage_season_id,source_type,source_chat_id,source_message_id,activated_at,active_until,schedule_date)
      VALUES($1,$2,'channel_schedule',-100999,$3,now()-interval '2 hours',now()+interval '22 hours',(now() AT TIME ZONE 'Asia/Baghdad')::date) RETURNING id`,[sub.id,ss,100+n])).rows[0];
    const fallback=(await db.pool.query(`INSERT INTO lessons(subject_id,stage_season_id,source_type,activated_at,active_until,schedule_date)
      VALUES($1,$2,'schedule_fallback',now()-interval '1 hour',now()+interval '23 hours',(now() AT TIME ZONE 'Asia/Baghdad')::date) RETURNING id`,[sub.id,ss])).rows[0];
    await db.pool.query('INSERT INTO attendance(student_id,lesson_id) VALUES($1,$2)',[student.id,fallback.id]);
    fixtures.push({real:real.id,fallback:fallback.id,ss,sub:sub.id,student:student.id});
  }
});
test.after(async()=>{if(db)await db.pool.end();});
test('one-time cleanup spans stages, rejects stale/invalid choices and retains every original attendance row',async()=>{
  let preview=await cleanup.preview();assert.equal(preview.available,true);assert.equal(preview.groups.length,2);
  assert.equal(preview.groups.flatMap(g=>g.lessons).filter(l=>l.recommended).length,2);
  await assert.rejects(cleanup.execute({token:preview.token,lessonIds:[fixtures[0].fallback],confirmed:false},42));
  await assert.rejects(cleanup.execute({token:preview.token,lessonIds:[999999],confirmed:true},42));
  await assert.rejects(cleanup.execute({token:preview.token,lessonIds:[fixtures[0].real,fixtures[0].fallback],confirmed:true},42));
  await db.pool.query('INSERT INTO attendance(student_id,lesson_id) VALUES($1,$2)',[fixtures[0].student,fixtures[0].real]);
  await assert.rejects(cleanup.execute({token:preview.token,lessonIds:[fixtures[0].fallback],confirmed:true},42),{code:'STALE'});
  preview=await cleanup.preview();
  const original=(await db.pool.query('SELECT * FROM attendance ORDER BY id')).rows;
  const results=await Promise.allSettled([1,2].map(()=>cleanup.execute({token:preview.token,lessonIds:fixtures.map(f=>f.fallback),confirmed:true},42)));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1,results.map(x=>x.reason?.message).join('; '));
  assert.equal(results.filter(x=>x.status==='rejected').length,1);
  assert.deepEqual((await db.pool.query('SELECT * FROM attendance ORDER BY id')).rows,original);
  assert.equal(Number((await db.pool.query('SELECT COUNT(*)::int n FROM lessons')).rows[0].n),4);
  assert.equal(Number((await db.pool.query('SELECT COUNT(*)::int n FROM effective_lessons')).rows[0].n),2);
  assert.equal(Number((await db.pool.query('SELECT COUNT(*)::int n FROM lesson_corrections WHERE canonical_lesson_id IS NULL')).rows[0].n),2);
  assert.deepEqual(await cleanup.preview(),{available:false,completed:true});
  assert.equal(await cleanup.completed(),true);
  assert.equal(Number((await db.pool.query("SELECT COUNT(*)::int n FROM admin_audit_log WHERE action='one_time_lesson_cleanup'")).rows[0].n),1);
});
