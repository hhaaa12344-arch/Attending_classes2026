'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {leavePeriod,endAfterWorkingDays}=require('../leavePolicy');
const {testDatabase}=require('./helpers.cjs');
test('Wednesday request for three calendar days charges Wednesday alone',()=>{
 assert.deepEqual(leavePeriod('2026-10-28',3),{start:'2026-10-28',end:'2026-10-28',days:1,holidays:2});
 assert.deepEqual(leavePeriod('2026-10-29',3),{start:'2026-10-31',end:'2026-10-31',days:1,holidays:2});
 assert.equal(endAfterWorkingDays('2026-10-28',2),'2026-10-31');
});
test('database counts only study days, preserves old policy and handles adjustments',async()=>{
 const {db}=await testDatabase();try{
 const stage=await db.addStage('إجازة جديدة');const st=await db.createStudent(78934567,'طالب اختبار جديد',stage.id);
 const l=await db.requestLeave(st.id,'2026-10-28',3,null);
 assert.equal(l.days,1);assert.equal(l.weekly_holidays,2);assert.equal(l.remaining_days,9);assert.equal(l.end_date.toISOString().slice(0,10),'2026-10-28');
 await db.decideLeave(l.id,true,1);assert.equal((await db.getCurrentSeasonLeaveUsage(st.id)).approvedDays,1);
 await assert.rejects(db.requestLeave(st.id,'2026-11-05',2,null),/عطلة أسبوعية/);
 const l2=await db.requestLeave(st.id,'2026-11-04',4,null);assert.equal(l2.days,2);
 const reduced=await db.adjustLeave(l2.id,{days:1,expectedDays:2,expectedStatus:'pending'},1);assert.equal(reduced.end_date.toISOString().slice(0,10),'2026-11-04');
 }finally{await db.pool.end();}
});
test('exam creation and editing retain explicit Baghdad minutes',async()=>{
 const {db,studies}=await testDatabase();try{
 const stage=await db.addStage('وقت امتحان'),subject=await db.addSubject(stage.id,'اختبار وقت','clock_exam'),season=(await db.listStageSeasons(stage.id))[0].id;
 const e=await studies.createExam(subject.id,season,null,{examNumber:1,title:'اختبار الوقت',dateIso:'2031-01-06',hours:2,time:'14:30'});
 assert.equal(new Date(e.opens_at).toISOString(),'2031-01-06T11:30:00.000Z');
 const updated=await studies.updateExam(e.id,{title:'اختبار معدل',dateIso:'2031-01-07',hours:2});assert.equal(new Date(updated.opens_at).toISOString(),'2031-01-07T11:30:00.000Z');
 await assert.rejects(studies.updateExam(e.id,{title:'اختبار معدل',dateIso:'2031-01-07',hours:2,time:'25:00'}),/وقت الامتحان/);
 }finally{await db.pool.end();}
});
test('approved transfers are counted independently per subject and season',async()=>{
 const {db,studies}=await testDatabase();try{
 const stage=await db.addStage('مرحلة التحويلات'),otherStage=await db.addStage('مرحلة ثانية'),sub=await db.addSubject(stage.id,'مادة التحويل','changes'),ss=(await db.listStageSeasons(stage.id))[0].id,ss2=(await db.listStageSeasons(otherStage.id))[0].id;
 const st=await db.createStudent(889900,'طالب عداد التحويلات',stage.id);
 await db.pool.query(`INSERT INTO participation_change_requests(student_id,subject_id,stage_season_id,from_mode,to_mode,status) VALUES
 ($1,$2,$3,'report','mubahatha','approved'),($1,$2,$3,'mubahatha','report','approved'),($1,$2,$3,'report','mubahatha','rejected'),($1,$2,$4,'report','mubahatha','approved')`,[st.id,sub.id,ss,ss2]);
 const counts=await studies.listParticipationChangeCounts(st.id);assert.equal(counts.find(x=>x.stage_season_id===ss).count,2);assert.equal(counts.find(x=>x.stage_season_id===ss2).count,1);
 }finally{await db.pool.end();}
});
test('notification cleanup removes old finished lesson notices but keeps active and important records',async()=>{
 const {db}=await testDatabase();try{
 await db.pool.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,status,created_at,sent_at,expires_at) VALUES
 ('daily:old:sent',1,'[]','sent',now()-interval '120 days',now()-interval '100 days',now()-interval '95 days'),
 ('daily:old:failed',1,'[]','failed',now()-interval '120 days',NULL,now()-interval '100 days'),
 ('daily:recent:failed',1,'[]','failed',now()-interval '20 days',NULL,now()-interval '10 days'),
 ('daily:future:sent',1,'[]','sent',now()-interval '120 days',now()-interval '100 days',now()+interval '1 day'),
 ('important:failed',1,'[]','failed',now()-interval '120 days',NULL,now()-interval '100 days'),
 ('other:sent',1,'[]','sent',now()-interval '120 days',now()-interval '100 days',now()-interval '100 days'),
 ('daily:pending',1,'[]','pending',now()-interval '120 days',NULL,NULL)`);
 await db.pool.query("INSERT INTO notification_outbox(dedupe_key,chat_id,payload,status,created_at,sent_at,expires_at,telegram_message_id) VALUES ('daily:undeleted',1,'[]','sent',now()-interval '120 days',now()-interval '100 days',now()-interval '100 days',99)");
 const worker=require('../outbox').createOutboxWorker(db.pool,{sendMessage:async()=>{throw Error('temporary');}});await worker.tick();worker.stop();
 const keys=(await db.pool.query("SELECT dedupe_key FROM notification_outbox ORDER BY dedupe_key")).rows.map(x=>x.dedupe_key);
 assert.ok(!keys.includes('daily:old:sent'));assert.ok(!keys.includes('daily:old:failed'));assert.ok(keys.includes('daily:recent:failed'));assert.ok(keys.includes('daily:future:sent'));assert.ok(keys.includes('important:failed'));assert.ok(keys.includes('other:sent'));assert.ok(keys.includes('daily:undeleted'));assert.ok(keys.includes('daily:pending'));assert.equal((await db.pool.query("SELECT status FROM notification_outbox WHERE dedupe_key='daily:pending'")).rows[0].status,'pending');
 }finally{await db.pool.end();}
});
test('daily deduplication remains while a delivery is active',async()=>{
 const {db}=await testDatabase();try{
 const stage=await db.addStage('مرحلة تنظيف التنبيهات'),st=await db.createStudent(998811,'طالب تنظيف التنبيهات',stage.id);
 await db.pool.query(`INSERT INTO student_daily_lesson_notifications(student_id,stage_id,notification_date)
  VALUES($1,$2,CURRENT_DATE-40),($1,$2,CURRENT_DATE-41)`,[st.id,stage.id]);
 await db.pool.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,status,available_at,expires_at)
  VALUES('daily:'||$1::text||':'||(CURRENT_DATE-40)::text||':'||$2::text,1,'[]','pending',now()+interval '1 day',now()+interval '2 days')`,[stage.id,st.id]);
 const worker=require('../outbox').createOutboxWorker(db.pool,{sendMessage:async()=>({})});await worker.tick();worker.stop();
 const rows=(await db.pool.query('SELECT notification_date::text AS day FROM student_daily_lesson_notifications WHERE student_id=$1',[st.id])).rows;
 assert.equal(rows.length,1);const expected=(await db.pool.query('SELECT (CURRENT_DATE-40)::text AS day')).rows[0].day;assert.equal(rows[0].day,expected);
 }finally{await db.pool.end();}
});
