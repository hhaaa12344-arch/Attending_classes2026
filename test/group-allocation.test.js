'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db,studies,id=750000;
test.before(async()=>{({db,studies}=await testDatabase());});
test.after(async()=>{await db.pool.end();});
async function setup(capacity=20){
  const stage=await db.addStage('مرحلة '+(++id));
  const ss=(await db.listStageSeasons(stage.id))[0].id;
  const subjects=await Promise.all(['فقه','نحو','عقائد'].map(n=>db.addSubject(stage.id,n,n+id)));
  const groups=[];
  for(const s of subjects)groups.push([
    await studies.createMubahathaGroup(s.id,ss,{title:s.name+' 1',capacity}),
    await studies.createMubahathaGroup(s.id,ss,{title:s.name+' 2',capacity})]);
  const student=await db.createStudent(++id,'طالب أول ثاني ثالث',stage.id);
  return {stage,ss,subjects,groups,student};
}
test('concurrent subject choices keep one number, including report mode; repeat is idempotent',async()=>{
  const {ss,subjects,student}=await setup();
  await studies.setParticipationMode(student.id,subjects[1].id,ss,'report');
  const results=await Promise.all(subjects.flatMap(s=>Array.from({length:5},()=>studies.assignStudentToGroup(student.id,s.id,ss))));
  assert.equal(results.filter(r=>r.created).length,3);
  assert.deepEqual([...new Set(results.map(r=>r.group.group_number))],[1]);
  await studies.initStudiesSchema();
  assert.equal((await studies.assignStudentToGroup(student.id,subjects[0].id,ss)).created,false);
});
test('full matching group never falls back to another number; removal remembers the number',async()=>{
  const {ss,subjects,groups,student,stage}=await setup(1);
  const other=await db.createStudent(++id,'طالب آخر ثاني ثالث',stage.id);
  await studies.assignStudentToGroup(other.id,subjects[1].id,ss);
  await studies.assignStudentToGroup(student.id,subjects[0].id,ss);
  const denied=await studies.assignStudentToGroup(student.id,subjects[1].id,ss);
  assert.equal(denied.reason,'GROUP_FULL');assert.equal(denied.groupNumber,1);
  assert.equal(await studies.getStudentGroup(student.id,subjects[1].id,ss),undefined);
  await studies.removeStudentFromGroup(student.id,subjects[0].id,ss);
  assert.equal((await studies.assignStudentToGroup(student.id,subjects[1].id,ss)).reason,'GROUP_FULL');
  await studies.setGroupActive(groups[2][0].id,false);
  assert.equal((await studies.assignStudentToGroup(student.id,subjects[2].id,ss)).reason,'GROUP_UNAVAILABLE');
});
test('admin cohort move changes every enrolled subject atomically and preserves report snapshots',async()=>{
  const {ss,subjects,groups,student}=await setup();
  for(const s of subjects){await studies.setParticipationMode(student.id,s.id,ss,'report');await studies.assignStudentToGroup(student.id,s.id,ss);}
  const report=await studies.submitReport(student.id,subjects[1].id,ss,{kind:'text',note:'تقرير سابق محفوظ'});
  const moved=await studies.moveStudentToGroup(student.id,subjects[0].id,ss,groups[0][1].id);
  assert.equal(moved.moved_subject_ids.length,3);
  for(const s of subjects)assert.equal((await studies.getStudentGroup(student.id,s.id,ss)).group_number,2);
  assert.equal((await studies.listStudentReports(student.id,subjects[1].id,ss))[0].group_id,report.group_id);
  assert.equal((await studies.moveStudentToGroup(student.id,subjects[0].id,ss,groups[0][1].id)).moved_subject_ids.length,0);
});
test('missing or full target in any subject rolls back all moves and saved cohort',async()=>{
  const {ss,subjects,groups,student,stage}=await setup(1);
  for(const s of subjects)await studies.assignStudentToGroup(student.id,s.id,ss);
  await studies.setGroupActive(groups[2][1].id,false);
  await assert.rejects(studies.moveStudentToGroup(student.id,subjects[0].id,ss,groups[0][1].id),{code:'GROUP_UNAVAILABLE'});
  await studies.setGroupActive(groups[2][1].id,true);
  const other=await db.createStudent(++id,'طالب مشغول ثاني ثالث',stage.id);
  await studies.moveStudentToGroup(other.id,subjects[2].id,ss,groups[2][1].id);
  await assert.rejects(studies.moveStudentToGroup(student.id,subjects[0].id,ss,groups[0][1].id),{code:'GROUP_FULL'});
  for(const s of subjects)assert.equal((await studies.getStudentGroup(student.id,s.id,ss)).group_number,1);
  assert.equal((await db.pool.query('SELECT group_number FROM student_group_numbers WHERE student_id=$1',[student.id])).rows[0].group_number,1);
});
test('legacy inconsistent records are blocked until explicit admin alignment',async()=>{
  const {ss,subjects,groups,student}=await setup();
  for(let i=0;i<2;i++)await db.pool.query('INSERT INTO group_memberships(group_id,student_id,subject_id,stage_season_id) VALUES($1,$2,$3,$4)',[groups[i][i].id,student.id,subjects[i].id,ss]);
  assert.equal((await studies.assignStudentToGroup(student.id,subjects[2].id,ss)).reason,'GROUP_NUMBER_CONFLICT');
  await studies.moveStudentToGroup(student.id,subjects[0].id,ss,groups[0][0].id);
  assert.equal((await studies.assignStudentToGroup(student.id,subjects[2].id,ss)).group.group_number,1);
});
test('initial allocation uses available capacity and parallel students do not overfill',async()=>{
  const {ss,subjects,student,stage}=await setup(1);
  const others=await Promise.all(Array.from({length:5},()=>db.createStudent(++id,'طالب ضغط ثاني ثالث',stage.id)));
  const results=await Promise.all([student,...others].map(s=>studies.assignStudentToGroup(s.id,subjects[0].id,ss)));
  assert.equal(results.filter(r=>r.group).length,2);
  assert.deepEqual(results.filter(r=>r.group).map(r=>r.group.group_number).sort(),[1,2]);
});
test('archived student cannot reuse existing membership and another stage gets its own number',async()=>{
  const a=await setup();const b=await setup();
  await studies.moveStudentToGroup(a.student.id,a.subjects[0].id,a.ss,a.groups[0][1].id);
  await db.pool.query('UPDATE students SET is_active=false WHERE id=$1',[a.student.id]);
  await assert.rejects(studies.assignStudentToGroup(a.student.id,a.subjects[0].id,a.ss));
  await db.pool.query('UPDATE students SET is_active=true WHERE id=$1',[a.student.id]);
  await db.updateStudentStage(a.student.id,b.stage.id);
  assert.equal((await studies.assignStudentToGroup(a.student.id,b.subjects[0].id,b.ss)).group.group_number,1);
});
