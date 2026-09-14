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
  assert.ok(messages.some(m=>m.text?.includes('الرجاء إدخال اسمك الرباعي الكامل')));
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
