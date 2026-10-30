'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
test('approval recalculates old pending weekend-only and mixed requests without changing historical approved leaves',async()=>{
 const {db}=await testDatabase();try{
  const stage=await db.addStage('مرحلة الإجازات القديمة'),season=(await db.listStageSeasons(stage.id))[0].id;
  const a=await db.createStudent(998812,'طالب إجازة الخميس والجمعة',stage.id);
  const b=await db.createStudent(998813,'طالب إجازة الأربعاء والجمعة',stage.id);
  const old=await db.pool.query(`INSERT INTO student_leaves(student_id,stage_season_id,start_date,end_date,days,status,working_days_policy) VALUES
   ($1,$3,'2026-10-29','2026-10-30',2,'pending',false),($2,$3,'2026-10-28','2026-10-30',3,'pending',false),
   ($1,$3,'2026-10-22','2026-10-23',2,'approved',false) RETURNING *`,[a.id,b.id,season]);
  const weekend=await db.decideLeave(old.rows[0].id,true,42);assert.equal(weekend.status,'cancelled');assert.equal(weekend.weekend_only,true);
  assert.equal((await db.getCurrentSeasonLeaveUsage(a.id)).approvedDays,2,'previously approved records remain untouched');
  const notice=(await db.pool.query('SELECT payload FROM notification_outbox WHERE dedupe_key=$1',[`leave:${weekend.id}:decision`])).rows[0].payload[0];assert.match(notice,/عطلة أسبوعية/);assert.match(notice,/لم يُخصم/);
  const mixed=await db.decideLeave(old.rows[1].id,true,42);assert.equal(mixed.status,'approved');assert.equal(mixed.days,1);assert.equal(mixed.end_date.toISOString().slice(0,10),'2026-10-28');
  assert.equal((await db.getCurrentSeasonLeaveUsage(b.id)).approvedDays,1);assert.equal(await db.decideLeave(old.rows[1].id,true,42),undefined);
  const fixed=await db.adjustLeave(old.rows[2].id,{cancel:true,expectedDays:2,expectedStatus:'approved'},42);assert.equal(fixed.status,'cancelled');assert.equal((await db.getCurrentSeasonLeaveUsage(a.id)).approvedDays,0);
  const correction=(await db.pool.query("SELECT payload FROM notification_outbox WHERE dedupe_key LIKE $1 AND status='pending'",[`leave:${fixed.id}:adjust:%`])).rows[0].payload[0];assert.match(correction,/عطلة أسبوعية/);assert.match(correction,/لا تُخصم/);
 }finally{await db.pool.end();}
});
