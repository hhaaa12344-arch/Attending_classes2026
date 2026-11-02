'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db,studies,repair;
test.before(async()=>{({db,studies}=await testDatabase());repair=require('../enrollmentConsistency').repairEnrollments;});
test.after(async()=>{await db.pool.end();});

const names=async(id)=>(await studies.listStudentSubjects(id)).map(s=>[s.subject_name,s.mode]);

test('a normal stage move shows only the new stage subjects',async()=>{
  const s1=await db.addStage('مستوى أول'),s2=await db.addStage('مستوى ثان'),ss1=(await db.listStageSeasons(s1.id))[0].id;
  const sub1=await db.addSubject(s1.id,'مادة قديمة','ق1'),sub2=await db.addSubject(s2.id,'مادة جديدة','ج1');
  const st=await db.createStudent(883001,'طالب منقول',s1.id);
  await studies.createMubahathaGroup(sub1.id,ss1,{title:'أ'});
  await studies.setParticipationMode(st.id,sub1.id,ss1,'report');
  assert.deepEqual(await names(st.id),[['مادة قديمة','report']]);
  await db.updateStudentStage(st.id,s2.id);
  assert.deepEqual(await names(st.id),[['مادة جديدة',null]]);

});

test('repair fixes a student whose stage changed but whose active enrollment stayed in the old stage',async()=>{
  const s1=await db.addStage('أ مستوى'),s2=await db.addStage('ب مستوى'),ss1=(await db.listStageSeasons(s1.id))[0].id;
  await db.addSubject(s1.id,'قديمة2','ق2');await db.addSubject(s2.id,'جديدة2','ج2');
  const st=await db.createStudent(883002,'طالب بلا تسجيل',s1.id);
  // انتقلت مرحلته فقط دون تسجيل جديد
  await db.pool.query('UPDATE students SET stage_id=$1 WHERE id=$2',[s2.id,st.id]);
  assert.deepEqual(await names(st.id),[],'لا مواد حتى يُصلح التسجيل');
  const r=await repair(db.pool);assert.ok(r.created>=1&&r.closed>=1);
  assert.deepEqual(await names(st.id),[['جديدة2',null]]);
  const act=(await db.pool.query("SELECT stage_season_id FROM enrollments WHERE student_id=$1 AND status='active'",[st.id])).rows;assert.equal(act.length,1);
  assert.equal((await repair(db.pool)).closed,0,'لا تغيير في التشغيل الثاني');
});
