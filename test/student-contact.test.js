'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
const {createStudentContact}=require('../studentContact');
let db,contact,serial=0;
test.before(async()=>{({db}=await testDatabase());contact=createStudentContact(db.pool);});
test.after(async()=>{if(db)await db.pool.end();});
async function fixture(){
  const n=++serial,stage=await db.addStage('مرحلة تواصل '+n),other=await db.addStage('مرحلة ثانية '+n);
  const subject=await db.addSubject(stage.id,'فقه '+n,'فقهتواصل'+n),wrong=await db.addSubject(other.id,'عقائد '+n,'عقائدتواصل'+n);
  const season=(await db.listStageSeasons(stage.id))[0].id;
  const student=await db.createStudent(810000+n*10,'طالب تواصل '+n,stage.id);
  const outsider=await db.createStudent(910000+n*10,'طالب خارج المادة '+n,other.id);
  const teacher=(await db.pool.query('INSERT INTO teachers(full_name,telegram_id) VALUES($1,$2) RETURNING *',['أستاذ فقه',610000+n])).rows[0];
  await db.pool.query('INSERT INTO teaching_assignments(teacher_id,subject_id,stage_season_id) VALUES($1,$2,$3)',[teacher.id,subject.id,season]);
  const report=(await db.pool.query('INSERT INTO student_reports(student_id,subject_id,stage_season_id,note) VALUES($1,$2,$3,$4) RETURNING *',[student.id,subject.id,season,'تقرير تجربة'])).rows[0];
  const leave=(await db.pool.query("INSERT INTO student_leaves(student_id,stage_season_id,start_date,end_date,days) VALUES($1,$2,CURRENT_DATE,CURRENT_DATE,1) RETURNING *",[student.id,season])).rows[0];
  return {stage,subject,wrong,student,outsider,teacher,report,leave};
}
test('administrator searches by name and sends a private reply to the leave with audit and outbox',async()=>{
  const f=await fixture();
  const found=await contact.search({actorId:42,role:'admin',q:'تواصل '+serial});
  assert.ok(found.rows.some(r=>r.id===f.student.id));
  const input={actorId:42,role:'admin',studentId:f.student.id,message:'تمت مراجعة إجازتك',contextKind:'leave',contextId:f.leave.id,requestKey:'leave-reply:'+serial};
  const first=await contact.send(input),again=await contact.send(input);
  assert.equal(first.duplicate,false);assert.equal(again.duplicate,true);assert.equal(first.id,again.id);
  const saved=(await db.pool.query('SELECT m.*,o.chat_id,o.payload,o.status FROM student_contact_messages m JOIN notification_outbox o ON o.id=m.outbox_id WHERE m.id=$1',[first.id])).rows[0];
  assert.equal(Number(saved.chat_id),Number(f.student.telegram_id));assert.equal(saved.status,'pending');
  assert.match(JSON.stringify(saved.payload),/تمت مراجعة إجازتك/);
  assert.equal((await contact.history({actorId:42,role:'admin',studentId:f.student.id})).length,1);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM admin_audit_log WHERE action='contact_student_admin' AND entity_id=$1",[f.student.id])).rows[0].n,1);
  await assert.rejects(contact.send({...input,message:'مختلفة'}),{code:'CONFLICT'});
  await assert.rejects(contact.send({...input,requestKey:'wrong-leave:'+serial,studentId:f.outsider.id}),{code:'CONFLICT'});
});
test('teacher sees only enrolled students in an assigned subject and can answer their report',async()=>{
  const f=await fixture(),actorId=Number(f.teacher.telegram_id);
  const found=await contact.search({actorId,role:'teacher',subjectId:f.subject.id,q:'طالب'});
  assert.deepEqual(found.rows.map(r=>r.id),[f.student.id]);
  const sent=await contact.send({actorId,role:'teacher',studentId:f.student.id,subjectId:f.subject.id,message:'راجعت تقريرك',contextKind:'report',contextId:f.report.id,requestKey:'report-reply:'+serial});
  assert.ok(sent.id);
  const row=(await db.pool.query('SELECT * FROM student_contact_messages WHERE id=$1',[sent.id])).rows[0];
  assert.equal(row.teacher_id,f.teacher.id);assert.equal(row.context_kind,'report');
  assert.equal((await contact.history({actorId,role:'teacher',studentId:f.student.id,subjectId:f.subject.id})).length,1);
  for(const params of [
    {studentId:f.outsider.id,subjectId:f.subject.id},
    {studentId:f.student.id,subjectId:f.wrong.id},
    {studentId:f.student.id,subjectId:f.subject.id,contextKind:'report',contextId:f.report.id+999},
    {studentId:f.student.id,subjectId:f.subject.id,contextKind:'leave',contextId:f.leave.id},
  ])await assert.rejects(contact.send({actorId,role:'teacher',message:'لا يجوز',...params}));
  await assert.rejects(contact.history({actorId,role:'teacher',studentId:f.outsider.id,subjectId:f.subject.id}),{code:'FORBIDDEN'});
  await db.pool.query('UPDATE teachers SET is_active=false WHERE id=$1',[f.teacher.id]);
  await assert.rejects(contact.send({actorId,role:'teacher',studentId:f.student.id,subjectId:f.subject.id,message:'بعد الإيقاف'}),{code:'FORBIDDEN'});
});
