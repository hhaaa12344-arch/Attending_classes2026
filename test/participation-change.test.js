'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.BOT_TOKEN = '12345:OFFLINE_TEST_ONLY';
process.env.DATABASE_URL = 'postgresql://localhost/attendance_test_unused';
process.env.ADMIN_IDS = '42';
const { Telegram } = require('telegraf');
const { testDatabase } = require('./helpers.cjs');

const messages = [];
let messageId = 5000;
const original = Telegram.prototype.callApi;
Telegram.prototype.callApi = async function (method, payload) {
  messages.push({ method, ...payload });
  if (method === 'getMe') return { id: 12345, is_bot: true, username: 'AttendanceTestBot', first_name: 'test' };
  return { message_id: messageId++, chat: { id: payload.chat_id, type: 'private' }, text: payload.text };
};

let db, studies, app, stage, ss, fiqh, nahw, student, group;
const STUDENT = 91001;
const INVITE = 'https://t.me/+GroupInviteCode123';

async function send(id, text, data) {
  messages.length = 0;
  const from = { id, is_bot: false, first_name: 'test' };
  const message = { message_id: messageId++, date: Math.floor(Date.now() / 1000), from, chat: { id, type: 'private' }, text };
  await app.bot.handleUpdate(data
    ? { update_id: messageId, callback_query: { id: 'cb' + messageId, from, data, message } }
    : { update_id: messageId, message });
  return messages;
}
const buttons = () => messages.flatMap((m) => m.reply_markup?.inline_keyboard?.flat() || []);
const toChat = (id) => messages.filter((m) => Number(m.chat_id) === Number(id) && ['sendMessage', 'editMessageText'].includes(m.method));
const modeOf = async (subjectId) => (await studies.listStudentSubjects(student.id)).find((s) => s.subject_id === subjectId)?.mode ?? null;

test.before(async () => {
  ({ db, studies } = await testDatabase());
  await require('../backups').initBackupSchema(db.pool);
  await require('../studentGuide').initStudentGuideSchema(db.pool);
  stage = await db.addStage('مرحلة طلب التغيير');
  ss = (await db.listStageSeasons(stage.id))[0].id;
  fiqh = await db.addSubject(stage.id, 'الفقه', 'فقه_ت');
  nahw = await db.addSubject(stage.id, 'النحو', 'نحو_ت');
  student = await db.createStudent(STUDENT, 'طالب طلب التغيير', stage.id);
  await db.confirmOfficialStudent(student.id);
  group = await studies.createMubahathaGroup(fiqh.id, ss, { title: 'المجموعة الأولى', capacity: 10, inviteLink: INVITE });
  await studies.changeParticipationMode(student.id, fiqh.id, ss, 'mubahatha', {});
  await studies.assignStudentToGroup(student.id, fiqh.id, ss);
  app = require('../index');
  app.bot.botInfo = { id: 12345, is_bot: true, username: 'AttendanceTestBot', first_name: 'test' };
});
test.after(async () => { Telegram.prototype.callApi = original; if (db) await db.pool.end(); });

test('the subscription screen ends with a change-subscription button', async () => {
  await send(STUDENT, '📖 المباحثات والتقارير');
  const all = buttons();
  assert.ok(all.some((b) => b.callback_data === `pm_subj:${fiqh.id}:${ss}`));
  assert.equal(all.at(-1).callback_data, 'pc_list', 'the button comes last, after every subject');
  assert.match(all.at(-1).text, /تغيير الاشتراك/);
});

test('the change list shows every chosen subject with an edit button, and skips unchosen ones', async () => {
  await send(STUDENT, '', 'pc_list');
  const edits = buttons().filter((b) => b.callback_data?.startsWith('pc_subj:'));
  assert.deepEqual(edits.map((b) => b.callback_data), [`pc_subj:${fiqh.id}:${ss}`], 'النحو لم يُختر نمطه بعد');
  assert.match(edits[0].text, /تعديل/);
  assert.match(toChat(STUDENT).at(-1).text, /الفقه: 👥 مباحثات/);
});

test('a mubahatha subject offers the move to reports and the request reaches the administration once', async () => {
  await send(STUDENT, '', `pc_subj:${fiqh.id}:${ss}`);
  assert.match(toChat(STUDENT).at(-1).text, /التحويل إلى التقارير/);
  assert.ok(buttons().some((b) => b.callback_data === `pc_req:${fiqh.id}:${ss}`));

  await send(STUDENT, '', `pc_req:${fiqh.id}:${ss}`);
  const adminMsg = toChat(42).find((m) => m.reply_markup?.inline_keyboard?.flat().some((b) => b.callback_data?.startsWith('pc_approve:')));
  assert.ok(adminMsg, 'the administration is notified with approve / reject buttons');
  assert.match(adminMsg.text, /طالب طلب التغيير/);
  assert.match(adminMsg.text, /الفقه/);
  const flat = adminMsg.reply_markup.inline_keyboard.flat();
  assert.ok(flat.some((b) => /^pc_reject:\d+$/.test(b.callback_data)));
  assert.equal(await modeOf(fiqh.id), 'mubahatha', 'nothing changes before approval');

  await send(STUDENT, '', `pc_req:${fiqh.id}:${ss}`);
  assert.equal(toChat(42).length, 0, 'asking again does not notify the administration twice');
  await send(STUDENT, '', `pc_subj:${fiqh.id}:${ss}`);
  assert.match(toChat(STUDENT).at(-1).text, /قيد مراجعة/);
});

test('only an administrator can decide; approval applies the change and informs the student', async () => {
  const pending = (await studies.listPendingParticipationChanges(student.id))[0];
  await send(STUDENT, '', `pc_approve:${pending.id}`);
  assert.equal(await modeOf(fiqh.id), 'mubahatha', 'a student cannot approve their own request');
  assert.equal((await studies.getParticipationChangeRequest(pending.id)).status, 'pending');

  await send(42, '', `pc_approve:${pending.id}`);
  assert.equal(await modeOf(fiqh.id), 'report');
  assert.equal((await studies.getParticipationChangeRequest(pending.id)).status, 'approved');
  assert.match(toChat(STUDENT).at(-1).text, /تحويلك إلى التقارير/);
  assert.match(toChat(STUDENT).at(-1).text, /هذه المادة خلال هذا الموسم: 1/);
  assert.equal((await db.pool.query("SELECT COUNT(*)::int AS n FROM admin_audit_log WHERE action='change_participation_mode'")).rows[0].n, 1, 'the approval is audited');

  await send(42, '', `pc_approve:${pending.id}`);
  assert.equal(await modeOf(fiqh.id), 'report', 'a second press changes nothing');
});

test('"مجموعات مباحثاتي" hides the groups of subjects the student moved to reports', async () => {
  await send(STUDENT, '', 'il_view:groups:0');
  assert.ok(!buttons().some((b) => b.url === INVITE), 'the report-mode subject group link must not appear');
  assert.match(toChat(STUDENT).at(-1).text, /لا توجد ارتباطات/);
});

test('a report subject offers the move to mubahatha; rejection keeps the current subscription', async () => {
  await send(STUDENT, '', `pc_subj:${fiqh.id}:${ss}`);
  assert.match(toChat(STUDENT).at(-1).text, /التحويل إلى المباحثات/);
  await send(STUDENT, '', `pc_req:${fiqh.id}:${ss}`);
  const id = (await studies.listPendingParticipationChanges(student.id))[0].id;
  await send(42, '', `pc_reject:${id}`);
  assert.equal(await modeOf(fiqh.id), 'report');
  assert.match(toChat(STUDENT).at(-1).text, /لم تعتمد الإدارة/);
  assert.equal((await studies.getParticipationChangeRequest(id)).status, 'rejected');
});

test('approving the move to mubahatha assigns the group, sends its link, and shows it in "my groups"', async () => {
  await send(STUDENT, '', `pc_req:${fiqh.id}:${ss}`);
  const id = (await studies.listPendingParticipationChanges(student.id))[0].id;
  await send(42, '', `pc_approve:${id}`);
  assert.equal(await modeOf(fiqh.id), 'mubahatha');
  const note = toChat(STUDENT).find((m) => /تحويلك إلى المباحثات/.test(m.text || ''));
  assert.ok(note);
  assert.match(note.text, /هذه المادة خلال هذا الموسم: 2/);
  assert.ok(note.reply_markup.inline_keyboard.flat().some((b) => b.url === INVITE), 'the group invite link is delivered');
  await send(STUDENT, '', 'il_view:groups:0');
  assert.ok(buttons().some((b) => b.url === INVITE), 'the group is visible again once back in mubahatha');
});

test('a cancelled request can no longer be approved', async () => {
  await send(STUDENT, '', `pc_req:${fiqh.id}:${ss}`);
  const id = (await studies.listPendingParticipationChanges(student.id))[0].id;
  await send(STUDENT, '', `pc_cancel:${id}`);
  assert.equal((await studies.getParticipationChangeRequest(id)).status, 'cancelled');
  await send(42, '', `pc_approve:${id}`);
  assert.equal(await modeOf(fiqh.id), 'mubahatha', 'the cancelled request was not applied');
});

test('if the mode changed before approval, the request is cancelled instead of applied', async () => {
  const { request } = await studies.requestParticipationChange(student.id, fiqh.id, ss);
  await studies.changeParticipationMode(student.id, fiqh.id, ss, 'report', { actorId: 42 });
  const result = await studies.decideParticipationChange(request.id, true, 42);
  assert.equal(result.stale, true);
  assert.equal(await modeOf(fiqh.id), 'report', 'the manual change stands; the stale request did not flip it back');
  assert.equal((await studies.getParticipationChangeRequest(request.id)).status, 'cancelled');
  await studies.changeParticipationMode(student.id, fiqh.id, ss, 'mubahatha', { actorId: 42 });
});

test('a subject without a chosen mode cannot be changed, and a stale duplicate is replaced', async () => {
  await assert.rejects(studies.requestParticipationChange(student.id, nahw.id, ss), /اختر نظام هذه المادة/);
  const first = await studies.requestParticipationChange(student.id, fiqh.id, ss);
  assert.equal(first.created, true);
  assert.equal((await studies.requestParticipationChange(student.id, fiqh.id, ss)).created, false);
  await studies.changeParticipationMode(student.id, fiqh.id, ss, 'report', { actorId: 42 });
  const replaced = await studies.requestParticipationChange(student.id, fiqh.id, ss);
  assert.equal(replaced.created, true);
  assert.equal(replaced.request.to_mode, 'mubahatha');
  assert.equal((await studies.getParticipationChangeRequest(first.request.id)).status, 'cancelled');
  await studies.cancelParticipationChange(replaced.request.id, student.id);
});
