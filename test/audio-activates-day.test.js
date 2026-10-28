'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createScheduledPublication,baghdadDay}=require('../scheduledPublication');
let db,publisher,seq=1700000,notices=[];
test.before(async()=>{
  ({db}=await require('./helpers.cjs').testDatabase());
  const recovery=require('../lessonRecovery').createLessonRecovery(db);
  publisher=createScheduledPublication(db,{notice:async(c,lesson,name,stageId,prefix)=>{notices.push(name);return recovery.notice(c,lesson,name,stageId,prefix);}});
});
test.after(async()=>db.pool.end());
async function fixture(n=3){
  const stage=await db.addStage('مرحلة الصوت '+(++seq)),ss=(await db.listStageSeasons(stage.id))[0].id,subs=[];
  for(let i=0;i<n;i++)subs.push(await db.addSubject(stage.id,'مادة صوت '+i,'صوت'+seq+i));
  const student=await db.createStudent(++seq,'طالب الصوت',stage.id),chat=-1000000000-seq;
  await db.linkChannel(stage.id,chat,'قناة الاختبار');
  const channel=await db.getChannelByChatId(chat),day=baghdadDay(new Date());
  for(const s of subs)await db.pool.query("INSERT INTO lesson_schedule_entries(stage_season_id,subject_id,lesson_date,created_at) VALUES($1,$2,$3,now()-interval '3 minutes')",[ss,s.id,day]);
  return {stage,ss,subs,student,chat,channel,day};
}
const audio=(f,id,extra={})=>({channel:f.channel,sourceUrl:`https://t.me/c/1/${id}`,contentKind:'audio',message:{audio:{file_id:'x',duration:60},chat:{id:f.chat},message_id:id,date:Math.floor(Date.now()/1000),...extra}});
test('anonymous audio opens every scheduled subject of the day once, without linking the file to a subject',async()=>{
  const f=await fixture(),r=await publisher.publish(audio(f,501));
  assert.equal(r.activatedAll.length,3);notices.length=0;
  const lessons=(await db.pool.query('SELECT * FROM effective_lessons WHERE stage_season_id=$1',[f.ss])).rows;
  assert.equal(lessons.length,3);assert.ok(lessons.every(l=>l.source_message_id===null&&l.source_type==='schedule_fallback'&&l.active_until>new Date()));
  assert.equal((await db.pool.query('SELECT COUNT(*)::int n FROM notification_outbox WHERE dedupe_key LIKE $1',['schedule-fallback:%'])).rows[0].n>=3,true);
  // الملف الثاني لا يكرّر الدروس
  const again=await publisher.publish(audio(f,502));assert.equal(again.activatedAll,undefined);
  assert.equal((await db.pool.query('SELECT COUNT(*)::int n FROM effective_lessons WHERE stage_season_id=$1',[f.ss])).rows[0].n,3);
  // الطالب يستطيع التأشير على أي منها، وحضوره محفوظ
  const mark=await db.markAttendance(f.student.id,lessons[0].id);assert.ok(mark);
  assert.equal((await db.pool.query('SELECT COUNT(*)::int n FROM attendance WHERE lesson_id=$1',[lessons[0].id])).rows[0].n,1);
});
test('a subject already opened that day is untouched; only the missing ones open; no schedule means nothing opens; edited/old posts are ignored',async()=>{
  const f=await fixture(),keep=await db.activateLesson(f.subs[0].id,24,'channel_schedule',null,f.chat,900,null,{scheduleDate:f.day});
  const r=await publisher.publish(audio(f,503));assert.equal(r.activatedAll.length,2);
  assert.equal((await db.pool.query('SELECT COUNT(*)::int n FROM effective_lessons WHERE stage_season_id=$1 AND subject_id=$2',[f.ss,f.subs[0].id])).rows[0].n,1);
  const g=await fixture();await db.pool.query('DELETE FROM lesson_schedule_entries WHERE stage_season_id=$1',[g.ss]);
  assert.equal((await publisher.publish(audio(g,504))).activatedAll,undefined);
  const h=await fixture();
  assert.equal((await publisher.publish(audio(h,505,{date:Math.floor(Date.now()/1000)-3*86400}))).activatedAll,undefined);
  assert.equal((await db.pool.query('SELECT COUNT(*)::int n FROM effective_lessons WHERE stage_season_id=$1',[h.ss])).rows[0].n,0);
});
test('a file that names a subject keeps the normal single-subject path',async()=>{
  const f=await fixture(),r=await publisher.publish(audio(f,506,{caption:'مادة صوت 1'}));
  assert.equal(r.activatedAll,undefined);
});

test('any fresh audio signal opens missing daily subjects and preserves attendance without duplication',async()=>{
  const f=await fixture(),existing=await db.activateLesson(f.subs[0].id,24,'channel_schedule',null,f.chat,700,null,{scheduleDate:f.day});
  await db.markAttendance(f.student.id,existing.id);
  const before=(await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1',[existing.id])).rows;
  const input=audio(f,701,{caption:'مادة صوت 0 #unknown'});
  const result=await publisher.activateAudioDay(input);
  assert.equal(result.activatedAll.length,2);
  assert.equal((await publisher.activateAudioDay(input)).activatedAll.length,0);
  assert.deepEqual((await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1',[existing.id])).rows,before);
  assert.equal((await db.pool.query('SELECT COUNT(*)::int n FROM effective_lessons WHERE stage_season_id=$1',[f.ss])).rows[0].n,3);
});
test('audio signal survives until today schedule is added, but old or edited audio cannot signal',async()=>{
  const f=await fixture();await db.pool.query('DELETE FROM lesson_schedule_entries WHERE stage_season_id=$1',[f.ss]);
  assert.equal((await publisher.activateAudioDay(audio(f,702))).activatedAll.length,0);
  await db.pool.query('INSERT INTO lesson_schedule_entries(stage_season_id,subject_id,lesson_date) VALUES($1,$2,$3)',[f.ss,f.subs[0].id,f.day]);
  await publisher.recoverAudioDaysToday();await publisher.recoverAudioDaysToday();
  assert.equal((await db.pool.query('SELECT COUNT(*)::int n FROM effective_lessons WHERE stage_season_id=$1',[f.ss])).rows[0].n,1);
  const g=await fixture();
  await publisher.activateAudioDay({...audio(g,703),edited:true});
  await publisher.activateAudioDay(audio(g,704,{date:Math.floor(Date.now()/1000)-2*86400}));
  await publisher.recoverAudioDaysToday();
  assert.equal((await db.pool.query('SELECT COUNT(*)::int n FROM effective_lessons WHERE stage_season_id=$1',[g.ss])).rows[0].n,0);
});
test('holiday blocks daily audio activation',async()=>{
  const f=await fixture();
  await db.pool.query("INSERT INTO stage_calendar_blocks(stage_season_id,kind,start_date,end_date) VALUES($1,'holiday',$2,$2)",[f.ss,f.day]);
  assert.equal((await publisher.activateAudioDay(audio(f,705))).activatedAll.length,0);
});
