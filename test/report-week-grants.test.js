'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db,studies,grants;
test.before(async()=>{
  ({db,studies}=await testDatabase());
  grants=require('../reportGrants').createReportGrants(db.pool,{tz:'Asia/Baghdad',acceptDays:[3,4,5,6]});
});
test.after(async()=>{await db.pool.end();});

async function setup(name,tid){
  const stage=await db.addStage('مرحلة '+name),ss=(await db.listStageSeasons(stage.id))[0].id;
  const subject=await db.addSubject(stage.id,'مادة '+name,'م'+tid);
  const st=await db.createStudent(tid,'طالب '+name,stage.id);
  await db.pool.query('UPDATE students SET official_confirmed_at=now() WHERE id=$1',[st.id]);
  const group=await studies.createMubahathaGroup(subject.id,ss,{title:'الأولى'});
  await studies.setParticipationMode(st.id,subject.id,ss,'report');
  await db.pool.query("INSERT INTO group_memberships(student_id,group_id,subject_id,stage_season_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",[st.id,group.id,subject.id,ss]).catch(()=>{});
  return {st,subject,ss};
}
const dayStr=d=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Baghdad'}).format(d);

test('admin grant lets a student send a report on any day, counted for the granted week, then closes',async()=>{
  const {st,subject,ss}=await setup('استثناء',995001);
  // اليوم الحقيقي للاختبار قد يكون أي يوم؛ نستخدم الأسبوع الماضي دائمًا
  const lastWeekDay=dayStr(new Date(Date.now()-7*86400000));
  const g=await grants.grant(st.id,{subjectId:subject.id,week:lastWeekDay,note:'عذر'},1);
  assert.match(g.weekFrom,/^\d{4}-\d{2}-\d{2}$/);
  const sunday=new Date(g.weekFrom+'T00:00:00Z');assert.equal(sunday.getUTCDay(),0,'بداية الأسبوع الأحد');
  const note=(await db.pool.query("SELECT payload FROM notification_outbox WHERE chat_id=$1 AND dedupe_key LIKE 'report-grant:%'",[995001])).rows;
  assert.equal(note.length,1);assert.match(note[0].payload[0],/سمحت لك إدارة المعهد/);

  // أسبوع ممنوح مرة ثانية، أو لأسبوع مستقبلي، مرفوض
  await assert.rejects(()=>grants.grant(st.id,{subjectId:subject.id,week:lastWeekDay},1),/ممنوح/);
  await assert.rejects(()=>grants.grant(st.id,{subjectId:subject.id,week:dayStr(new Date(Date.now()+14*86400000))},1),/لم يبدأ/);

  // مهما كان اليوم فالحجب لا يمنع الطالب (يوجد استثناء مفتوح)
  assert.equal(await studies.getReportSubmissionBlock(st.id,subject.id,ss),null);
  const report=await studies.submitReport(st.id,subject.id,ss,{fileId:null,kind:'text',note:'تقرير الأسبوع الفائت',sourceMessageId:null});
  assert.ok(report,'قُبل التقرير');
  assert.equal(dayStr(report.counted_week),g.weekFrom,'يُحتسب للأسبوع الممنوح');
  const used=(await db.pool.query('SELECT used_at,report_id FROM report_week_grants WHERE student_id=$1',[st.id])).rows[0];
  assert.ok(used.used_at);assert.equal(used.report_id,report.id);

  // لا استثناء الآن: الحجب يعود لقواعد الأيام المعتادة، ولا يوجد تقرير محتسب لأسبوع الاستثناء مرة ثانية
  const again=await grants.grant(st.id,{subjectId:subject.id,week:lastWeekDay},1).catch(e=>e);
  assert.match(String(again.message),/محتسب|ممنوح/);
});

test('grant is refused for a mubahatha student and can be cancelled before use',async()=>{
  const {st,subject,ss}=await setup('إلغاء',995002);
  const lastWeekDay=dayStr(new Date(Date.now()-7*86400000));
  const g=await grants.grant(st.id,{subjectId:subject.id,week:lastWeekDay},1);
  await grants.cancel(g.id,1);
  await assert.rejects(()=>grants.cancel(g.id,1),/مستخدم|ملغى/);
  const list=await grants.listForStudent(st.id);assert.ok(list[0].cancelled_at);
  await db.pool.query("UPDATE participation_modes SET mode='mubahatha' WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3",[st.id,subject.id,ss]);
  await assert.rejects(()=>grants.grant(st.id,{subjectId:subject.id,week:lastWeekDay},1),/التقارير|ممنوح/);
});
