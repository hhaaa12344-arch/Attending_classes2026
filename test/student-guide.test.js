'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
process.env.BOT_TOKEN='12345:OFFLINE_TEST_ONLY';process.env.DATABASE_URL='postgresql://localhost/attendance_test_unused';process.env.ADMIN_IDS='42';
const {Telegram}=require('telegraf');
const messages=[];let messageId=3000,updateId=50000,failPhoto=false;
const original=Telegram.prototype.callApi;
Telegram.prototype.callApi=async function(method,payload){
  messages.push({method,...payload});
  if(failPhoto&&['sendPhoto','editMessageMedia'].includes(method))throw Object.assign(Error('Bad Request: wrong file identifier'),{response:{error_code:400}});
  if(method==='getMe')return {id:12345,is_bot:true,username:'GuideTestBot',first_name:'test'};
  const result={message_id:payload.message_id||++messageId,chat:{id:payload.chat_id,type:'private'},text:payload.text};
  if(method==='sendPhoto'||method==='editMessageMedia')result.photo=[{file_id:payload.photo||payload.media?.media,width:1240,height:1754}];
  return result;
};
const {testDatabase}=require('./helpers.cjs');
const {PAGES,ADMIN_BUTTON,STUDENT_BUTTON}=require('../studentGuideContent');
const {initStudentGuideSchema}=require('../studentGuide');
let db,app,full,limited,existing;
test.before(async()=>{
  ({db}=await testDatabase());await initStudentGuideSchema(db.pool);await require('../backups').initBackupSchema(db.pool);
  full=await db.addStage('مرحلة الدليل الكاملة');limited=await db.addStage('مرحلة الدروس فقط');
  await db.pool.query("UPDATE stages SET stage_type='lessons_only' WHERE id=$1",[limited.id]);
  existing=await db.createStudent(80011,'طالب دليل مسجل سابقًا',full.id);await db.confirmOfficialStudent(existing.id);
  const basic=await db.createStudent(80012,'طالب دروس فقط مسجل',limited.id);await db.confirmOfficialStudent(basic.id);
  app=require('../index');app.bot.botInfo={id:12345,is_bot:true,username:'GuideTestBot',first_name:'test'};
});
test.after(async()=>{Telegram.prototype.callApi=original;await db.pool.end();});
async function send(id,{text='',data,photo=false,callbackMessageId,chatType='private',album}={}){
  messages.length=0;
  const from={id,is_bot:false,first_name:'test'};
  const message={message_id:callbackMessageId||++messageId,date:Math.floor(Date.now()/1000),from,chat:{id:chatType==='private'?id:-123,type:chatType},text,
    ...(text.startsWith('/')?{entities:[{offset:0,length:text.split(/\s/)[0].length,type:'bot_command'}]}:{}),
    ...(photo?{photo:[{file_id:photo,width:1240,height:1754}]}:{}),...(album?{media_group_id:album}:{})};
  await app.bot.handleUpdate(data?{update_id:++updateId,callback_query:{id:'g'+updateId,from,data,message}}:{update_id:++updateId,message});
  return messages;
}
const buttons=()=>messages.flatMap(m=>m.reply_markup?.inline_keyboard?.flat()||[]);
const current=async id=>(await db.pool.query('SELECT * FROM student_guide_views WHERE telegram_id=$1',[id])).rows[0];
test('guide: unregistered users can start with no photos; admin and teacher /start keep their own dashboards',async()=>{
  await send(80001,{text:'/start'});
  assert.ok(messages.some(m=>m.text?.includes('دليل الطالب')));assert.ok(buttons().some(b=>b.callback_data==='guide:begin'));
  assert.ok(!messages.some(m=>m.method==='sendPhoto'));
  await send(42,{text:'/start'});assert.ok(messages.some(m=>m.reply_markup?.keyboard));assert.ok(!messages.some(m=>m.text?.includes('دليل الطالب —')));
  const teacher=await db.addTeacher('أستاذ الدليل');await db.linkTeacherAccount(teacher.link_code,80013);
  await send(80013,{text:'/start'});assert.ok(messages.some(m=>m.text?.includes('أهلًا بك أستاذ')));
});
test('guide admin: upload all photos in order, reject albums, preserve photos across schema reinitialization',async()=>{
  await send(42,{text:ADMIN_BUTTON});assert.ok(buttons().some(b=>b.callback_data==='guide:upload_all'));
  await send(42,{data:'guide:upload_all'});
  await send(42,{photo:'not-consumed',album:'album1'});
  assert.equal((await db.pool.query("SELECT photo_file_id FROM student_guide_pages WHERE page_key='registration'")).rows[0].photo_file_id,null);
  for(let i=0;i<PAGES.length;i++)await send(42,{photo:'telegram-guide-'+i});
  await initStudentGuideSchema(db.pool);
  for(let i=0;i<PAGES.length;i++)assert.equal((await db.pool.query('SELECT photo_file_id FROM student_guide_pages WHERE page_key=$1',[PAGES[i].key])).rows[0].photo_file_id,'telegram-guide-'+i);
});
test('guide: photos are reused by file_id, next/previous edit one message, stale callbacks are rejected',async()=>{
  await send(80002,{text:'/start'});
  const first=messages.find(m=>m.method==='sendPhoto');assert.equal(first.photo,'telegram-guide-0');
  let v=await current(80002);
  await send(80002,{data:'guide:page:lessons',callbackMessageId:Number(v.message_id)});
  assert.ok(messages.some(m=>m.method==='editMessageMedia'&&m.media.media==='telegram-guide-1'));
  assert.equal((await current(80002)).message_id,v.message_id);
  await send(80002,{data:'guide:page:registration',callbackMessageId:Number(v.message_id)});
  assert.ok(messages.some(m=>m.method==='editMessageMedia'));assert.ok(!messages.some(m=>m.method==='sendPhoto'));
  await send(80002,{data:'guide:page:lessons',callbackMessageId:1});
  assert.ok(messages.some(m=>m.method==='answerCallbackQuery'&&m.text?.includes('قديمة')));
  assert.ok(!messages.some(m=>m.method==='editMessageMedia'));
});
test('guide: lessons-only stage hides studies pages and prevents forged navigation to them',async()=>{
  await send(80012,{text:STUDENT_BUTTON});let v=await current(80012);
  assert.ok(messages.some(m=>m.caption?.includes('1 / 3')));
  await send(80012,{data:'guide:page:lessons',callbackMessageId:Number(v.message_id)});
  assert.ok(buttons().some(b=>b.callback_data==='guide:page:followup'));
  assert.ok(!buttons().some(b=>b.callback_data==='guide:page:discussions'));
  await send(80012,{data:'guide:page:exams',callbackMessageId:Number(v.message_id)});
  assert.ok(messages.some(m=>m.method==='answerCallbackQuery'&&m.text?.includes('لا ينطبق')));
});
test('guide: registration continuation, code shortcut, legacy button, and an existing account cannot be reset',async()=>{
  await send(80003,{text:'/start'});await send(80003,{data:'guide:begin'});
  assert.ok(messages.some(m=>m.text?.includes('الرجاء إدخال اسمك الرباعي')));assert.equal(await current(80003),undefined);
  await send(80004,{text:'/start'});await send(80004,{data:'guide:code'});assert.ok(messages.some(m=>m.text?.includes('كود تفعيل')));
  await send(80011,{data:'onboarding_ack'});
  assert.equal((await db.getStudentById(existing.id)).full_name,existing.full_name);
  assert.ok(messages.some(m=>m.reply_markup?.keyboard));assert.ok(!messages.some(m=>m.text?.includes('الرجاء إدخال اسمك الرباعي')));
});
test('guide: non-admins, groups and preview cannot change guide content; cancel exits upload cleanly',async()=>{
  const before=(await db.pool.query("SELECT * FROM student_guide_pages WHERE page_key='registration'")).rows[0];
  await send(80011,{data:'guide:remove:registration'});
  assert.equal((await db.pool.query("SELECT photo_file_id FROM student_guide_pages WHERE page_key='registration'")).rows[0].photo_file_id,before.photo_file_id);
  await send(42,{data:'guide:remove:registration',chatType:'group'});
  assert.equal((await db.pool.query("SELECT photo_file_id FROM student_guide_pages WHERE page_key='registration'")).rows[0].photo_file_id,before.photo_file_id);
  app.previewMode.set(42,{role:'student',id:existing.id,name:existing.full_name});
  await send(42,{data:'guide:remove:registration'});app.previewMode.delete(42);
  assert.equal((await db.pool.query("SELECT photo_file_id FROM student_guide_pages WHERE page_key='registration'")).rows[0].photo_file_id,before.photo_file_id);
  await send(42,{data:'guide:upload:registration'});await send(42,{text:'❌ إلغاء العملية'});
  await send(42,{text:'🎓 إدارة الطلبة'});assert.ok(!messages.some(m=>m.text?.includes('أرسلها كصورة')));
});
test('guide: unavailable photo falls back to full text and registration stays available',async()=>{
  failPhoto=true;try{await send(80005,{text:'/start'});}finally{failPhoto=false;}
  assert.ok(messages.some(m=>m.method==='sendMessage'&&m.text?.includes('التسجيل وبداية الاستخدام')));
  assert.ok(buttons().some(b=>b.callback_data==='guide:begin'));
});
test('guide: navigating to another student menu clears the guide and retains the reply keyboard',async()=>{
  await send(80011,{text:'/start'});assert.ok(messages.some(m=>m.reply_markup?.keyboard));
  await send(80011,{text:STUDENT_BUTTON});const v=await current(80011);assert.ok(v);
  await send(80011,{text:'📚 دروس اليوم'});
  assert.equal(await current(80011),undefined);
  assert.ok(messages.some(m=>m.method==='deleteMessage'&&Number(m.message_id)===Number(v.message_id)));
  await send(80011,{text:'/start'});assert.ok(messages.some(m=>m.reply_markup?.keyboard));
});
