'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHmac}=require('node:crypto');
const {testDatabase}=require('./helpers.cjs');
let db,studies,student,stage,ss,a,b,teacher,ga,gb,server,base,adminToken,teacherToken;
const botToken='12345:LOCAL_ONLY';
function signed(id){
  const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id,first_name:'اختبار'})});
  const secret=createHmac('sha256','WebAppData').update(botToken).digest();
  p.set('hash',createHmac('sha256',secret).update([...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));
  return p.toString();
}
async function request(role,path,body,token=role==='admin'?adminToken:teacherToken,method=body?'POST':'GET'){
  return fetch(base+'/api/'+role+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
}
const change=(sub,mode,expectedMode)=>request('admin',`/students/${student.id}/subjects/${sub.id}/participation`,{seasonId:ss,mode,expectedMode},adminToken,'PATCH');
test.before(async()=>{
  ({db,studies}=await testDatabase());
  stage=await db.addStage('مرحلة المتابعة المختلطة');ss=(await db.listStageSeasons(stage.id))[0].id;
  a=await db.addSubject(stage.id,'مادة A','a');b=await db.addSubject(stage.id,'مادة B','b');
  teacher=await db.addTeacher('أستاذ المادتين');await db.linkTeacherAccount(teacher.link_code,99002);
  await db.assignTeacherToSubject(teacher.id,a.id);await db.assignTeacherToSubject(teacher.id,b.id);
  ga=await studies.createMubahathaGroup(a.id,ss,{title:'مجموعة A'});gb=await studies.createMubahathaGroup(b.id,ss,{title:'مجموعة B'});
  student=await db.createStudent(99001,'طالب متابعة مادة مستقلة',stage.id);
  await studies.setParticipationMode(student.id,a.id,ss,'report');await studies.setParticipationMode(student.id,b.id,ss,'mubahatha');
  await studies.assignStudentToGroup(student.id,a.id,ss);await studies.assignStudentToGroup(student.id,b.id,ss);
  for(const [group,subject,hour] of [[ga,a,18],[gb,b,20]])await db.pool.query(`INSERT INTO schedule_slots(group_id,subject_id,stage_season_id,teacher_id,day_of_week,hour) VALUES($1,$2,$3,$4,1,$5)`,[group.id,subject.id,ss,teacher.id,hour]);
  const adminData=require('../adminData').createAdminData(db,studies);
  server=require('../adminServer').createAdminServer({db,studies,adminData,scheduler:require('../scheduler').createScheduler({pool:db.pool,studies}),botToken,adminIds:[42],origin:'https://institute.example'});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
  adminToken=(await (await request('admin','/auth',{initData:signed(42)},null)).json()).token;
  teacherToken=(await (await request('teacher','/auth',{initData:signed(99002)},null)).json()).token;
});
test.after(async()=>{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(db)await db.pool.end();});

test('mixed subjects appear together; schedules and teacher lists use the subject choice',async()=>{
  const subjects=await studies.listStudentSubjects(student.id);
  assert.deepEqual(subjects.map(s=>[s.subject_id,s.mode]),[[a.id,'report'],[b.id,'mubahatha']]);
  assert.deepEqual((await studies.listStudentSlots(student.id)).map(s=>s.subject_id),[b.id]);
  assert.equal((await studies.listGroupStudents(ga.id)).length,0);assert.equal((await studies.listGroupStudents(gb.id)).length,1);
  const detail=await (await request('admin','/students/'+student.id)).json();assert.equal(detail.subjects.length,2);
  const list=async(sub)=>(await (await request('teacher',`/reports/students?subjectId=${sub.id}&seasonId=${ss}`)).json());
  assert.equal((await list(a))[0].student_id,student.id);assert.equal((await list(b)).length,0);
  for(const [sub,mode] of [[a,'report'],[b,'mubahatha']]){
    const r=await request('teacher',`/attendance?subjectId=${sub.id}&seasonId=${ss}`);
    assert.equal(r.status,200);assert.equal((await r.json())[0].mode,mode);
  }
});

test('switching A preserves B, reports, lesson attendance, and closed discussion periods through a round trip',async()=>{
  const bBefore=await studies.getParticipationMode(student.id,b.id,ss);
  const report=await studies.submitReport(student.id,a.id,ss,{kind:'text',note:'تقرير تاريخي'});
  const lesson=await db.activateLesson(a.id,24);
  await db.pool.query('INSERT INTO attendance(lesson_id,student_id) VALUES($1,$2)',[lesson.id,student.id]);
  assert.equal((await change(a,'mubahatha','report')).status,200);
  assert.equal(await studies.submitReport(student.id,a.id,ss,{kind:'text',note:'زر قديم'}),undefined);
  const session=await studies.openSession(ga.id,teacher.id,'مباحثة قبل التبديل',1);
  const otherSession=await studies.openSession(gb.id,teacher.id,'مباحثة المادة الثانية',1);
  const enqueue=require('../outbox').enqueueNotification;
  for(const s of [session,otherSession])await enqueue(db.pool,{key:`session:${s.id}:start:${student.telegram_id}`,chatId:student.telegram_id,text:'حضور المباحثة'});
  await db.pool.query("INSERT INTO mubahatha_attendance(session_id,student_id,phase) VALUES($1,$2,'start'),($1,$2,'end')",[session.id,student.id]);
  assert.equal((await change(a,'report','mubahatha')).status,200);
  const notices=(await db.pool.query("SELECT status FROM notification_outbox WHERE chat_id=$1 AND dedupe_key LIKE 'session:%' ORDER BY id",[student.telegram_id])).rows;
  assert.deepEqual(notices.map(r=>r.status),['expired','pending']);
  assert.equal(await studies.markSessionAttendance(session.id,student.id),undefined);
  const gap=await studies.openSession(ga.id,teacher.id,'جلسة أثناء التقارير',1);
  assert.equal((await change(a,'mubahatha','report')).status,200);
  const rows=await db.pool.query(`SELECT id,was_in_mubahatha($1,$2,$3,opened_at) AS eligible FROM mubahatha_sessions WHERE id=ANY($4::int[]) ORDER BY id`,[student.id,a.id,ss,[session.id,gap.id]]);
  assert.deepEqual(rows.rows.map(r=>r.eligible),[true,false]);
  const grade=(await studies.computeSeasonGrades(a.id,ss))[0];assert.equal(grade.eligibleSessions,1);assert.equal(grade.attendedSessions,1);
  assert.deepEqual(await studies.getParticipationMode(student.id,b.id,ss),bBefore);
  assert.equal((await studies.listStudentReports(student.id,a.id,ss))[0].id,report.id);
  assert.equal((await db.pool.query('SELECT * FROM attendance WHERE student_id=$1',[student.id])).rowCount,1);
  assert.equal((await db.pool.query('SELECT * FROM mubahatha_attendance WHERE student_id=$1',[student.id])).rowCount,2);
  const audit=(await db.pool.query("SELECT * FROM admin_audit_log WHERE action='change_participation_mode' ORDER BY id")).rows;
  assert.equal(audit.length,3);assert.ok(audit.every(r=>Number(r.actor_id)===42&&r.after_data.subject_id===a.id));
  const reports=await (await request('teacher',`/reports/students?subjectId=${a.id}&seasonId=${ss}`)).json();
  assert.equal(reports[0].mode,'mubahatha');assert.equal(Number(reports[0].report_count),1);
});

test('stale edits, unauthorized users, unrelated subjects and disabled participation are rejected',async()=>{
  assert.equal((await change(a,'report','report')).status,409);
  assert.equal((await change(a,'invalid','mubahatha')).status,400);
  const route=`/students/${student.id}/subjects/${a.id}/participation`,body={seasonId:ss,mode:'report',expectedMode:'mubahatha'};
  assert.equal((await request('admin',route,body,null,'PATCH')).status,401);
  assert.equal((await request('admin',route,body,teacherToken,'PATCH')).status,401);
  const other=await db.addStage('مرحلة أخرى'),sub=await db.addSubject(other.id,'خارج المرحلة','outside');
  assert.equal((await change(sub,'report',null)).status,409);
  const results=await Promise.all([change(a,'report','mubahatha'),change(a,'report','mubahatha')]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  await db.pool.query("UPDATE mubahatha_sessions SET is_closed=true,closes_at=now()-interval '1 second',end_closes_at=now()-interval '1 second' WHERE group_id=$1",[ga.id]);
  await require('../participationSettings').createParticipationSettings(db.pool).save(ss,{grouped:true,enabledSubjectIds:[b.id]},42);
  assert.equal((await change(a,'mubahatha','report')).status,409);
  const details=await (await request('admin','/students/'+student.id)).json();
  assert.equal(details.subjects.find(s=>s.subject_id===a.id).participation_enabled,false);
});

test('repeatable migration keeps legacy choices, history, and undecided subjects without guessing a global mode',async()=>{
  const legacy=await db.createStudent(99009,'طالب بيانات قديمة محفوظة',stage.id);
  await db.pool.query(`INSERT INTO participation_modes(student_id,subject_id,stage_season_id,mode,chosen_at,joined_mubahatha_at)
    VALUES($1,$2,$3,'mubahatha',now()-interval '2 days',now()-interval '2 days')`,[legacy.id,b.id,ss]);
  const undecided=await db.addSubject(stage.id,'مادة بلا اختيار','undecided');
  const before=(await db.pool.query('SELECT * FROM participation_modes ORDER BY id')).rows;
  const history=(await db.pool.query('SELECT * FROM participation_mode_history ORDER BY id')).rows;
  await studies.initStudiesSchema();await studies.initStudiesSchema();
  assert.deepEqual((await db.pool.query('SELECT * FROM participation_modes ORDER BY id')).rows,before);
  assert.deepEqual((await db.pool.query('SELECT * FROM participation_mode_history ORDER BY id')).rows,history);
  assert.equal((await db.pool.query("SELECT was_in_mubahatha($1,$2,$3,(now()-interval '1 day')::timestamp) AS eligible",[legacy.id,b.id,ss])).rows[0].eligible,true);
  const subjects=await studies.listStudentSubjects(student.id,{includeDisabled:true});
  assert.equal(subjects.find(s=>s.subject_id===undecided.id).mode,null);
  assert.equal((await change(undecided,'report',null)).status,200);
});
