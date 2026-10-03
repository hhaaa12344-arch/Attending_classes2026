'use strict';
process.env.SCHEDULE_REQUIRE_CONFIRMATION='false';
const test=require('node:test');const assert=require('node:assert/strict');const {testDatabase}=require('./helpers.cjs');
let db,studies,subject,seasonId,teacher,seq=0;
test.before(async()=>{
  ({db,studies}=await testDatabase());const stage=await db.addStage('اختبار التأكيد الاختياري');seasonId=(await db.listStageSeasons(stage.id))[0].id;
  subject=await db.addSubject(stage.id,'مادة التأكيد','تأكيد');teacher=await db.addTeacher('أستاذ التأكيد');
});
test.after(async()=>{if(db)await db.pool.end();});
async function slot(minutesAgo=2){
  const group=await studies.createMubahathaGroup(subject.id,seasonId,{title:'مجموعة '+(++seq)});
  return (await db.pool.query(`INSERT INTO schedule_slots(group_id,subject_id,stage_season_id,teacher_id,day_of_week,hour,minute)
    SELECT $1,$2,$3,$4,extract(dow from t)::int,extract(hour from t)::int,extract(minute from t)::int
    FROM (SELECT now() AT TIME ZONE 'Asia/Baghdad'-make_interval(mins=>$5::int) t) x RETURNING *`,[group.id,subject.id,seasonId,teacher.id,minutesAgo])).rows[0];
}
// موعد قديم الإنشاء (كان موجودًا قبل بدايته) كما في الاستعمال الطبيعي.
async function oldSlot(minutesAgo=2){
  const s=await slot(minutesAgo);
  await db.pool.query("UPDATE schedule_slots SET created_at=now()-interval '10 hours' WHERE id=$1",[s.id]);
  return s;
}
test('confirmation=false opens an unanswered slot once and preserves its original deadline',async()=>{
  assert.equal(studies.SCHEDULE_REQUIRE_CONFIRMATION,false);const s=await oldSlot();
  const ready=(await studies.getSlotsReadyToStart()).find(x=>x.id===s.id);assert.ok(ready);
  const results=await Promise.all(Array.from({length:10},()=>studies.startSessionFromSlot(ready)));const created=results.filter(Boolean);assert.equal(created.length,1);
  assert.equal(created[0].opened_at.getTime(),ready.scheduled_start.getTime());assert.equal(created[0].closes_at.getTime(),ready.scheduled_end.getTime());
  assert.equal((await studies.getSlotDecision(s.id,ready.scheduled_date)).session_id,created[0].id);
});
test('confirmation=false still honors a postponement made after selection and ignores expired or future slots',async()=>{
  const s=await oldSlot(),ready=(await studies.getSlotsReadyToStart()).find(x=>x.id===s.id);assert.ok(ready);
  await db.pool.query("INSERT INTO slot_decisions(slot_id,scheduled_date,decision) VALUES($1,$2,'postponed')",[s.id,ready.scheduled_date]);
  assert.equal(await studies.startSessionFromSlot(ready),null);assert.ok(!(await studies.getSlotsReadyToStart()).some(x=>x.id===s.id));
  const old=await slot(90),future=await slot(-10);const pending=await studies.getSlotsReadyToStart();assert.ok(!pending.some(x=>x.id===old.id||x.id===future.id));
});
test('confirmation=false never starts a slot that was created after its start time, but an explicit confirmation still does',async()=>{
  const late=await slot(10);  // created just now, 10 minutes after its start
  assert.ok(!(await studies.getSlotsReadyToStart()).some(x=>x.id===late.id),'adding or editing a slot during the lesson sends nothing');
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  await db.pool.query("INSERT INTO slot_decisions(slot_id,scheduled_date,decision) VALUES($1,$2,'confirmed')",[late.id,date]);
  const ready=(await studies.getSlotsReadyToStart()).find(x=>x.id===late.id);
  assert.ok(ready,'the teacher explicitly confirmed it, so it starts');
  assert.ok(await studies.startSessionFromSlot(ready));
});
