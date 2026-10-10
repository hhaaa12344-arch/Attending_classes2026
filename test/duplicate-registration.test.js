'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.BOT_TOKEN = '12345:OFFLINE_TEST_ONLY';
process.env.DATABASE_URL = 'postgresql://localhost/attendance_test_unused';
process.env.ADMIN_IDS = '42';
const { Telegram } = require('telegraf');
const { testDatabase } = require('./helpers.cjs');

const messages = [];
let messageId = 900;
const original = Telegram.prototype.callApi;
Telegram.prototype.callApi = async function (method, payload) {
  messages.push({ method, ...payload });
  if (method === 'getMe') return { id: 12345, is_bot: true, username: 'AttendanceTestBot', first_name: 'test' };
  return { message_id: messageId++, chat: { id: payload.chat_id, type: 'private' }, text: payload.text };
};

let db, app, stage;
async function send(id, text, data) {
  messages.length = 0;
  const from = { id, is_bot: false, first_name: 'test' };
  const message = { message_id: messageId++, date: Math.floor(Date.now() / 1000), from, chat: { id, type: 'private' }, text,
    ...(text && text.startsWith('/') ? { entities: [{ offset: 0, length: text.split(/\s/)[0].length, type: 'bot_command' }] } : {}) };
  await app.bot.handleUpdate(data
    ? { update_id: messageId, callback_query: { id: 'cb' + messageId, from, data, message } }
    : { update_id: messageId, message });
  return messages;
}
const texts = () => messages.filter((m) => ['sendMessage', 'editMessageText'].includes(m.method)).map((m) => m.text || '');
const stageButtons = () => messages.flatMap((m) => m.reply_markup?.inline_keyboard?.flat() || []).filter((b) => b.callback_data?.startsWith('reg_stage:'));
const countByName = async (name) => Number((await db.pool.query('SELECT COUNT(*) AS n FROM students WHERE full_name=$1', [name])).rows[0].n);
// يصل الطالب الجديد إلى خطوة إدخال الاسم (دليل الطالب ثم زر التأكيد)
async function startRegistration(id) {
  await send(id, '/start');
  await send(id, '', 'onboarding_ack');
}

test.before(async () => {
  ({ db } = await testDatabase());
  await require('../backups').initBackupSchema(db.pool);
  await require('../studentGuide').initStudentGuideSchema(db.pool);
  stage = await db.addStage('مرحلة منع التكرار');
  app = require('../index');
  app.bot.botInfo = { id: 12345, is_bot: true, username: 'AttendanceTestBot', first_name: 'test' };
});
test.after(async () => { Telegram.prototype.callApi = original; if (db) await db.pool.end(); });

test('db: the four-name key catches spaces, hamza/ya/ta-marbuta variants and an added fifth name', async () => {
  const first = await db.createStudent(610001, 'أحمد علي حسين كاظم', stage.id, { rejectDuplicateName: true });
  for (const same of ['أحمد علي حسين كاظم', ' احمد   علي حسين  كاظم ', 'إحمد علي حسين كاظم', 'أحمد علي حسين كاظم الموسوي']) {
    await assert.rejects(db.createStudent(610002, same, stage.id, { rejectDuplicateName: true }),
      (err) => err.code === 'DUPLICATE_NAME' && err.existing.id === first.id, same);
  }
  assert.equal(Number((await db.pool.query('SELECT COUNT(*) AS n FROM students WHERE telegram_id=610002')).rows[0].n), 0, 'nothing was inserted');
  const other = await db.createStudent(610003, 'أحمد علي حسين صالح', stage.id, { rejectDuplicateName: true });
  assert.ok(other.id, 'a different fourth name is a different student');
});

test('db: archived record does not block, and the admin manual path (no option) is unchanged', async () => {
  const old = await db.createStudent(610010, 'مصطفى جاسم ناصر عباس', stage.id);
  await db.pool.query('UPDATE students SET is_active=false WHERE id=$1', [old.id]);
  const fresh = await db.createStudent(610011, 'مصطفى جاسم ناصر عباس', stage.id, { rejectDuplicateName: true });
  assert.ok(fresh.id, 'archived record means the problem was handled');
  const adminAdded = await db.createStudent(610012, 'مصطفى جاسم ناصر عباس', stage.id);
  assert.ok(adminAdded.id, 'admin manual add keeps working as before');
});

test('db: two simultaneous registrations of the same name leave exactly one record', async () => {
  const name = 'زينب هادي كريم جواد';
  const results = await Promise.allSettled([
    db.createStudent(610020, name, stage.id, { rejectDuplicateName: true }),
    db.createStudent(610021, name, stage.id, { rejectDuplicateName: true }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'DUPLICATE_NAME').length, 1);
  assert.equal(await countByName(name), 1);
});

test('bot: a duplicate name is refused before stage choice, the admin is told once, and no record is created', async () => {
  const name = 'حيدر رعد سلمان فاضل';
  const existing = await db.createStudent(620001, name, stage.id);
  await startRegistration(620002);
  await send(620002, name);
  assert.ok(texts().some((t) => t.includes('مسجَّل مسبقًا')), JSON.stringify(messages));
  assert.equal(stageButtons().length, 0, 'never reaches stage selection');
  assert.equal(await db.getStudentByTelegramId(620002), undefined);
  const adminNotes = messages.filter((m) => m.method === 'sendMessage' && m.chat_id === 42);
  assert.equal(adminNotes.length, 1);
  assert.ok(adminNotes[0].text.includes(existing.full_name) && adminNotes[0].text.includes('620002'));
  assert.ok(!texts().some((t) => t.includes('620001')), 'the student is not shown the other account id');
  await send(620002, name);
  assert.equal(messages.filter((m) => m.method === 'sendMessage' && m.chat_id === 42).length, 0, 'repeat attempts do not spam the admin');
  assert.equal(await countByName(name), 1);
});

test('bot: replacement by transfer code still works from the same name prompt', async () => {
  const name = 'كاظم باسم هاشم ثامر';
  const old = await db.createStudent(630001, name, stage.id);
  await startRegistration(630002);
  await send(630002, name);
  assert.equal(await db.getStudentByTelegramId(630002), undefined);
  const withCode = await db.generateStudentTransferCode(old.id);
  await send(630002, withCode.transfer_code);
  assert.ok(texts().some((t) => t.includes('تم نقل حسابك')), JSON.stringify(messages));
  const moved = await db.getStudentByTelegramId(630002);
  assert.equal(moved.id, old.id, 'the original record moved; no second record');
  assert.equal(await countByName(name), 1);
});

test('bot: a new name still registers normally', async () => {
  await startRegistration(640001);
  await send(640001, 'عبدالله محمد صادق نعمة');
  const buttons = stageButtons();
  assert.ok(buttons.length > 0);
  await send(640001, '', buttons.find((b) => b.callback_data === `reg_stage:${stage.id}`).callback_data);
  assert.equal((await db.getStudentByTelegramId(640001)).full_name, 'عبدالله محمد صادق نعمة');
});

test('bot: a name taken between typing it and choosing the stage is refused at the last step', async () => {
  const name = 'مرتضى ياسر عادل حميد';
  await startRegistration(650001);
  await send(650001, name);
  const buttons = stageButtons();
  assert.ok(buttons.length > 0);
  await db.createStudent(650002, name, stage.id); // سبقه آخر
  await send(650001, '', buttons.find((b) => b.callback_data === `reg_stage:${stage.id}`).callback_data);
  assert.ok(texts().some((t) => t.includes('مسجَّل مسبقًا')), JSON.stringify(messages));
  assert.equal(await db.getStudentByTelegramId(650001), undefined);
  assert.equal(await countByName(name), 1);
});
