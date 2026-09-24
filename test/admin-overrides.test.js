'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHmac}=require('node:crypto');
const {testDatabase}=require('./helpers.cjs');
const {createAdminOverrides,windowDates}=require('../adminOverrides');
const {examWindowSql}=require('../examAccess');
let db,studies,ops,serial=0,server,base,token;
test.before(async()=>{
  ({db,studies}=await testDatabase());ops=createAdminOverrides(db.pool);
  server=require('../adminServer').createAdminServer({db,studies,
    adminData:require('../adminData').createAdminData(db,studies),scheduler:{},botToken:'123:test',adminIds:[42],origin:'https://test.example'});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
  const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:42,first_name:'Test'})});
  const secret=createHmac('sha256','WebAppData').update('123:test').digest();
  p.set('hash',createHmac('sha256',secret).update([...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));
  const r=await fetch(base+'/api/admin/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:p.toString()})});
  token=(await r.json()).token;assert.ok(token);
});
test.after(async()=>{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(db)await db.pool.end();});
async function fixture(){
  const n=++serial,stage=await db.addStage('مرحلة اختبار الاستثناءات '+n);
  const subject=await db.addSubject(stage.id,'العقائد '+n,'عقائد'+n),target=await db.addSubject(stage.id,'الفقه '+n,'فقه'+n);
  const ss=(await db.listStageSeasons(stage.id))[0].id;
  const students=[];for(let i=0;i<3;i++)students.push(await db.createStudent(700000+n*10+i,'طالب اختبار '+n+' رقم '+i,stage.id));
  await db.pool.query("UPDATE enrollments SET started_at=now()-interval '10 days' WHERE stage_season_id=$1",[ss]);
  const lesson=await db.activateLesson(subject.id,24,'channel_schedule','https://t.me/test/12',-90000-n,12);
  await db.pool.query("UPDATE lessons SET activated_at=now()-interval '3 days',active_until=now()-interval '2 days' WHERE id=$1",[lesson.id]);
  return {stage,ss,subject,target,students,lesson:await db.getLessonById(lesson.id)};
}
async function examFixture(){
  const f=await fixture();
  const exam=(await db.pool.query(`INSERT INTO exams(subject_id,stage_season_id,exam_number,title,opens_at,closes_at,available_hours,status)
    VALUES($1,$2,1,'امتحان التجربة',now()-interval '3 days',now()-interval '2 days',24,'published') RETURNING *`,[f.subject.id,f.ss])).rows[0];
  const qs=[];for(let i=1;i<=2;i++)qs.push((await db.pool.query(`INSERT INTO exam_questions(exam_id,position,question_type,prompt,correct_answer)
    VALUES($1,$2,'tf','سؤال','صح') RETURNING *`,[exam.id,i])).rows[0]);
  return {...f,exam,qs};
}
const futureWindow=f=>({studentId:f.students[0].id,subjectId:f.subject.id,opensAt:new Date(Date.now()-60000).toISOString(),closesAt:new Date(Date.now()+3600000).toISOString(),note:'فرصة إدارية'});
async function request(path,body,method='POST',authorized=true){
  const r=await fetch(base+'/api/admin'+path,{method,headers:{'Content-Type':'application/json',...(authorized?{Authorization:'Bearer '+token}:{})},...(method==='GET'?{}:{body:JSON.stringify(body)})});
  return {status:r.status,data:await r.json()};
}
test('subject correction preserves every attendance row, source and original lesson times; reports follow the new subject',async()=>{
  const f=await fixture();
  await db.pool.query('INSERT INTO attendance(student_id,lesson_id) VALUES($1,$3),($2,$3)',[f.students[0].id,f.students[1].id,f.lesson.id]);
  const before=(await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1 ORDER BY id',[f.lesson.id])).rows;
  await ops.correctSubject(f.lesson.id,{subjectId:f.target.id,expectedSubjectId:f.subject.id},42);
  assert.deepEqual((await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1 ORDER BY id',[f.lesson.id])).rows,before);
  const after=await db.getLessonById(f.lesson.id);
  for(const key of ['id','activated_at','active_until','stage_season_id','source_type','source_url','source_chat_id','source_message_id'])assert.deepEqual(after[key],f.lesson[key],key);
  assert.equal(after.subject_id,f.target.id);
  const data=await require('../lessonAttendance').createLessonAttendance(db.pool).matrix({stageId:f.stage.id});
  assert.equal(data.rows[0].attendance.find(x=>x.subject_id===f.target.id).attended,1);
  assert.equal(data.rows[0].attendance.find(x=>x.subject_id===f.subject.id).attended,0);
  const audit=(await db.pool.query("SELECT * FROM admin_audit_log WHERE entity_id=$1 AND action='correct_lesson_subject'",[f.lesson.id])).rows[0];
  assert.equal(audit.before_data.subject_id,f.subject.id);assert.equal(audit.after_data.subject_name,f.target.name);assert.equal(Number(audit.actor_id),42);assert.ok(audit.created_at);
  await assert.rejects(ops.correctSubject(f.lesson.id,{subjectId:f.subject.id,expectedSubjectId:f.subject.id},42),{code:'CONFLICT'});
});
test('correction rejects another stage and an archived season without touching attendance',async()=>{
  const f=await fixture(),other=await fixture();
  await assert.rejects(ops.correctSubject(f.lesson.id,{subjectId:other.subject.id,expectedSubjectId:f.subject.id},42));
  await db.pool.query('UPDATE stage_seasons SET is_active=false WHERE id=$1',[f.ss]);
  await assert.rejects(ops.correctSubject(f.lesson.id,{subjectId:f.target.id,expectedSubjectId:f.subject.id},42),{code:'ARCHIVED'});
  assert.equal((await db.getLessonById(f.lesson.id)).subject_id,f.subject.id);
});
test('late attendance supports one or many students, preserves existing records and times, and is idempotent',async()=>{
  const f=await fixture();
  const single=await ops.lateAttendance(f.lesson.id,{subjectId:f.subject.id,studentIds:[f.students[0].id],note:'عذر'},42);assert.equal(single.added,1);
  const saved=(await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1',[f.lesson.id])).rows[0];
  const body={subjectId:f.subject.id,studentIds:[f.students[0].id,f.students[1].id,f.students[1].id,f.students[2].id]};
  const results=await Promise.all([ops.lateAttendance(f.lesson.id,body,42),ops.lateAttendance(f.lesson.id,body,42)]);
  assert.equal(results.reduce((n,r)=>n+r.added,0),2);
  assert.deepEqual((await db.pool.query('SELECT * FROM attendance WHERE id=$1',[saved.id])).rows[0],saved);
  const rows=(await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1',[f.lesson.id])).rows;
  assert.equal(rows.length,3);assert.ok(rows.every(r=>r.marking_kind==='admin_late'&&Number(r.marked_by)===42&&r.listened_at>f.lesson.active_until));
  const after=await db.getLessonById(f.lesson.id);assert.deepEqual(after.activated_at,f.lesson.activated_at);assert.deepEqual(after.active_until,f.lesson.active_until);
  const md=await Array.fromAsync(require('../adminData').createAdminData(db,studies).attendanceMarkdown(f.ss,'lessons'));
  assert.match(md.join(''),/حضور إداري متأخر/);
});
test('late attendance rejects empty, oversized, foreign, inactive and stale-subject batches atomically',async()=>{
  const f=await fixture(),other=await fixture();
  for(const studentIds of [[],Array(501).fill(f.students[0].id),[f.students[0].id,other.students[0].id]])
    await assert.rejects(ops.lateAttendance(f.lesson.id,{subjectId:f.subject.id,studentIds},42));
  await db.pool.query('UPDATE students SET is_active=false WHERE id=$1',[f.students[1].id]);
  await assert.rejects(ops.lateAttendance(f.lesson.id,{subjectId:f.subject.id,studentIds:[f.students[0].id,f.students[1].id]},42));
  await assert.rejects(ops.lateAttendance(f.lesson.id,{subjectId:f.target.id,studentIds:[f.students[0].id]},42),{code:'CONFLICT'});
  assert.equal((await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1',[f.lesson.id])).rowCount,0);
  const open=await db.activateLesson(f.subject.id);
  await assert.rejects(ops.lateAttendance(open.id,{subjectId:f.subject.id,studentIds:[f.students[0].id]},42),{code:'NOT_EXPIRED'});
});
test('late attendance corrects a stored absence day and streak; future processing also counts administrative attendance',async()=>{
  const f=await fixture();
  await db.pool.query("UPDATE absence_monitoring_config SET started_at=now()-interval '20 days' WHERE id=1");
  await db.processCompletedAttendanceDays('Asia/Baghdad');
  const before=(await db.pool.query('SELECT * FROM student_attendance_days WHERE student_id=$1 AND stage_season_id=$2',[f.students[0].id,f.ss])).rows[0];
  assert.ok(before.is_full_absence);
  await ops.lateAttendance(f.lesson.id,{subjectId:f.subject.id,studentIds:[f.students[0].id]},42);
  const after=(await db.pool.query('SELECT * FROM student_attendance_days WHERE id=$1',[before.id])).rows[0];
  assert.equal(after.is_full_absence,false);assert.equal(after.absence_streak,0);assert.equal(after.attended_on_time_count,1);
  const g=await fixture();await ops.lateAttendance(g.lesson.id,{subjectId:g.subject.id,studentIds:[g.students[0].id]},42);
  await db.processCompletedAttendanceDays('Asia/Baghdad');
  const row=(await db.pool.query('SELECT * FROM student_attendance_days WHERE student_id=$1 AND stage_season_id=$2',[g.students[0].id,g.ss])).rows[0];
  assert.equal(row.is_full_absence,false);
});
test('exam window belongs only to the selected student: listing, starting and answers honor it',async()=>{
  const f=await examFixture(),body=futureWindow(f);
  await assert.rejects(studies.startOrResumeAttempt(f.exam.id,f.students[0].id),{code:'EXAM_CLOSED'});
  const saved=await ops.reopenExam(f.exam.id,body,42);assert.equal(saved.note,body.note);
  assert.ok((await studies.getOpenExamsForStudent(f.students[0].id)).some(e=>e.id===f.exam.id));
  assert.ok(!(await studies.getOpenExamsForStudent(f.students[1].id)).some(e=>e.id===f.exam.id));
  await assert.rejects(studies.startOrResumeAttempt(f.exam.id,f.students[1].id),{code:'EXAM_CLOSED'});
  const a=await studies.startOrResumeAttempt(f.exam.id,f.students[0].id);
  assert.ok(await studies.submitAnswer(a.id,f.qs[0].id,'صح'));
  assert.equal((await studies.startOrResumeAttempt(f.exam.id,f.students[0].id)).id,a.id);
  const exam=await studies.getExamById(f.exam.id);assert.deepEqual(exam.closes_at,f.exam.closes_at);assert.deepEqual(exam.opens_at,f.exam.opens_at);
  await db.pool.query("UPDATE exam_student_windows SET opens_at=now()-interval '1 hour',closes_at=now()-interval '1 second' WHERE exam_id=$1",[f.exam.id]);
  await assert.rejects(studies.submitAnswer(a.id,f.qs[1].id,'صح'),{code:'EXAM_CLOSED'});
});
test('incomplete submitted attempt resumes without losing answers; completed attempt cannot be retaken',async()=>{
  const f=await examFixture();await ops.reopenExam(f.exam.id,futureWindow(f),42);
  const a=await studies.startOrResumeAttempt(f.exam.id,f.students[0].id);await studies.submitAnswer(a.id,f.qs[0].id,'صح');await studies.finalizeAttempt(a.id);
  await ops.reopenExam(f.exam.id,futureWindow(f),42);
  const resumed=await studies.startOrResumeAttempt(f.exam.id,f.students[0].id);assert.equal(resumed.id,a.id);assert.deepEqual(resumed.started_at,a.started_at);
  assert.equal((await studies.getNextUnansweredQuestion(a.id)).id,f.qs[1].id);
  await studies.submitAnswer(a.id,f.qs[1].id,'صح');const done=await studies.finalizeAttempt(a.id);assert.equal(Number(done.score),5);
  await assert.rejects(ops.reopenExam(f.exam.id,futureWindow(f),42),{code:'ALREADY_SUBMITTED'});
  assert.deepEqual((await studies.getAttemptById(a.id)).submitted_at,done.submitted_at);
});
test('exact start is allowed, exact end and pre-start are denied using the database clock',async()=>{
  const f=await examFixture();await ops.reopenExam(f.exam.id,futureWindow(f),42);
  const c=await db.pool.connect();try{
    await c.query('BEGIN');
    for(const [start,end,allowed] of [["now()","now()+interval '1 hour'",true],["now()+interval '1 second'","now()+interval '1 hour'",false],["now()-interval '1 hour'","now()",false]]){
      await c.query(`UPDATE exam_student_windows SET opens_at=${start},closes_at=${end} WHERE exam_id=$1`,[f.exam.id]);
      const result=await c.query(`SELECT ${examWindowSql('e','$2')} AS allowed FROM exams e WHERE id=$1`,[f.exam.id,f.students[0].id]);
      assert.equal(result.rows[0].allowed,allowed);
    }
    await c.query('ROLLBACK');
  }finally{c.release();}
});
test('future window prevents premature timeout finalization and is not available until its start',async()=>{
  const f=await examFixture();await ops.reopenExam(f.exam.id,futureWindow(f),42);
  const a=await studies.startOrResumeAttempt(f.exam.id,f.students[0].id);
  await ops.reopenExam(f.exam.id,{...futureWindow(f),opensAt:new Date(Date.now()+600000).toISOString()},42);
  assert.equal(await studies.isExamAvailable(f.exam.id,f.students[0].id),false);
  assert.equal(await studies.finalizeAttempt(a.id,{onlyIfClosed:true}),null);
  assert.equal((await studies.getAttemptById(a.id)).submitted_at,null);
});
test('window validation rejects invalid dates, reversed intervals, missing timezones and past ends',async()=>{
  for(const body of [{opensAt:'2026-02-30T10:00:00Z',closesAt:'2026-03-01T10:00:00Z'},
    {opensAt:'2026-09-23T10:00',closesAt:'2026-09-23T11:00'},
    {opensAt:'2026-09-23T12:00:00Z',closesAt:'2026-09-23T11:00:00Z'}])assert.throws(()=>windowDates(body));
  const f=await examFixture(),g=await fixture();
  await assert.rejects(ops.reopenExam(f.exam.id,{...futureWindow(f),closesAt:new Date(Date.now()-1000).toISOString()},42));
  await assert.rejects(ops.reopenExam(f.exam.id,{...futureWindow(f),studentId:g.students[0].id},42),{code:'NOT_ENROLLED'});
  await assert.rejects(ops.reopenExam(f.exam.id,{...futureWindow(f),subjectId:f.target.id},42));
  await db.pool.query("UPDATE exams SET status='draft' WHERE id=$1",[f.exam.id]);
  await assert.rejects(ops.reopenExam(f.exam.id,futureWindow(f),42));
  assert.equal((await db.pool.query('SELECT * FROM exam_student_windows WHERE exam_id=$1',[f.exam.id])).rowCount,0);
});
test('repeatable additive migrations retain windows and late attendance',async()=>{
  const f=await examFixture();const w=await ops.reopenExam(f.exam.id,futureWindow(f),42);
  await ops.lateAttendance(f.lesson.id,{subjectId:f.subject.id,studentIds:[f.students[0].id]},42);
  await db.initSchema();await studies.initStudiesSchema();await require('../integrity').initIntegritySchema(db.pool);
  await require('../integrity').initIntegritySchema(db.pool);
  assert.deepEqual((await db.pool.query('SELECT * FROM exam_student_windows WHERE exam_id=$1',[f.exam.id])).rows[0],w);
  assert.equal((await db.pool.query('SELECT marking_kind FROM attendance WHERE lesson_id=$1',[f.lesson.id])).rows[0].marking_kind,'admin_late');
  await assert.rejects(db.pool.query('UPDATE exam_student_windows SET closes_at=opens_at WHERE exam_id=$1',[f.exam.id]),{code:'23514'});
});
test('audit failure rolls back correction, attendance and reopening completely',async()=>{
  const f=await examFixture();
  const broken=createAdminOverrides({connect:async()=>{const c=await db.pool.connect();return {release:()=>c.release(),query:(sql,args)=>{
    if(sql.startsWith('INSERT INTO admin_audit_log'))throw Error('audit unavailable');return c.query(sql,args);
  }};}});
  await assert.rejects(broken.correctSubject(f.lesson.id,{subjectId:f.target.id,expectedSubjectId:f.subject.id},42),/audit unavailable/);
  await assert.rejects(broken.lateAttendance(f.lesson.id,{subjectId:f.subject.id,studentIds:[f.students[0].id]},42),/audit unavailable/);
  await assert.rejects(broken.reopenExam(f.exam.id,futureWindow(f),42),/audit unavailable/);
  assert.equal((await db.getLessonById(f.lesson.id)).subject_id,f.subject.id);
  assert.equal((await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1',[f.lesson.id])).rowCount,0);
  assert.equal((await db.pool.query('SELECT * FROM exam_student_windows WHERE exam_id=$1',[f.exam.id])).rowCount,0);
});
test('HTTP authorization, correction, selected attendance and individual windows persist and are visible',async()=>{
  const f=await examFixture();
  for(const [path,body,method] of [[`/lessons/${f.lesson.id}/subject`,{subjectId:f.target.id,expectedSubjectId:f.subject.id},'PATCH'],
    [`/lessons/${f.lesson.id}/late-attendance`,{subjectId:f.subject.id,studentIds:[f.students[0].id]},'POST'],
    [`/exams/${f.exam.id}/student-window`,futureWindow(f),'POST']])assert.equal((await request(path,body,method,false)).status,401);
  const options=await request(`/lessons/${f.lesson.id}/admin-options`,null,'GET');assert.equal(options.status,200);assert.equal(options.data.rows.length,3);
  assert.equal((await request(`/lessons/${f.lesson.id}/subject`,{subjectId:f.target.id,expectedSubjectId:f.subject.id},'PATCH')).status,200);
  assert.equal((await request(`/lessons/${f.lesson.id}/late-attendance`,{subjectId:f.target.id,studentIds:[f.students[0].id]})).data.added,1);
  assert.equal((await request(`/exams/${f.exam.id}/student-window`,futureWindow(f))).status,200);
  const detail=await request(`/exams/${f.exam.id}`,null,'GET');assert.equal(detail.data.studentWindows.length,1);assert.equal(detail.data.studentWindows[0].student_id,f.students[0].id);
});

test('expired permission cannot be used after transfer, archival or before original exam expiry',async()=>{
  const f=await examFixture();await ops.reopenExam(f.exam.id,futureWindow(f),42);
  const a=await studies.startOrResumeAttempt(f.exam.id,f.students[0].id);
  await db.pool.query("UPDATE enrollments SET status='archived' WHERE student_id=$1 AND stage_season_id=$2",[f.students[0].id,f.ss]);
  assert.equal(await studies.isExamAvailable(f.exam.id,f.students[0].id),false);
  assert.equal((await studies.getOpenExamsForStudent(f.students[0].id)).length,0);
  await assert.rejects(studies.startOrResumeAttempt(f.exam.id,f.students[0].id),{code:'NOT_ENROLLED'});
  await assert.rejects(studies.submitAnswer(a.id,f.qs[0].id,'صح'),{code:'EXAM_CLOSED'});
  await db.pool.query('UPDATE stage_seasons SET is_active=false WHERE id=$1',[f.ss]);
  await assert.rejects(ops.reopenExam(f.exam.id,{...futureWindow(f),studentId:f.students[1].id},42),{code:'ARCHIVED'});
  const g=await examFixture();await db.pool.query("UPDATE exams SET closes_at=now()+interval '1 hour' WHERE id=$1",[g.exam.id]);
  await assert.rejects(ops.reopenExam(g.exam.id,futureWindow(g),42),{code:'INVALID_WINDOW'});
});
test('attendance closes at the boundary; student records remain unchanged and expired admin marking is accepted',async()=>{
  const f=await fixture();
  await db.pool.query('UPDATE lessons SET active_until=now() WHERE id=$1',[f.lesson.id]);
  assert.equal(await db.markAttendance(f.students[0].id,f.lesson.id),undefined);
  assert.equal((await ops.lateAttendance(f.lesson.id,{subjectId:f.subject.id,studentIds:[f.students[0].id]},42)).added,1);
});
