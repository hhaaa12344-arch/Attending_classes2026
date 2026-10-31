'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db,studies,svc;
test.before(async()=>{
  ({db,studies}=await testDatabase());
  svc=require('../weeklyReportReminders').createWeeklyReportReminders(db.pool,{sendDays:[3,4,5],tz:'Asia/Baghdad',
    dayNames:{3:'الأربعاء',4:'الخميس',5:'الجمعة'}});
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
  assert.match(satRows[0].payload[0],/انتهت أيام إرسال التقارير/);
  assert.equal((await svc.sweep({at:SAT})).queued,0);
});
