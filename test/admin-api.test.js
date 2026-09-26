'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHmac}=require('node:crypto');
const {testDatabase}=require('./helpers.cjs');
const {createAdminServer}=require('../adminServer');
let db,studies,server,base,token,stage,subject,ss,teacher,student,group;
const botToken='12345:LOCAL_ONLY';
function signed(id=42){
  const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id,first_name:'إدارة اختبار'})});
  const secret=createHmac('sha256','WebAppData').update(botToken).digest();
  p.set('hash',createHmac('sha256',secret).update([...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));return p.toString();
}
async function request(route,body,method=body?'POST':'GET',auth=token,headers={}){
  return fetch(base+'/api/admin'+route,{method,headers:{...(auth?{Authorization:'Bearer '+auth}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
}
test.before(async()=>{
  ({db,studies}=await testDatabase());
  stage=await db.addStage('مرحلة الاختبار');subject=await db.addSubject(stage.id,'المنطق','منطق');ss=(await db.listStageSeasons(stage.id))[0].id;
  teacher=await db.addTeacher('أستاذ التجربة');await db.assignTeacherToSubject(teacher.id,subject.id);
  student=await db.createStudent(99001,'طالب اختبار واجهة الإدارة',stage.id);
  const adminData=require('../adminData').createAdminData(db,studies);
  const scheduler=require('../scheduler').createScheduler({pool:db.pool,studies});
  server=createAdminServer({db,studies,adminData,scheduler,botToken,adminIds:[42],origin:'https://institute.example'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
});
test.after(async()=>{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(db)await db.pool.end();});
test('admin HTTP: public shell contains no records; every data endpoint requires verified admin',async()=>{
  const shell=await fetch(base+'/admin/');assert.equal(shell.status,200);assert.match(shell.headers.get('content-security-policy'),/default-src 'none'/);
  const html=await shell.text();assert.match(html,/dir="rtl"/);assert.ok(!html.includes(student.full_name));
  for(const route of ['/lesson-attendance?stageId=1','/stages','/students','/leaves','/reports?seasonId=1','/attendance.csv?seasonId=1','/attendance.md?seasonId=1','/schedule-batch-import'])assert.equal((await request(route,null,'GET',null)).status,401);
  assert.equal((await request('/auth',{initData:signed(43)},'POST',null)).status,403);
  assert.equal((await request('/auth',{initData:signed().replace('42','45')},'POST',null)).status,401);
  const auth=await request('/auth',{initData:signed()},'POST',null);assert.equal(auth.status,200);token=(await auth.json()).token;
  assert.equal((await request('/stages',null,'GET',token,{Origin:'https://attacker.example'})).status,403);
});
test('admin HTTP: stages, search, pagination validation, optimistic edits and audit',async()=>{
  const stages=await (await request('/stages')).json();assert.equal(stages[0].id,stage.id);
  const list=await (await request('/students?stageId='+stage.id)).json();assert.equal(list.total,1);
  assert.equal((await request('/students?page=-1')).status,400);
  const name='طالب جديد اسم رباعي';
  assert.equal((await request('/students/'+student.id,{fullName:name,expectedName:student.full_name},'PATCH')).status,200);
  assert.equal((await request('/students/'+student.id,{fullName:'طالب آخر اسم رباعي',expectedName:student.full_name},'PATCH')).status,409);
  const audit=await (await request('/audit')).json();assert.equal(Number(audit[0].actor_id),42);assert.equal(audit[0].action,'update_student');
  const detail=await (await request('/students/'+student.id)).json();assert.ok(!('transfer_code' in detail));
});
test('admin HTTP: independent groups, teacher assignment, conflict rejection and non-destructive schedule removal',async()=>{
  let response=await request('/groups',{subjectId:subject.id,seasonId:ss,title:'الأولى',capacity:40});assert.equal(response.status,200);group=await response.json();
  assert.equal((await request('/groups',{subjectId:subject.id,seasonId:ss,title:'رابط سيئ',capacity:40,inviteLink:'javascript:alert(1)'})).status,400);
  assert.equal((await request('/students/'+student.id+'/group',{groupId:group.id})).status,200);
  const other=await db.addTeacher('أستاذ آخر');await request('/assignments',{teacherId:other.id,subjectId:subject.id});
  const detail=await (await request('/stages/'+stage.id)).json();assert.equal(detail.subjects.length,1);assert.equal(detail.subjects[0].teachers.length,2);
  response=await request('/schedule',{groupId:group.id,teacherId:teacher.id,dayOfWeek:6,hour:20,minute:40});assert.equal(response.status,200);const slot=(await response.json()).slot;
  const second=await studies.createMubahathaGroup(subject.id,ss,{title:'الثانية'});
  assert.equal((await request('/schedule',{groupId:second.id,teacherId:teacher.id,dayOfWeek:6,hour:21,minute:10})).status,409,'same-teacher overlap across groups');
  assert.equal((await request('/schedule/'+slot.id+'/remove',{})).status,200);
  assert.equal((await db.pool.query('SELECT is_active FROM schedule_slots WHERE id=$1',[slot.id])).rows[0].is_active,false);
});
test('admin HTTP: leave double decision, export date columns, archived access and restoration',async()=>{
  const today=new Date().toISOString().slice(0,10);const leave=await db.requestLeave(student.id,today,2,'اختبار');
  await require('../outbox').enqueueNotification(db.pool,{key:'daily:approval-race',chatId:student.telegram_id,text:'يجب إلغاؤه عند الموافقة'});
  const decisions=await Promise.all([request('/leaves/'+leave.id+'/decision',{approve:true}),request('/leaves/'+leave.id+'/decision',{approve:true})]);
  assert.deepEqual(decisions.map(r=>r.status).sort(),[200,409]);
  assert.equal((await db.pool.query("SELECT status FROM notification_outbox WHERE dedupe_key='daily:approval-race'")).rows[0].status,'expired');
  const activity=await (await request('/students/'+student.id)).json();assert.equal(activity.activity.approvedLeaveDays,2);
  const csv=await request('/attendance.csv?seasonId='+ss);assert.equal(csv.status,200);assert.match(await csv.text(),/تاريخ تسجيل الحضور/);
  const md=await request('/attendance.md?seasonId='+ss);assert.equal(md.status,200);assert.match(md.headers.get('content-type'),/text\/markdown/);assert.match(md.headers.get('content-disposition'),/\.md"$/);
  const markdown=await md.text();assert.match(markdown,/^# تقرير حضور الدروس/);assert.match(markdown,/تاريخ تسجيل الحضور/);assert.match(markdown,/لا توجد تسجيلات حضور/);
  assert.equal((await request('/students/'+student.id,{active:false},'PATCH')).status,200);
  assert.equal((await (await request('/students?status=active')).json()).total,0);
  assert.equal((await request('/students/'+student.id,{active:true},'PATCH')).status,200);
});
test('admin HTTP: group edits validate together and cannot reduce capacity below membership',async()=>{
  const extra=await db.createStudent(99907,'طالب فحص سعة مجموعة',stage.id);
  await studies.assignStudentToGroup(extra.id,subject.id,ss);
  const before=await studies.getGroupById(group.id);
  assert.equal((await request('/groups/'+group.id,{capacity:1},'PATCH')).status,400);
  assert.equal((await request('/groups/'+group.id,{capacity:70,inviteLink:'javascript:bad'},'PATCH')).status,400);
  assert.equal((await studies.getGroupById(group.id)).capacity,before.capacity);
  assert.equal((await request('/groups/'+group.id,{capacity:70,inviteLink:'https://t.me/test_group'},'PATCH')).status,200);
});
test('admin HTTP: attendance endpoint and season participation configuration require valid scoped values',async()=>{
  let response=await request('/lesson-attendance?stageId='+stage.id);assert.equal(response.status,200);
  const matrix=await response.json();assert.equal(matrix.subjects.length,1);assert.ok(matrix.rows.some(r=>r.id===student.id));
  assert.equal((await request('/lesson-attendance?stageId=bad')).status,400);
  const route='/stage-seasons/'+ss+'/participation-settings';
  assert.equal((await request(route,{grouped:true,enabledSubjectIds:[subject.id]},'PATCH',null)).status,401);
  assert.equal((await request(route,{grouped:'false',enabledSubjectIds:[subject.id]},'PATCH')).status,400);
  assert.equal((await request(route,{grouped:true,enabledSubjectIds:[]},'PATCH')).status,200);
  assert.equal((await (await request('/stages/'+stage.id)).json()).subjects[0].participation_enabled,false);
  assert.equal((await request(route,{grouped:true,enabledSubjectIds:[subject.id]},'PATCH')).status,200);
});
test('admin HTTP: exam editor, edits before attempts, postponement and logout',async()=>{
  const dateIso=new Date(Date.now()+86400000).toISOString().slice(0,10);
  const created=await request('/exams',{subjectId:subject.id,seasonId:ss,teacherId:teacher.id,examNumber:1,title:'امتحان تجريبي',dateIso,hours:24});
  assert.equal(created.status,200);const exam=await created.json();
  assert.equal((await request('/exams/'+exam.id+'/publish',{})).status,400);
  const added=await request('/exams/'+exam.id+'/question',{type:'tf',prompt:'هل العبارة صحيحة؟',correct:'صح'});assert.equal(added.status,200);const question=await added.json();
  assert.equal((await request('/exams/'+exam.id+'/publish',{})).status,200);
  assert.equal((await request('/exams/'+exam.id+'/publish',{})).status,409);
  assert.equal((await request('/questions/'+question.id+'/update',{type:'tf',prompt:'هل الجواب صحيح؟',correct:'خطأ'})).status,200);
  assert.equal((await request('/exams/'+exam.id+'/update',{title:'امتحان مصحح',dateIso,hours:12})).status,200);
  assert.equal((await request('/exams/'+exam.id+'/question',{type:'tf',prompt:'هل العبارة صحيحة؟',correct:'صح'})).status,200);
  assert.equal((await request('/questions/'+question.id+'/remove',{})).status,200);
  assert.equal((await request('/exams/'+exam.id+'/postpone',{dateIso})).status,200);
  assert.equal((await (await request('/exams/'+exam.id)).json()).questions.length,1);
  assert.equal((await request('/exams/'+exam.id+'/delete',{})).status,200);
  assert.equal((await request('/exams/'+exam.id)).status,404);
  assert.equal((await request('/logout',{})).status,200);assert.equal((await request('/students')).status,401);
});

test('admin HTTP: lesson deadline and independent ten-minute discussion recovery',async()=>{
 token=(await (await request('/auth',{initData:signed()},'POST',null)).json()).token;
 const l=await db.activateLesson(subject.id,1);
 let response=await request('/lessons/'+l.id+'/reopen',{hours:999});assert.equal(response.status,200);
 const reopened=await response.json();assert.equal(new Date(reopened.active_until)-new Date(reopened.activated_at),86400000);
 response=await request('/lesson-management?stageId='+stage.id+'&subjectId='+subject.id);assert.equal(response.status,200);assert.equal((await response.json()).total,1);
 response=await request('/lesson-attendance.md?stageId='+stage.id);assert.equal(response.status,200);
 assert.match(response.headers.get('content-type'),/text\/markdown/);assert.match(await response.text(),/إجمالي الحضور/);
 const session=await studies.openSession(group.id,teacher.id,'إدارة',1);
 response=await request('/sessions/'+session.id+'/reopen',{});assert.equal(response.status,200);
 const recovery=await response.json();assert.equal(new Date(recovery.attendance_reopen_until)-new Date(recovery.attendance_reopened_at),600000);
 assert.equal(new Date(recovery.closes_at).getTime(),session.closes_at.getTime());
 response=await request('/session-management?stageId='+stage.id);assert.equal(response.status,200);assert.equal((await response.json()).total,1);
 assert.equal((await request('/sessions/'+session.id+'/mark-all',{},'POST',null)).status,401);
 assert.equal((await request('/sessions/'+session.id+'/mark-all',{})).status,200);
 await db.pool.query("UPDATE mubahatha_sessions SET opened_at=now()-interval '25 hours' WHERE id=$1",[session.id]);
 response=await request('/sessions/'+session.id+'/reopen',{});assert.equal(response.status,200);
 assert.equal((await response.json()).attendance_reopen_until,recovery.attendance_reopen_until);
 assert.equal((await request('/sessions/'+session.id+'/cancel',{})).status,200);
 assert.equal((await request('/sessions/'+session.id+'/cancel',{})).status,404);
 await db.pool.query("UPDATE lessons SET activated_at=now()-interval '25 hours' WHERE id=$1",[l.id]);
 assert.equal((await request('/lessons/'+l.id+'/reopen',{})).status,409);
 assert.equal((await request('/lesson-attendance.md?stageId='+stage.id,null,'GET',null)).status,401);
});
test('teacher HTTP: reports submitted before assignment become readable and gradable after linking and activation',async()=>{
 const sub=await db.addSubject(stage.id,'تقارير قبل الإسناد','تقارير_قديمة');
 await studies.createMubahathaGroup(sub.id,ss,{title:'تقارير'});
 await studies.setParticipationMode(student.id,sub.id,ss,'report');await studies.assignStudentToGroup(student.id,sub.id,ss);
 const report=await studies.submitReport(student.id,sub.id,ss,{kind:'text',note:'هذا التقرير سبق إسناد الأستاذ'});assert.ok(report);
 const late=await db.addTeacher('الأستاذ المسند لاحقًا');await db.linkTeacherAccount(late.link_code,780001);
 async function teacherRequest(path,body,auth){return fetch(base+'/api/teacher'+path,{method:body?'POST':'GET',headers:{...(auth?{Authorization:'Bearer '+auth}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});}
 const auth=await teacherRequest('/auth',{initData:signed(780001)});assert.equal(auth.status,200);const key=(await auth.json()).token;
 const route=`/reports?studentId=${student.id}&subjectId=${sub.id}&seasonId=${ss}`;
 assert.equal((await teacherRequest(route,null,key)).status,403);
 await db.assignTeacherToSubject(late.id,sub.id);
 const visible=await teacherRequest(route,null,key);assert.equal(visible.status,200);assert.ok((await visible.json()).some(r=>r.id===report.id));
 const students=await teacherRequest(`/reports/students?subjectId=${sub.id}&seasonId=${ss}`,null,key);
 assert.ok((await students.json()).some(r=>r.student_id===student.id&&Number(r.report_count)===1));
 assert.equal((await teacherRequest('/reports/'+report.id+'/score',{score:12},key)).status,200);
  const pendingReport=await studies.submitReport(student.id,sub.id,ss,{kind:'text',note:'تقرير جديد بانتظار التقييم'});
  assert.equal((await teacherRequest('/reports/average',{studentId:student.id,subjectId:sub.id,seasonId:ss},key)).status,409);
  assert.equal((await teacherRequest('/reports/'+pendingReport.id+'/score',{score:12},key)).status,200);
  const summary=await teacherRequest(`/reports/summary?studentId=${student.id}&subjectId=${sub.id}&seasonId=${ss}`,null,key);
  assert.equal(summary.status,200);assert.equal(Number((await summary.json()).average),12);
  const average=await teacherRequest('/reports/average',{studentId:student.id,subjectId:sub.id,seasonId:ss},key);
  assert.equal(average.status,200);assert.equal(Number((await average.json()).average),12);
  const attendance=await teacherRequest(`/attendance?subjectId=${sub.id}&seasonId=${ss}`,null,key);
  assert.equal(attendance.status,200);assert.ok((await attendance.json()).some(r=>r.student_id===student.id&&r.group_id));
  const examResponse=await teacherRequest('/exams',{subjectId:sub.id,seasonId:ss,examNumber:1,title:'اختبار التقارير',dateIso:'2030-01-01',hours:24},key);
  assert.equal(examResponse.status,200);const teacherExam=await examResponse.json();
  const teacherQuestion=await (await teacherRequest(`/exams/${teacherExam.id}/questions`,{type:'tf',prompt:'سؤال تجريبي',correct:'صح'},key)).json();
  assert.equal((await teacherRequest(`/questions/${teacherQuestion.id}/update`,{type:'tf',prompt:'سؤال معدل',correct:'خطأ'},key)).status,200);
  assert.equal((await teacherRequest(`/exams/${teacherExam.id}/update`,{title:'اختبار معدل',dateIso:'2030-01-02',hours:12},key)).status,200);
  assert.equal((await teacherRequest(`/exams/${teacherExam.id}/delete`,{},key)).status,200);
 await db.setTeacherActive(late.id,false);assert.equal((await teacherRequest(route,null,key)).status,401);
 await db.setTeacherActive(late.id,true);
 const again=(await (await teacherRequest('/auth',{initData:signed(780001)})).json()).token;
 assert.equal((await teacherRequest(route,null,again)).status,200);
});

test('admin and teacher HTTP: cancelling exams requires ownership and queues notices',async()=>{
 const dateIso=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
 const exam=await studies.createExam(subject.id,ss,teacher.id,{examNumber:2,title:'امتحان للإلغاء',dateIso,hours:24});
 assert.equal((await request('/exams/'+exam.id+'/cancel',{reason:'تغيير البرنامج'},'POST',null)).status,401);
 const cancelled=await request('/exams/'+exam.id+'/cancel',{reason:'تغيير البرنامج'});
 assert.equal(cancelled.status,200);assert.ok((await cancelled.json()).recipientCount>=1);
 assert.equal((await request('/exams/'+exam.id+'/cancel',{})).status,409);
 assert.equal((await (await request('/exams/'+exam.id)).json()).status,'cancelled');
 assert.ok((await (await request('/audit')).json()).some(row=>row.action==='exam_cancel'&&Number(row.entity_id)===exam.id));
 const replacement=await studies.createExam(subject.id,ss,teacher.id,{examNumber:2,title:'امتحان بديل',dateIso,hours:24});
 await db.linkTeacherAccount(teacher.link_code,780002);
 async function teacherRequest(path,body,key){return fetch(base+'/api/teacher'+path,{method:body?'POST':'GET',headers:{...(key?{Authorization:'Bearer '+key}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});}
 const auth=await teacherRequest('/auth',{initData:signed(780002)});assert.equal(auth.status,200);
 const key=(await auth.json()).token;
 assert.equal((await teacherRequest('/exams/'+replacement.id+'/cancel',{reason:'سبب الأستاذ'},key)).status,200);
 assert.equal((await studies.getExamById(replacement.id)).status,'cancelled');
});

test('teacher dashboard shows the independent recovery window only while it is open',async()=>{
 const auth=await fetch(base+'/api/teacher/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:signed(780002)})});
 assert.equal(auth.status,200);const key=(await auth.json()).token;
 async function dashboard(){const r=await fetch(base+'/api/teacher/dashboard',{headers:{Authorization:'Bearer '+key}});assert.equal(r.status,200);return r.json();}
 const old=(await db.pool.query("INSERT INTO mubahatha_sessions(group_id,teacher_id,title,opened_at,closes_at,is_closed) VALUES($1,$2,'استعادة قديمة',now()-interval '2 days',now()-interval '47 hours',true) RETURNING *",[group.id,teacher.id])).rows[0];
 assert.ok(!(await dashboard()).activeSessions.some(s=>s.id===old.id));
 const response=await request('/sessions/'+old.id+'/reopen',{});assert.equal(response.status,200);const recovery=await response.json();
 const visible=(await dashboard()).activeSessions.find(s=>s.id===old.id);assert.ok(visible);
 assert.equal(visible.attendance_reopen_until,recovery.attendance_reopen_until);
 assert.equal(visible.opened_at,old.opened_at.toISOString());assert.equal(visible.closes_at,old.closes_at.toISOString());
 await db.pool.query('UPDATE mubahatha_sessions SET attendance_reopen_until=now() WHERE id=$1',[old.id]);
 assert.ok(!(await dashboard()).activeSessions.some(s=>s.id===old.id));
 await db.pool.query('UPDATE stage_seasons SET is_active=false WHERE id=$1',[ss]);
 try{assert.equal((await request('/sessions/'+old.id+'/reopen',{})).status,409);}
 finally{await db.pool.query('UPDATE stage_seasons SET is_active=true WHERE id=$1',[ss]);}
 const future=(await db.pool.query("INSERT INTO mubahatha_sessions(group_id,opened_at,closes_at) VALUES($1,now()+interval '1 hour',now()+interval '2 hours') RETURNING id",[group.id])).rows[0];
 assert.equal((await request('/sessions/'+future.id+'/reopen',{})).status,409);
});
