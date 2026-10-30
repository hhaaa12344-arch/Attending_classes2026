'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db,studies,stage,sub,ss,serial=0;
test.before(async()=>{({db,studies}=await testDatabase());stage=await db.addStage('مرحلة اختبار الإجازات');sub=await db.addSubject(stage.id,'مادة الإجازات','leave_tests');ss=(await db.listStageSeasons(stage.id))[0].id;});
test.after(async()=>{await db.pool.end();});
const student=()=>db.createStudent(887000+(++serial),'طالب اختبار إجازات '+serial,stage.id);
const row=id=>db.getLeaveById(id);
test('exception requests require exhausted approved quota and an emergency reason, with explicit exception approval',async()=>{
  const st=await student();
  await assert.rejects(()=>db.requestLeave(st.id,'2020-02-01',2,'حالة صحية طارئة',{exception:true}),{code:'LEAVE_EXCEPTION_NOT_ELIGIBLE'});
  const normal=await db.requestLeave(st.id,'2020-01-01',10,null);
  await assert.rejects(()=>db.requestLeave(st.id,'2020-02-01',2,'حالة صحية طارئة',{exception:true}),{code:'LEAVE_EXCEPTION_NOT_ELIGIBLE'},'pending reservation does not expose exceptions');
  await db.decideLeave(normal.id,true,42);
  const remainder=await db.requestLeave(st.id,'2020-01-11',4,null);await db.decideLeave(remainder.id,true,42);
  assert.equal((await db.getCurrentSeasonLeaveUsage(st.id)).exceptionEligible,true);
  await assert.rejects(()=>db.requestLeave(st.id,'2020-02-01',2,null,{exception:true}),/الحالة الطارئة/);
  const extra=await db.requestLeave(st.id,'2020-02-01',2,'حالة صحية طارئة',{exception:true});
  assert.equal(extra.remaining_days,0);assert.equal(extra.is_exception,true);
  await assert.rejects(()=>db.decideLeave(extra.id,true,42),/موافقة استثنائية/);
  assert.equal((await row(extra.id)).status,'pending');
  const approved=await db.decideLeave(extra.id,true,42,{exceptionApproval:true});assert.equal(approved.status,'approved');
  const usage=await db.getCurrentSeasonLeaveUsage(st.id);assert.equal(usage.approvedDays,10);assert.equal(usage.exceptionDays,2);assert.equal(usage.remainingDays,0);
  const activity=await db.getStudentCurrentSeasonActivity(st.id);assert.equal(activity.approvedLeaveDays,10);assert.equal(activity.exceptionLeaveDays,2);
  const report=await db.getStudentSeasonReport(st.id,ss);assert.equal(report[0].approved_leave_days,10);assert.match(report[0].approved_leave_periods,/استثناء طارئ/);
  assert.equal(await db.isStudentOnLeave(st.id,'2020-02-01'),true);
  await db.initSchema();assert.equal((await row(extra.id)).is_exception,true);
});
test('normal quota returns after reducing or cancelling pending and approved leaves; stale requests cannot overwrite',async()=>{
  const st=await student(),l=await db.requestLeave(st.id,'2030-01-01',6,null);
  const reduced=await db.adjustLeave(l.id,{days:2,expectedDays:4,expectedStatus:'pending'},42);
  assert.equal(reduced.days,2);assert.equal(reduced.end_date.toISOString().slice(0,10),'2030-01-02');assert.equal(reduced.status,'pending');
  assert.equal((await db.getCurrentSeasonLeaveUsage(st.id)).remainingDays,8);
  await assert.rejects(()=>db.adjustLeave(l.id,{days:1,expectedDays:4,expectedStatus:'pending'},42),{code:'CONFLICT'});
  await assert.rejects(()=>db.adjustLeave(l.id,{days:3,expectedDays:2,expectedStatus:'pending'},42),/أقل/);
  await db.decideLeave(l.id,true,42);
  await db.adjustLeave(l.id,{cancel:true,expectedDays:2,expectedStatus:'approved'},42);
  assert.equal((await row(l.id)).status,'cancelled');assert.equal((await db.getCurrentSeasonLeaveUsage(st.id)).remainingDays,10);
  assert.equal((await db.pool.query("SELECT * FROM admin_audit_log WHERE entity_type='leave' AND entity_id=$1 AND action IN ('reduce_leave','cancel_leave')",[l.id])).rows.length,2);
  const notices=(await db.pool.query("SELECT * FROM notification_outbox WHERE dedupe_key LIKE $1 AND status='pending'",[`leave:${l.id}:adjust:%`])).rows;assert.equal(notices.length,1);assert.match(notices[0].payload[0],/ألغت الإدارة/);
  assert.equal((await db.pool.query('SELECT status FROM notification_outbox WHERE dedupe_key=$1',[`leave:${l.id}:decision`])).rows[0].status,'expired','a correction withdraws an unsent approval notice');
});
test('exception approval rechecks quota after an administrator frees ordinary days',async()=>{
  const st=await student(),l=await db.requestLeave(st.id,'2020-03-01',10,null);await db.decideLeave(l.id,true,42);
  const remainder=await db.requestLeave(st.id,'2020-03-14',2,null);await db.decideLeave(remainder.id,true,42);
  const extra=await db.requestLeave(st.id,'2020-04-01',2,'ظرف صحي حرج جدًا',{exception:true});
  await db.adjustLeave(l.id,{days:6,expectedDays:8,expectedStatus:'approved'},42);
  await assert.rejects(()=>db.decideLeave(extra.id,true,42,{exceptionApproval:true}),{code:'CONFLICT'});
  assert.equal((await row(extra.id)).status,'pending');assert.equal((await db.getCurrentSeasonLeaveUsage(st.id)).exceptionEligible,false);
});
test('reducing and cancelling a leave recomputes saved absence days and streaks immediately',async()=>{
  const st=await student();await db.pool.query("UPDATE enrollments SET started_at=now()-interval '40 days' WHERE student_id=$1",[st.id]);
  await db.pool.query("UPDATE absence_monitoring_config SET started_at=now()-interval '40 days' WHERE id=1");
  const lessons=(await db.pool.query(`INSERT INTO lessons(subject_id,stage_season_id,activated_at,active_until)
    SELECT $1,$2,(CURRENT_DATE-20+n)+time '08:00',(CURRENT_DATE-19+n)+time '08:00' FROM generate_series(0,2) n RETURNING *`,[sub.id,ss])).rows;
  const start=lessons[0].activated_at.toISOString().slice(0,10);
  const l=await db.requestLeave(st.id,start,3,null);await db.decideLeave(l.id,true,42);await db.processCompletedAttendanceDays();
  const days=()=>db.pool.query('SELECT * FROM student_attendance_days WHERE student_id=$1 ORDER BY attendance_date',[st.id]).then(r=>r.rows);
  assert.deepEqual((await days()).map(r=>r.is_excused_leave),[true,true,true]);
  await db.adjustLeave(l.id,{days:1,expectedDays:3,expectedStatus:'approved'},42);
  assert.deepEqual((await days()).map(r=>r.is_excused_leave),[true,false,false]);assert.equal((await days()).at(-1).absence_streak,2);
  await db.adjustLeave(l.id,{cancel:true,expectedDays:1,expectedStatus:'approved'},42);
  assert.deepEqual((await days()).map(r=>r.is_excused_leave),[false,false,false]);assert.equal((await days()).at(-1).absence_streak,3);
});
test('student withdrawal before the leave starts cancels all days rather than charging one day',async()=>{
  const st=await student(),l=await db.requestLeave(st.id,'2030-02-01',3,null);await db.decideLeave(l.id,true,42);
  const cancelled=await db.cancelLeave(st.id,l.id,'2030-02-01');assert.equal(cancelled.status,'cancelled');assert.equal((await db.getCurrentSeasonLeaveUsage(st.id)).remainingDays,10);
});
