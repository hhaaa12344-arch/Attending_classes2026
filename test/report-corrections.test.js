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
// تقرير محتسب لأسبوع اليوم مهما كان يوم تشغيل الاختبار (عبر استثناء إداري للأسبوع الحالي)
async function sendThisWeek(st,subject,ss,note,msgId){
  await grants.grant(st.id,{subjectId:subject.id,week:dayStr(new Date())},1);
  return studies.submitReport(st.id,subject.id,ss,{fileId:null,kind:'text',note,sourceMessageId:msgId});
}

test('student replaces an ungraded report; after rating it is final; limit is 3',async()=>{
  const {st,subject,ss}=await setup('استبدال',996001);
  const r1=await sendThisWeek(st,subject,ss,'تقرير خاطئ',1);
  assert.ok(r1);
  assert.equal((await studies.getReplaceableReport(st.id,subject.id,ss)).id,r1.id);

  const r2=await studies.replaceReport(st.id,subject.id,ss,r1.id,{fileId:null,kind:'text',note:'تقرير صحيح',sourceMessageId:2});
  assert.equal(r2.id,r1.id);assert.equal(r2.note,'تقرير صحيح');assert.equal(r2.replace_count,1);
  const count=(await db.pool.query('SELECT COUNT(*)::int AS c FROM student_reports WHERE student_id=$1',[st.id])).rows[0].c;
  assert.equal(count,1,'لا يتكرر التقرير');

  await studies.replaceReport(st.id,subject.id,ss,r1.id,{fileId:null,kind:'text',note:'ثانية',sourceMessageId:3});
  await studies.replaceReport(st.id,subject.id,ss,r1.id,{fileId:null,kind:'text',note:'ثالثة',sourceMessageId:4});
  await assert.rejects(()=>studies.replaceReport(st.id,subject.id,ss,r1.id,{fileId:null,kind:'text',note:'رابعة',sourceMessageId:5}),/3 مرات/);

  await studies.setReportItemRating(r1.id,'acceptable',1);
  assert.equal(await studies.getReplaceableReport(st.id,subject.id,ss),null);
  await assert.rejects(()=>studies.replaceReport(st.id,subject.id,ss,r1.id,{fileId:null,kind:'text',note:'متأخر',sourceMessageId:6}),/قيّمه/);
  const row=(await db.pool.query('SELECT rating,score FROM student_reports WHERE id=$1',[r1.id])).rows[0];
  assert.equal(row.rating,'acceptable');assert.equal(Number(row.score),0.5);
});

test('another student cannot replace a report that is not his',async()=>{
  const a=await setup('أ',996002),b=await setup('ب',996003);
  const ra=await sendThisWeek(a.st,a.subject,a.ss,'تقرير أ',11);
  await assert.rejects(()=>studies.replaceReport(b.st.id,b.subject.id,b.ss,ra.id,{fileId:null,kind:'text',note:'x',sourceMessageId:12}),/لا يمكن استبدال/);
});

test('admin deletes a report, reopens the week for the student, and the student can resend',async()=>{
  const {st,subject,ss}=await setup('حذف',996004);
  const r1=await sendThisWeek(st,subject,ss,'خطأ',21);
  await studies.setReportItemRating(r1.id,'weak',1);
  const del=await studies.deleteReport(r1.id,1);
  assert.equal(del.was_graded,true);assert.equal(del.student_id,st.id);
  assert.equal((await db.pool.query('SELECT 1 FROM student_reports WHERE id=$1',[r1.id])).rowCount,0);
  const g=(await db.pool.query('SELECT used_at,report_id,cancelled_at FROM report_week_grants WHERE student_id=$1',[st.id])).rows[0];
  assert.equal(g.used_at,null);assert.equal(g.report_id,null);assert.equal(g.cancelled_at,null);
  assert.equal(await studies.getReportSubmissionBlock(st.id,subject.id,ss),null,'يستطيع الإرسال في أي يوم');
  const r2=await studies.submitReport(st.id,subject.id,ss,{fileId:null,kind:'text',note:'صحيح',sourceMessageId:22});
  assert.ok(r2);assert.equal(dayStr(r2.counted_week),dayStr(new Date(del.week_start)));
  await assert.rejects(()=>studies.deleteReport(999999,1),/غير موجود/);
});

test('admin replaces report text, clears the previous rating, and keeps date and week',async()=>{
  const {st,subject,ss}=await setup('استبدال إداري',996005);
  const r1=await sendThisWeek(st,subject,ss,'نص خاطئ قديم جدا',31);
  await studies.setReportItemRating(r1.id,'good',1);
  await assert.rejects(()=>studies.adminReplaceReport(r1.id,'قصير'),/قصير/);
  const {before,after,wasGraded}=await studies.adminReplaceReport(r1.id,'  النص الصحيح بعد تصحيح الإدارة  ');
  assert.equal(wasGraded,true);assert.equal(before.rating,'good');
  assert.equal(after.note,'النص الصحيح بعد تصحيح الإدارة');assert.equal(after.file_kind,'text');
  assert.equal(after.rating,null);assert.equal(after.score,null);assert.equal(after.replace_count,0,'لا يستهلك حد الطالب');
  assert.equal(after.submitted_at.getTime(),before.submitted_at.getTime());
  assert.equal(String(after.counted_week),String(before.counted_week));
  await assert.rejects(()=>studies.adminReplaceReport(999999,'نص طويل كفاية للتحقق'),/غير موجود/);
});
