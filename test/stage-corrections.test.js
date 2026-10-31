'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
process.env.BOT_TOKEN='12345:OFFLINE_TEST_ONLY';process.env.DATABASE_URL='postgresql://localhost/attendance_test_unused';process.env.ADMIN_IDS='42';
const {Telegram}=require('telegraf');const original=Telegram.prototype.callApi;
let messages=[],seq=100,db,studies,service,app,oldStage,newStage,student,worker;
Telegram.prototype.callApi=async function(method,payload){messages.push({method,...payload});return {message_id:seq++,chat:{id:payload.chat_id,type:'private'},text:payload.text};};
test.before(async()=>{
  ({db,studies}=await require('./helpers.cjs').testDatabase());
  await require('../backups').initBackupSchema(db.pool);await require('../studentGuide').initStudentGuideSchema(db.pool);
  await require('../instituteLinks').createInstituteLinks(db.pool).initSchema();
  service=require('../stageCorrections').createStageCorrections(db);await service.initSchema();
  oldStage=await db.addStage('المرحلة الأولى');newStage=await db.addStage('المرحلة الثانية');
  student=await db.createStudent(991811,'طالب طلب تصحيح تجريبي',oldStage.id);
  await db.pool.query('UPDATE students SET official_confirmed_at=now() WHERE id=$1',[student.id]);
  const outbox=require('../outbox'),factory=outbox.createOutboxWorker;
  outbox.createOutboxWorker=(...args)=>(worker=factory(...args));
  try{app=require('../index');}finally{outbox.createOutboxWorker=factory;}
  app.bot.botInfo={id:12345,is_bot:true,username:'TestBot',first_name:'test'};
});
test.after(async()=>{worker?.stop();for(let i=0;i<400&&worker?.isRunning();i++)await new Promise(r=>setTimeout(r,10));assert.ok(!worker?.isRunning());Telegram.prototype.callApi=original;await db.pool.end();});
async function send(id,text='',data=null){
  messages=[];const from={id:Number(id),is_bot:false,first_name:'test'};
  const message={message_id:seq++,date:Math.floor(Date.now()/1000),from,chat:{id:Number(id),type:'private'},text};
  await app.bot.handleUpdate(data?{update_id:seq++,callback_query:{id:'cb'+seq,from,data,message}}:{update_id:seq++,message});
}
test('renamed student menus route to the student schedule and channel screen exposes correction',async()=>{
  await send(student.telegram_id,'↩️ رجوع');
  assert.ok(messages.some(m=>m.reply_markup?.keyboard?.flat().some(b=>b.text==='🗂️ المباحثات والتقارير')));
  await send(student.telegram_id,'🗂️ المباحثات والتقارير');
  assert.ok(messages.some(m=>m.reply_markup?.keyboard?.flat().some(b=>b.text==='🗓️ جدول المباحثات')));
  await send(student.telegram_id,'🗓️ جدول المباحثات');assert.ok(messages.some(m=>m.text?.includes('لا توجد مواعيد مباحثات في جدولك')));
  assert.ok(!messages.some(m=>m.text?.includes('متاحة للأساتذة')));
  await send(student.telegram_id,'🔗 روابط المعهد');assert.ok(messages.some(m=>m.reply_markup?.inline_keyboard?.flat().some(b=>b.text==='📡 قناتي الدراسية')));
  await send(student.telegram_id,'','il_view:channels:0');assert.ok(messages.some(m=>m.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='stage_fix_start')));
});
test('student chooses a stage and must send a reason; only an admin can approve',async()=>{
  await send(student.telegram_id,'','stage_fix_start');
  await send(student.telegram_id,'',`stage_fix_choose:${newStage.id}`);
  assert.equal(await service.pending(student.id),undefined);
  assert.equal((await db.getStudentById(student.id)).stage_id,oldStage.id);
  await send(student.telegram_id,'اخترت المرحلة الأولى بالخطأ');
  const r=await service.pending(student.id);assert.ok(r);assert.equal(r.reason,'اخترت المرحلة الأولى بالخطأ');
  assert.equal((await db.getStudentById(student.id)).stage_id,oldStage.id);
  const notices=(await db.pool.query('SELECT * FROM notification_outbox WHERE dedupe_key=$1',[`stage-correction:${r.id}:admin:42`])).rows;
  assert.equal(notices.length,1);assert.match(notices[0].payload[0],/اخترت المرحلة الأولى بالخطأ/);
  assert.equal(notices[0].payload[1].reply_markup.inline_keyboard[0][0].callback_data,`stage_fix_approve:${r.id}`);
  await send(student.telegram_id,'',`stage_fix_approve:${r.id}`);
  assert.equal((await db.getStudentById(student.id)).stage_id,oldStage.id);
  await send(42,'',`stage_fix_approve:${r.id}`);
  assert.equal((await db.getStudentById(student.id)).stage_id,newStage.id);
  await send(42,'',`stage_fix_approve:${r.id}`);
  assert.equal((await db.pool.query("SELECT * FROM admin_audit_log WHERE action='stage_correction_approved' AND entity_id=$1",[student.id])).rows.length,1);
});
test('requests survive schema reinitialization; rejection and stale approvals cannot move a student',async()=>{
  const r=await service.submit(student.id,oldStage.id,newStage.id,'تصحيح اختبار الرفض',[42]);
  await service.initSchema();assert.equal((await service.pending(student.id)).id,r.id);
  await service.decide(r.id,false,42);assert.equal((await db.getStudentById(student.id)).stage_id,newStage.id);
  const second=await service.submit(student.id,oldStage.id,newStage.id,'طلب سبق تغييره إداريًا',[42]);
  await db.updateStudentStage(student.id,oldStage.id);
  const result=await service.decide(second.id,true,42);assert.equal(result.status,'stale');
  assert.equal((await db.getStudentById(student.id)).stage_id,oldStage.id);
  await assert.rejects(service.submit(student.id,oldStage.id,oldStage.id,'نفس المرحلة',[42]));
  await assert.rejects(service.submit(student.id,newStage.id,oldStage.id,'   ',[42]));
});
test('approval preserves lesson, discussion and report history and duplicate submissions have one pending request',async()=>{
  const ss=(await db.listStageSeasons(oldStage.id))[0].id,sub=await db.addSubject(oldStage.id,'مادة قديمة','old');
  const group=await studies.createMubahathaGroup(sub.id,ss,{title:'مجموعة قديمة'});
  await studies.setParticipationMode(student.id,sub.id,ss,'mubahatha');await studies.assignStudentToGroup(student.id,sub.id,ss);
  const lesson=await db.activateLesson(sub.id,24),session=await studies.openSession(group.id,null,'تاريخ محفوظ',1);
  await db.pool.query('INSERT INTO attendance(student_id,lesson_id) VALUES($1,$2)',[student.id,lesson.id]);
  await db.pool.query("INSERT INTO mubahatha_attendance(student_id,session_id,phase) VALUES($1,$2,'start')",[student.id,session.id]);
  await db.pool.query("INSERT INTO student_reports(student_id,subject_id,stage_season_id,note) VALUES($1,$2,$3,'تقرير محفوظ')",[student.id,sub.id,ss]);
  const before={};for(const t of ['attendance','mubahatha_attendance','student_reports'])before[t]=(await db.pool.query(`SELECT * FROM ${t} WHERE student_id=$1 ORDER BY id`,[student.id])).rows;
  const [a,b]=await Promise.all([service.submit(student.id,newStage.id,oldStage.id,'تصحيح نهائي',[42]),service.submit(student.id,newStage.id,oldStage.id,'تصحيح نهائي',[42])]);assert.equal(a.id,b.id);
  const decisions=await Promise.all([service.decide(a.id,true,42),service.decide(a.id,true,42)]);assert.equal(decisions.filter(x=>x.alreadyDecided).length,1);
  assert.equal((await db.getStudentById(student.id)).stage_id,newStage.id);
  for(const t of Object.keys(before))assert.deepEqual((await db.pool.query(`SELECT * FROM ${t} WHERE student_id=$1 ORDER BY id`,[student.id])).rows,before[t]);
  assert.equal((await db.pool.query('SELECT * FROM group_memberships WHERE student_id=$1',[student.id])).rows.length,0);
});


test('teacher renamed buttons still select teacher subjects, attendance and schedule',async()=>{
 const teacher=await db.addTeacher('أستاذ التسميات الجديدة');await db.linkTeacherAccount(teacher.link_code,991899);
 const subject=await db.addSubject(newStage.id,'مادة أستاذ التسميات','teacher_labels');await db.assignTeacherToSubject(teacher.id,subject.id);
 await send(991899,'↩️ رجوع');
 const keys=messages.flatMap(m=>m.reply_markup?.keyboard?.flat().map(b=>b.text)||[]);
 assert.ok(keys.includes('📚 المواد الدراسية'));assert.ok(keys.includes('📊 حضور المباحثات'));
 assert.ok(!keys.includes('📚 موادي'));assert.ok(!keys.includes('📊 حضور موادي'));
 await send(991899,'📚 المواد الدراسية');assert.ok(messages.some(m=>m.text?.includes('مادة أستاذ التسميات')));
 await send(991899,'📊 حضور المباحثات');assert.ok(messages.some(m=>m.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data?.startsWith('teacher_att:'))));
 await send(991899,'🗓️ جدول المباحثات');assert.ok(messages.some(m=>m.text?.includes('لا توجد مواعيد مباحثات نشطة')));
});
