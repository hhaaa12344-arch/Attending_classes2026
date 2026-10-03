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
  const expectedSettings={grouped:true,enabledSubjectIds:[subject.id]};
  assert.equal((await request(route,{grouped:'false',enabledSubjectIds:[subject.id],expectedSettings},'PATCH')).status,400);
  assert.equal((await request(route,{grouped:true,enabledSubjectIds:[],expectedSettings},'PATCH')).status,200);
  assert.equal((await (await request('/stages/'+stage.id)).json()).subjects[0].participation_enabled,false);
  assert.equal((await request(route,{grouped:true,enabledSubjectIds:[subject.id],expectedSettings:{grouped:true,enabledSubjectIds:[]}},'PATCH')).status,200);
});
test('admin HTTP: renaming a subject preserves identifiers, attendance, groups, schedule and exams; stale and foreign edits fail',async()=>{
  const sg=await db.addStage('مرحلة تعديل اسم المادة'),seasonId=(await db.listStageSeasons(sg.id))[0].id;
  const sub=await db.addSubject(sg.id,'اسم المادة القديم','هاشتاغ_ثابت'),other=await db.addSubject(sg.id,'مادة أخرى','مادة_أخرى');
  const st=await db.createStudent(99331,'طالب تعديل اسم المادة',sg.id);
  const g=await studies.createMubahathaGroup(sub.id,seasonId,{title:'الأولى'});
  await studies.setParticipationMode(st.id,sub.id,seasonId,'report');await studies.assignStudentToGroup(st.id,sub.id,seasonId);
  const report=await studies.submitReport(st.id,sub.id,seasonId,{kind:'text',note:'التقرير المحفوظ'});
  const l=await db.activateLesson(sub.id);await db.markAllPresentForLesson(l.id);
  const ex=await studies.createExam(sub.id,seasonId,null,{examNumber:1,dateIso:'2030-01-01',hours:2});
  await db.pool.query('INSERT INTO schedule_slots(group_id,subject_id,stage_season_id,day_of_week,hour) VALUES($1,$2,$3,0,19)',[g.id,sub.id,seasonId]);
  const snapshot=async()=>{
    const values={};for(const [table,field,value] of [['attendance','lesson_id',l.id],['group_memberships','subject_id',sub.id],['student_reports','id',report.id],['schedule_slots','subject_id',sub.id],['exams','id',ex.id]])values[table]=(await db.pool.query(`SELECT * FROM ${table} WHERE ${field}=$1 ORDER BY id`,[value])).rows;
    return values;
  };
  const before=await snapshot(),route='/subjects/'+sub.id,body={name:'اسم المادة الجديد',expectedName:sub.name,stageSeasonId:seasonId};
  assert.equal((await request(route,body,'PATCH',null)).status,401);
  assert.equal((await request(route,{...body,stageSeasonId:ss},'PATCH')).status,404);
  assert.equal((await request(route,{...body,name:' '},'PATCH')).status,400);
  assert.equal((await request(route,{...body,name:other.name},'PATCH')).status,409);
  const saved=await request(route,body,'PATCH');assert.equal(saved.status,200);const result=await saved.json();
  assert.equal(result.id,sub.id);assert.equal(result.name,body.name);assert.equal(result.hashtag,sub.hashtag);
  assert.deepEqual(await snapshot(),before);
  assert.equal((await request(route,{...body,name:'اسم قديم من شاشة ثانية'},'PATCH')).status,409);
  const entry=(await db.pool.query("SELECT * FROM admin_audit_log WHERE action='update_subject' AND entity_id=$1",[sub.id])).rows[0];
  assert.equal(entry.before_data.name,sub.name);assert.equal(entry.after_data.name,body.name);
  await db.pool.query('UPDATE stage_seasons SET is_active=false WHERE id=$1',[seasonId]);
  assert.equal((await request(route,{...body,expectedName:body.name},'PATCH')).status,409);
});
test('admin HTTP: participation changes require a reviewed snapshot and reject stale settings atomically',async()=>{
  const sg=await db.addStage('مرحلة حماية التقسيم'),seasonId=(await db.listStageSeasons(sg.id))[0].id;
  const sub=await db.addSubject(sg.id,'مادة حماية التقسيم','حماية_التقسيم');
  const route='/stage-seasons/'+seasonId+'/participation-settings',expectedSettings={grouped:true,enabledSubjectIds:[sub.id]};
  assert.equal((await request(route,{grouped:false,enabledSubjectIds:[sub.id]},'PATCH')).status,409);
  assert.equal((await request(route,{grouped:false,enabledSubjectIds:[sub.id],expectedSettings},'PATCH')).status,400);
  assert.equal((await request(route,{grouped:true,enabledSubjectIds:[],expectedSettings},'PATCH')).status,200);
  assert.equal((await request(route,{grouped:false,enabledSubjectIds:[sub.id],expectedSettings,confirmGroupingChange:true},'PATCH')).status,409);
  const current=await (await request('/stages/'+sg.id)).json();assert.equal(current.discussion_grouping,true);assert.equal(current.subjects[0].participation_enabled,false);assert.equal(current.groups.length,0);
  assert.equal((await request(route,{grouped:false,enabledSubjectIds:[sub.id],expectedSettings:{grouped:true,enabledSubjectIds:[]},confirmGroupingChange:true},'PATCH')).status,200);
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

test('discussion notification diagnostics and retries require an admin and preserve the original window',async()=>{
 const s=await studies.openSession(group.id,teacher.id,'حالة الإشعارات',1);
 const opened=await (await request('/sessions/'+s.id+'/reopen',{})).json();
 assert.equal((await request('/sessions/'+s.id+'/notifications',null,'GET',null)).status,401);
 assert.equal((await request('/sessions/'+s.id+'/retry-notifications',{},'POST',null)).status,401);
 let r=await request('/sessions/'+s.id+'/notifications');assert.equal(r.status,200);
 assert.equal((await r.json()).sessionId,s.id);
 r=await request('/sessions/'+s.id+'/retry-notifications',{});assert.equal(r.status,200);
 assert.equal((await r.json()).attendance_reopen_until,opened.attendance_reopen_until);
 assert.equal((await request('/sessions/9999999/notifications')).status,404);
 await db.pool.query('UPDATE mubahatha_sessions SET attendance_reopen_until=now() WHERE id=$1',[s.id]);
 assert.equal((await request('/sessions/'+s.id+'/retry-notifications',{})).status,409);
});

test('HTTP keeps pending-lesson restoration and selected discussion attendance behind distinct admin routes',async()=>{
 const sub=await db.addSubject(stage.id,'اختبار الاسترجاع والتحضير','recover_http');
 const g=await studies.createMubahathaGroup(sub.id,ss,{title:'مجموعة طلبة محددين'});
 await studies.setParticipationMode(student.id,sub.id,ss,'mubahatha');await studies.assignStudentToGroup(student.id,sub.id,ss);
 await db.pool.query("UPDATE group_memberships SET assigned_at=now()-interval '1 hour' WHERE student_id=$1 AND group_id=$2",[student.id,g.id]);
 await db.pool.query("UPDATE participation_modes SET joined_mubahatha_at=now()-interval '1 hour' WHERE student_id=$1 AND subject_id=$2",[student.id,sub.id]);
 const session=await studies.openSession(g.id,teacher.id,'اختبار التحضير',1),body={subjectId:sub.id,studentIds:[student.id],note:'حضور إداري'};
 assert.equal((await request('/sessions/'+session.id+'/admin-options',null,'GET',null)).status,401);
 assert.equal((await request('/sessions/'+session.id+'/selected-attendance',body,'POST',null)).status,401);
 assert.equal((await (await request('/sessions/'+session.id+'/admin-options')).json()).total,1);
 const marked=await request('/sessions/'+session.id+'/selected-attendance',body);assert.equal(marked.status,200);assert.equal((await marked.json()).records,2);
 assert.equal((await request('/sessions/'+session.id+'/selected-attendance',{...body,subjectId:subject.id})).status,409);
 const chat=-100777888999;await db.linkChannel(stage.id,chat,'قناة استرجاع اختبار');
 const p=await db.queuePendingChannelLessonPost({chatId:chat,messageId:10,stageId:stage.id,stageSeasonId:ss,lessonDate:'2026-01-01',receivedAt:new Date('2026-01-01T12:00:00Z')});
 assert.equal((await request('/pending-lessons/'+p.id+'/restore',{subjectId:sub.id},'POST',null)).status,401);
 const restored=await request('/pending-lessons/'+p.id+'/restore',{subjectId:sub.id});assert.equal(restored.status,200);
 const result=await restored.json();assert.equal(result.created,true);assert.equal(new Date(result.lesson.active_until)-new Date(result.lesson.attendance_opened_at),86400000);
 assert.equal((await (await request('/pending-lessons/'+p.id+'/restore',{subjectId:sub.id})).json()).created,false);
});

test('admin HTTP: republishing an expired lesson is admin-only, guarded by subject and idempotent',async()=>{
 const l=await db.activateLesson(subject.id,24,'manual',null,null,null,new Date(Date.now()-3*86400000));
 const body={expectedSubjectId:subject.id};
 assert.equal((await request('/lessons/'+l.id+'/republish',body,'POST',null)).status,401);
 const response=await request('/lessons/'+l.id+'/republish',body);assert.equal(response.status,200);
 const result=await response.json();assert.equal(result.created,true);
 assert.equal(new Date(result.lesson.active_until)-new Date(result.lesson.republished_at),86400000);
 assert.equal((await (await request('/lessons/'+l.id+'/republish',body)).json()).created,false);
 assert.equal((await request('/lessons/'+l.id+'/republish',{expectedSubjectId:999999})).status,409);
});

test('admin HTTP: historical publication repair is private and refuses an unrelated stage',async()=>{
 assert.equal((await request('/lesson-publication-repair?stageId='+stage.id,null,'GET',null)).status,401);
 assert.equal((await request('/lesson-publication-repair',{stageId:stage.id,token:'x'},'POST',null)).status,401);
 assert.equal((await request('/lesson-publication-repair?stageId='+stage.id)).status,404);
});
test('admin HTTP: grouping impact preview is admin-only, validates its input and changes nothing',async()=>{
  const sg=await db.addStage('مرحلة معاينة الأثر'),seasonId=(await db.listStageSeasons(sg.id))[0].id;
  await db.addSubject(sg.id,'مادة المعاينة','معاينة_م');
  const route='/stage-seasons/'+seasonId+'/grouping-impact';
  assert.equal((await request(route+'?grouped=false',null,'GET',null)).status,401);
  assert.equal((await request(route)).status,400);
  assert.equal((await request(route+'?grouped=maybe')).status,400);
  assert.equal((await request('/stage-seasons/99999999/grouping-impact?grouped=false')).status,404);
  const same=await (await request(route+'?grouped=true')).json();assert.equal(same.changing,false);
  const preview=await request(route+'?grouped=false');assert.equal(preview.status,200);
  const body=await preview.json();
  assert.deepEqual([body.changing,body.blocked,body.groupsToMerge,body.membershipsToMove,body.slotsToPause],[true,null,0,0,0]);
  assert.equal((await (await request('/stages/'+sg.id)).json()).discussion_grouping,true,'previewing never changes the stage');
});
