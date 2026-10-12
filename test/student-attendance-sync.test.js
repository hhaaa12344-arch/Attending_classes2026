'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { testDatabase } = require('./helpers.cjs');
const { createAdminServer } = require('../adminServer');
const { createLessonAttendance } = require('../lessonAttendance');
const { repairLateMarkedAttendance, KEY } = require('../attendanceKindRepair');

const botToken = '12345:LOCAL_ONLY';
let db, studies, server, base, token, att;
let stageA, stageB, ssA, fiqh, aqeedah, nahw, ali, sara, outsider;
const lessons = {};

function signed(id = 42) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: 'إدارة اختبار' }) });
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  p.set('hash', createHmac('sha256', secret).update([...p].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n')).digest('hex'));
  return p.toString();
}
async function request(route, body, method = body ? 'POST' : 'GET') {
  return fetch(base + '/api/admin' + route, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
// درس منشور قبل hoursAgo ساعة ومهلته انتهت قبل closedAgo ساعة (سالب = ما زال مفتوحًا)
async function lesson(subject, hoursAgo, closedAgo) {
  const l = await db.activateLesson(subject.id);
  await db.pool.query("UPDATE lessons SET activated_at=now()-($2||' hours')::interval,active_until=now()-($3||' hours')::interval WHERE id=$1", [l.id, String(hoursAgo), String(closedAgo)]);
  return l;
}
const reportOf = async (student, subject) => (await db.getStudentSeasonReport(student.id, ssA)).find((r) => r.subject_id === subject.id);
const matrixOf = async (student, subject) => {
  const m = await att.matrix({ stageId: stageA.id });
  return m.rows.find((r) => r.id === student.id).attendance.find((a) => a.subject_id === subject.id);
};
const agree = async (student, subject) => {
  const r = await reportOf(student, subject), m = await matrixOf(student, subject);
  return { student: Number(r.attended_lessons), panel: m.attended, studentTotal: Number(r.total_lessons), panelTotal: m.total };
};

test.before(async () => {
  ({ db, studies } = await testDatabase());
  att = createLessonAttendance(db.pool);
  stageA = await db.addStage('مرحلة تزامن الحضور أ');
  stageB = await db.addStage('مرحلة تزامن الحضور ب');
  ssA = (await db.listStageSeasons(stageA.id))[0].id;
  fiqh = await db.addSubject(stageA.id, 'الفقه', 'fiqh_sync');
  aqeedah = await db.addSubject(stageA.id, 'العقائد', 'aqeedah_sync');
  nahw = await db.addSubject(stageA.id, 'النحو', 'nahw_sync');
  ali = await db.createStudent(810001, 'أحمد علي حسين كاظم', stageA.id);
  sara = await db.createStudent(810002, 'زينب هادي كريم جواد', stageA.id);
  outsider = await db.createStudent(810003, 'مصطفى جاسم ناصر عباس', stageB.id);
  await db.pool.query("UPDATE enrollments SET started_at=now()-interval '20 days' WHERE student_id IN ($1,$2)", [ali.id, sara.id]);
  // الفقه: ثلاثة منتهية + واحد ما زال مفتوحًا. العقائد: اثنان منتهيان. النحو: درس قديم نُشر وانتهى قبل التحاقه.
  lessons.f1 = await lesson(fiqh, 100, 76); lessons.f2 = await lesson(fiqh, 80, 56); lessons.f3 = await lesson(fiqh, 60, 36);
  lessons.fOpen = await lesson(fiqh, 2, -22);
  lessons.a1 = await lesson(aqeedah, 90, 66); lessons.a2 = await lesson(aqeedah, 50, 26);
  lessons.nOld = await lesson(nahw, 900, 876);
  const sg = createAdminServer({ db, studies, adminData: require('../adminData').createAdminData(db, studies), scheduler: require('../scheduler').createScheduler({ pool: db.pool, studies }), botToken, adminIds: [42], origin: 'https://institute.example' });
  server = sg; await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  token = (await (await fetch(base + '/api/admin/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: signed() }) })).json()).token;
});
test.after(async () => { if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); } if (db) await db.pool.end(); });

test('bug: mass attendance on an expired lesson now shows the same number to the admin and to the student', async () => {
  const before = await agree(ali, fiqh);
  assert.equal(before.student, 0);
  await db.markAllPresentForLesson(lessons.f1.id, 42);
  const row = (await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1 AND student_id=$2', [lessons.f1.id, ali.id])).rows[0];
  assert.equal(row.marking_kind, 'admin_late');
  assert.equal(Number(row.marked_by), 42);
  const after = await agree(ali, fiqh);
  assert.equal(after.student, 1, 'the student report counts it');
  assert.equal(after.panel, after.student, 'panel and student agree');
});

test('mass attendance on a lesson that is still open stays an ordinary in-window attendance', async () => {
  await db.markAllPresentForLesson(lessons.fOpen.id, 42);
  const row = (await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1 AND student_id=$2', [lessons.fOpen.id, ali.id])).rows[0];
  assert.equal(row.marking_kind, 'student');
  const r = await agree(ali, fiqh);
  assert.equal(r.student, r.panel);
});

test('the panel never counts what the student report ignores (stale rows saved after the deadline)', async () => {
  await db.pool.query("INSERT INTO attendance(student_id,lesson_id,listened_at) VALUES($1,$2,now())", [sara.id, lessons.a1.id]);
  const r = await agree(sara, aqeedah);
  assert.equal(r.student, 0);
  assert.equal(r.panel, 0, 'before the repair the panel agrees with the student instead of overstating');
});

test('one-time repair converts those stale rows, refreshes absence, keeps genuine rows, and runs once', async () => {
  const genuine = await db.pool.query('SELECT id,marking_kind FROM attendance WHERE lesson_id=$1 AND student_id=$2', [lessons.fOpen.id, ali.id]);
  await db.pool.query('DELETE FROM applied_migrations WHERE key=$1', [KEY]);
  const first = await repairLateMarkedAttendance(db.pool);
  assert.equal(first.skipped, false);
  assert.equal(first.repaired, 1);
  const fixed = (await db.pool.query('SELECT * FROM attendance WHERE lesson_id=$1 AND student_id=$2', [lessons.a1.id, sara.id])).rows[0];
  assert.equal(fixed.marking_kind, 'admin_late');
  assert.match(fixed.admin_note, /تصحيح تلقائي/);
  const r = await agree(sara, aqeedah);
  assert.equal(r.student, 1);
  assert.equal(r.panel, 1);
  assert.equal((await db.pool.query('SELECT marking_kind FROM attendance WHERE id=$1', [genuine.rows[0].id])).rows[0].marking_kind, 'student');
  assert.deepEqual(await repairLateMarkedAttendance(db.pool), { skipped: true, repaired: 0 });
});

test('missing lessons: exactly what the student report counts as a shortfall, open lessons flagged, pre-enrolment lessons excluded', async () => {
  const data = await (await request(`/students/${ali.id}/missing-lessons`)).json();
  assert.equal(data.season.stage_name.includes('تزامن الحضور أ'), true);
  const byName = Object.fromEntries(data.subjects.map((s) => [s.subject_name, s.lessons]));
  assert.deepEqual(byName['الفقه'].map((l) => l.id), [lessons.f2.id, lessons.f3.id], 'f1 attended by admin, fOpen attended by mass attendance');
  assert.deepEqual(byName['العقائد'].map((l) => [l.id, l.lesson_number]), [[lessons.a1.id, 1], [lessons.a2.id, 2]]);
  assert.equal(byName['النحو'], undefined, 'published and closed before enrolment: not his shortfall');
  assert.equal(data.notCounted, 1);
  assert.equal(data.totalMissing, 4);
  const rep = await reportOf(ali, fiqh);
  assert.equal(Number(rep.total_lessons) - Number(rep.attended_lessons), byName['الفقه'].length, 'matches the shortfall in the student report');
  await db.pool.query('DELETE FROM attendance WHERE student_id=$1 AND lesson_id=$2', [sara.id, lessons.fOpen.id]);
  const open = await (await request(`/students/${sara.id}/missing-lessons`)).json();
  const fiqhOpen = open.subjects.find((s) => s.subject_name === 'الفقه').lessons.find((l) => l.id === lessons.fOpen.id);
  assert.equal(fiqhOpen.is_open, true);
});

test('HTTP: register missing lessons for a student; report and panel change together; audit is written', async () => {
  const done = await request(`/students/${ali.id}/late-attendance`, { lessonIds: [lessons.f2.id, lessons.a1.id], note: 'استمع خارج المهلة' });
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { added: 2, existing: 0 });
  assert.equal((await agree(ali, fiqh)).student, (await agree(ali, fiqh)).panel);
  assert.equal((await agree(ali, aqeedah)).student, 1);
  const rows = (await db.pool.query('SELECT * FROM attendance WHERE student_id=$1 AND lesson_id=ANY($2::int[])', [ali.id, [lessons.f2.id, lessons.a1.id]])).rows;
  assert.ok(rows.every((r) => r.marking_kind === 'admin_late' && Number(r.marked_by) === 42 && r.admin_note === 'استمع خارج المهلة'));
  const audit = (await db.pool.query("SELECT * FROM admin_audit_log WHERE action='late_lesson_attendance' ORDER BY id DESC LIMIT 2")).rows;
  assert.equal(audit.length, 2);
  const again = await (await request(`/students/${ali.id}/late-attendance`, { lessonIds: [lessons.f2.id] })).json();
  assert.deepEqual(again, { added: 0, existing: 1 });
  const after = await (await request(`/students/${ali.id}/missing-lessons`)).json();
  assert.ok(!after.subjects.flatMap((s) => s.lessons).some((l) => l.id === lessons.f2.id));
});

test('HTTP: an open lesson, a foreign-stage student, or bad input is refused and nothing at all is saved', async () => {
  const before = Number((await db.pool.query('SELECT COUNT(*) AS n FROM attendance')).rows[0].n);
  let r = await request(`/students/${sara.id}/late-attendance`, { lessonIds: [lessons.f3.id, lessons.fOpen.id] });
  assert.equal(r.status, 409, 'open lesson');
  r = await request(`/students/${outsider.id}/late-attendance`, { lessonIds: [lessons.f3.id] });
  assert.equal(r.status, 409, 'student is not enrolled in that stage');
  assert.equal((await request(`/students/${sara.id}/late-attendance`, { lessonIds: [] })).status, 400);
  assert.equal((await request(`/students/${sara.id}/late-attendance`, { lessonIds: ['x'] })).status, 400);
  assert.equal((await request('/students/999999/missing-lessons')).status, 404);
  assert.equal(Number((await db.pool.query('SELECT COUNT(*) AS n FROM attendance')).rows[0].n), before, 'all-or-nothing');
});

test('HTTP: search finds any student in any stage, ignoring hamza differences', async () => {
  let list = await (await request('/students?q=' + encodeURIComponent('احمد') + '&status=all')).json();
  assert.ok(list.rows.some((s) => s.id === ali.id), 'أحمد found by typing احمد');
  list = await (await request('/students?q=' + encodeURIComponent('مصطفى') + '&status=all')).json();
  assert.deepEqual(list.rows.map((s) => [s.id, s.stage_name]), [[outsider.id, stageB.name]], 'a student of another stage');
  list = await (await request('/students?q=' + encodeURIComponent('%') + '&status=all')).json();
  assert.equal(list.total, 0, 'a percent sign is literal text, not a wildcard');
});

test('discussions: admin attendance for a session counts for the student exactly like the panel', async () => {
  const sub = await db.addSubject(stageA.id, 'المنطق', 'mantiq_sync');
  const group = await studies.createMubahathaGroup(sub.id, ssA, { title: 'المجموعة 1' });
  await studies.changeParticipationMode(sara.id, sub.id, ssA, 'mubahatha', {});
  await db.pool.query('INSERT INTO group_memberships(student_id,group_id,subject_id,stage_season_id) VALUES($1,$2,$3,$4)', [sara.id, group.id, sub.id, ssA]);
  const times = [];
  for (const h of [72, 48, 24]) {
    const s = (await db.pool.query(`INSERT INTO mubahatha_sessions(group_id,opened_at,closes_at,is_closed,title)
      VALUES($1,now()-($2||' hours')::interval,now()-($2||' hours')::interval+interval '1 hour',true,'جلسة') RETURNING id`, [group.id, String(h)])).rows[0];
    times.push(s.id);
  }
  await db.pool.query("UPDATE group_memberships SET assigned_at=now()-interval '10 days' WHERE student_id=$1", [sara.id]);
  await db.pool.query("UPDATE participation_modes SET joined_mubahatha_at=now()-interval '10 days',chosen_at=now()-interval '10 days' WHERE student_id=$1 AND subject_id=$2", [sara.id, sub.id]);
  const discussionAttendance = require('../discussionAttendance').createDiscussionAttendance(db.pool);
  await discussionAttendance.mark(times[0], { studentIds: [sara.id], subjectId: sub.id }, 42);
  await db.pool.query("INSERT INTO mubahatha_attendance(session_id,student_id,phase) VALUES($1,$2,'start')", [times[1], sara.id]);
  const rows = await studies.listDiscussionAttendanceForTeacher(sub.id, ssA);
  const mine = rows.find((r) => r.student_id === sara.id);
  assert.equal(Number(mine.eligible_sessions), 3);
  assert.equal(Number(mine.attended_sessions), 1, 'the admin-marked session counts as complete for the student');
  assert.equal(Number(mine.incomplete_sessions), 1, 'start-only attendance stays incomplete');
  const panel = (await (await request('/sessions?seasonId=' + ssA)).json()).find((s) => s.id === times[0]);
  assert.equal(Number(panel.complete_count), 1);
  const grades = (await studies.computeSeasonGrades(sub.id, ssA)).find((g) => g.studentId === sara.id);
  assert.equal(grades.attendedSessions, 1);
});

test('admin shell: search entry, student search view, missing-lessons section and its actions are wired', async () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(require.resolve('../admin/index.html'), 'utf8');
  const app = fs.readFileSync(require.resolve('../admin/app.js'), 'utf8');
  assert.match(html, /data-action="student-search"/);
  for (const needle of ["a==='student-search'", "a==='search-student'", "form.id==='student-search-form'", "form.id==='student-late-form'", "'/missing-lessons'", "/late-attendance'", "view==='student-search'"]) {
    assert.ok(app.includes(needle), needle);
  }
});
