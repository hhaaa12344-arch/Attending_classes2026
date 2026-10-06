'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
process.env.BOT_TOKEN = '12345:OFFLINE_TEST_ONLY';
process.env.DATABASE_URL = 'postgresql://localhost/attendance_test_unused';
process.env.ADMIN_IDS = '42';
const { Telegram } = require('telegraf');
const { testDatabase } = require('./helpers.cjs');

const calls = [];
let messageId = 20000;
const original = Telegram.prototype.callApi;
Telegram.prototype.callApi = async function (method, payload) {
  calls.push({ method, ...payload });
  if (method === 'getMe') return { id: 12345, is_bot: true, username: 'AttendanceTestBot', first_name: 'test' };
  return { message_id: messageId++, chat: { id: payload.chat_id, type: 'private' }, text: payload.text };
};

let db, studies, adminData, app, duplicates, stage, otherStage, ss, subject, teacher, group;
let original1, twin1, solo;
const press = (data, from = 42) => {
  calls.length = 0;
  const user = { id: from, is_bot: false, first_name: 'test' };
  const message = { message_id: messageId++, date: Math.floor(Date.now() / 1000), from: user, chat: { id: from, type: 'private' }, text: '' };
  return app.bot.handleUpdate({ update_id: messageId, callback_query: { id: 'cb' + messageId, from: user, data, message } });
};
const buttons = () => calls.flatMap((c) => c.reply_markup?.inline_keyboard?.flat() || []);
const texts = () => calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).map((c) => c.text);

test.before(async () => {
  ({ db, studies } = await testDatabase());
  await require('../backups').initBackupSchema(db.pool);
  await require('../studentGuide').initStudentGuideSchema(db.pool);
  adminData = require('../adminData').createAdminData(db, studies);
  duplicates = require('../duplicateStudents').createDuplicateStudents(db.pool);
  stage = await db.addStage('المقدمات المرحلة الأولى - المستوى الثاني');
  otherStage = await db.addStage('مرحلة أخرى');
  ss = (await db.listStageSeasons(stage.id))[0].id;
  subject = await db.addSubject(stage.id, 'المنطق ج1 القسم الثاني', 'منطق_ج1');
  teacher = await db.addTeacher('أستاذ');
  group = await studies.createMubahathaGroup(subject.id, ss, { title: 'المجموعة 2' });
  // السجل الأصلي: له مجموعة وحضور. التوأم: فارغ. وطالب منفرد باسم مختلف.
  original1 = await db.createStudent(500001111, 'حسين سمير مجيد رشيد', stage.id);
  twin1 = await db.createStudent(500002222, 'حسين  سمير مجيد رشيد', stage.id); // مسافتان
  solo = await db.createStudent(500003333, 'علي كريم ناصر', stage.id);
  await studies.changeParticipationMode(original1.id, subject.id, ss, 'mubahatha', {});
  await db.pool.query('INSERT INTO group_memberships(student_id,group_id,subject_id,stage_season_id) VALUES($1,$2,$3,$4)', [original1.id, group.id, subject.id, ss]);
  app = require('../index');
  app.bot.botInfo = { id: 12345, is_bot: true, username: 'AttendanceTestBot', first_name: 'test' };
});
test.after(async () => { Telegram.prototype.callApi = original; if (db) await db.pool.end(); });

test('name key ignores extra spaces and Arabic letter variants but never merges different names', async () => {
  const key = async (n) => (await db.pool.query('SELECT student_name_key($1) AS k', [n])).rows[0].k;
  assert.equal(await key('  أحمد   إبراهيم  '), await key('احمد ابراهيم'));
  assert.equal(await key('فاطمة علي'), await key('فاطمه علي'));
  assert.equal(await key('مصطفى'), await key('مصطفي'));
  assert.notEqual(await key('حسين علي'), await key('حسن علي'));
});

test('twins lists the other records of the same name with groups and activity, never itself', async () => {
  const list = await duplicates.twins(original1.id);
  assert.deepEqual(list.map((t) => t.id), [twin1.id]);
  assert.equal(list[0].groups_count, 0);
  assert.equal(list[0].activity_count, 0);
  const back = await duplicates.twins(twin1.id);
  assert.deepEqual(back.map((t) => t.id), [original1.id]);
  assert.equal(back[0].groups_count, 1);
  assert.deepEqual(await duplicates.twins(solo.id), []);
});

test('the admin student list marks a name that exists twice among active students', async () => {
  const rows = (await adminData.students({ stageId: stage.id, status: 'all' })).rows;
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.same_name_active_others]));
  assert.equal(byId[original1.id], 1);
  assert.equal(byId[twin1.id], 1);
  assert.equal(byId[solo.id], 0);
});

test('search buttons tell the two records apart even when the label is cut by Telegram', async () => {
  await press(`students_page:${stage.id}:0`);
  const labels = buttons().filter((b) => b.callback_data?.startsWith('stu_select:')).map((b) => b.text);
  const a = labels.find((l) => l.includes('…1111'));
  const b = labels.find((l) => l.includes('…2222'));
  assert.ok(a && b, JSON.stringify(labels));
  assert.ok(a.includes('⚠️') && b.includes('⚠️'), 'both records carry the duplicate mark');
  assert.match(a, /1 مجموعة/);
  assert.match(b, /بلا مجموعات/);
  assert.ok(!labels.find((l) => l.includes('علي كريم')).includes('⚠️'), 'a unique name is not marked');
  assert.ok(labels.every((l) => l.length <= 64), 'labels stay within the button limit');
});

test('the admin profile shows the Telegram ID, the twin record and a button to open it', async () => {
  await press(`stu_select:${twin1.id}`);
  const text = texts().find((t) => /الطالب:/.test(t));
  assert.match(text, /معرّف تليجرام: 500002222/);
  assert.match(text, /سجلات أخرى بالاسم نفسه \(1\)/);
  assert.match(text, /معرّف تليجرام 500001111 — 1 مجموعة، 0 سجل حضور/);
  assert.match(text, /لا يوجد دمج تلقائي/);
  assert.ok(buttons().some((b) => b.callback_data === `stu_select:${original1.id}` && /…1111/.test(b.text)), 'one tap opens the twin');
  await press(`stu_select:${solo.id}`);
  assert.ok(!/سجلات أخرى/.test(texts().find((t) => /الطالب:/.test(t))), 'no warning for a unique name');
});

test('the duplicates screen lists clusters of active students only and is admin-only', async () => {
  await press('students_duplicates:0');
  const text = texts()[0];
  assert.match(text, /أسماء مكررة بين الطلبة النشطين \(1\)/);
  assert.match(text, /…1111/);
  assert.match(text, /…2222/);
  assert.equal(buttons().filter((b) => b.callback_data?.startsWith('stu_select:')).length, 2);
  await press('students_duplicates:0', 90909);
  assert.ok(calls.some((c) => c.method === 'answerCallbackQuery' && /غير مصرح/.test(c.text || '')), 'a non-admin is refused');
  assert.ok(!texts().some((t) => /أسماء مكررة/.test(t || '')));
  // archiving the empty twin resolves the cluster
  await db.pool.query('UPDATE students SET is_active=false WHERE id=$1', [twin1.id]);
  await press('students_duplicates:0');
  assert.match(texts()[0], /لا توجد أسماء مكررة بين الطلبة النشطين/);
  const rows = (await adminData.students({ stageId: stage.id, status: 'all' })).rows;
  assert.equal(rows.find((r) => r.id === original1.id).same_name_active_others, 0, 'the mark disappears once one record is archived');
  await db.pool.query('UPDATE students SET is_active=true WHERE id=$1', [twin1.id]);
});

test('the same name in two different stages is also detected', async () => {
  const other = await db.createStudent(500004444, 'علي كريم ناصر', otherStage.id);
  const list = await duplicates.twins(solo.id);
  assert.deepEqual(list.map((t) => t.id), [other.id]);
  assert.equal(list[0].stage_name, 'مرحلة أخرى');
  const clusters = await duplicates.clusters({ page: 0, size: 10 });
  assert.equal(clusters.total, 2);
  await db.pool.query('DELETE FROM students WHERE id=$1', [other.id]);
});

// ---------------------------------------------------------------- the teacher mini-app finish route
function initData(botToken, user) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user), query_id: 'AAA' });
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

test('teacher mini-app: the finish route reports the real reason instead of claiming success', async () => {
  const scheduler = require('../scheduler').createScheduler({ pool: db.pool, studies });
  const teacherTelegram = 700123;
  await db.pool.query('UPDATE teachers SET telegram_id=$2 WHERE id=$1', [teacher.id, teacherTelegram]);
  await db.pool.query('INSERT INTO teaching_assignments(teacher_id,subject_id,stage_season_id) VALUES($1,$2,$3)', [teacher.id, subject.id, ss]);
  const handle = require('../teacherWeb').createTeacherWeb({ db, studies, scheduler, botToken: process.env.BOT_TOKEN, origin: 'https://institute.example',
    readJson: async (req) => req.body || {} });
  const call = async (method, path, body, token) => {
    const req = { method, headers: { origin: 'https://institute.example', ...(token ? { authorization: 'Bearer ' + token } : {}) }, socket: { remoteAddress: '1.2.3.4' }, body };
    let status = 0, payload = null;
    const res = { writeHead: (c) => { status = c; }, end: (b) => { payload = b ? JSON.parse(b) : null; } };
    const handled = await handle(req, res, new URL(path, 'https://institute.example'));
    return { handled, status, payload };
  };
  const auth = await call('POST', '/api/teacher/auth', { initData: initData(process.env.BOT_TOKEN, { id: teacherTelegram, first_name: 'أستاذ' }) });
  assert.equal(auth.status, 200);
  const token = auth.payload.token;
  const newSession = async (openedMinutesAgo) => (await db.pool.query(`INSERT INTO mubahatha_sessions(group_id,teacher_id,title,opened_at,closes_at,held_on,start_notifications_queued)
    VALUES($1,$2,'جلسة',now()-($3||' minutes')::interval,now()+interval '45 minutes',current_date,true) RETURNING id`, [group.id, teacher.id, String(openedMinutesAgo)])).rows[0].id;

  const early = await newSession(3);
  await assert.rejects(call('POST', `/api/teacher/sessions/${early}/end`, {}, token), (e) => e.code === 'CONFLICT' && /قبل مرور 10 دقائق|بعد بدء حضور البداية/.test(e.message));
  const ok = await newSession(15);
  const done = await call('POST', `/api/teacher/sessions/${ok}/end`, {}, token);
  assert.equal(done.status, 200);
  assert.equal(done.payload.status, 'opened');
  const again = await call('POST', `/api/teacher/sessions/${ok}/end`, {}, token);
  assert.equal(again.status, 200, 'pressing again is harmless');
  assert.equal(again.payload.status, 'already_open');
  const inactive = await newSession(15);
  await db.pool.query('UPDATE mubahatha_groups SET is_active=false WHERE id=$1', [group.id]);
  await assert.rejects(call('POST', `/api/teacher/sessions/${inactive}/end`, {}, token), { code: 'CONFLICT' });
  await db.pool.query('UPDATE mubahatha_groups SET is_active=true WHERE id=$1', [group.id]);
});

test('the unexpected-error message carries a reference code that is also logged with the pressed button', async () => {
  const logged = [];
  const realError = console.error;
  const realRecord = studies.recordSlotDecision;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  studies.recordSlotDecision = async () => { throw new Error('boom'); };
  try {
    await press('slot_yes:1:2026-10-05');
    const reply = calls.find((c) => c.method === 'sendMessage');
    const code = /رمز (\d+)/.exec(reply.text);
    assert.ok(code, reply.text);
    assert.ok(logged.some((l) => l.includes(`التحديث ${code[1]} [slot_yes:1:2026-10-05]`)));
  } finally {
    console.error = realError;
    studies.recordSlotDecision = realRecord;
  }
});
