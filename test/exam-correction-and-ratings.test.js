'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db,studies,seq=9100000;
test.before(async()=>({db,studies}=await testDatabase()));
test.after(async()=>db.pool.end());
const iso=d=>new Date(Date.UTC(2026,0,5+d,9)).toISOString().slice(0,-1);

async function examFixture(){
  const stage=await db.addStage('مرحلة التصحيح '+(++seq)),ss=(await db.listStageSeasons(stage.id))[0].id;
  const sub=await db.addSubject(stage.id,'مادة التصحيح',`ت${seq}`);
  const exam=(await db.pool.query(`INSERT INTO exams(subject_id,stage_season_id,exam_number,title,opens_at,available_hours,closes_at,status,published_at)
    VALUES($1,$2,1,'امتحان',now()-interval '2 hours',48,now()+interval '46 hours','published',now()) RETURNING *`,[sub.id,ss])).rows[0];
  const qs=[];
  for(let i=1;i<=4;i++)qs.push((await db.pool.query(`INSERT INTO exam_questions(exam_id,position,question_type,prompt,correct_answer) VALUES($1,$2,'tf',$3,'صح') RETURNING *`,[exam.id,i,'سؤال '+i])).rows[0]);
  const sit=async(name,answers)=>{
    const st=await db.createStudent(++seq,name,stage.id);
    const a=(await db.pool.query(`INSERT INTO exam_attempts(exam_id,student_id,submitted_at,score,correct_count,total_questions) VALUES($1,$2,now(),$3,$4,4) RETURNING *`,
      [exam.id,st.id,Math.round(answers.filter(x=>x==='صح').length/4*5*100)/100,answers.filter(x=>x==='صح').length])).rows[0];
    for(let i=0;i<4;i++)await db.pool.query('INSERT INTO exam_answers(attempt_id,question_id,answer,is_correct) VALUES($1,$2,$3,$4)',[a.id,qs[i].id,answers[i],answers[i]==='صح']);
    return {st,a};
  };
  return {stage,ss,sub,exam,qs,sit};
}
const score=async a=>Number((await db.pool.query('SELECT score FROM exam_attempts WHERE id=$1',[a.id])).rows[0].score);

test('changing a question\'s correct answer re-scores every attempt, updates untouched final grades and notifies changed students',async()=>{
  const f=await examFixture();
  const A=await f.sit('أ',['صح','صح','صح','صح']),B=await f.sit('ب',['صح','صح','صح','خطأ']);
  for(const [x,edited] of [[A,false],[B,true]])
    await db.pool.query(`INSERT INTO final_grades(student_id,subject_id,stage_season_id,exams_score,participation_score,total_score,finalized_at,edited_at)
      VALUES($1,$2,$3,$4,10,$5,now(),$6)`,[x.st.id,f.sub.id,f.ss,x===A?5:3.75,x===A?15:13.75,edited?new Date():null]);
  assert.equal(await score(A.a),5);assert.equal(await score(B.a),3.75);
  const r=await studies.correctExamQuestion(f.qs[3].id,{action:'change_answer',correct:'خطأ'},42);
  assert.equal(r.changedStudents,2);assert.equal(r.manualGradesSkipped,1);
  assert.equal(await score(A.a),3.8);assert.equal(await score(B.a),5);
  const fg=async x=>(await db.pool.query('SELECT exams_score,total_score FROM final_grades WHERE student_id=$1',[x.st.id])).rows[0];
  assert.deepEqual([Number((await fg(A)).exams_score),Number((await fg(A)).total_score)],[3.8,13.8]);
  assert.equal(Number((await fg(B)).exams_score),3.75,'تعديل الأستاذ اليدوي لا يُمس');
  assert.equal((await db.pool.query("SELECT COUNT(*)::int n FROM notification_outbox WHERE dedupe_key LIKE $1",[`exam-fix:${f.qs[3].id}:%`])).rows[0].n,2);
  assert.equal((await db.pool.query("SELECT COUNT(*)::int n FROM admin_audit_log WHERE action='exam_question_correction'")).rows[0].n>=1,true);
  await assert.rejects(studies.correctExamQuestion(f.qs[3].id,{action:'change_answer',correct:'خطأ'},42),{message:/الحالية/});
  await assert.rejects(studies.correctExamQuestion(f.qs[3].id,{action:'change_answer',correct:'ربما'},42),{message:/خيارات/});
});
test('removing a flawed question re-divides the grade proportionally and never deletes a submission',async()=>{
  const f=await examFixture();
  const A=await f.sit('أ',['صح','صح','صح','خطأ']),B=await f.sit('ب',['صح','خطأ','خطأ','خطأ']);
  await studies.correctExamQuestion(f.qs[3].id,{action:'remove'},42);
  assert.equal(await score(A.a),5);assert.equal(await score(B.a),1.7);
  const row=(await db.pool.query('SELECT correct_count,total_questions FROM exam_attempts WHERE id=$1',[B.a.id])).rows[0];
  assert.deepEqual([row.correct_count,row.total_questions],[1,3]);
  assert.equal((await db.pool.query('SELECT COUNT(*)::int n FROM exam_attempts WHERE exam_id=$1',[f.exam.id])).rows[0].n,2);
  await studies.correctExamQuestion(f.qs[2].id,{action:'remove'},42);await studies.correctExamQuestion(f.qs[1].id,{action:'remove'},42);
  await assert.rejects(studies.correctExamQuestion(f.qs[0].id,{action:'remove'},42),{code:'LAST_QUESTION'});
  await db.pool.query("UPDATE exams SET status='draft' WHERE id=$1",[f.exam.id]);
  await assert.rejects(studies.correctExamQuestion(f.qs[0].id,{action:'change_answer',correct:'خطأ'},42),{code:'CONFLICT'});
});

test('migration restores one decimal from counts, backs up records and preserves manual final grades',async()=>{
  const f=await examFixture();
  const A=await f.sit('قديم أ',['صح','صح','صح','خطأ']);
  const B=await f.sit('قديم ب',['صح','صح','صح','خطأ']);
  for(const [x,manual] of [[A,false],[B,true]]) await db.pool.query(`INSERT INTO final_grades(student_id,subject_id,stage_season_id,exams_score,participation_score,total_score,finalized_at,edited_at)
    VALUES($1,$2,$3,3.75,10,13.75,now(),$4)`,[x.st.id,f.sub.id,f.ss,manual?new Date():null]);
  await db.pool.query('UPDATE exam_attempts SET score=4 WHERE id=ANY($1::int[])',[[A.a.id,B.a.id]]);
  const migrate=require('../examScoreRounding').roundExistingExamScores;
  const r=await migrate(db.pool);assert.equal(r.applied,true);assert.ok(r.attempts>=2);
  assert.equal(await score(A.a),3.8);assert.equal(await score(B.a),3.8);
  const rows=(await db.pool.query('SELECT student_id,exams_score,total_score FROM final_grades WHERE subject_id=$1 ORDER BY student_id',[f.sub.id])).rows;
  assert.deepEqual(rows.map(x=>[Number(x.exams_score),Number(x.total_score)]),[[3.8,13.8],[3.75,13.75]]);
  const backup=(await db.pool.query("SELECT original_data FROM exam_score_decimal_backup WHERE kind='attempt' AND row_id=$1",[A.a.id])).rows[0];
  assert.equal(Number(backup.original_data.score),4);
  assert.equal((await migrate(db.pool)).applied,false);
});

test('exam submission rounds to one decimal and preserves half points',async()=>{
  const f=await examFixture();
  const student=await db.createStudent(++seq,'طالب التقريب',f.stage.id);
  const attempt=await studies.startOrResumeAttempt(f.exam.id,student.id);
  await studies.submitAnswer(attempt.id,f.qs[0].id,'صح');
  await studies.submitAnswer(attempt.id,f.qs[1].id,'صح');
  const result=await studies.finalizeAttempt(attempt.id);
  assert.equal(Number(result.score),2.5); // 2/4 × 5 = 2.5
});

test('report levels: good=full, acceptable=half, weak=0, one best level per week, scaled to the most regular student out of 15',async()=>{
  const stage=await db.addStage('مرحلة المستويات '+(++seq)),ss=(await db.listStageSeasons(stage.id))[0].id;
  const sub=await db.addSubject(stage.id,'مادة التقارير',`ق${seq}`);
  await studies.createMubahathaGroup(sub.id,ss,{title:'مجموعة'});
  const names=['منتظم جيد','منتظم مقبول','نصف جيد ونصف ضعيف','أسبوع بتقريرين','بلا'],S={};
  for(const n of names){S[n]=await db.createStudent(++seq,n,stage.id);await studies.setParticipationMode(S[n].id,sub.id,ss,'report');}
  const add=async(n,w,rating,off=0)=>{
    const r=(await db.pool.query(`INSERT INTO student_reports(student_id,subject_id,stage_season_id,file_kind,note,submitted_at) VALUES($1,$2,$3,'text','تقرير',$4) RETURNING id`,[S[n].id,sub.id,ss,iso(w*7+off)])).rows[0];
    if(rating)await studies.setReportItemRating(r.id,rating,42);return r;
  };
  for(let w=0;w<4;w++){await add('منتظم جيد',w,'good');await add('منتظم مقبول',w,'acceptable');}
  for(let w=0;w<4;w++)await add('نصف جيد ونصف ضعيف',w,w<2?'good':'weak');
  await add('أسبوع بتقريرين',0,'weak');await add('أسبوع بتقريرين',0,'good',1);await add('أسبوع بتقريرين',0,'acceptable',2);
  await assert.rejects(studies.setReportItemRating(1,'ممتاز',42),{message:/جيد أو مقبول أو ضعيف/});
  const g=await studies.computeSeasonGrades(sub.id,ss),by=n=>g.find(x=>x.studentId===S[n].id);
  assert.equal(by('منتظم جيد').reportBenchmark,4);
  assert.equal(by('منتظم جيد').reportScore,15);assert.equal(by('منتظم مقبول').reportScore,7.5);
  assert.equal(by('نصف جيد ونصف ضعيف').reportScore,7.5);
  assert.equal(by('أسبوع بتقريرين').reportWeeks,1);assert.equal(by('أسبوع بتقريرين').reportScore,3.75);
  assert.equal(by('بلا').reportScore,0);
  // الاعتماد يتطلب اكتمال التقييم ثم يحفظ درجة المعيار
  const pending=await add('نصف جيد ونصف ضعيف',5,null);
  await assert.rejects(studies.applyReportAverage(S['نصف جيد ونصف ضعيف'].id,sub.id,ss),{code:'REPORTS_PENDING'});
  await studies.setReportItemRating(pending.id,'good',42);
  const applied=await studies.applyReportAverage(S['نصف جيد ونصف ضعيف'].id,sub.id,ss);
  assert.equal(applied.benchmark,5);assert.equal(applied.points,3);assert.equal(applied.average,9);
  assert.equal(Number((await db.pool.query('SELECT report_score FROM final_grades WHERE student_id=$1',[S['نصف جيد ونصف ضعيف'].id])).rows[0].report_score),9);
  const summary=await studies.getReportGradingSummary(S['نصف جيد ونصف ضعيف'].id,sub.id,ss);
  assert.deepEqual([Number(summary.good),Number(summary.weak)],[3,2]);
});

test('the student sees upcoming exams (scheduled drafts and published) with details, never cancelled, past or other stages',async()=>{
  const stage=await db.addStage('مرحلة القادمة '+(++seq)),other=await db.addStage('مرحلة أخرى '+seq);
  const ss=(await db.listStageSeasons(stage.id))[0].id,oss=(await db.listStageSeasons(other.id))[0].id;
  const sub=await db.addSubject(stage.id,'نحو',`ن${seq}`),osub=await db.addSubject(other.id,'فقه',`ف${seq}`);
  const st=await db.createStudent(++seq,'طالب',stage.id);
  const mk=(subject,season,n,status,open,hours=24,extra='')=>db.pool.query(`INSERT INTO exams(subject_id,stage_season_id,exam_number,title,opens_at,available_hours,closes_at,status${extra?',postponed_count,original_opens_at':''})
    VALUES($1,$2,$3,$4,now()+interval '${open}',$5::int,now()+interval '${open}'+($5::int||' hours')::interval,$6${extra?",1,now()+interval '1 day'":''}) RETURNING id`,[subject,season,n,'موضوع '+n,hours,status]);
  const draft=(await mk(sub.id,ss,2,'draft','5 days',24)).rows[0].id;
  const published=(await mk(sub.id,ss,1,'published','2 days',12,'x')).rows[0].id;
  await mk(sub.id,ss,3,'cancelled','9 days');await mk(osub.id,oss,1,'draft','3 days');
  await db.pool.query(`INSERT INTO exams(subject_id,stage_season_id,exam_number,title,opens_at,available_hours,closes_at,status) VALUES($1,$2,3,'سابق',now()-interval '3 days',24,now()-interval '2 days','published')`,[sub.id,ss]);
  await db.pool.query(`INSERT INTO exam_questions(exam_id,position,question_type,prompt,correct_answer) VALUES($1,1,'tf','س','صح'),($1,2,'tf','ص','صح')`,[published]);
  const list=await studies.getUpcomingExamsForStudent(st.id);
  assert.deepEqual(list.map(e=>e.id),[published,draft]);
  assert.equal(list[0].subject_name,'نحو');assert.equal(list[0].question_count,2);assert.equal(Number(list[0].available_hours),12);assert.equal(Number(list[0].postponed_count),1);
});

test('one-time migration turns every previously graded report above zero into "good" and keeps the old score',async()=>{
  const stage=await db.addStage('مرحلة الترحيل '+(++seq)),ss=(await db.listStageSeasons(stage.id))[0].id;
  const sub=await db.addSubject(stage.id,'مادة الترحيل',`ر${seq}`),st=await db.createStudent(++seq,'طالب',stage.id);
  const ins=(score,at)=>db.pool.query(`INSERT INTO student_reports(student_id,subject_id,stage_season_id,file_kind,note,submitted_at,score) VALUES($1,$2,$3,'text','ت',$4,$5) RETURNING id`,[st.id,sub.id,ss,at,score]).then(r=>r.rows[0].id);
  const high=await ins(12,iso(0)),low=await ins(0.5,iso(7)),zero=await ins(0,iso(14)),pending=await ins(null,iso(21));
  await studies.initStudiesSchema();
  const row=id=>db.pool.query('SELECT score,rating,legacy_score FROM student_reports WHERE id=$1',[id]).then(r=>r.rows[0]);
  assert.deepEqual([Number((await row(high)).score),(await row(high)).rating,Number((await row(high)).legacy_score)],[1,'good',12]);
  assert.deepEqual([Number((await row(low)).score),(await row(low)).rating],[1,'good']);
  assert.deepEqual([Number((await row(zero)).score),(await row(zero)).rating],[0,null],'الصفر لا يتغير');
  assert.deepEqual([(await row(pending)).score,(await row(pending)).rating],[null,null],'غير المقيَّم يبقى بانتظار التقييم');
  await studies.initStudiesSchema(); // إعادة التشغيل لا تغيّر شيئًا
  assert.equal(Number((await row(high)).legacy_score),12);
});

test('reports may only be sent Wednesday–Friday, one per week; repeats are refused even if graded',async()=>{
  const stage=await db.addStage('مرحلة الأيام '+(++seq)),ss=(await db.listStageSeasons(stage.id))[0].id;
  const sub=await db.addSubject(stage.id,'مادة الأيام',`ي${seq}`),st=await db.createStudent(++seq,'طالب',stage.id);
  // 2026-01-05 الاثنين. الأحد 4 كانون الثاني بداية أسبوع (الأحد–السبت) بتوقيت بغداد.
  const at=day=>new Date(Date.UTC(2026,0,day,9)).toISOString();
  const block=(day)=>studies.getReportSubmissionBlock(st.id,sub.id,ss,{at:at(day)});
  assert.equal((await block(4)).code,'WRONG_DAY');assert.equal((await block(5)).code,'WRONG_DAY');assert.equal((await block(6)).code,'WRONG_DAY');
  assert.equal((await block(11)).code,'WRONG_DAY');assert.equal(await block(10),null,'السبت يقبل التقرير المتأخر لمن لم يرسل');
  for(const d of [7,8,9])assert.equal(await block(d),null,'الأربعاء والخميس والجمعة مفتوحة');
  const r=await db.pool.query(`INSERT INTO student_reports(student_id,subject_id,stage_season_id,file_kind,note,submitted_at,score,rating) VALUES($1,$2,$3,'text','ت',$4,1,'good') RETURNING id`,[st.id,sub.id,ss,at(7)]);
  assert.equal((await block(8)).code,'WEEK_USED');assert.equal((await block(9)).code,'WEEK_USED');assert.equal((await block(10)).code,'WEEK_USED','من أرسل في الأسبوع لا يرسل متأخرًا');
  assert.equal(await block(14),null,'الأسبوع التالي يبدأ من جديد');
  // تقرير قديم أُرسل الاثنين لا يمنع إرسال هذا الأسبوع
  const st2=await db.createStudent(++seq,'طالب2',stage.id);
  await db.pool.query(`INSERT INTO student_reports(student_id,subject_id,stage_season_id,file_kind,note,submitted_at) VALUES($1,$2,$3,'text','ت',$4)`,[st2.id,sub.id,ss,at(5)]);
  assert.equal(await studies.getReportSubmissionBlock(st2.id,sub.id,ss,{at:at(8)}),null);
  assert.deepEqual(studies.REPORT_SEND_DAYS,[3,4,5]);
});
