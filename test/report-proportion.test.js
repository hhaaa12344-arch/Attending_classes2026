'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { testDatabase } = require('./helpers.cjs');

let db, studies, stage, ss, subject, teacher, group;
const students = {};

// 2026-01-05 is a Monday; each +7 days is a new calendar week in Asia/Baghdad.
const week = (n, dayOffset = 0) => new Date(Date.UTC(2026, 0, 5 + n * 7 + dayOffset, 9, 0, 0)).toISOString().slice(0, -1);
async function addReport(studentId, at, score = 10) {
  await db.pool.query(
    `INSERT INTO student_reports(student_id,subject_id,stage_season_id,file_kind,note,submitted_at,score)
     VALUES($1,$2,$3,'text','تقرير',$4,$5)`,
    [studentId, subject.id, ss, at, score]
  );
}

test.before(async () => {
  ({ db, studies } = await testDatabase());
  stage = await db.addStage('مرحلة التقارير');
  ss = (await db.listStageSeasons(stage.id))[0].id;
  subject = await db.addSubject(stage.id, 'مادة التقارير', 'reports');
  teacher = await db.addTeacher('أستاذ التقارير');
  group = await studies.createMubahathaGroup(subject.id, ss, { title: 'مجموعة التقارير' });
  let tg = 7000;
  for (const name of ['منتظم', 'متوسط', 'مكثّف في أسبوع', 'بلا تقارير']) {
    const st = await db.createStudent(tg++, 'طالب ' + name, stage.id);
    await studies.setParticipationMode(st.id, subject.id, ss, 'report');
    students[name] = st;
  }
});
test.after(async () => { if (db) await db.pool.end(); });

test('report score = student weeks / highest weeks × 15, ignoring teacher scores and same-week bursts', async () => {
  // منتظم: 4 weeks, one report each week
  for (let w = 0; w < 4; w++) await addReport(students['منتظم'].id, week(w));
  // متوسط: 2 weeks; the teacher gave full marks, which must not matter
  await addReport(students['متوسط'].id, week(0), 15);
  await addReport(students['متوسط'].id, week(2), 15);
  // مكثّف: 30 reports inside a single week must count as one week, not inflate the benchmark
  for (let i = 0; i < 30; i++) await addReport(students['مكثّف في أسبوع'].id, week(1, i % 5));

  // تقارير غير مُقيَّمة (وهمية/مكررة) في أسابيع لاحقة لا تُحتسب ولا ترفع المعيار
  for (let w = 4; w < 9; w++) await addReport(students['متوسط'].id, week(w), null);
  for (let w = 4; w < 9; w++) await addReport(students['بلا تقارير'].id, week(w), null);
  // تقرير رفضه الأستاذ بدرجة صفر لا يُحتسب أيضًا
  await addReport(students['بلا تقارير'].id, week(9), 0);

  const grades = await studies.computeSeasonGrades(subject.id, ss);
  const by = (n) => grades.find((g) => g.studentId === students[n].id);
  assert.equal(by('منتظم').reportBenchmark, 4);
  assert.equal(by('منتظم').reportWeeks, 4);
  assert.equal(by('منتظم').reportScore, 15);
  assert.equal(by('متوسط').reportScore, 7.5);
  assert.equal(by('مكثّف في أسبوع').reportWeeks, 1);
  assert.equal(by('مكثّف في أسبوع').reportCount, 30);
  assert.equal(by('بلا تقارير').reportWeeks, 0);
  assert.equal(by('مكثّف في أسبوع').reportScore, 3.75);
  assert.equal(by('بلا تقارير').reportScore, 0);
});

test('manual or average report scores are replaced by the proportional score on finalization', async () => {
  await studies.setReportScore(students['متوسط'].id, subject.id, ss, 15);
  await studies.finalizeSeasonGrades(subject.id, ss);
  const row = (await db.pool.query(
    'SELECT report_score,participation_score FROM final_grades WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3',
    [students['متوسط'].id, subject.id, ss]
  )).rows[0];
  assert.equal(Number(row.report_score), 7.5);
  assert.equal(Number(row.participation_score), 7.5);
});

test('benchmark is zero (and scores zero) when nobody submitted a report', async () => {
  const stage2 = await db.addStage('مرحلة بلا تقارير');
  const ss2 = (await db.listStageSeasons(stage2.id))[0].id;
  const sub2 = await db.addSubject(stage2.id, 'مادة فارغة', 'empty');
  const st = await db.createStudent(7100, 'طالب فارغ', stage2.id);
  await studies.setParticipationMode(st.id, sub2.id, ss2, 'report');
  const [g] = await studies.computeSeasonGrades(sub2.id, ss2);
  assert.equal(g.reportBenchmark, 0);
  assert.equal(g.reportScore, 0);
});

test('teacher session log counts students who attended both start and end', async () => {
  await db.pool.query(
    `INSERT INTO schedule_slots(group_id,subject_id,stage_season_id,teacher_id,day_of_week,hour) VALUES($1,$2,$3,$4,1,18)`,
    [group.id, subject.id, ss, teacher.id]
  );
  const slot = (await db.pool.query('SELECT id FROM schedule_slots WHERE group_id=$1', [group.id])).rows[0];
  const session = await studies.openSession(group.id, teacher.id, 'مباحثة الحضور الكامل', 1);
  await db.pool.query("INSERT INTO slot_decisions(slot_id,scheduled_date,decision,session_id) VALUES($1,CURRENT_DATE,'confirmed',$2)", [slot.id, session.id]);
  const [a, b, c] = [students['منتظم'], students['متوسط'], students['مكثّف في أسبوع']];
  for (const [st, phases] of [[a, ['start', 'end']], [b, ['start', 'end']], [c, ['start']]]) {
    for (const phase of phases) await db.pool.query('INSERT INTO mubahatha_attendance(session_id,student_id,phase) VALUES($1,$2,$3)', [session.id, st.id, phase]);
  }
  const [row] = await db.getTeacherSessionLog(teacher.id);
  assert.equal(row.held, true);
  assert.equal(row.full_attendees, 2);

  await db.pool.query("UPDATE slot_decisions SET decision='postponed',session_id=NULL WHERE slot_id=$1", [slot.id]);
  const [postponed] = await db.getTeacherSessionLog(teacher.id);
  assert.equal(postponed.held, false);
  assert.equal(postponed.full_attendees, null);
});

test('menu cleanup never deletes a menu message newer than the one just sent', async () => {
  const st = students['منتظم'];
  for (const id of [101, 102, 103]) await db.recordStudentUiMessage(st.id, id, 'menu');
  // two concurrent updates: the older one (102) finishing last must not remove 103
  const removedByOlder = await db.takeStudentUiMessages(st.id, true, 102);
  assert.deepEqual(removedByOlder, [101]);
  const removedByNewer = await db.takeStudentUiMessages(st.id, true, 103);
  assert.deepEqual(removedByNewer.sort(), [102]);
  const left = await db.pool.query('SELECT message_id FROM student_ui_messages WHERE student_id=$1 ORDER BY message_id', [st.id]);
  assert.deepEqual(left.rows.map((r) => Number(r.message_id)), [103]);
});

test('week runs Sunday to Saturday: Wed and Sat of one week count once, next week counts again', async () => {
  const stage3 = await db.addStage('مرحلة الأسابيع');
  const ss3 = (await db.listStageSeasons(stage3.id))[0].id;
  const sub3 = await db.addSubject(stage3.id, 'مادة الأسابيع', 'weeks');
  const st = await db.createStudent(7200, 'طالب الأسابيع', stage3.id);
  await studies.setParticipationMode(st.id, sub3.id, ss3, 'report');
  // 2026-01-07 Wed, 01-10 Sat (same week); 01-14 Wed next week; 01-17 Sat next week
  for (const d of ['2026-01-07', '2026-01-10', '2026-01-14', '2026-01-17']) {
    await db.pool.query(`INSERT INTO student_reports(student_id,subject_id,stage_season_id,file_kind,note,submitted_at,score) VALUES($1,$2,$3,'text','x',$4,10)`, [st.id, sub3.id, ss3, d + 'T09:00:00']);
  }
  const [g] = await studies.computeSeasonGrades(sub3.id, ss3);
  assert.equal(g.reportWeeks, 2);
});
