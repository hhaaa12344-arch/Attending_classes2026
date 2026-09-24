'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db,studies,data,settings,seq=840000;
test.before(async()=>{({db,studies}=await testDatabase());data=require('../adminData').createAdminData(db,studies);settings=require('../participationSettings').createParticipationSettings(db.pool);});
test.after(async()=>{await db.pool.end();});
async function fixture(){
 const stage=await db.addStage('مرحلة '+(++seq)),ss=(await db.listStageSeasons(stage.id))[0].id;
 const subjects=[];for(const name of ['الفقه','العقائد','النحو'])subjects.push(await db.addSubject(stage.id,name,name+seq));
 const students=[];for(let i=0;i<3;i++)students.push(await db.createStudent(++seq,'طالب '+i+' اسم رباعي',stage.id));
 return {stage,ss,subjects,students};
}
test('lesson matrix: live and expired lessons, saved administrative attendance and no grouping dependency',async()=>{
 const f=await fixture(),{stage,ss,subjects,students}=f;
 const expired=[];for(let i=0;i<3;i++)expired.push((await db.pool.query(`INSERT INTO lessons(subject_id,stage_season_id,activated_at,active_until)
  VALUES($1,$2,now()-interval '2 days',now()-interval '1 day') RETURNING id`,[subjects[0].id,ss])).rows[0]);
 const open=await db.activateLesson(subjects[0].id,24);
 await db.pool.query(`INSERT INTO attendance(student_id,lesson_id,listened_at) VALUES($1,$2,now()-interval '36 hours'),($1,$3,now()-interval '36 hours'),($1,$4,now()),($1,$5,now())`,[students[0].id,expired[0].id,expired[1].id,expired[2].id,open.id]);
 await settings.save(ss,{grouped:false,enabledSubjectIds:[]},42);
 const matrix=await data.lessonAttendance({stageId:stage.id});
 assert.equal(matrix.rows.length,3);assert.equal(matrix.subjects.length,3);
 assert.deepEqual(matrix.rows[0].attendance.find(a=>a.subject_id===subjects[0].id),{subject_id:subjects[0].id,attended:4,total:4});
 assert.equal(matrix.rows[1].attendance.find(a=>a.subject_id===subjects[0].id).attended,0);
 assert.equal(matrix.rows[0].attendance.find(a=>a.subject_id===subjects[2].id).total,0);
 assert.equal((await studies.listStudentSubjects(students[0].id)).length,0);
 const p=await data.lessonAttendance({stageId:stage.id,page:1,size:2});assert.equal(p.rows[0].sequence,3);
 assert.equal((await data.lessonAttendance({stageId:stage.id,q:'%'})).total,0);
 await assert.rejects(data.lessonAttendance({stageId:stage.id,page:-1}));
});
test('historical attendance follows enrollment after stage transfer and isolates season totals',async()=>{
 const f=await fixture(),other=await fixture();
 const season=(await db.pool.query('SELECT season_id FROM stage_seasons WHERE id=$1',[f.ss])).rows[0].season_id;
 await db.pool.query(`INSERT INTO lessons(subject_id,stage_season_id,activated_at,active_until) VALUES($1,$2,now()-interval '2 days',now()-interval '1 day')`,[f.subjects[0].id,f.ss]);
 await db.updateStudentStage(f.students[0].id,other.stage.id);
 const m=await data.lessonAttendance({stageId:f.stage.id,seasonId:season});
 assert.ok(m.rows.some(r=>r.id===f.students[0].id));assert.equal(m.subjects.find(s=>s.id===f.subjects[0].id).total_lessons,1);
 const wrongSeason=(await db.pool.query("INSERT INTO seasons(name) VALUES('موسم آخر') RETURNING id")).rows[0].id;
 await assert.rejects(data.lessonAttendance({stageId:f.stage.id,seasonId:wrongSeason}),{code:'NOT_FOUND'});
});
test('whole-stage mode provisions subjects automatically and ignores numbered group capacity',async()=>{
 const f=await fixture(),sub=f.subjects[0];
 const old=await studies.createMubahathaGroup(sub.id,f.ss,{title:'مجموعة 1',capacity:1});
 await studies.assignStudentToGroup(f.students[0].id,sub.id,f.ss);
 const before=await studies.getStudentGroup(f.students[0].id,sub.id,f.ss);
 await settings.save(f.ss,{grouped:false,enabledSubjectIds:f.subjects.map(s=>s.id)},42);
 for(const st of f.students){await studies.setParticipationMode(st.id,sub.id,f.ss,'report');assert.equal((await studies.assignStudentToGroup(st.id,sub.id,f.ss)).group.id,old.id);}
 assert.equal((await studies.getStudentGroup(f.students[0].id,sub.id,f.ss)).assigned_at.getTime(),before.assigned_at.getTime());
 assert.equal((await data.stage(f.stage.id)).groups.length,3);
 assert.equal((await studies.listStudentSubjects(f.students[0].id))[0].group_number,null);
 assert.ok(await studies.submitReport(f.students[1].id,sub.id,f.ss,{kind:'text',note:'تقرير مستقل للمادة'}));
 await assert.rejects(studies.createMubahathaGroup(sub.id,f.ss,{title:'الثانية'}));
 await studies.initStudiesSchema();assert.equal((await data.stage(f.stage.id)).discussion_grouping,false);
});
test('merging numbered groups moves students, preserves old attendance/grades/report snapshots and pauses competing schedules',async()=>{
 const f=await fixture(),sub=f.subjects[0];
 const g1=await studies.createMubahathaGroup(sub.id,f.ss,{title:'الأولى'}),g2=await studies.createMubahathaGroup(sub.id,f.ss,{title:'الثانية'});
 const st=f.students[0];await studies.setParticipationMode(st.id,sub.id,f.ss,'mubahatha');await studies.moveStudentToGroup(st.id,sub.id,f.ss,g2.id);
 await db.pool.query("UPDATE group_memberships SET assigned_at=now()-interval '1 hour' WHERE student_id=$1 AND group_id=$2",[st.id,g2.id]);
 await db.pool.query("UPDATE participation_modes SET joined_mubahatha_at=now()-interval '1 hour' WHERE student_id=$1 AND subject_id=$2",[st.id,sub.id]);
 const session=await studies.openSession(g2.id,null,'سابقة',1);
 await db.pool.query("UPDATE mubahatha_sessions SET opened_at=now()-interval '20 minutes',closes_at=now()+interval '40 minutes',start_notifications_queued=true WHERE id=$1",[session.id]);
 await studies.markSessionAttendance(session.id,st.id,'start');await studies.openEndAttendance(session.id);await studies.markSessionAttendance(session.id,st.id,'end');
 await db.pool.query("UPDATE mubahatha_sessions SET closes_at=now()-interval '1 hour',end_closes_at=now()-interval '1 minute' WHERE id=$1",[session.id]);
 const reporter=f.students[1];await studies.setParticipationMode(reporter.id,sub.id,f.ss,'report');await studies.moveStudentToGroup(reporter.id,sub.id,f.ss,g2.id);
 const report=await studies.submitReport(reporter.id,sub.id,f.ss,{kind:'text',note:'تقرير قبل الدمج'});
 await db.pool.query(`INSERT INTO schedule_slots(group_id,subject_id,stage_season_id,day_of_week,hour) VALUES($1,$3,$4,0,17),($2,$3,$4,1,18)`,[g1.id,g2.id,sub.id,f.ss]);
 const before=(await studies.computeSeasonGrades(sub.id,f.ss)).find(r=>r.studentId===st.id);
 const result=await settings.save(f.ss,{grouped:false,enabledSubjectIds:f.subjects.map(s=>s.id)},42);
 assert.equal(result.mergedGroups,1);assert.equal(result.movedMemberships,2);assert.equal(result.pausedSlots,2);
 assert.equal((await studies.getStudentGroup(st.id,sub.id,f.ss)).id,g1.id);
 assert.equal((await studies.getGroupById(g2.id)).is_active,false);
 assert.equal((await studies.listGroups(sub.id,f.ss)).length,1);
 const after=(await studies.computeSeasonGrades(sub.id,f.ss)).find(r=>r.studentId===st.id);
 assert.equal(before.attendedSessions,1);assert.equal(after.attendedSessions,1);assert.equal(after.mubahathaScore,before.mubahathaScore);
 const saved=(await studies.listStudentReports(reporter.id,sub.id,f.ss))[0];assert.equal(saved.group_id,report.group_id);assert.equal(saved.group_title_snapshot,'الثانية');
 assert.equal((await studies.listStudentReports(reporter.id,sub.id,f.ss,{groupId:g1.id})).length,1);
 assert.equal(Number((await studies.listReportStudentsForGrading(sub.id,f.ss,{groupId:g1.id})).find(s=>s.student_id===reporter.id).report_count),1);
 await assert.rejects(studies.updateGroupSettings(g2.id,{active:true}));
 const repeated=await settings.save(f.ss,{grouped:false,enabledSubjectIds:f.subjects.map(s=>s.id)},42);assert.equal(repeated.movedMemberships,0);
 await db.pool.query("UPDATE group_memberships SET assigned_at=now()-interval '1 hour' WHERE student_id=$1 AND group_id=$2",[st.id,g1.id]);
 const next=await studies.openSession(g1.id,null,'بعد الدمج',1);
 await db.pool.query("UPDATE mubahatha_sessions SET opened_at=now()-interval '20 minutes',closes_at=now()+interval '40 minutes',start_notifications_queued=true WHERE id=$1",[next.id]);
 assert.ok(await studies.markSessionAttendance(next.id,st.id,'start'));
 assert.equal(await studies.markSessionAttendance(next.id,f.students[2].id,'start'),undefined,'students without discussion participation cannot mark');
});
test('live attendance blocks merging atomically, and excluded subjects reject stale student actions',async()=>{
 const f=await fixture(),sub=f.subjects[0],g=await studies.createMubahathaGroup(sub.id,f.ss,{title:'واحدة'}),st=f.students[0];
 await studies.setParticipationMode(st.id,sub.id,f.ss,'report');await studies.assignStudentToGroup(st.id,sub.id,f.ss);
 const session=await studies.openSession(g.id,null,'مباشرة',1);
 await assert.rejects(settings.save(f.ss,{grouped:false,enabledSubjectIds:f.subjects.map(s=>s.id)},42),{code:'SESSION_OPEN'});
 assert.equal((await data.stage(f.stage.id)).discussion_grouping,true);
 await db.pool.query("UPDATE mubahatha_sessions SET is_closed=true,closes_at=now()-interval '1 minute' WHERE id=$1",[session.id]);
 await settings.save(f.ss,{grouped:true,enabledSubjectIds:[f.subjects[1].id]},42);
 assert.equal(await studies.switchToMubahatha(st.id,sub.id,f.ss),undefined);
 assert.equal(await studies.setParticipationMode(f.students[1].id,sub.id,f.ss,'report'),undefined);
 await assert.rejects(studies.assignStudentToGroup(st.id,sub.id,f.ss));
 assert.equal(await studies.submitReport(st.id,sub.id,f.ss,{kind:'text',note:'رابط قديم'}),undefined);
 assert.equal((await studies.listStudentSubjects(st.id)).length,1);
 assert.equal((await db.listSubjectsByStage(f.stage.id)).length,3,'lessons keep every subject');
 await assert.rejects(settings.save(f.ss,{grouped:true,enabledSubjectIds:[99999999]},42));
 await db.pool.query('UPDATE stage_seasons SET is_active=false WHERE id=$1',[f.ss]);
 await assert.rejects(settings.save(f.ss,{grouped:false,enabledSubjectIds:[]},42),{code:'ARCHIVED'});
});

test('lesson reopening keeps original timestamps, a 24 hour deadline and previous attendance',async()=>{
 const f=await fixture(),l=(await db.pool.query(`INSERT INTO lessons(subject_id,stage_season_id,activated_at,active_until)
 VALUES($1,$2,now()-interval '4 hours',now()-interval '1 hour') RETURNING *`,[f.subjects[0].id,f.ss])).rows[0];
 await db.markAllPresentForLesson(l.id);
 const before=(await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1 ORDER BY id',[l.id])).rows;
 const reopened=await db.reopenLesson(l.id,999);
 assert.equal(reopened.activated_at.getTime(),l.activated_at.getTime());
 assert.equal(reopened.active_until-reopened.activated_at,24*3600000);
 assert.ok(Math.abs(reopened.active_until-Date.now()-20*3600000)<10000);
 assert.deepEqual((await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1 ORDER BY id',[l.id])).rows,before);
 assert.equal((await db.reopenLesson(l.id)).active_until.getTime(),reopened.active_until.getTime());
 const matrix=await data.lessonAttendance({stageId:f.stage.id});assert.equal(matrix.rows[0].attendance.find(a=>a.subject_id===f.subjects[0].id).attended,1);
 await db.pool.query("UPDATE lessons SET activated_at=now()-interval '24 hours' WHERE id=$1",[l.id]);
 assert.equal(await db.reopenLesson(l.id),undefined);
 await db.pool.query('UPDATE stage_seasons SET is_active=false WHERE id=$1',[f.ss]);assert.equal(await db.reopenLesson(l.id),undefined);
});
test('management lists cover every lesson, filter subjects, isolate seasons and export all matrix pages',async()=>{
 const f=await fixture();
 for(let i=0;i<27;i++)await db.activateLesson(f.subjects[i===26?1:0].id);
 const first=await data.managedItems('lessons',{stageId:f.stage.id});
 assert.equal(first.total,27);assert.equal(first.rows.length,25);assert.equal(first.subjects.find(s=>s.id===f.subjects[0].id).total,26);
 const last=await data.managedItems('lessons',{stageId:f.stage.id,page:1});assert.equal(last.rows.length,2);
 assert.equal(new Set([...first.rows,...last.rows].map(r=>r.id)).size,27);
 const filtered=await data.managedItems('lessons',{stageId:f.stage.id,subjectId:f.subjects[0].id,page:1});
 assert.equal(filtered.total,26);assert.equal(filtered.rows[0].item_number,1);
 await assert.rejects(data.managedItems('lessons',{stageId:f.stage.id,subjectId:999999}));
 const md=await data.lessonAttendanceMarkdown({stageId:f.stage.id,size:1,page:2});
 for(const st of f.students)assert.ok(md.includes(st.full_name));
 const only=await data.lessonAttendanceMarkdown({stageId:f.stage.id,q:f.students[1].full_name});
 assert.ok(only.includes(f.students[1].full_name));assert.ok(!only.includes(f.students[0].full_name));
 const se=(await db.pool.query("INSERT INTO seasons(name) VALUES('قديم') RETURNING id")).rows[0];
 const old=(await db.pool.query('INSERT INTO stage_seasons(stage_id,season_id,is_active) VALUES($1,$2,false) RETURNING id',[f.stage.id,se.id])).rows[0];
 await db.pool.query("INSERT INTO lessons(subject_id,stage_season_id,active_until) VALUES($1,$2,now())",[f.subjects[0].id,old.id]);
 assert.equal((await data.managedItems('lessons',{stageId:f.stage.id})).total,27);
 assert.equal((await data.managedItems('lessons',{stageId:f.stage.id,seasonId:se.id})).total,1);
});
test('discussion reopening, complete manual attendance, deletion and scheduled occurrence cancellation',async()=>{
 const f=await fixture(),sub=f.subjects[0],g=await studies.createMubahathaGroup(sub.id,f.ss,{title:'اختبار الإدارة'});
 for(const st of f.students){await studies.setParticipationMode(st.id,sub.id,f.ss,'mubahatha');await studies.moveStudentToGroup(st.id,sub.id,f.ss,g.id);}
 await db.pool.query("UPDATE group_memberships SET assigned_at=now()-interval '1 day' WHERE group_id=$1",[g.id]);
 await db.pool.query("UPDATE participation_modes SET joined_mubahatha_at=now()-interval '1 day' WHERE subject_id=$1",[sub.id]);
 const session=(await db.pool.query(`INSERT INTO mubahatha_sessions(group_id,title,opened_at,closes_at,is_closed)
 VALUES($1,'قبل أربع ساعات',now()-interval '4 hours',now()-interval '3 hours',true) RETURNING *`,[g.id])).rows[0];
 const reopened=await data.manageSession(session.id,'reopen',42);
 assert.equal(reopened.opened_at.getTime(),session.opened_at.getTime());
 assert.equal(reopened.closes_at-reopened.opened_at,24*3600000);assert.equal(reopened.end_closes_at.getTime(),reopened.closes_at.getTime());
 assert.ok(await studies.markSessionAttendance(session.id,f.students[0].id,'start'));
 assert.ok(await studies.markSessionAttendance(session.id,f.students[0].id,'end'));
 const saved=(await db.pool.query('SELECT * FROM mubahatha_attendance WHERE session_id=$1 ORDER BY id',[session.id])).rows;
 await data.manageSession(session.id,'reopen',42);
 assert.deepEqual((await db.pool.query('SELECT * FROM mubahatha_attendance WHERE session_id=$1 ORDER BY id',[session.id])).rows,saved);
 const result=await data.manageSession(session.id,'mark-all',42);assert.deepEqual(result,{added:2,records:4});
 assert.deepEqual(await data.manageSession(session.id,'mark-all',42),{added:0,records:0});
 const listing=await data.managedItems('sessions',{stageId:f.stage.id});assert.equal(listing.total,1);assert.equal(listing.rows[0].complete_count,3);
 const slot=(await db.pool.query(`INSERT INTO schedule_slots(group_id,subject_id,stage_season_id,day_of_week,hour) VALUES($1,$2,$3,1,16) RETURNING id`,[g.id,sub.id,f.ss])).rows[0];
 await db.pool.query("INSERT INTO slot_decisions(slot_id,scheduled_date,decision,session_id) VALUES($1,CURRENT_DATE,'confirmed',$2)",[slot.id,session.id]);
 await db.pool.query("UPDATE mubahatha_sessions SET opened_at=now()-interval '25 hours' WHERE id=$1",[session.id]);
 await assert.rejects(data.manageSession(session.id,'reopen',42),{code:'EXPIRED'});
 await data.manageSession(session.id,'cancel',42);
 assert.equal((await db.pool.query('SELECT * FROM mubahatha_attendance WHERE session_id=$1',[session.id])).rows.length,0);
 const decision=(await db.pool.query('SELECT decision,session_id FROM slot_decisions WHERE slot_id=$1',[slot.id])).rows[0];
 assert.deepEqual(decision,{decision:'postponed',session_id:null});
 assert.equal((await data.managedItems('sessions',{stageId:f.stage.id})).total,0);
 await assert.rejects(data.manageSession(session.id,'cancel',42),{code:'NOT_FOUND'});
});
