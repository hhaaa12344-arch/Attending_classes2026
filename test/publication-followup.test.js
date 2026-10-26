'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { testDatabase } = require('./helpers.cjs');
const { createPublicationFollowup, initSchema, minutesFromEnv } = require('../publicationFollowup');
const { createScheduledFallback } = require('../scheduledFallback');
const { baghdadDay } = require('../scheduledPublication');

let db, today, seq = 0;
const CHAT = -1001234599000;
const ADMINS = [42, 43];

async function scenario(names = ['الصرف', 'تهذيب البلاغة', 'شرائع الإسلام', 'المنطق']) {
  seq += 1;
  const stage = await db.addStage(`مرحلة متابعة النشر ${seq}`);
  const ss = (await db.listStageSeasons(stage.id))[0].id;
  const subjects = [];
  for (const name of names) {
    const s = await db.addSubject(stage.id, name, `${name}_${seq}`);
    await db.pool.query('INSERT INTO lesson_schedule_entries(stage_season_id,subject_id,lesson_date) VALUES($1,$2,$3::date)', [ss, s.id, today]);
    subjects.push(s);
  }
  return { stage, ss, subjects };
}
// منشور درس معروف من القناة كأنه نُشر قبل `minutes` دقيقة
async function post(subject, messageId, minutes) {
  const lesson = await db.activateLesson(subject.id, 24, 'channel_schedule', `https://t.me/c/1/${messageId}`, CHAT, messageId, null, { scheduleDate: today });
  await db.pool.query("UPDATE lessons SET activated_at=now()-($2||' minutes')::interval WHERE id=$1", [lesson.id, String(minutes)]);
  return lesson;
}
const outboxFor = async (ss) => (await db.pool.query("SELECT * FROM notification_outbox WHERE dedupe_key LIKE $1 ORDER BY chat_id", [`publication-followup:${ss}:%`])).rows;

test.before(async () => {
  ({ db } = await testDatabase());
  await initSchema(db.pool);
  today = baghdadDay(new Date());
});
test.after(async () => { if (db) await db.pool.end(); });

test('env: default 60 minutes, off disables, nonsense is rejected', () => {
  assert.equal(minutesFromEnv(undefined), 60);
  assert.equal(minutesFromEnv('45'), 45);
  assert.equal(minutesFromEnv('off'), null);
  assert.throws(() => minutesFromEnv('0'));
  assert.throws(() => minutesFromEnv('abc'));
});

test('four scheduled, three posted, an hour passed: one alert per admin naming the missing subject', async () => {
  const { ss, subjects } = await scenario();
  const f = createPublicationFollowup(db, { adminIds: ADMINS, minutes: 60 });
  for (let i = 0; i < 3; i++) await post(subjects[i], 700 + i, 75);
  const r = await f.sweepDate(ss, today);
  assert.equal(r.alerted, true);
  assert.equal(r.scheduled, 4);
  assert.equal(r.published, 3);
  assert.deepEqual(r.missing, [subjects[3].id]);
  assert.ok(r.text.includes('المنطق') && !r.text.includes('الصرف'), r.text);
  assert.ok(r.text.includes('المجدول: 4') && r.text.includes('المنشور: 3') && r.text.includes('الناقص: 1'));
  const rows = await outboxFor(ss);
  assert.deepEqual(rows.map((x) => Number(x.chat_id)), ADMINS);
  const again = await f.sweepDate(ss, today);
  assert.equal(again.alerted, false);
  assert.equal(again.reason, 'already-alerted');
  assert.equal((await outboxFor(ss)).length, ADMINS.length, 'no second alert');
});

test('no alert before the hour is over, and none while nothing has been posted today', async () => {
  const { ss, subjects } = await scenario();
  const f = createPublicationFollowup(db, { adminIds: ADMINS, minutes: 60 });
  assert.equal((await f.sweepDate(ss, today)).reason, 'no-posts-yet');
  await post(subjects[0], 710, 20);
  assert.equal((await f.sweepDate(ss, today)).reason, 'not-due');
  assert.equal((await outboxFor(ss)).length, 0);
  await db.pool.query("UPDATE lessons SET activated_at=now()-interval '61 minutes' WHERE source_message_id=710");
  assert.equal((await f.sweepDate(ss, today)).alerted, true, 'alerts once the hour has passed');
});

test('everything posted: no alert', async () => {
  const { ss, subjects } = await scenario();
  const f = createPublicationFollowup(db, { adminIds: ADMINS, minutes: 60 });
  for (let i = 0; i < 4; i++) await post(subjects[i], 720 + i, 90);
  assert.equal((await f.sweepDate(ss, today)).reason, 'complete');
  assert.equal((await outboxFor(ss)).length, 0);
});

test('a subject opened by the schedule fallback without a post still counts as missing, and says so', async () => {
  const { ss, subjects } = await scenario();
  const f = createPublicationFollowup(db, { adminIds: [42], minutes: 60 });
  for (let i = 0; i < 3; i++) await post(subjects[i], 730 + i, 90);
  const fb = createScheduledFallback(db, { graceMinutes: 30 });
  const opened=await fb.activateManually({stageSeasonId:ss,subjectId:subjects[3].id,scheduleDate:today,actorId:42});
  assert.ok(opened.created, 'administrator explicitly opened the fourth subject');
  const r = await f.sweepDate(ss, today);
  assert.equal(r.alerted, true);
  assert.deepEqual(r.missing, [subjects[3].id]);
  assert.ok(r.text.includes('فُتحت تلقائيًا'), r.text);
});

test('a post that arrives before the check (even onto a fallback lesson) means no alert', async () => {
  const { ss, subjects } = await scenario();
  const f = createPublicationFollowup(db, { adminIds: [42], minutes: 60 });
  for (let i = 0; i < 3; i++) await post(subjects[i], 740 + i, 90);
  await createScheduledFallback(db, { graceMinutes: 30 }).sweepDate(ss, today);
  await db.activateLesson(subjects[3].id, 24, 'channel_schedule', 'https://t.me/c/1/749', CHAT, 749, null, { scheduleDate: today });
  assert.equal((await f.sweepDate(ss, today)).reason, 'complete');
});

test('sweepToday alerts only seasons with a missing subject, once; disabled follow-up does nothing', async () => {
  const a = await scenario(['مادة أ', 'مادة ب']);
  const b = await scenario(['مادة ج', 'مادة د']);
  const f = createPublicationFollowup(db, { adminIds: [42], minutes: 60 });
  await post(a.subjects[0], 760, 80); // A: ناقصة
  await post(b.subjects[0], 761, 80); await post(b.subjects[1], 762, 80); // B: كاملة
  assert.equal((await f.sweepToday()).alerted >= 1, true);
  assert.equal((await outboxFor(a.ss)).length, 1);
  assert.equal((await outboxFor(b.ss)).length, 0);
  assert.equal((await f.sweepToday()).alerted, 0, 'second sweep is quiet');
  const off = createPublicationFollowup(db, { adminIds: [42], minutes: null });
  assert.deepEqual(await off.sweepToday(), { alerted: 0 });
  assert.equal((await off.sweepDate(a.ss, today)).alerted, false);
});
