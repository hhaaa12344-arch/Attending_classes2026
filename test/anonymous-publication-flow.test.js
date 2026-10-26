'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createScheduledPublication,baghdadDay}=require('../scheduledPublication');
const subjects=[
  {id:18,name:'عقائد الباب الحادي عشر - مستوى1',hashtag:'العقائد'},
  {id:19,name:'مسائل معاملات مستوى 1',hashtag:'الفقه'},
  {id:20,name:'المنطق ج2 - مستوى 1',hashtag:'المنطق'},
];
function fake(){
  let n=0;const pending=[],activated=[];
  const day=baghdadDay(new Date());
  const c={release(){},async query(sql,args){
    if(sql==='SELECT now() AS at')return {rows:[{at:new Date()}]};
    if(sql.includes('SELECT ch.id FROM channels'))return {rows:[{id:1}]};
    if(sql.includes('FROM lesson_corrections r'))return {rows:[]};
    if(sql.includes('FROM effective_lessons WHERE source_chat_id='))return {rows:[]};
    if(sql.includes('FROM pending_channel_lesson_posts WHERE telegram_chat_id=')&&sql.includes('content_kind=\'lesson_title\''))return {rows:[]};
    if(sql.includes('SELECT id,name,hashtag FROM subjects'))return {rows:subjects};
    if(sql.includes('COUNT(DISTINCT subject_id)'))return {rows:[{n:3}]};
    return {rows:[]};
  }};
  const db={pool:{connect:async()=>c},
    async queuePendingChannelLessonPost(p){const row={id:++n,status:'pending',...p,auto_match:p.autoMatch};pending.push(row);return row;},
    async getPendingScheduledSubjectsForDate(){return subjects.filter(s=>!activated.some(l=>l.subject_id===s.id));},
    async activateLesson(subjectId,unused,sourceType,sourceUrl,chatId,messageId){const result={id:++n,subject_id:subjectId,source_type:sourceType,source_url:sourceUrl,source_chat_id:chatId,source_message_id:messageId};activated.push(result);return result;},
  };
  return {publisher:createScheduledPublication(db),pending,activated,day};
}
function media(messageId,caption){return {channel:{stage_id:4,stage_season_id:5},sourceUrl:'https://t.me/c/4311434262/'+messageId,
  contentKind:'audio',message:{chat:{id:-1004311434262},message_id:messageId,date:Math.floor(Date.now()/1000),audio:{file_name:caption?.includes('العقائد')?'الدرس 11.mp3':'22.mp3'},caption}};}
test('unknown file 284 is pending, explicit Aqeedah file 286 is activated first, and old unknown remains pending',async()=>{
  const f=fake();const unknown=await f.publisher.publish(media(284,'المرحلة الثانية مقدمات - المستوى الأول'));
  assert.equal(unknown.created,false);assert.equal(unknown.pending.status,'pending');assert.equal(f.activated.length,0);
  const known=await f.publisher.publish(media(286,'عقائد الباب الحادي عشر - الدرس 11'));
  assert.equal(known.created,true);assert.equal(known.lesson.subject_id,18);
  assert.equal(f.activated.length,1);assert.equal(f.pending.length,2);
});
