'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db,studies,stage,subject,ss,teacher,group,student;
test.before(async()=>{
  ({db,studies}=await testDatabase());
  stage=await db.addStage('التمهيدية');
  subject=await db.addSubject(stage.id,'الفقه','فقه');
  ss=(await db.listStageSeasons(stage.id))[0].id;
  teacher=await db.addTeacher('الأستاذ الأول');
  await db.assignTeacherToSubject(teacher.id,subject.id);
  group=await studies.createMubahathaGroup(subject.id,ss,{title:'المجموعة الأولى',capacity:2000});
  student=await db.createStudent(90101,'طالب أول ثاني ثالث',stage.id);
  await studies.setParticipationMode(student.id,subject.id,ss,'mubahatha');
  await studies.assignStudentToGroup(student.id,subject.id,ss);
});
test.after(async()=>{if(db)await db.pool.end();});
test('fresh database and repeatable migrations preserve existing records',async()=>{
  await db.initSchema();await studies.initStudiesSchema();await require('../integrity').initIntegritySchema(db.pool);
  assert.equal((await db.getStudentById(student.id)).full_name,'طالب أول ثاني ثالث');
});
test('stages and stage detail exist before any search; empty stages remain visible',async()=>{
  const a=require('../adminData').createAdminData(db,studies);
  const empty=await db.addStage('مرحلة فارغة');
  assert.ok((await a.stages()).some(x=>x.id===empty.id&&Number(x.student_count)===0));
  const detail=await a.stage(stage.id);assert.equal(detail.groups.length,1);assert.equal(detail.subjects.length,1);
  assert.equal((await a.students({stageId:stage.id})).rows[0].groups[0].group,'المجموعة الأولى');
});
test('atomic attendance: first opens after ten minutes, duplicate presses insert once, both phases complete attendance',async()=>{
  const session=await studies.openSession(group.id,teacher.id,'جلسة اختبار',1);
  await db.pool.query("UPDATE group_memberships SET assigned_at=now()-interval '1 hour' WHERE student_id=$1 AND group_id=$2",[student.id,group.id]);
  await db.pool.query("UPDATE participation_modes SET joined_mubahatha_at=now()-interval '1 hour' WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3",[student.id,subject.id,ss]);
  assert.equal(await studies.markSessionAttendance(session.id,student.id,'start'),undefined,'first attendance is closed before +10 minutes');
  await db.pool.query(`UPDATE mubahatha_sessions SET opened_at=now()-interval '10 minutes',
    closes_at=now()+interval '50 minutes',start_notifications_queued=true WHERE id=$1`,[session.id]);
  const results=await Promise.all(Array.from({length:40},()=>studies.markSessionAttendance(session.id,student.id,'start')));
  assert.equal(results.filter(Boolean).length,1);
  await studies.openEndAttendance(session.id);
  assert.ok(await studies.markSessionAttendance(session.id,student.id,'end'));
  assert.equal((await studies.listGroupSessions(group.id))[0].attended_count,1);
});
test('wrong group, archived student and expired window cannot insert attendance',async()=>{
  const g2=await studies.createMubahathaGroup(subject.id,ss,{title:'الثانية'});
  const s=await studies.openSession(g2.id,teacher.id,'للمجموعة الثانية',1);
  assert.equal(await studies.markSessionAttendance(s.id,student.id,'start'),undefined);
  const own=await studies.openSession(group.id,teacher.id,'منتهية',1);
  await db.pool.query("UPDATE mubahatha_sessions SET closes_at=now()-interval '1 second' WHERE id=$1",[own.id]);
  assert.equal(await studies.markSessionAttendance(own.id,student.id,'start'),undefined);
  assert.equal(await studies.openEndAttendance(own.id),undefined,'attendance is never extended beyond the original hour');
  const noStart=await db.createStudent(90103,'طالب نهاية بلا بداية',stage.id);
  await studies.setParticipationMode(noStart.id,subject.id,ss,'mubahatha');await studies.assignStudentToGroup(noStart.id,subject.id,ss);
  await db.pool.query("UPDATE group_memberships SET assigned_at=now()-interval '1 hour' WHERE student_id=$1",[noStart.id]);
  await db.pool.query("UPDATE participation_modes SET joined_mubahatha_at=now()-interval '1 hour' WHERE student_id=$1",[noStart.id]);
  const active=await studies.openSession(group.id,teacher.id,'نهاية مستقلة',1);
  await db.pool.query(`UPDATE mubahatha_sessions SET opened_at=now()-interval '20 minutes',
    closes_at=now()+interval '40 minutes',start_notifications_queued=true WHERE id=$1`,[active.id]);
  assert.ok(await studies.openEndAttendance(active.id));
  assert.ok(await studies.markSessionAttendance(active.id,noStart.id,'end'),'end mark is retained for audit even without start');
  assert.equal(Number((await studies.listGroupSessions(group.id)).find(x=>x.id===active.id).attended_count),0,'end alone is not complete attendance');
});
test('report captures group and source message; later move never reassigns historical report',async()=>{
  const rep=await db.createStudent(90102,'طالب تقارير ثاني ثالث',stage.id);
  await studies.setParticipationMode(rep.id,subject.id,ss,'report');
  assert.equal(await studies.submitReport(rep.id,subject.id,ss,{kind:'text',note:'تقرير قبل التوزيع'}),undefined);
  await studies.assignStudentToGroup(rep.id,subject.id,ss);
  const r=await studies.submitReport(rep.id,subject.id,ss,{kind:'text',note:'تقرير تجريبي',sourceMessageId:50});
  assert.equal(r.group_id,group.id);
  assert.equal(await studies.submitReport(rep.id,subject.id,ss,{kind:'text',note:'مكرر',sourceMessageId:50}),undefined);
  const g=(await studies.listGroups(subject.id,ss))[1];
  await studies.moveStudentToGroup(rep.id,subject.id,ss,g.id);
  assert.equal((await studies.listStudentReports(rep.id,subject.id,ss))[0].group_id,group.id);
  assert.ok(!(await studies.listGroupStudents(g.id)).some(x=>x.id===rep.id),'report mode receives no discussion attendance');
});
test('teacher ownership is checked against the actual session and slot',async()=>{
  const access=require('../access').createAccess(db.pool);
  const other=await db.addTeacher('أستاذ غير مسند');
  const s=await studies.openSession(group.id,teacher.id,'صلاحيات',1);
  assert.equal(await access.teacherObject(other.id,'session',s.id),false);
  assert.equal(await access.teacherObject(teacher.id,'session',s.id),true);
});
test('1000 simultaneous submissions, stable pagination and no duplicate student rows',async()=>{
  const students=(await db.pool.query(`INSERT INTO students(telegram_id,full_name,stage_id)
    SELECT 200000+n,'طالب اختبار حمل '||lpad(n::text,4,'0'),$1 FROM generate_series(1,1000) n RETURNING id`,[stage.id])).rows;
  const ids=students.map(x=>x.id);
  await db.pool.query(`INSERT INTO enrollments(student_id,stage_season_id,status) SELECT unnest($1::int[]),$2,'active'`,[ids,ss]);
  await db.pool.query(`INSERT INTO participation_modes(student_id,subject_id,stage_season_id,mode,joined_mubahatha_at)
    SELECT unnest($1::int[]),$2,$3,'mubahatha',now()`,[ids,subject.id,ss]);
  await db.pool.query(`INSERT INTO group_memberships(student_id,group_id,subject_id,stage_season_id,assigned_at)
    SELECT unnest($1::int[]),$2,$3,$4,now()-interval '1 hour'`,[ids,group.id,subject.id,ss]);
  await db.pool.query(`UPDATE participation_modes SET joined_mubahatha_at=now()-interval '1 hour' WHERE student_id=ANY($1::int[])`,[ids]);
  const s=await studies.openSession(group.id,teacher.id,'اختبار ألف طلب',1);
  await db.pool.query(`UPDATE mubahatha_sessions SET opened_at=now()-interval '10 minutes',
    closes_at=now()+interval '50 minutes',start_notifications_queued=true WHERE id=$1`,[s.id]);
  const started=performance.now();
  const results=await Promise.all(ids.map(id=>studies.markSessionAttendance(s.id,id,'start')));
  assert.equal(results.filter(Boolean).length,1000);
  const a=require('../adminData').createAdminData(db,studies);const seen=new Set();
  for(let page=0;page<40;page++){
    const result=await a.students({stageId:stage.id,q:'طالب اختبار حمل',page});
    assert.equal(result.total,1000);assert.equal(result.rows.length,25);
    for(const r of result.rows){assert.ok(!seen.has(r.id));seen.add(r.id);}
  }
  assert.equal(seen.size,1000);
  console.log(`Local PostgreSQL engine: 1000 concurrent promises + 40 pages in ${Math.round(performance.now()-started)} ms (single backend; not a Railway load benchmark).`);
});
test('report pages include student #1000 and all reports beyond first ten',async()=>{
  const rep=await db.createStudent(90105,'طالب صاحب تقارير كثيرة',stage.id);
  await studies.setParticipationMode(rep.id,subject.id,ss,'report');await studies.assignStudentToGroup(rep.id,subject.id,ss);
  for(let i=0;i<13;i++)await studies.submitReport(rep.id,subject.id,ss,{kind:'text',note:'نص تقرير للاختبار '+i,sourceMessageId:500+i});
  assert.equal((await studies.listStudentReports(rep.id,subject.id,ss,{page:1})).length,3);
  assert.equal(Number((await studies.listStudentReports(rep.id,subject.id,ss))[0].total_count),13);
  const summaries=await studies.listReportStudentsForGrading(subject.id,ss,{groupId:group.id});
  assert.ok(summaries.some(x=>x.student_id===rep.id));
  const a=require('../adminData').createAdminData(db,studies);
  assert.ok((await a.reports({seasonId:ss,groupId:group.id})).rows.every(r=>r.group_id===group.id));
});
test('two grade component updates preserve each other; out-of-range scores rejected',async()=>{
  await Promise.all([
    studies.overrideStudentGrade(student.id,subject.id,ss,{examsScore:12},1),
    studies.overrideStudentGrade(student.id,subject.id,ss,{participationScore:9},2)
  ]);
  const r=(await studies.listSubjectGrades(subject.id,ss,{studentId:student.id}))[0];
  assert.equal(Number(r.exams_score),12);assert.equal(Number(r.participation_score),9);assert.equal(Number(r.total_score),21);
  await assert.rejects(()=>studies.overrideStudentGrade(student.id,subject.id,ss,{examsScore:Infinity},1));
});
test('leave quota: duplicate simultaneous requests cannot reserve more than ten days',async()=>{
  const st=await db.createStudent(90106,'طالب إجازات أول ثاني',stage.id);
  const attempts=await Promise.allSettled([db.requestLeave(st.id,'2030-01-01',6,'اختبار'),db.requestLeave(st.id,'2030-02-01',6,'اختبار')]);
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
  const leave=attempts.find(x=>x.status==='fulfilled').value;
  const decisions=await Promise.all([db.decideLeave(leave.id,true,1),db.decideLeave(leave.id,true,2)]);
  assert.equal(decisions.filter(Boolean).length,1);
  assert.equal(Number((await db.getStudentCurrentSeasonActivity(st.id)).approvedLeaveDays),6);
  await db.requestLeave(st.id,'2030-03-01',4,null);
  await assert.rejects(()=>db.requestLeave(st.id,'2030-04-01',1,null),{code:'LEAVE_SEASON_LIMIT'});
});
test('scheduled start requires explicit teacher confirmation, is idempotent and keeps the original closing time',async()=>{
  const g=await studies.createMubahathaGroup(subject.id,ss,{title:'مجموعة الجدول'});
  const slot=(await db.pool.query(`INSERT INTO schedule_slots(group_id,subject_id,stage_season_id,teacher_id,day_of_week,hour,minute)
    SELECT $1,$2,$3,$4,extract(dow from t)::int,extract(hour from t)::int,extract(minute from t)::int
    FROM (SELECT now() AT TIME ZONE 'Asia/Baghdad'-interval '2 minutes' t) x RETURNING *`,[g.id,subject.id,ss,teacher.id])).rows[0];
  assert.ok(!(await studies.getSlotsReadyToStart()).some(x=>x.id===slot.id),'no session without pressing yes');
  const localDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  assert.ok(await studies.recordSlotDecision(slot.id,localDate,'confirmed',1));
  const ready=(await studies.getSlotsReadyToStart()).find(x=>x.id===slot.id);assert.ok(ready);
  const results=await Promise.all(Array.from({length:15},()=>studies.startSessionFromSlot(ready)));
  assert.equal(results.filter(Boolean).length,1);
  assert.equal(new Date(results.find(Boolean).closes_at).getTime(),new Date(ready.scheduled_end).getTime());
  assert.equal(await studies.recordSlotDecision(slot.id,ready.scheduled_date,'postponed',1),undefined);
  const scheduler=require('../scheduler').createScheduler({pool:db.pool,studies});
  await scheduler.tick();await scheduler.tick();
});
test('automatic second attendance opens at the final ten minutes and never extends past the original hour',async()=>{
  const s=await studies.openSession(group.id,teacher.id,'فتح تلقائي',1);
  await db.pool.query(`UPDATE mubahatha_sessions SET opened_at=now()-interval '50 minutes',
    closes_at=now()+interval '10 minutes',start_notifications_queued=true WHERE id=$1`,[s.id]);
  assert.ok((await studies.getSessionsNeedingAutoEnd()).some(x=>x.id===s.id));
  const values=await Promise.all([studies.openEndAttendance(s.id,true),studies.openEndAttendance(s.id,true)]);
  assert.equal(values.filter(Boolean).length,1);
  assert.equal(new Date(values.find(Boolean).end_closes_at).getTime(),new Date(values.find(Boolean).closes_at).getTime());
  const old=await studies.openSession(group.id,teacher.id,'قديمة',1);
  await db.pool.query("UPDATE mubahatha_sessions SET opened_at=now()-interval '3 days',closes_at=now()-interval '2 days' WHERE id=$1",[old.id]);
  assert.equal(await studies.openEndAttendance(old.id,true),undefined);
  assert.ok(!(await studies.getSessionsNeedingAutoEnd()).some(x=>x.id===old.id));
  const closed=await studies.closeExpiredSessionsWithoutEnd();assert.ok(closed.some(x=>x.id===old.id));
});
test('exam creation, concurrent starts, cross-exam answers, resumption and finalization',async()=>{
  const exam=await studies.createExam(subject.id,ss,teacher.id,{examNumber:1,title:'امتحان اختبار',dateIso:'2030-01-01',hours:2});
  await assert.rejects(()=>studies.publishExam(exam.id),{code:'NO_QUESTIONS'});
  const qs=await Promise.all([studies.addExamQuestion(exam.id,{type:'tf',prompt:'السؤال الأول',correct:'صح'}),studies.addExamQuestion(exam.id,{type:'mcq',prompt:'السؤال الثاني',options:['أ','ب'],correct:'ب'})]);
  assert.deepEqual(qs.map(x=>x.position).sort(),[1,2]);
  await studies.publishExam(exam.id);
  await db.pool.query("UPDATE exams SET opens_at=now()-interval '1 minute',closes_at=now()+interval '1 hour' WHERE id=$1",[exam.id]);
  const attempts=await Promise.all(Array.from({length:30},()=>studies.startOrResumeAttempt(exam.id,student.id)));
  assert.equal(new Set(attempts.map(x=>x.id)).size,1);
  const a=attempts[0];
  const answers=await Promise.all(Array.from({length:10},()=>studies.submitAnswer(a.id,qs[0].id,'صح')));
  assert.equal(answers.filter(Boolean).length,1);
  assert.equal((await studies.startOrResumeAttempt(exam.id,student.id)).id,a.id);
  await assert.rejects(()=>studies.postponeExam(exam.id,'2030-01-02',1),{code:'ALREADY_TAKEN'});
  await assert.rejects(()=>studies.updateExam(exam.id,{title:'موضوع جديد',dateIso:'2030-01-02',hours:2}),{code:'ALREADY_TAKEN'});
  await assert.rejects(()=>studies.updateExamQuestion(qs[0].id,{type:'tf',prompt:'سؤال معدل',correct:'خطأ'}),{code:'ALREADY_TAKEN'});
  await assert.rejects(()=>studies.deleteExam(exam.id),{code:'ALREADY_TAKEN'});
  const other=await studies.createExam(subject.id,ss,teacher.id,{examNumber:2,dateIso:'2030-01-01',hours:2});
  const otherQ=await studies.addExamQuestion(other.id,{type:'tf',prompt:'سؤال لامتحان آخر',correct:'صح'});
  await assert.rejects(()=>studies.submitAnswer(a.id,otherQ.id,'صح'));
  await studies.submitAnswer(a.id,qs[1].id,'ب');
  const final=await Promise.all([studies.finalizeAttempt(a.id),studies.finalizeAttempt(a.id)]);
  assert.equal(Number(final[0].score),5);assert.equal(Number(final[1].score),5);
  await assert.rejects(()=>studies.submitAnswer(a.id,qs[1].id,'أ'),{code:'EXAM_CLOSED'});
  await assert.rejects(()=>studies.startOrResumeAttempt(exam.id,student.id),{code:'ALREADY_SUBMITTED'});
});
test('daily notification fanout is durable and deduplicated across simultaneous lesson posts',async()=>{
  const {queueDailyLessons}=require('../dailyNotifications');
  const options={stageId:stage.id,onDate:new Date().toISOString().slice(0,10),text:'دروس اليوم',extra:{},expiresAt:new Date(Date.now()+86400000)};
  await Promise.all([queueDailyLessons(db.pool,options),queueDailyLessons(db.pool,options)]);
  const rows=(await db.pool.query("SELECT chat_id,COUNT(*) AS n FROM notification_outbox WHERE dedupe_key LIKE 'daily:%' GROUP BY chat_id")).rows;
  assert.ok(rows.length>=1000);assert.ok(rows.every(r=>Number(r.n)===1));
});
test('CSV exports each actual attendance as its own row with date and time columns',async()=>{
  const data=require('../adminData').createAdminData(db,studies);let text='';
  for await(const chunk of data.attendanceCsv(ss,'discussions'))text+=chunk;
  assert.ok(text.startsWith('\uFEFF'));assert.match(text,/تاريخ تسجيل الحضور/);assert.match(text,/وقت تسجيل الحضور/);
  assert.ok(text.split('\r\n').length>1000);assert.match(text,/"start"/);assert.match(text,/"end"/);
});
test('Markdown export includes all attendance rows, Arabic phases and safe table cells',async()=>{
  const data=require('../adminData').createAdminData(db,studies);
  const original=(await db.getStudentById(student.id)).full_name;
  await db.updateStudentName(student.id,'طالب | <script>اختبار</script>\nاسم');
  try{
    let text='';for await(const part of data.attendanceMarkdown(ss,'discussions'))text+=part;
    assert.match(text,/^# تقرير حضور المباحثات/);assert.match(text,/تاريخ تسجيل الحضور/);assert.match(text,/وقت تسجيل الحضور/);
    assert.match(text,/\| البداية \|/);assert.match(text,/\| النهاية \|/);
    assert.ok(text.split('\n').length>1000);assert.ok(text.includes('طالب \\| &lt;script&gt;اختبار&lt;/script&gt; اسم'));assert.ok(!text.includes('<script>'));
    const count=Number((await db.pool.query(`SELECT COUNT(*) AS n FROM mubahatha_attendance a JOIN mubahatha_sessions s ON s.id=a.session_id JOIN mubahatha_groups g ON g.id=s.group_id WHERE g.stage_season_id=$1`,[ss])).rows[0].n);
    assert.ok(text.includes('**عدد تسجيلات الحضور:** '+count));
  }finally{await db.updateStudentName(student.id,original);}
});
test('absence snapshots: excused day excluded, late marking unchanged, 3 and 10 alerts independent',async()=>{
  const stage2=await db.addStage('مرحلة الغياب');const sub=await db.addSubject(stage2.id,'مادة الغياب','غياب');const season=(await db.listStageSeasons(stage2.id))[0].id;
  const a=await db.createStudent(90200,'طالب غياب أيام متتابعة',stage2.id);
  await db.pool.query("UPDATE enrollments SET started_at=now()-interval '40 days' WHERE student_id=$1",[a.id]);
  await db.pool.query("UPDATE absence_monitoring_config SET started_at=now()-interval '40 days' WHERE id=1");
  const lessons=(await db.pool.query(`INSERT INTO lessons(subject_id,stage_season_id,activated_at,active_until)
    SELECT $1,$2,(CURRENT_DATE-30+n)+time '08:00',(CURRENT_DATE-29+n)+time '08:00' FROM generate_series(1,11) n RETURNING *`,[sub.id,season])).rows;
  const leaveDay=new Date(lessons[4].activated_at).toISOString().slice(0,10);
  const leave=await db.requestLeave(a.id,leaveDay,1,null);await db.decideLeave(leave.id,true,1);
  await db.processCompletedAttendanceDays();
  const days=(await db.pool.query('SELECT * FROM student_attendance_days WHERE student_id=$1 ORDER BY attendance_date',[a.id])).rows;
  assert.equal(days.length,11);assert.equal(days[4].is_full_absence,false);assert.equal(days[4].is_excused_leave,true);
  assert.equal(days.at(-1).absence_streak,10);
  const three=(await db.getStudentAbsenceAlertCandidates()).find(x=>x.student_id===a.id);
  const ten=(await db.getAdminAbsenceAlertCandidates()).find(x=>x.student_id===a.id);
  assert.ok(three);assert.ok(ten);assert.ok(three.streak_start_date);
  await db.markStudentAbsenceAlertSent(three.attendance_day_id);
  assert.ok((await db.getAdminAbsenceAlertCandidates()).some(x=>x.student_id===a.id));
  assert.equal(await db.markAttendance(a.id,lessons[0].id),undefined,'expired lesson cannot be marked through bot data layer');
  await db.pool.query('INSERT INTO attendance(student_id,lesson_id,listened_at) VALUES($1,$2,now())',[a.id,lessons[0].id]);
  await db.processCompletedAttendanceDays();
  assert.equal((await db.pool.query('SELECT absence_streak FROM student_attendance_days WHERE id=$1',[days.at(-1).id])).rows[0].absence_streak,10);
  const lateLeave=await db.requestLeave(a.id,new Date(lessons[1].activated_at).toISOString().slice(0,10),1,null);
  await db.decideLeave(lateLeave.id,true,1);await db.processCompletedAttendanceDays();
  assert.equal((await db.pool.query('SELECT absence_streak FROM student_attendance_days WHERE id=$1',[days.at(-1).id])).rows[0].absence_streak,9);
});
test('outbox restart recovery, expiry and delivery markers are durable',async()=>{
  const {enqueueNotification,createOutboxWorker}=require('../outbox');
  await db.pool.query("UPDATE notification_outbox SET status='sent' WHERE status='pending'");
  await enqueueNotification(db.pool,{key:'test:recovery',chatId:123,text:'recovery'});
  await enqueueNotification(db.pool,{key:'test:expired',chatId:123,text:'expired',expiresAt:new Date(Date.now()-1000)});
  await db.pool.query("UPDATE notification_outbox SET status='sending',lease_until=now()-interval '1 minute' WHERE dedupe_key='test:recovery'");
  const sent=[];const queue={sendMessage:async(chat,text)=>{sent.push(text);},sendDocument:async()=>{},sendPhoto:async()=>{}};
  const worker=createOutboxWorker(db.pool,queue);await worker.tick();await worker.tick();worker.stop();
  assert.deepEqual(sent,['recovery']);
  const row=(await db.pool.query("SELECT status FROM notification_outbox WHERE dedupe_key='test:expired'")).rows[0];assert.equal(row.status,'expired');
});
test('sent attendance reminder is deleted after its attendance window',async()=>{
  const {enqueueNotification,createOutboxWorker}=require('../outbox');
  const key='lesson-reminder:test-expiry';
  await enqueueNotification(db.pool,{key,chatId:123,text:'تذكير الحضور',expiresAt:new Date(Date.now()+60000)});
  const queue={sendMessage:async()=>({message_id:456}),sendDocument:async()=>{},sendPhoto:async()=>{}};
  const removed=[];
  const worker=createOutboxWorker(db.pool,queue,async(chatId,messageId)=>removed.push([chatId,messageId]));
  await worker.tick();worker.stop();
  await db.pool.query("UPDATE notification_outbox SET expires_at=now()-interval '1 second' WHERE dedupe_key=$1",[key]);
  const cleanup=createOutboxWorker(db.pool,queue,async(chatId,messageId)=>removed.push([chatId,messageId]));
  await cleanup.tick();cleanup.stop();
  assert.deepEqual(removed,[[123,456]]);
  assert.ok((await db.pool.query('SELECT deleted_at FROM notification_outbox WHERE dedupe_key=$1',[key])).rows[0].deleted_at);
});
