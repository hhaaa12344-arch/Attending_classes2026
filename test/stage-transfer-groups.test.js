'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db,studies;
test.before(async()=>{({db,studies}=await testDatabase());});
test.after(async()=>{if(db)await db.pool.end();});

test('moving stages closes old group memberships while retaining their attendance history',async()=>{
  const oldStage=await db.addStage('مرحلة سابقة'),newStage=await db.addStage('مرحلة جديدة');
  const oldSeason=(await db.listStageSeasons(oldStage.id))[0].id;
  const newSeason=(await db.listStageSeasons(newStage.id))[0].id;
  const oldSubject=await db.addSubject(oldStage.id,'فقه سابق','فقه_سابق');
  const newSubject=await db.addSubject(newStage.id,'فقه جديد','فقه_جديد');
  const student=await db.createStudent(99111,'طالب نقل مرحلة اسم رباعي',oldStage.id);
  const oldGroup=await studies.createMubahathaGroup(oldSubject.id,oldSeason,{title:'المجموعة السابقة'});
  await studies.setParticipationMode(student.id,oldSubject.id,oldSeason,'mubahatha');
  assert.equal((await studies.assignStudentToGroup(student.id,oldSubject.id,oldSeason)).group.id,oldGroup.id);
  const session=(await db.pool.query(`INSERT INTO mubahatha_sessions(group_id,title,closes_at)
    VALUES($1,'مباحثة محفوظة',now()+interval '1 hour') RETURNING id`,[oldGroup.id])).rows[0];
  await db.pool.query("INSERT INTO mubahatha_attendance(session_id,student_id,phase) VALUES($1,$2,'start'),($1,$2,'end')",[session.id,student.id]);
  await db.updateStudentStage(student.id,newStage.id);
  assert.equal((await studies.listStudentGroups(student.id)).length,0);
  assert.equal((await db.pool.query('SELECT * FROM group_memberships WHERE student_id=$1',[student.id])).rowCount,0);
  const previous=(await db.pool.query('SELECT * FROM group_membership_history WHERE student_id=$1 AND group_id=$2',[student.id,oldGroup.id])).rows;
  assert.equal(previous.length,1);assert.ok(previous[0].ended_at);
  assert.equal((await db.pool.query('SELECT COUNT(*)::int AS n FROM mubahatha_attendance WHERE student_id=$1',[student.id])).rows[0].n,2);
  assert.equal(Number((await studies.listGroups(oldSubject.id,oldSeason))[0].member_count),0);
  const newGroup=await studies.createMubahathaGroup(newSubject.id,newSeason,{title:'المجموعة الجديدة'});
  await studies.setParticipationMode(student.id,newSubject.id,newSeason,'mubahatha');
  assert.equal((await studies.assignStudentToGroup(student.id,newSubject.id,newSeason)).group.id,newGroup.id);
  assert.deepEqual((await studies.listStudentGroups(student.id)).map(g=>Number(g.group_id)),[newGroup.id]);
});

test('repeatable migration repairs old-stage memberships left by previous transfers',async()=>{
  const oldStage=await db.addStage('مرحلة قديمة تحتاج إصلاحًا'),newStage=await db.addStage('مرحلة قائمة');
  const oldSeason=(await db.listStageSeasons(oldStage.id))[0].id;
  const oldSubject=await db.addSubject(oldStage.id,'أصول قديمة','أصول_قديمة');
  const student=await db.createStudent(99112,'طالب عضوية قديمة اسم رباعي',oldStage.id);
  const group=await studies.createMubahathaGroup(oldSubject.id,oldSeason,{title:'مجموعة قديمة'});
  await studies.setParticipationMode(student.id,oldSubject.id,oldSeason,'mubahatha');
  await studies.assignStudentToGroup(student.id,oldSubject.id,oldSeason);
  await db.pool.query("UPDATE enrollments SET status='moved',ended_at=now() WHERE student_id=$1 AND stage_season_id=$2",[student.id,oldSeason]);
  await db.pool.query('UPDATE students SET stage_id=$2 WHERE id=$1',[student.id,newStage.id]);
  await require('../integrity').initIntegritySchema(db.pool);
  assert.equal((await db.pool.query('SELECT * FROM group_memberships WHERE student_id=$1',[student.id])).rowCount,0);
  assert.equal((await db.pool.query('SELECT * FROM group_membership_history WHERE student_id=$1 AND group_id=$2',[student.id,group.id])).rowCount,1);
  await require('../integrity').initIntegritySchema(db.pool);
  assert.equal((await db.pool.query('SELECT * FROM group_membership_history WHERE student_id=$1 AND group_id=$2',[student.id,group.id])).rowCount,1);
});
