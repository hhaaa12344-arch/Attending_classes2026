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
  for(const route of ['/stages','/students','/leaves','/reports?seasonId=1','/attendance.csv?seasonId=1','/attendance.md?seasonId=1'])assert.equal((await request(route,null,'GET',null)).status,401);
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
test('admin HTTP: exam editor, protected publication, question immutability, postponement and logout',async()=>{
  const dateIso=new Date(Date.now()+86400000).toISOString().slice(0,10);
  const created=await request('/exams',{subjectId:subject.id,seasonId:ss,teacherId:teacher.id,examNumber:1,title:'امتحان تجريبي',dateIso,hours:24});
  assert.equal(created.status,200);const exam=await created.json();
  assert.equal((await request('/exams/'+exam.id+'/publish',{})).status,400);
  const added=await request('/exams/'+exam.id+'/question',{type:'tf',prompt:'هل العبارة صحيحة؟',correct:'صح'});assert.equal(added.status,200);const question=await added.json();
  assert.equal((await request('/exams/'+exam.id+'/publish',{})).status,200);
  assert.equal((await request('/exams/'+exam.id+'/publish',{})).status,409);
  assert.equal((await request('/questions/'+question.id+'/remove',{})).status,400);
  assert.equal((await request('/exams/'+exam.id+'/postpone',{dateIso})).status,200);
  assert.equal((await (await request('/exams/'+exam.id)).json()).questions.length,1);
  assert.equal((await request('/logout',{})).status,200);assert.equal((await request('/students')).status,401);
});
