'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db,studies,broadcasts,stage,ss,subject,otherSubject,teacher,students,group;

test.before(async()=>{
  ({db,studies}=await testDatabase());
  broadcasts=require('../broadcasts').createBroadcasts(db.pool);
  stage=await db.addStage('مرحلة التنبيهات');
  ss=(await db.listStageSeasons(stage.id))[0].id;
  subject=await db.addSubject(stage.id,'الفقه','فقه');
  otherSubject=await db.addSubject(stage.id,'العقائد','عقائد');
  teacher=await db.addTeacher('أستاذ الفقه');
  await db.assignTeacherToSubject(teacher.id,subject.id);
  students=[];
  for(let i=0;i<3;i++)students.push(await db.createStudent(98000+i,`طالب التنبيه ${i} اسم رباعي`,stage.id));
  group=await studies.createMubahathaGroup(subject.id,ss,{title:'مجموعة الفقه'});
  for(const st of students.slice(0,2)){
    await studies.setParticipationMode(st.id,subject.id,ss,'mubahatha');
    await studies.assignStudentToGroup(st.id,subject.id,ss);
  }
});
test.after(async()=>{if(db)await db.pool.end();});

test('scoped broadcasts respect teacher ownership, deduplicate recipients and persist delivery jobs',async()=>{
  const actor={id:71001,role:'teacher',teacherId:teacher.id};
  const groupScope={kind:'group',groupId:group.id,subjectId:subject.id,seasonId:ss};
  assert.equal((await broadcasts.preview(actor,groupScope)).recipientCount,2);
  assert.equal((await broadcasts.preview(actor,{kind:'subject',subjectId:subject.id,seasonId:ss})).recipientCount,3);
  await assert.rejects(broadcasts.preview(actor,{kind:'subject',subjectId:otherSubject.id,seasonId:ss}),{code:'FORBIDDEN'});
  await assert.rejects(broadcasts.preview(actor,{kind:'all'}),{code:'FORBIDDEN'});
  const first=await broadcasts.send(actor,groupScope,'موعد المباحثة غدًا','test:group:once');
  assert.equal(first.recipientCount,2);
  const repeated=await broadcasts.send(actor,groupScope,'موعد المباحثة غدًا','test:group:once');
  assert.equal(repeated.id,first.id);assert.equal(repeated.repeated,true);
  const jobs=(await db.pool.query("SELECT chat_id,payload FROM notification_outbox WHERE dedupe_key LIKE 'broadcast:%' ORDER BY chat_id")).rows;
  assert.deepEqual(jobs.map(r=>Number(r.chat_id)),students.slice(0,2).map(st=>Number(st.telegram_id)));
  assert.ok(jobs.every(r=>r.payload[0].includes('موعد المباحثة غدًا')));
  const admin={id:42,role:'admin'};
  assert.equal((await broadcasts.preview(admin,{kind:'all'})).recipientCount,3);
  assert.equal((await broadcasts.send(admin,{kind:'all'},'إعلان للجميع','test:all:once')).recipientCount,3);
  await assert.rejects(broadcasts.send(actor,{kind:'all'},'غير مسموح','test:forbidden'),{code:'FORBIDDEN'});
});

test('cancelling a notified exam expires its old announcement and notifies every original recipient',async()=>{
  const exam=await studies.createExam(subject.id,ss,teacher.id,{examNumber:1,title:'أحكام البيع',dateIso:'2026-10-20',hours:24});
  const initial=(await db.pool.query('SELECT status FROM notification_outbox WHERE dedupe_key LIKE $1',[`exam:${exam.id}:%`])).rows;
  assert.equal(initial.length,3);
  await db.pool.query('UPDATE students SET is_active=false WHERE id=$1',[students[2].id]);
  const result=await studies.cancelExam(exam.id,42,'تغيير الخطة');
  assert.equal(result.recipientCount,3,'even an original recipient who is now inactive receives the cancellation');
  const saved=await studies.getExamById(exam.id);
  assert.equal(saved.status,'cancelled');assert.equal(saved.cancellation_reason,'تغيير الخطة');
  assert.equal((await studies.getOpenExamsForStudent(students[0].id)).length,0);
  assert.equal((await db.pool.query('SELECT status FROM notification_outbox WHERE dedupe_key LIKE $1',[`exam:${exam.id}:%`])).rows.filter(r=>r.status==='expired').length,3);
  const cancelled=(await db.pool.query('SELECT chat_id,payload FROM notification_outbox WHERE dedupe_key LIKE $1',[`exam-cancel:${exam.id}:%`])).rows;
  assert.equal(cancelled.length,3);
  assert.ok(cancelled.every(r=>r.payload[0].includes('أُلغي الامتحان')&&r.payload[0].includes('تغيير الخطة')));
  await assert.rejects(studies.cancelExam(exam.id,42),{code:'CONFLICT'});
  await studies.initStudiesSchema();
  assert.equal((await studies.getExamById(exam.id)).status,'cancelled');
  const replacement=await studies.createExam(subject.id,ss,teacher.id,{examNumber:1,title:'بديل أحكام البيع',dateIso:'2026-10-22',hours:24});
  assert.notEqual(replacement.id,exam.id);
  assert.equal((await studies.getExamById(exam.id)).status,'cancelled');
  await assert.rejects(studies.createExam(subject.id,ss,teacher.id,{examNumber:1,title:'مكرر',dateIso:'2026-10-23',hours:24}),{code:'EXAM_EXISTS'});
});

test('exam with a saved attempt cannot be cancelled or postponed',async()=>{
  const exam=await studies.createExam(subject.id,ss,teacher.id,{examNumber:2,title:'البيع الثاني',dateIso:'2026-10-21',hours:24});
  await db.pool.query('INSERT INTO exam_attempts(exam_id,student_id) VALUES($1,$2)',[exam.id,students[0].id]);
  await assert.rejects(studies.cancelExam(exam.id,42),{code:'CONFLICT'});
  assert.equal((await studies.getExamById(exam.id)).status,'draft');
  assert.equal((await db.pool.query('SELECT 1 FROM notification_outbox WHERE dedupe_key LIKE $1',[`exam-cancel:${exam.id}:%`])).rowCount,0);
});
