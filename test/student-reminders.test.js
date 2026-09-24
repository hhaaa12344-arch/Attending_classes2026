'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
const reminders=require('../studentReminders');
let db,studies;
test.before(async()=>{({db,studies}=await testDatabase());});
test.after(async()=>{await db.pool.end();});

test('general notice lists each missing procedure and queues one message per eligible student',async()=>{
  const stage=await db.addStage('مرحلة تذكير'),ss=(await db.listStageSeasons(stage.id))[0].id;
  const subject=await db.addSubject(stage.id,'المنطق','منطق');
  const students=[];
  for(let i=0;i<3;i++)students.push(await db.createStudent(880000+i,'طالب تذكير رقم '+i,stage.id));
  await db.pool.query('UPDATE students SET official_confirmed_at=now() WHERE id IN ($1,$2)',[students[1].id,students[2].id]);
  await studies.setParticipationMode(students[1].id,subject.id,ss,'report');
  await studies.setParticipationMode(students[2].id,subject.id,ss,'mubahatha');
  const rows=await reminders.incompleteStudents(db.pool);
  const byId=new Map(rows.map(r=>[r.studentId,r.text]));
  assert.match(byId.get(students[0].id),/تأكيد التسجيل الرسمي/);
  assert.match(byId.get(students[0].id),/اختر نوع مشاركتك/);
  assert.match(byId.get(students[1].id),/أرسل تقريرًا/);
  assert.match(byId.get(students[2].id),/الدخول إلى المباحثة/);
  const first=await reminders.queueIncompleteStudents(db.pool,'test-general-notice');
  const repeat=await reminders.queueIncompleteStudents(db.pool,'test-general-notice');
  assert.equal(first.queued,3);assert.equal(repeat.queued,0);
  const queued=(await db.pool.query("SELECT chat_id,payload FROM notification_outbox WHERE dedupe_key LIKE 'student-incomplete:test-general-notice:%'")).rows;
  assert.equal(queued.length,3);
  assert.match(queued.find(x=>Number(x.chat_id)===students[1].telegram_id).payload[0],/📄 إرسال تقرير/);
});

test('missed discussion alerts the admin once, while an explicitly postponed slot is skipped',async()=>{
  const stage=await db.addStage('مرحلة تنبيه المباحثة'),ss=(await db.listStageSeasons(stage.id))[0].id;
  const subject=await db.addSubject(stage.id,'الفقه','فقه');
  const group=await studies.createMubahathaGroup(subject.id,ss,{title:'الأولى'});
  const teacher=await db.addTeacher('أستاذ التنبيه');
  const slot=(await db.pool.query(`INSERT INTO schedule_slots(group_id,subject_id,stage_season_id,teacher_id,day_of_week,hour,minute,created_at)
    SELECT $1,$2,$3,$4,extract(dow from t)::int,extract(hour from t)::int,extract(minute from t)::int,now()-interval '2 days'
    FROM (SELECT now() AT TIME ZONE 'Asia/Baghdad'-interval '3 hours' AS t) x RETURNING *`,
    [group.id,subject.id,ss,teacher.id])).rows[0];
  const scheduler=require('../scheduler').createScheduler({pool:db.pool,studies});
  assert.equal(await scheduler.queueMissedSlotAlerts([42]),1);
  assert.equal(await scheduler.queueMissedSlotAlerts([42]),0);
  const notice=(await db.pool.query('SELECT payload FROM notification_outbox WHERE dedupe_key LIKE $1',[`missed-slot:${slot.id}:%`])).rows[0];
  assert.match(notice.payload[0],/أستاذ التنبيه/);
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()-3*3600000));
  await db.pool.query("INSERT INTO slot_decisions(slot_id,scheduled_date,decision) VALUES($1,$2,'postponed') ON CONFLICT(slot_id,scheduled_date) DO UPDATE SET decision='postponed'",[slot.id,date]);
  await db.pool.query("DELETE FROM notification_outbox WHERE dedupe_key LIKE $1",[`missed-slot:${slot.id}:%`]);
  assert.equal(await scheduler.queueMissedSlotAlerts([42]),0);
});
