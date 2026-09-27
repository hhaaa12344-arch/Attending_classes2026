'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
let db,studies,serial=1900000;
test.before(async()=>{({db,studies}=await require('./helpers.cjs').testDatabase());});
test.after(async()=>db.pool.end());
async function fixture(){
  const stage=await db.addStage('مرحلة اتساق التقرير '+(++serial)),ss=(await db.listStageSeasons(stage.id))[0].id;
  const subject=await db.addSubject(stage.id,'مادة تقرير '+serial,'report'+serial),student=await db.createStudent(++serial,'طالب منقول لاختبار التقرير',stage.id);
  await db.pool.query("UPDATE enrollments SET started_at=now()-interval '1 hour' WHERE student_id=$1",[student.id]);
  return {stage,ss,subject,student};
}
async function lesson(f,published,opened=null,closed="now()+interval '1 hour'",republished=null){
  const l=await db.activateLesson(f.subject.id);
  await db.pool.query(`UPDATE lessons SET activated_at=${published},attendance_opened_at=${opened||'NULL'},active_until=${closed},republished_at=${republished||'NULL'} WHERE id=$1`,[l.id]);
  return l;
}
async function reports(f,total,attended){
  const queries=[await db.getStudentSeasonReport(f.student.id),await db.getStudentSeasonReport(f.student.id,f.ss),await db.getStageSeasonReport(f.ss),await db.getSubjectAttendanceForTeacher(f.subject.id,f.ss)];
  for(const rows of queries){const row=rows.find(r=>r.student_id===f.student.id);assert.ok(row);assert.equal(Number(row.total_lessons),total);assert.equal(Number(row.attended_lessons),attended);}
}
test('transferred student report includes open older, recovered and new lessons; attendance and enrollment remain intact',async()=>{
  const f=await fixture();
  const expired=await lesson(f,"now()-interval '3 days'",null,"now()-interval '2 days'");
  const older=await lesson(f,"now()-interval '3 hours'");
  const recovered=await lesson(f,"now()-interval '3 days'","now()-interval '30 minutes'");
  const current=await lesson(f,"now()-interval '20 minutes'");
  const enrollment=(await db.pool.query('SELECT * FROM enrollments WHERE student_id=$1',[f.student.id])).rows;
  assert.deepEqual(new Set((await db.getActiveLessonsForStudent(f.stage.id,f.student.id)).map(l=>l.lesson_id)),new Set([older.id,recovered.id,current.id]));
  await reports(f,3,0);
  assert.ok(await db.markAttendance(f.student.id,older.id));
  await reports(f,3,1);
  assert.equal((await db.getActiveLessonsForStudent(f.stage.id,f.student.id)).length,2);
  assert.deepEqual((await db.pool.query('SELECT * FROM enrollments WHERE student_id=$1',[f.student.id])).rows,enrollment);
  assert.equal((await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1',[expired.id])).rows.length,0);
  assert.equal((await db.pool.query('SELECT * FROM student_attendance_days WHERE student_id=$1',[f.student.id])).rows.length,0);
});
test('report counts remain after a window closes; pre-enrollment expired lessons and future lessons are excluded',async()=>{
  const f=await fixture();
  await lesson(f,"now()-interval '3 hours'",null,"now()-interval '10 minutes'");
  await lesson(f,"now()-interval '3 days'","now()-interval '40 minutes'","now()-interval '10 minutes'");
  await lesson(f,"now()-interval '3 days'",null,"now()-interval '2 days'");
  await lesson(f,"now()+interval '1 hour'",null,"now()+interval '25 hours'");
  await reports(f,2,0);
  assert.equal((await db.getActiveLessonsForStudent(f.stage.id,f.student.id)).length,0);
});
test('republication counts only overlapping original or reopened windows, and historical attendance is preserved',async()=>{
  const f=await fixture();
  const l=await lesson(f,"now()-interval '4 days'",null,"now()+interval '1 hour'","now()-interval '30 minutes'");
  await reports(f,1,0);
  // This historical enrollment falls in the closed gap between the two windows.
  await db.pool.query("UPDATE enrollments SET started_at=now()-interval '2 days',ended_at=now()-interval '1 day' WHERE student_id=$1",[f.student.id]);
  await reports(f,0,0);
  await db.pool.query("INSERT INTO attendance(student_id,lesson_id,listened_at,marking_kind,marked_by) VALUES($1,$2,now(),'admin_late',42)",[f.student.id,l.id]);
  await reports(f,1,1);
  const before=(await db.pool.query('SELECT * FROM attendance WHERE student_id=$1',[f.student.id])).rows;
  await db.initSchema();await reports(f,1,1);
  assert.deepEqual((await db.pool.query('SELECT * FROM attendance WHERE student_id=$1',[f.student.id])).rows,before);
});

test('student enrolled before publication keeps seven of seven; excluded announcement attendance stays stored without inflating totals',async()=>{
  const f=await fixture();
  await db.pool.query("UPDATE enrollments SET started_at=now()-interval '5 days' WHERE student_id=$1",[f.student.id]);
  for(let i=0;i<8;i++){
    const l=await lesson(f,"now()-interval '2 days'",null,"now()-interval '1 day'");
    await db.pool.query("INSERT INTO attendance(student_id,lesson_id,listened_at) VALUES($1,$2,now()-interval '36 hours')",[f.student.id,l.id]);
    if(i===7)await db.pool.query("INSERT INTO lesson_corrections(lesson_id,reason,actor_id) VALUES($1,'إعلان مستبعد',42)",[l.id]);
  }
  const before=(await db.pool.query('SELECT * FROM attendance WHERE student_id=$1 ORDER BY id',[f.student.id])).rows;
  await reports(f,7,7);
  assert.deepEqual((await db.pool.query('SELECT * FROM attendance WHERE student_id=$1 ORDER BY id',[f.student.id])).rows,before);
});
