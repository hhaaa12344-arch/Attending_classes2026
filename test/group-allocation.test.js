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
test('a first subject reserves the same cohort seat in other subjects',async()=>{
  const {ss,subjects,groups,student,stage}=await setup(1);
  const other=await db.createStudent(++id,'طالب آخر ثاني ثالث',stage.id);
  await studies.assignStudentToGroup(other.id,subjects[1].id,ss);
  assert.equal((await studies.assignStudentToGroup(student.id,subjects[0].id,ss)).group.group_number,2);
  assert.equal((await studies.assignStudentToGroup(student.id,subjects[1].id,ss)).group.group_number,2);
  await studies.removeStudentFromGroup(student.id,subjects[0].id,ss);
  assert.equal((await studies.assignStudentToGroup(student.id,subjects[0].id,ss)).group.group_number,2);
  await studies.setGroupActive(groups[2][0].id,false);
  assert.equal((await studies.assignStudentToGroup(student.id,subjects[2].id,ss)).group.group_number,2);
});
test('four subjects and four group numbers reserve seats before later material choices',async()=>{
  const stage=await db.addStage('مرحلة أربعة مواد '+(++id));
  const ss=(await db.listStageSeasons(stage.id))[0].id;
  const subjects=[];for(let i=0;i<4;i++)subjects.push(await db.addSubject(stage.id,'مادة '+i+' '+id,'مادة'+i+id));
  const groups=[];for(const sub of subjects){const row=[];for(let i=0;i<4;i++)row.push(await studies.createMubahathaGroup(sub.id,ss,{capacity:2}));groups.push(row);}
  const students=[];for(let i=0;i<4;i++)students.push(await db.createStudent(++id,'طالب أربعة مواد رقم '+i,stage.id));
  assert.equal((await studies.assignStudentToGroup(students[0].id,subjects[0].id,ss)).group.group_number,1);
  assert.equal((await studies.assignStudentToGroup(students[1].id,subjects[1].id,ss)).group.group_number,1);
  assert.equal((await studies.assignStudentToGroup(students[2].id,subjects[1].id,ss)).group.group_number,2);
  assert.equal((await studies.assignStudentToGroup(students[3].id,subjects[2].id,ss)).group.group_number,2);
  const unseen=(await studies.listGroups(subjects[3].id,ss))[0];
  assert.equal(Number(unseen.member_count),0);assert.equal(Number(unseen.reserved_count),2);
  await assert.rejects(studies.setGroupCapacity(groups[3][0].id,1),{code:'GROUP_CAPACITY'});
  for(let i=0;i<students.length;i++)for(const sub of subjects){
    const result=await studies.assignStudentToGroup(students[i].id,sub.id,ss);
    assert.equal(result.group.group_number,i<2?1:2);
  }
  for(const sub of subjects){
    const cohort=await studies.listGroups(sub.id,ss);
    assert.deepEqual(cohort.slice(0,2).map(g=>Number(g.member_count)),[2,2]);
  }
  const extra=await db.addSubject(stage.id,'مادة إضافية '+id,'إضافية'+id);
  await assert.rejects(studies.createMubahathaGroup(extra.id,ss,{capacity:1}),{code:'GROUP_CAPACITY'});
  assert.equal((await studies.createMubahathaGroup(extra.id,ss,{capacity:2})).group_number,1);
});
test('existing overbooking needs matching capacity corrected before the saved cohort can finish',async()=>{
  const {ss,subjects,groups,student,stage}=await setup(1);
  const other=await db.createStudent(++id,'طالب سجل سابق ثان ثالث',stage.id);
  assert.equal((await studies.assignStudentToGroup(student.id,subjects[0].id,ss)).group.group_number,1);
  await db.pool.query('INSERT INTO group_memberships(group_id,student_id,subject_id,stage_season_id) VALUES($1,$2,$3,$4)',
    [groups[1][0].id,other.id,subjects[1].id,ss]);
  const denied=await studies.assignStudentToGroup(student.id,subjects[1].id,ss);
  assert.equal(denied.reason,'GROUP_FULL');assert.equal(denied.groupNumber,1);
  for(const perSubject of groups)await studies.setGroupCapacity(perSubject[0].id,2);
  const corrected=await studies.assignStudentToGroup(student.id,subjects[1].id,ss);
  assert.equal(corrected.group.group_number,1);
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
