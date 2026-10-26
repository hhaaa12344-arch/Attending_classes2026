'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {classify}=require('../lessonContent');
const {createScheduledPublication,baghdadDay}=require('../scheduledPublication');
let db,studies,publisher,admin,server,base,token,wakeCount=0,seq=1600000;
async function api(path,body,auth=token){
  const response=await fetch(base+'/api/admin'+path,{method:body?'POST':'GET',headers:{...(auth?{Authorization:'Bearer '+auth}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,data:await response.json()};
}
test.before(async()=>{
  ({db,studies}=await require('./helpers.cjs').testDatabase());publisher=createScheduledPublication(db);
  admin=require('../adminData').createAdminData(db,studies);
  const botToken='12345:LOCAL_REPAIR_TEST',scheduler=require('../scheduler').createScheduler({pool:db.pool,studies});
  server=require('../adminServer').createAdminServer({db,studies,adminData:admin,scheduler,botToken,adminIds:[42],origin:'https://institute.example',wakeNotifications:()=>{wakeCount++;}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  const {createHmac}=require('node:crypto'),p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:42,first_name:'إدارة اختبار'})});
  const secret=createHmac('sha256','WebAppData').update(botToken).digest();
  p.set('hash',createHmac('sha256',secret).update([...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));
  const auth=await api('/auth',{initData:p.toString()},null);assert.equal(auth.status,200);token=auth.data.token;
});
test.after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(db)await db.pool.end();});
async function fixture(chat=null){
  const stage=await db.addStage('مرحلة مراجعة المحتوى '+(++seq)),ss=(await db.listStageSeasons(stage.id))[0].id;
  const definitions=[['مسائل معاملات مستوى 2','الفقه'],['عقائد الباب الحادي عشر - مستوى 2','العقائد'],['شرح قطر ج2 مستوى2','النحو'],['المنطق ج2 مستوى 2','المنطق'],['التفسير','التفسير']];
  const subjects=[];for(const [name,tag] of definitions)subjects.push(await db.addSubject(stage.id,name,tag));
  chat=chat||-1000000000-seq;await db.linkChannel(stage.id,chat,'القناة');const channel=await db.getChannelByChatId(chat);
  const student=await db.createStudent(++seq,'طالب مراجعة نشر',stage.id),day=baghdadDay(new Date());
  for(const sub of subjects.slice(0,4))await db.pool.query("INSERT INTO lesson_schedule_entries(stage_season_id,subject_id,lesson_date,created_at) VALUES($1,$2,$3,now()-interval '3 minutes')",[ss,sub.id,day]);
  return {stage,ss,subjects,channel,chat,student,day};
}
function input(f,id,content,kind){return {channel:f.channel,sourceUrl:`https://t.me/c/1/${id}`,contentKind:kind,message:{chat:{id:f.chat},message_id:id,date:Math.floor(Date.now()/1000),...content}};}

test('the supplied calendar banner, bot instructions and demonstration video are not lessons',()=>{
  for(const message of [
    {text:'🗓 السبت - 14 ربيع الآخر 1448 هـ — 2026/9/26 م https://youtu.be/znSuDf1jIjM'},
    {text:'أدناه رابط البوت الخاص بتسجيل الحضور https://t.me/Attending_classesbot'},
    {video:{file_id:'demo'},caption:'فيديو توضيحي لكيفية الدخول إلى نظام تسجيل الحضور الإلكتروني'},
    {sticker:{file_id:'sticker'}}])assert.equal(classify(message).kind,'ignore');
});

test('audio inherits المنطق, المسائل, القطر and العقائد from its immediately preceding title; links do not double the count',async()=>{
  const f=await fixture();
  const titles=['مرحلة المقدمات الثانية المنطق للشيخ المظفر ج2 - المحاضرة 62','المسائل المنتخبة - الدرس 62','النحو (قطر الندى وبل الصدى ج2) - المحاضرة 36','مرحلة المقدمات الثانية عقائد الباب الحادي عشر - الدرس 29'];
  const expected=[f.subjects[3],f.subjects[0],f.subjects[2],f.subjects[1]];
  for(let i=0;i<titles.length;i++){
    const titleId=10+i*2,audioId=titleId+1;
    assert.equal((await publisher.publish(input(f,titleId,{text:titles[i]+' https://youtu.be/example'},'link'))).created,false);
    const result=await publisher.publish(input(f,audioId,{audio:{file_id:'audio'+i,duration:60}},'audio'));
    assert.equal(result.lesson.subject_id,expected[i].id);
    assert.equal((await db.getLessonBySource(f.chat,titleId)).id,result.lesson.id);
    assert.equal((await publisher.publish(input(f,titleId,{text:titles[i]+' https://youtu.be/example'},'link'))).created,false);
  }
  assert.equal((await admin.managedItems('lessons',{stageId:f.stage.id})).total,4);
});

test('generic link and anonymous audio stay pending on a multi-subject day; titled files activate normally',async()=>{
  const f=await fixture();
  await publisher.publish(input(f,20,{caption:'المرحلة الثانية اضغط هنا http://edu.turathalanbiaa.com/lesson/1433',photo:[{file_id:'photo'}]},'link'));
  const first=await publisher.publish(input(f,21,{audio:{file_id:'62.mp3',duration:60}},'audio'));
  assert.equal(first.created,false);assert.ok(first.pending);
  assert.equal(await db.getLessonBySource(f.chat,20),undefined);
  for(const [index,sub] of f.subjects.slice(1,3).entries()){
    const result=await publisher.publish(input(f,30+index,{audio:{file_id:'known'+index,duration:60},caption:sub.name},'audio'));
    assert.equal(result.lesson.subject_id,sub.id);
  }
  const last=await publisher.publish(input(f,40,{audio:{file_id:'last.mp3',duration:60}},'audio'));
  assert.equal(last.created,false);
  const explicit=await publisher.publish(input(f,42,{audio:{file_id:'titled.mp3',duration:60},caption:f.subjects[3].name},'audio'));
  assert.equal(explicit.lesson.subject_id,f.subjects[3].id);
  assert.deepEqual((await db.getPendingScheduledSubjectsForDate(f.ss,f.day)).map(s=>s.id),[f.subjects[0].id]);
  const extra=await publisher.publish(input(f,41,{audio:{file_id:'extra.mp3',duration:60}},'audio'));
  assert.equal(extra.created,false);assert.ok(extra.pending);
});

test('audio file name or title identifies the subject when there is no caption',async()=>{
  const f=await fixture();
  const r=await publisher.publish(input(f,50,{audio:{file_id:'named-file',duration:60,file_name:'عقائد الباب الحادي عشر - 30.mp3'}},'audio'));
  assert.equal(r.lesson.subject_id,f.subjects[1].id);
  const next=await publisher.publish(input(f,51,{audio:{file_id:'plain',duration:60}},'audio'));
  assert.equal(next.created,false);assert.ok(next.pending);
});

test('legacy HTTP repair is review-only and never copies attendance',async()=>{
  const f=await fixture(-1003488013652),[a,b,c,d,e]=f.subjects;
  const beforeDefinitions=[[22,a],[23,b],[25,a],[26,a],[27,a],[28,c],[30,d],[36,d],[37,e]];
  const ids={};
  for(const [message,subject] of beforeDefinitions){
    const lesson=await db.activateLesson(subject.id,24,'channel_schedule',`https://t.me/c/3488013652/${message}`,f.chat,message,new Date('2026-09-26T06:00:00Z'));
    ids[message]=lesson.id;await db.pool.query('INSERT INTO attendance(student_id,lesson_id) VALUES($1,$2)',[f.student.id,lesson.id]);
  }
  const second=await db.createStudent(++seq,'طالب حضر الرابط المكرر فقط',f.stage.id);
  await db.pool.query('INSERT INTO attendance(student_id,lesson_id) VALUES($1,$2)',[second.id,ids[26]]);
  for(const message of [21,24,29,31,38,39,40,41,42,43,44])await db.queuePendingChannelLessonPost({chatId:f.chat,messageId:message,stageId:f.stage.id,stageSeasonId:f.ss,lessonDate:'2026-09-27',contentKind:message%2?'link':'audio',receivedAt:new Date('2026-09-27T05:33:00Z')});
  const original=(await db.pool.query('SELECT * FROM attendance WHERE lesson_id=ANY($1::int[]) ORDER BY id',[Object.values(ids)])).rows;
  const discussions=(await db.pool.query('SELECT * FROM mubahatha_attendance ORDER BY id')).rows;
  const before=await api('/lesson-management?stageId='+f.stage.id);assert.equal(before.status,200);assert.equal(before.data.total,9);
  assert.equal(before.data.repairAvailable,true);assert.equal(before.data.repairApplied,false);
  const previewResponse=await api('/lesson-publication-repair?stageId='+f.stage.id);assert.equal(previewResponse.status,200);
  const preview=previewResponse.data;
  assert.equal(preview.beforeCount,9);assert.equal(preview.afterCount,7);
  const body={stageId:f.stage.id,token:preview.token};
  assert.equal((await api('/lesson-publication-repair',body,null)).status,401);
  assert.equal((await api('/lesson-publication-repair',{...body,token:'invalid'})).status,409);
  assert.equal((await api('/lesson-management?stageId='+f.stage.id)).data.total,9);assert.equal(wakeCount,0);
  const applied=await api('/lesson-publication-repair',body);assert.equal(applied.status,409);assert.equal(wakeCount,0);
  assert.equal((await api('/lesson-management?stageId='+f.stage.id)).data.total,9);
  assert.deepEqual((await db.pool.query('SELECT * FROM attendance WHERE lesson_id=ANY($1::int[]) ORDER BY id',[Object.values(ids)])).rows,original);
  assert.equal((await db.pool.query('SELECT 1 FROM attendance WHERE student_id=$1 AND lesson_id=$2',[second.id,ids[27]])).rows.length,0);
  assert.deepEqual((await db.pool.query('SELECT * FROM mubahatha_attendance ORDER BY id')).rows,discussions);
});
