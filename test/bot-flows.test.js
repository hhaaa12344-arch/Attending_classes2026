'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
process.env.BOT_TOKEN='12345:OFFLINE_TEST_ONLY';process.env.DATABASE_URL='postgresql://localhost/attendance_test_unused';process.env.ADMIN_IDS='42';
const {Telegram}=require('telegraf');
const messages=[];let messageId=100;
const original=Telegram.prototype.callApi;
Telegram.prototype.callApi=async function(method,payload){messages.push({method,...payload});if(method==='getMe')return {id:12345,is_bot:true,username:'AttendanceTestBot',first_name:'test'};if(method==='getChat')return {id:payload.chat_id,type:'channel',title:'قناة اختبار'};return {message_id:messageId++,chat:{id:payload.chat_id,type:'private'},text:payload.text};};
const {testDatabase}=require('./helpers.cjs');
let db,studies,app,stage,student,ss,subject;
test.before(async()=>{
  ({db,studies}=await testDatabase());await require('../backups').initBackupSchema(db.pool);await require('../studentGuide').initStudentGuideSchema(db.pool);stage=await db.addStage('المرحلة التمهيدية');ss=(await db.listStageSeasons(stage.id))[0].id;subject=await db.addSubject(stage.id,'الفقه','فقه');
  student=await db.createStudent(90000,'طالب حقيقي أول ثاني',stage.id);app=require('../index');
  app.bot.botInfo={id:12345,is_bot:true,username:'AttendanceTestBot',first_name:'test'};
});
test.after(async()=>{Telegram.prototype.callApi=original;if(db)await db.pool.end();});
test('student lesson schedule advances from Thursday and Friday to the immediate Saturday',()=>{
  assert.deepEqual(app.studentScheduleWindow('2026-09-24'),{startDate:'2026-09-26',endDate:'2026-09-30',label:'الأسبوع القادم'});
  assert.deepEqual(app.studentScheduleWindow('2026-09-25'),{startDate:'2026-09-26',endDate:'2026-09-30',label:'الأسبوع القادم'});
});
async function send(id,text,data){messages.length=0;const from={id,is_bot:false,first_name:'test'};const message={message_id:messageId++,date:Math.floor(Date.now()/1000),from,chat:{id,type:'private'},text,...(text&&text.startsWith('/')?{entities:[{offset:0,length:text.split(/\s/)[0].length,type:'bot_command'}]}:{})};
  await app.bot.handleUpdate(data?{update_id:messageId,callback_query:{id:'cb'+messageId,from,data,message}}:{update_id:messageId,message});return messages;
}
test('bot: /start guide has a text fallback and gates registration behind its button',async()=>{
  await send(77777,'/start');
  const screen=messages.find(m=>m.method==='sendMessage'&&m.text?.includes('دليل الطالب'));
  assert.ok(screen,'shows a usable guide before photos are uploaded');
  assert.ok(screen.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='guide:begin'));
  assert.ok(!messages.some(m=>m.photo?.source),'never reads a missing local onboarding image');
  await send(77777,'محمد علي حسن جعفر');
  assert.ok(messages.some(m=>m.text?.includes('اضغط زر')),'typing before pressing the button only nudges, does not register');
  assert.equal(await db.getStudentByTelegramId(77777),undefined);
  await send(77777,'','onboarding_ack');
  assert.ok(messages.some(m=>m.text?.includes('أرسل اسمك الرباعي في رسالة واحدة')&&m.text.includes('للأستاذ:')&&m.text.includes('حساب تليجرام جديدًا')));
  await send(77777,'محمد علي حسن جعفر');
  assert.ok(messages.some(m=>m.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data?.startsWith('reg_stage:'))),'name is accepted only after the button, then registration proceeds as before');
});
test('bot: student management starts with stages, stage contents and students without requiring search',async()=>{
  await send(42,'🎓 إدارة الطلبة');assert.ok(messages.some(m=>m.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='students_stage:'+stage.id)));
  await send(42,'',`students_stage:${stage.id}`);assert.ok(messages.some(m=>m.text?.includes('المرحلة التمهيدية')));
  await send(42,'',`students_page:${stage.id}:0`);assert.ok(messages.some(m=>m.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='stu_select:'+student.id)));
});
test('bot: first-use confirmation required, marking disappears and today retains reply keyboard',async()=>{
  await send(90000,'📚 دروس اليوم');assert.ok(messages.some(m=>m.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='confirm_official_student')));
  await send(90000,'','confirm_official_student');assert.ok((await db.getStudentById(student.id)).official_confirmed_at);
  const menu=messages.find(m=>m.reply_markup?.keyboard);assert.ok(menu,'confirmation supplies persistent main keyboard');
  const keys=menu.reply_markup.keyboard.flat().map(b=>b.text);assert.ok(keys.includes('📊 تقرير الحضور'));assert.ok(keys.includes('📖 المباحثات والتقارير'));assert.ok(!keys.includes('📊 تقريري'));
  const saved=await db.pool.query("SELECT message_id FROM student_ui_messages WHERE student_id=$1 AND message_kind='menu'",[student.id]);assert.equal(saved.rows.length,1);
  const lesson=await db.activateLesson(subject.id,24);await send(90000,'📚 دروس اليوم');
  assert.ok(!messages.some(m=>m.method==='deleteMessage'&&Number(m.message_id)===Number(saved.rows[0].message_id)),'today never deletes the menu message');
  await send(90000,'',`attend:${lesson.id}`);assert.equal((await db.getActiveLessonsForStudent(stage.id,student.id)).length,0);
});
test('bot: unauthorized callbacks and preview writes do not mutate records',async()=>{
  await send(90000,'',`stu_archive:${student.id}`);assert.equal((await db.getStudentById(student.id)).is_active,true);
  app.previewMode.set(42,{role:'student',id:student.id,name:student.full_name});
  await send(42,'',`confirm_official_student`);assert.ok(messages.some(m=>m.method==='answerCallbackQuery'&&m.text?.includes('المعاينة')));
  await send(42,'➕ إضافة مرحلة');assert.ok(messages.some(m=>m.text?.includes('المعاينة')));
  app.previewMode.delete(42);
});
test('bot: cancel exits channel setup before interpreting another menu command',async()=>{
  await send(42,'🔗 ربط قناة بمرحلة');await send(42,'❌ إلغاء العملية');await send(42,'🎓 إدارة الطلبة');
  assert.ok(!messages.some(m=>m.text?.includes('لم أتعرف على قناة')));
  assert.ok(messages.some(m=>m.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='students_stage:'+stage.id)));
});
test('bot: two channel posts with the same hashtag create two lessons and one daily notification',async()=>{
  const chat={id:-1001234567890,type:'channel',title:'قناة الاختبار',username:'class_test'};
  await db.linkChannel(stage.id,chat.id,chat.title);
  const post=id=>({message_id:id,date:Math.floor(Date.now()/1000),chat,audio:{file_id:'offline',duration:10},caption:'#فقه'});
  await app.bot.handleUpdate({update_id:8001,channel_post:post(8001)});
  await app.bot.handleUpdate({update_id:8002,channel_post:post(8002)});
  await app.bot.handleUpdate({update_id:8003,edited_channel_post:post(8001)});
  assert.equal(Number((await db.pool.query('SELECT COUNT(*) AS n FROM lessons WHERE source_chat_id=$1',[chat.id])).rows[0].n),2);
  const notices=(await db.pool.query("SELECT * FROM notification_outbox WHERE dedupe_key LIKE 'daily:%' AND chat_id=$1",[student.telegram_id])).rows;
  assert.equal(notices.length,1);
  const links=notices[0].payload[1].reply_markup.inline_keyboard.flat().filter(b=>b.url);assert.equal(links.length,1);assert.equal(links[0].url,'https://t.me/class_test');
  assert.equal(app.parseLeaveDays('١'),1);assert.equal(app.parseLeaveDays('۱'),1);assert.equal(app.parseLeaveDays('11'),null);
});
test('bot: both current and old export buttons return Markdown documents',async()=>{
  for(const prefix of ['admin_report_md','admin_report_csv']){
    await send(42,'',`${prefix}:${ss}:lessons`);
    const doc=messages.find(m=>m.method==='sendDocument');assert.ok(doc);assert.equal(doc.document.filename,`attendance-${ss}-lessons.md`);
  }
});

test('bot: backup menu is private/admin-only, works during an input step, and preview cannot access it',async()=>{
  await send(42,'🔗 ربط قناة بمرحلة');
  await send(42,'💾 النسخ الاحتياطية');
  assert.ok(messages.some(m=>m.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='backup:enable')));
  assert.ok(!messages.some(m=>m.text?.includes('لم أتعرف على قناة')));
  await send(90000,'','backup:download');
  assert.ok(!messages.some(m=>m.method==='sendDocument'));
  await send(90000,'','backup:enable_confirm');
  assert.equal((await db.pool.query('SELECT enabled FROM backup_control')).rows[0].enabled,false);
  app.previewMode.set(42,{role:'student',id:student.id,name:student.full_name});
  await send(42,'','backup:enable_confirm');
  assert.equal((await db.pool.query('SELECT enabled FROM backup_control')).rows[0].enabled,false);
  app.previewMode.delete(42);
  await send(42,'↩️ رجوع');
  assert.ok(messages.some(m=>m.reply_markup?.keyboard?.flat().some(b=>(b.text||b)==='💾 النسخ الاحتياطية')));
});

test('bot: reopened monthly exam accepts an answer after the original deadline only for its student',async()=>{
  const e=(await db.pool.query(`INSERT INTO exams(subject_id,stage_season_id,exam_number,opens_at,closes_at,available_hours,status)
    VALUES($1,$2,1,now()-interval '3 days',now()-interval '2 days',24,'published') RETURNING *`,[subject.id,ss])).rows[0];
  const qs=[];for(let i=1;i<=2;i++)qs.push((await db.pool.query(`INSERT INTO exam_questions(exam_id,position,question_type,prompt,correct_answer)
    VALUES($1,$2,'tf','سؤال اختبار فتح خاص','صح') RETURNING *`,[e.id,i])).rows[0]);
  await require('../adminOverrides').createAdminOverrides(db.pool).reopenExam(e.id,{studentId:student.id,subjectId:subject.id,
    opensAt:new Date(Date.now()-60000).toISOString(),closesAt:new Date(Date.now()+3600000).toISOString()},42);
  await send(90000,'',`stex_start:${e.id}`);
  const attempt=(await db.pool.query('SELECT * FROM exam_attempts WHERE exam_id=$1 AND student_id=$2',[e.id,student.id])).rows[0];assert.ok(attempt);
  await send(90000,'',`stex_ans:${attempt.id}:${qs[0].id}:0`);
  assert.equal((await db.pool.query('SELECT * FROM exam_answers WHERE attempt_id=$1',[attempt.id])).rowCount,1);
  assert.equal((await studies.getAttemptById(attempt.id)).submitted_at,null);
  assert.ok(messages.some(m=>m.text?.includes('السؤال 2')));
  const outsider=await db.createStudent(91000,'طالب آخر لن يفتح الامتحان',stage.id);await db.pool.query('UPDATE students SET official_confirmed_at=now() WHERE id=$1',[outsider.id]);
  await send(91000,'',`stex_start:${e.id}`);assert.ok(messages.some(m=>m.text?.includes('مغلق')));
  await send(91000,'',`stex_ans:${attempt.id}:${qs[1].id}:0`);assert.ok(messages.some(m=>m.text?.includes('غير مصرح')));
  assert.equal((await db.pool.query('SELECT * FROM exam_answers WHERE attempt_id=$1',[attempt.id])).rowCount,1);
  await db.pool.query("UPDATE exam_student_windows SET opens_at=now()-interval '1 hour',closes_at=now()-interval '1 second' WHERE exam_id=$1",[e.id]);
  await send(90000,'',`stex_ans:${attempt.id}:${qs[1].id}:0`);
  assert.ok(messages.some(m=>m.text?.includes('انتهت مهلة الامتحان')));
  assert.equal((await db.pool.query('SELECT * FROM exam_answers WHERE attempt_id=$1',[attempt.id])).rowCount,1);
});
test('bot: administrator and assigned teacher search one student, open their profile and queue private messages',async()=>{
  await send(42,'💬 التواصل مع طالب معين');assert.ok(messages.some(m=>m.text?.includes('اسم الطالب')));
  await send(42,'طالب حقيقي');assert.ok(messages.some(m=>m.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data===`contact:select:admin:${student.id}:0`)));
  await send(42,'',`contact:select:admin:${student.id}:0`);
  assert.ok(messages.some(m=>m.reply_markup?.inline_keyboard?.flat().some(b=>b.url===`tg://user?id=${student.telegram_id}`)));
  await send(42,'',`contact:compose:admin:${student.id}:0:0`);await send(42,'رسالة الإدارة الخاصة');
  const adminMessage=(await db.pool.query("SELECT * FROM student_contact_messages WHERE student_id=$1 AND actor_role='admin' ORDER BY id DESC LIMIT 1",[student.id])).rows[0];
  assert.equal(adminMessage.message_text,'رسالة الإدارة الخاصة');
  const teacher=(await db.pool.query("INSERT INTO teachers(full_name,telegram_id) VALUES('أستاذ المادة',80000) RETURNING *")).rows[0];
  await db.pool.query('INSERT INTO teaching_assignments(teacher_id,subject_id,stage_season_id) VALUES($1,$2,$3)',[teacher.id,subject.id,ss]);
  await send(80000,'💬 التواصل مع طالب معين');assert.ok(messages.some(m=>m.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data===`contact:subject:${subject.id}:${ss}`)));
  await send(80000,'',`contact:subject:${subject.id}:${ss}`);await send(80000,'طالب حقيقي');
  assert.ok(messages.some(m=>m.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data===`contact:select:teacher:${student.id}:${subject.id}`)));
  await send(80000,'',`contact:select:teacher:${student.id}:${subject.id}`);
  await send(80000,'',`contact:compose:teacher:${student.id}:${subject.id}:0`);await send(80000,'رسالة الأستاذ الخاصة');
  assert.equal((await db.pool.query("SELECT message_text FROM student_contact_messages WHERE student_id=$1 AND actor_role='teacher' ORDER BY id DESC LIMIT 1",[student.id])).rows[0].message_text,'رسالة الأستاذ الخاصة');
  const outsider=await db.createStudent(92000,'طالب خارج مادة الأستاذ', (await db.addStage('مرحلة خارجية')).id);
  await send(80000,'',`contact:select:teacher:${outsider.id}:${subject.id}`);
  assert.ok(messages.some(m=>m.method==='answerCallbackQuery'&&m.show_alert));
});

test('bot: student screens identify the student and report upload explains its weekly cadence',async()=>{
  const heading=`👤 الطالب: ${student.full_name}`;
  for(const button of ['📋 المتغيرات','📖 المباحثات والتقارير','📄 إرسال تقرير','🌴 طلب إجازة','📝 الامتحانات الشهرية','📊 تقرير الحضور']){
    await send(student.telegram_id,button);
    assert.ok(messages.some(m=>m.method==='sendMessage'&&m.text?.includes(heading)),`${button} shows the student name`);
  }
  await send(student.telegram_id,'📄 إرسال تقرير');
  assert.ok(messages.some(m=>m.text?.includes('مرة واحدة أسبوعيًا، وليس يوميًا')));
  const mode=await studies.setParticipationMode(student.id,subject.id,ss,'report');
  assert.ok(mode);
  await send(student.telegram_id,'',`rep_send:${subject.id}:${ss}`);
  assert.ok(messages.some(m=>m.text?.includes(heading)&&m.text.includes('مرة واحدة أسبوعيًا، وليس يوميًا')));
});
test('bot: teacher can edit a question and delete an untouched exam',async()=>{
  const teacher=(await db.getTeacherByTelegramId(80000));
  const exam=await studies.createExam(subject.id,ss,teacher.id,{examNumber:2,title:'موضوع أول',dateIso:'2030-01-01',hours:24});
  const question=await studies.addExamQuestion(exam.id,{type:'tf',prompt:'سؤال قديم',correct:'صح'});
  await send(80000,'',`ex_view:${exam.id}`);
  assert.ok(messages.some(m=>m.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data===`ex_edit_question:${exam.id}`)));
  await send(80000,'',`ex_edit_question:${exam.id}`);
  await send(80000,'',`ex_edit_question_pick:${question.id}`);
  await send(80000,'سؤال جديد واضح');
  await send(80000,'',`ex_edit_tfans:${question.id}:خطأ`);
  assert.equal((await studies.getQuestionById(question.id)).correct_answer,'خطأ');
  await send(80000,'',`ex_edit_title:${exam.id}`);await send(80000,'موضوع جديد');
  assert.equal((await studies.getExamById(exam.id)).title,'موضوع جديد');
  await send(80000,'',`ex_delete:${exam.id}`);await send(80000,'',`ex_delete_confirm:${exam.id}`);
  assert.equal(await studies.getExamById(exam.id),undefined);
});
