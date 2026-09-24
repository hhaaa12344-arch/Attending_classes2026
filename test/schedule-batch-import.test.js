'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
const {createScheduleBatchImport,validatePlan}=require('../scheduleBatchImport');
const source=require('../scheduleBatchPlan.json');

test('the corrected workbook plan has 88 appointments, no overlaps, and two shared free times',()=>{
  assert.doesNotThrow(()=>validatePlan(source));
  assert.equal(source.rows.length,24);
  assert.equal(new Set(source.slots.map(s=>s.groupId)).size,44);
  assert.equal(source.slots.length,88);
  for(const teacherId of new Set(source.slots.map(s=>s.teacherId))){
    const slots=source.slots.filter(s=>s.teacherId===teacherId);
    assert.equal(slots.length,8);
    assert.ok(!slots.some(s=>s.dayOfWeek===1&&s.hour===20));
    assert.ok(!slots.some(s=>s.dayOfWeek===3&&s.hour===19));
  }
});

test('one button inserts the whole batch and assignment atomically, then disappears',async()=>{
  const {db,studies}=await testDatabase();
  try{
    const stage=await db.addStage('مرحلة تجربة الدفعة');
    const season=(await db.listStageSeasons(stage.id))[0].id;
    const subject=await db.addSubject(stage.id,'منطق التجربة','منطق');
    const teacher=await db.addTeacher('أستاذ تجربة الجداول');
    const groups=[await studies.createMubahathaGroup(subject.id,season,{capacity:10}),
      await studies.createMubahathaGroup(subject.id,season,{capacity:10})];
    const plan={rows:[{workbookRow:2,stageName:stage.name,subjectName:subject.name,teacherName:teacher.full_name,
      subjectId:subject.id,teacherId:teacher.id,seasonId:season,groupCount:2}],slots:groups.flatMap((g,i)=>[
      {workbookRow:2,subjectId:subject.id,teacherId:teacher.id,seasonId:season,groupId:g.id,groupNumber:i+1,dayOfWeek:i===0?6:0,hour:19,minute:0},
      {workbookRow:2,subjectId:subject.id,teacherId:teacher.id,seasonId:season,groupId:g.id,groupNumber:i+1,dayOfWeek:i===0?2:3,hour:20,minute:0}
    ]),sourceWorkbookSha256:'test',sourceBackupCreatedAt:'test'};
    const batch=createScheduleBatchImport(db.pool,{plan,action:'test_one_time_schedule_batch'});
    assert.equal((await batch.status()).assignmentsToAdd,1);
    await db.pool.query(`INSERT INTO schedule_slots(group_id,subject_id,stage_season_id,teacher_id,day_of_week,hour,minute)
      VALUES($1,$2,$3,$4,1,19,0)`,[groups[0].id,subject.id,season,teacher.id]);
    assert.equal((await batch.status()).available,false);
    await assert.rejects(batch.execute(42),{code:'SCHEDULE_CONFLICT'});
    assert.equal((await db.pool.query('SELECT COUNT(*) AS n FROM teaching_assignments WHERE subject_id=$1',[subject.id])).rows[0].n,0);
    await db.pool.query('DELETE FROM schedule_slots WHERE group_id=$1',[groups[0].id]);
    const result=await batch.execute(42);assert.deepEqual(result,{appointments:4,groups:2,addedAssignments:1});
    assert.equal((await db.pool.query('SELECT COUNT(*) AS n FROM schedule_slots WHERE stage_season_id=$1',[season])).rows[0].n,4);
    assert.equal((await batch.status()).completed,true);
    await assert.rejects(batch.execute(42),{code:'CONFLICT'});
  }finally{await db.pool.end();}
});

test('manual scheduling refuses a second subject at the same cohort time',async()=>{
  const {db,studies}=await testDatabase();
  try{
    const stage=await db.addStage('مرحلة تعارض المواد');
    const ss=(await db.listStageSeasons(stage.id))[0].id;
    const first=await db.addSubject(stage.id,'المادة الأولى','أولى');
    const second=await db.addSubject(stage.id,'المادة الثانية','ثانية');
    const t1=await db.addTeacher('أستاذ المادة الأولى');
    const t2=await db.addTeacher('أستاذ المادة الثانية');
    await db.assignTeacherToSubject(t1.id,first.id);
    await db.assignTeacherToSubject(t2.id,second.id);
    const first1=await studies.createMubahathaGroup(first.id,ss,{capacity:10});
    await studies.createMubahathaGroup(first.id,ss,{capacity:10});
    const second1=await studies.createMubahathaGroup(second.id,ss,{capacity:10});
    const second2=await studies.createMubahathaGroup(second.id,ss,{capacity:10});
    await studies.addScheduleSlot(first1.id,{teacherId:t1.id,dayOfWeek:6,hour:19});
    await assert.rejects(studies.addScheduleSlot(second1.id,{teacherId:t2.id,dayOfWeek:6,hour:19}),{code:'SCHEDULE_CONFLICT'});
    assert.ok((await studies.addScheduleSlot(second2.id,{teacherId:t2.id,dayOfWeek:6,hour:19})).slot);
  }finally{await db.pool.end();}
});
