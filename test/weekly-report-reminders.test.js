'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db,studies,svc;
test.before(async()=>{
  ({db,studies}=await testDatabase());
  svc=require('../weeklyReportReminders').createWeeklyReportReminders(db.pool,{sendDays:[3,4,5],tz:'Asia/Baghdad',
    dayNames:{3:'الأربعاء',4:'الخميس',5:'الجمعة'},lateDays:[6]});
});
test.after(async()=>{await db.pool.end();});

// 2026-10-28 أربعاء، 29 خميس، 30 جمعة، 31 سبت (بتوقيت بغداد UTC+3)
const FRI_NOON='2026-10-30T12:30:00+03:00',FRI_EARLY='2026-10-30T08:00:00+03:00',SAT='2026-10-31T21:00:00+03:00',THU='2026-10-29T15:00:00+03:00';

test('friday and saturday reminders reach only students who forgot, once per day',async()=>{
  const stage=await db.addStage('مرحلة تذكير التقارير'),ss=(await db.listStageSeasons(stage.id))[0].id;
  const subject=await db.addSubject(stage.id,'الأصول','أصول');
  const [forgot,sent,mub]=[];
  const f=await db.createStudent(991001,'طالب نسي',stage.id),s=await db.createStudent(991002,'طالب أرسل',stage.id),m=await db.createStudent(991003,'طالب مباحثة',stage.id);
  const group=await studies.createMubahathaGroup(subject.id,ss,{title:'الأولى'});
  for(const st of [f,s,m]){await db.pool.query('UPDATE students SET official_confirmed_at=now() WHERE id=$1',[st.id]);}
  await db.pool.query("UPDATE enrollments SET started_at='2026-09-01' WHERE stage_season_id=$1",[ss]);
  await studies.setParticipationMode(f.id,subject.id,ss,'report');
  await studies.setParticipationMode(s.id,subject.id,ss,'report');
  await studies.setParticipationMode(m.id,subject.id,ss,'mubahatha');
  await db.pool.query("INSERT INTO student_reports(student_id,subject_id,stage_season_id,file_kind,note,submitted_at) VALUES($1,$2,$3,'text','x','2026-10-29 12:00:00')",[s.id,subject.id,ss]);

  assert.equal((await svc.sweep({at:THU})).kind,null);
  assert.equal((await svc.sweep({at:FRI_EARLY})).kind,null);

  const fri=await svc.sweep({at:FRI_NOON});
  assert.equal(fri.kind,'last-day');
  const friRows=(await db.pool.query("SELECT chat_id,payload FROM notification_outbox WHERE dedupe_key LIKE 'weekly-report:last-day:2026-10-30:%'")).rows;
  const mine=friRows.filter(r=>[991001,991002,991003].includes(Number(r.chat_id)));
  assert.deepEqual(mine.map(r=>Number(r.chat_id)),[991001]);
  assert.match(mine[0].payload[0],/آخر يوم/);assert.match(mine[0].payload[0],/الأصول/);
  assert.equal((await svc.sweep({at:FRI_NOON})).queued,0);

  const sat=await svc.sweep({at:SAT});
  assert.equal(sat.kind,'missed');
  const satRows=(await db.pool.query("SELECT chat_id,payload FROM notification_outbox WHERE dedupe_key LIKE 'weekly-report:missed:2026-10-31:%'")).rows
    .filter(r=>[991001,991002,991003].includes(Number(r.chat_id)));
  assert.deepEqual(satRows.map(r=>Number(r.chat_id)),[991001]);
  assert.match(satRows[0].payload[0],/انتهت أيام إرسال التقارير/);assert.match(satRows[0].payload[0],/تقريرك المتأخر اليوم/);
  // التقرير المتأخر يوم السبت مقبول لمن نسي ثم يمنع تكراره
  assert.equal(await studies.getReportSubmissionBlock(f.id,subject.id,ss,{at:SAT}),null);
  await db.pool.query("INSERT INTO student_reports(student_id,subject_id,stage_season_id,file_kind,note,submitted_at) VALUES($1,$2,$3,'text','متأخر','2026-10-31 15:00:00')",[f.id,subject.id,ss]);
  assert.equal((await studies.getReportSubmissionBlock(f.id,subject.id,ss,{at:SAT})).code,'WEEK_USED');
  assert.equal((await svc.sweep({at:SAT})).queued,0);
});

let nextChat = 992000;
async function fixture() {
  const stage = await db.addStage('تدقيق التنبيه ' + nextChat);
  const ss = (await db.listStageSeasons(stage.id))[0].id;
  const st = await db.createStudent(nextChat++, 'طالب اختبار', stage.id);
  await db.pool.query("UPDATE enrollments SET started_at='2026-09-01' WHERE student_id=$1", [st.id]);
  const subjects = [];
  for (const name of ['النحو', 'المنطق']) {
    const sub = await db.addSubject(stage.id, name, name);
    await studies.setParticipationMode(st.id, sub.id, ss, 'report');
    subjects.push(sub);
  }
  const report = (sub, when = '2026-10-31 06:00:00', countedWeek = null) => db.pool.query(
    `INSERT INTO student_reports(student_id,subject_id,stage_season_id,file_kind,submitted_at,counted_week)
     VALUES($1,$2,$3,'text',$4,$5)`, [st.id, sub.id, ss, when, countedWeek]);
  const job = async () => (await db.pool.query(
    "SELECT * FROM notification_outbox WHERE dedupe_key=$1", [`weekly-report:missed:2026-10-31:${st.id}`])).rows[0];
  return { st, ss, subjects, report, job };
}

test('Saturday submission before the reminder is recognized even without a teacher rating', async () => {
  const f = await fixture();
  for (const sub of f.subjects) await f.report(sub);
  await svc.sweep({at:SAT});
  assert.equal(await f.job(), undefined);
  assert.equal((await studies.getReportSubmissionBlock(f.st.id,f.subjects[0].id,f.ss,{at:SAT})).code, 'WEEK_USED');
});

test('delivery refresh removes submitted subjects, then cancels when the remainder switches mode', async () => {
  const f = await fixture();
  await svc.sweep({at:SAT});
  const job = await f.job();
  await f.report(f.subjects[0]);
  const payload = await svc.prepareNotification(job,{at:SAT});
  assert.doesNotMatch(payload[0], /• النحو/);
  assert.match(payload[0], /• المنطق/);
  await studies.changeParticipationMode(f.st.id,f.subjects[1].id,f.ss,'mubahatha');
  assert.equal(await svc.prepareNotification(job,{at:SAT}), null);
});

test('all reports submitted after enqueue cancel delivery; old dates and changed accounts also cancel', async () => {
  const f = await fixture();
  await svc.sweep({at:SAT});
  const job = await f.job();
  assert.equal(await svc.prepareNotification({...job,chat_id:0},{at:SAT}), null);
  assert.equal(await svc.prepareNotification(job,{at:'2026-11-01T00:01:00+03:00'}), null);
  for (const sub of f.subjects) await f.report(sub);
  assert.equal(await svc.prepareNotification(job,{at:SAT}), null);
});

test('a grant for a previous week does not satisfy the current week; an explicit current week does', async () => {
  const f = await fixture();
  await f.report(f.subjects[0], '2026-10-31 06:00:00','2026-10-18');
  await f.report(f.subjects[1], '2026-10-27 06:00:00','2026-10-25');
  await svc.sweep({at:SAT});
  const payload = await svc.prepareNotification(await f.job(),{at:SAT});
  assert.match(payload[0], /• النحو/);
  assert.doesNotMatch(payload[0], /• المنطق/);
});

test('real outbox and Telegram queue recheck after waiting and cancel without sending', async () => {
  const f = await fixture();
  await svc.sweep({at:SAT});
  const job = await f.job();
  await db.pool.query("UPDATE notification_outbox SET status='expired' WHERE id<>$1",[job.id]);
  await db.pool.query("UPDATE notification_outbox SET expires_at=now()+interval '1 day' WHERE id=$1",[job.id]);
  let release, ready;
  const blocked = new Promise(r=>release=r), started = new Promise(r=>ready=r);
  const calls=[];
  const send = async (chat,text) => {calls.push(text);if(text==='block'){ready();await blocked;}return {message_id:1};};
  const queue = require('../telegramQueue').createTelegramQueue({sendMessage:send,sendPhoto:send,sendDocument:send,sendVideo:send},{sleep:async()=>{}});
  const first = queue.sendMessage(1,'block');
  await started;
  const worker = require('../outbox').createOutboxWorker(db.pool,queue,null,{
    prepareNotification: job=>svc.prepareNotification(job,{at:SAT})
  });
  const ticking = worker.tick({force:true});
  // Wait for the worker to hand its notification to the blocked queue.
  for(let i=0;queue.pendingCount()===0 && i<1000;i++) await new Promise(r=>setTimeout(r,1));
  assert.equal(queue.pendingCount(),1);
  for(const sub of f.subjects) await f.report(sub);
  release(); await first; await ticking;
  assert.deepEqual(calls,['block']);
  assert.equal((await f.job()).status,'expired');
  worker.stop();queue.stop();
});

test('delivery sends and persists only still-missing subjects, once', async () => {
  const f = await fixture();
  await svc.sweep({at:SAT});
  const job = await f.job();
  await f.report(f.subjects[0]);
  await db.pool.query("UPDATE notification_outbox SET status='expired' WHERE id<>$1",[job.id]);
  await db.pool.query("UPDATE notification_outbox SET expires_at=now()+interval '1 day' WHERE id=$1",[job.id]);
  const calls=[];
  const send=async(chat,text)=>{calls.push({chat,text});return {message_id:123};};
  const queue=require('../telegramQueue').createTelegramQueue({sendMessage:send,sendPhoto:send,sendDocument:send,sendVideo:send},{sleep:async()=>{}});
  const worker=require('../outbox').createOutboxWorker(db.pool,queue,null,{prepareNotification:job=>svc.prepareNotification(job,{at:SAT})});
  await worker.tick({force:true});await worker.tick({force:true});
  assert.equal(calls.length,1);assert.equal(calls[0].chat,Number(f.st.telegram_id));
  assert.doesNotMatch(calls[0].text,/• النحو/);assert.match(calls[0].text,/• المنطق/);
  const saved=await f.job();assert.equal(saved.status,'sent');assert.equal(saved.payload[0],calls[0].text);
  worker.stop();queue.stop();
});
