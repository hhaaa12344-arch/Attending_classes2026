'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db,studies,data,ss,sub,group,session,students;
test.before(async()=>{
  ({db,studies}=await testDatabase());data=require('../adminData').createAdminData(db,studies);
  const stage=await db.addStage('اختبار إشعارات إعادة الفتح');ss=(await db.listStageSeasons(stage.id))[0].id;
  sub=await db.addSubject(stage.id,'مادة الإشعارات','recovery_notices');
  group=await studies.createMubahathaGroup(sub.id,ss,{title:'مجموعة الإشعارات'});
  students=[];
  for(let i=0;i<3;i++){
    const st=await db.createStudent(998001+i,'طالب إشعارات '+i+' تجريبي',stage.id);students.push(st);
    await studies.setParticipationMode(st.id,sub.id,ss,'mubahatha');await studies.assignStudentToGroup(st.id,sub.id,ss);
  }
  await db.pool.query("UPDATE group_memberships SET assigned_at=now()-interval '1 day' WHERE group_id=$1",[group.id]);
  await db.pool.query("UPDATE participation_modes SET joined_mubahatha_at=now()-interval '1 day' WHERE subject_id=$1",[sub.id]);
  session=(await db.pool.query("INSERT INTO mubahatha_sessions(group_id,title,opened_at,closes_at,is_closed) VALUES($1,'اختبار',now()-interval '2 hours',now()-interval '1 hour',true) RETURNING *",[group.id])).rows[0];
});
test.after(async()=>{await db.pool.end();});

test('recovery delivery is observable, urgent, retryable and never resends successful notices',async()=>{
  const reopened=await data.manageSession(session.id,'reopen',42);
  assert.equal(reopened.queued,3);assert.equal(reopened.notifications.counts.pending,3);
  const attempts=[];let blocked=true;
  const worker=require('../outbox').createOutboxWorker(db.pool,{sendMessage:async(chat,text,extra,options)=>{
    attempts.push(chat);assert.match(text,/10 دقائق/);assert.equal(options.priority,2);
    assert.equal(extra.reply_markup.inline_keyboard[0].length,2);
    if(chat===Number(students[1].telegram_id)&&blocked)throw Object.assign(Error('blocked'),{response:{error_code:403}});
    return {message_id:attempts.length};
  }});
  await worker.tick();
  let state=await data.sessionNotifications(session.id);
  assert.equal(state.counts.sent,2);assert.equal(state.counts.failed,1);assert.deepEqual(state.errors,[{code:'403',count:1}]);
  blocked=false;
  const retry=await data.manageSession(session.id,'retry-notifications',42);
  assert.equal(retry.retried,1);assert.equal(retry.queued,0);
  assert.deepEqual(retry.attendance_reopen_until,reopened.attendance_reopen_until);
  // The worker just exhausted its queue; an explicit wake bypasses its idle polling delay.
  await worker.tick({force:true});state=await data.sessionNotifications(session.id);
  assert.equal(state.counts.sent,3);assert.equal(state.counts.failed,0);
  assert.equal(attempts.filter(x=>x===Number(students[0].telegram_id)).length,1);
  assert.equal(attempts.filter(x=>x===Number(students[1].telegram_id)).length,2);
  await data.manageSession(session.id,'retry-notifications',42);await worker.tick({force:true});assert.equal(attempts.length,4);
  worker.stop();
});

test('an existing active window repairs missing notices without extending time or duplicating sent rows',async()=>{
  const before=await studies.getSessionById(session.id);
  const key=`session:${session.id}:reopen:${before.attendance_reopen_count}:${students[2].id}`;
  await db.pool.query('DELETE FROM notification_outbox WHERE dedupe_key=$1',[key]);
  const result=await data.manageSession(session.id,'reopen',42);
  assert.equal(result.queued,1);assert.equal(result.notifications.counts.sent,2);assert.equal(result.notifications.counts.pending,1);
  assert.deepEqual(result.attendance_reopen_until,before.attendance_reopen_until);
});

test('empty audience is reported explicitly and expired windows cannot retry or extend themselves',async()=>{
  const empty=await studies.createMubahathaGroup(sub.id,ss,{title:'بلا طلبة'});
  const s=await studies.openSession(empty.id,null,'لا يوجد مستلمون',1);
  const result=await data.manageSession(s.id,'reopen',42);
  assert.equal(result.notifications.eligible,0);assert.equal(result.notifications.counts.total,0);
  assert.deepEqual(result.notifications.audience,[]);
  await db.pool.query('UPDATE mubahatha_sessions SET attendance_reopen_until=now() WHERE id=$1',[s.id]);
  await assert.rejects(data.manageSession(s.id,'retry-notifications',42),{code:'EXPIRED'});
  assert.equal((await data.sessionNotifications(s.id)).windowOpen,false);
});

test('a student transferred after the original discussion is explicitly excluded with the same attendance rule',async()=>{
  await db.pool.query('UPDATE group_memberships SET assigned_at=now() WHERE student_id=$1',[students[0].id]);
  const s=(await db.pool.query("INSERT INTO mubahatha_sessions(group_id,title,opened_at,closes_at,is_closed) VALUES($1,'سبب استبعاد المنقول',now()-interval '2 hours',now()-interval '1 hour',true) RETURNING *",[group.id])).rows[0];
  const reopened=await data.manageSession(s.id,'reopen',42);
  assert.equal(reopened.notifications.eligible,2);assert.equal(reopened.queued,2);
  assert.equal(reopened.notifications.audience.find(x=>x.reason==='joined_group_later').count,1);
  assert.equal((await db.pool.query('SELECT * FROM notification_outbox WHERE dedupe_key LIKE $1 AND chat_id=$2',['session:'+s.id+':reopen:%',students[0].telegram_id])).rows.length,0);
  assert.equal(await studies.markSessionAttendance(s.id,students[0].id,'start'),undefined);
  assert.ok(await studies.markSessionAttendance(s.id,students[1].id,'start'));
});
