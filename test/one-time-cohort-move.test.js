'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db,studies;
test.before(async()=>{({db,studies}=await testDatabase());});
test.after(async()=>{await db.pool.end();});

test('the selected thirteen move atomically across subjects and the action cannot run twice',async()=>{
  const stage=await db.addStage('المرحلة التمهيدية الدورة 22');
  const ss=(await db.listStageSeasons(stage.id))[0].id;
  const subjects=[await db.addSubject(stage.id,'المادة الأولى','الأولى'),await db.addSubject(stage.id,'المادة الثانية','الثانية')];
  const groups=[];
  for(const sub of subjects)groups.push([await studies.createMubahathaGroup(sub.id,ss,{capacity:100}),await studies.createMubahathaGroup(sub.id,ss,{capacity:100})]);
  const students=[];
  for(let i=0;i<13;i++){
    const st=await db.createStudent(840000+i,'طالب اختبار المجموعة رقم '+i,stage.id);students.push(st);
    for(const sub of subjects)await studies.assignStudentToGroup(st.id,sub.id,ss);
  }
  const repair=require('../oneTimeCohortMove').createOneTimeCohortMove(db.pool);
  const before=await repair.status();assert.equal(before.available,true);assert.equal(before.sourceCount,13);
  const ids=students.map(st=>st.id);
  await assert.rejects(repair.execute(ids.slice(0,12),42));
  // A legacy mismatch in one selected student must cancel the entire batch.
  await db.pool.query('UPDATE group_memberships SET group_id=$2 WHERE student_id=$1 AND subject_id=$3',[ids[0],groups[1][1].id,subjects[1].id]);
  await assert.rejects(repair.execute(ids,42));
  assert.equal((await db.pool.query('SELECT COUNT(*)::int AS n FROM group_memberships WHERE group_id=$1',[groups[0][0].id])).rows[0].n,13);
  await db.pool.query('UPDATE group_memberships SET group_id=$2 WHERE student_id=$1 AND subject_id=$3',[ids[0],groups[1][0].id,subjects[1].id]);
  const result=await repair.execute(ids,42);assert.equal(result.moved,13);
  assert.equal((await db.pool.query('SELECT COUNT(*)::int AS n FROM student_group_numbers WHERE stage_season_id=$1 AND group_number=2',[ss])).rows[0].n,13);
  for(const group of groups)assert.equal((await db.pool.query('SELECT COUNT(*)::int AS n FROM group_memberships WHERE group_id=$1',[group[1].id])).rows[0].n,13);
  assert.equal((await db.pool.query('SELECT COUNT(*)::int AS n FROM group_membership_history WHERE stage_season_id=$1',[ss])).rows[0].n,26);
  assert.equal((await repair.status()).completed,true);
  await assert.rejects(repair.execute(ids,42),{code:'CONFLICT'});
});
