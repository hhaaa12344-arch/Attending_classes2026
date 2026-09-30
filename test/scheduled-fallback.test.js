'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { testDatabase } = require('./helpers.cjs');
const { createScheduledFallback, graceFromEnv } = require('../scheduledFallback');
const { baghdadDay } = require('../scheduledPublication');

let db, stage, ss, subjects, fallback, today, yesterday;
const CHAT = -1001234500000;

async function lessonsOf(subjectId) {
  return (await db.pool.query('SELECT * FROM lessons WHERE subject_id=$1 ORDER BY id', [subjectId])).rows;
}
async function schedule(subjectId, day) {
  await db.pool.query('INSERT INTO lesson_schedule_entries(stage_season_id,subject_id,lesson_date) VALUES($1,$2,$3::date)', [ss, subjectId, day]);
}
// درس معروف من القناة كأنه فُعّل قبل `minutes` دقيقة
async function recognisedLesson(subject, messageId, day, minutes) {
  const lesson = await db.activateLesson(subject.id, 24, 'channel_schedule', `https://t.me/c/1/${messageId}`, CHAT, messageId, null, { scheduleDate: day });
  await db.pool.query("UPDATE lessons SET activated_at=now()-($2||' minutes')::interval WHERE id=$1", [lesson.id, String(minutes)]);
  return lesson;
}

test.before(async () => {
  ({ db } = await testDatabase());
  stage = await db.addStage('مرحلة التفعيل الاحتياطي');
  ss = (await db.listStageSeasons(stage.id))[0].id;
  subjects = [];
  for (const name of ['الصرف', 'تهذيب البلاغة', 'شرائع الإسلام']) subjects.push(await db.addSubject(stage.id, name, name));
  today = baghdadDay(new Date());
  yesterday = baghdadDay(new Date(Date.now() - 86400e3));
  fallback = createScheduledFallback(db, { graceMinutes: 30 });
});
test.after(async () => { if (db) await db.pool.end(); });

test('env: grace minutes default to 30, accept 0 and "off", reject nonsense', () => {
  assert.equal(graceFromEnv(undefined), 30);
  assert.equal(graceFromEnv('0'), 0);
  assert.equal(graceFromEnv('off'), null);
  assert.throws(() => graceFromEnv('-5'));
  assert.throws(() => graceFromEnv('abc'));
});

test('nothing opens without a recognised lesson, nor before the grace period ends', async () => {
  for (const s of subjects) await schedule(s.id, today);
  assert.deepEqual((await fallback.sweepDate(ss, today)).created, [], 'no recognised lesson yet');
  await recognisedLesson(subjects[1], 501, today, 5);
  assert.deepEqual((await fallback.sweepDate(ss, today)).created, [], 'only 5 minutes since the first recognised lesson');
  assert.equal((await lessonsOf(subjects[0].id)).length, 0);
});

test('after the grace period every remaining scheduled subject opens once, without a post link', async () => {
  await db.pool.query("UPDATE lessons SET activated_at=now()-interval '45 minutes' WHERE source_message_id=501");
  const first = await fallback.sweepDate(ss, today);
  assert.deepEqual(first.created.map((x) => x.subject.id).sort(), [subjects[0].id, subjects[2].id].sort());
  for (const s of [subjects[0], subjects[2]]) {
    const rows = await lessonsOf(s.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_type, 'schedule_fallback');
    assert.equal(rows[0].source_message_id, null);
    assert.equal(String(rows[0].schedule_date.toISOString?.().slice(0, 10) ?? rows[0].schedule_date).slice(0, 10), today);
    assert.ok(new Date(rows[0].active_until) > new Date(), 'attendance is open');
  }
  assert.equal((await lessonsOf(subjects[1].id)).length, 1, 'the recognised lesson is untouched');
  assert.deepEqual((await fallback.sweepDate(ss, today)).created, [], 'a second sweep changes nothing');
  assert.equal((await db.getPendingScheduledSubjectsForDate(ss, today)).length, 2, 'unlinked fallback lessons still await their post');
});

test('a post that arrives later attaches to the opened lesson instead of creating a duplicate', async () => {
  const opened = (await lessonsOf(subjects[0].id))[0];
  await db.pool.query('INSERT INTO attendance(lesson_id,student_id) SELECT $1,id FROM students LIMIT 0', [opened.id]);
  const linked = await db.activateLesson(subjects[0].id, 24, 'channel_hashtag', 'https://t.me/c/1/777', CHAT, 777, new Date(), { scheduleDate: today });
  assert.equal(linked.id, opened.id, 'same lesson row');
  assert.equal(Number(linked.source_message_id), 777);
  assert.equal(linked.source_url, 'https://t.me/c/1/777');
  assert.equal((await lessonsOf(subjects[0].id)).length, 1, 'no duplicate lesson');
  assert.equal(new Date(linked.activated_at).getTime(), new Date(opened.activated_at).getTime(), 'the open window is not shifted');
  const pending = (await db.getPendingScheduledSubjectsForDate(ss, today)).map((x) => x.id);
  assert.deepEqual(pending, [subjects[2].id], 'a linked lesson no longer awaits a post');
  // the same message again is idempotent
  const again = await db.activateLesson(subjects[0].id, 24, 'channel_hashtag', 'https://t.me/c/1/777', CHAT, 777, new Date(), { scheduleDate: today });
  assert.equal(again.id, opened.id);
  assert.equal((await lessonsOf(subjects[0].id)).length, 1);
});

test('adoption is limited to the same subject and the same schedule day', async () => {
  const other = await db.activateLesson(subjects[1].id, 24, 'channel_hashtag', 'https://t.me/c/1/900', CHAT, 900, new Date(), { scheduleDate: today });
  assert.notEqual(other.id, (await lessonsOf(subjects[2].id))[0].id, 'another subject never adopts a foreign fallback lesson');
  const wrongDay = await db.activateLesson(subjects[2].id, 24, 'channel_hashtag', 'https://t.me/c/1/901', CHAT, 901, new Date(), { scheduleDate: yesterday });
  assert.notEqual(wrongDay.id, (await lessonsOf(subjects[2].id))[0].id, 'a post for another day creates its own lesson');
  assert.equal((await lessonsOf(subjects[2].id)).length, 2);
});

test('manual activation opens an older waiting subject once and audits it', async () => {
  const s = await db.addSubject(stage.id, 'مغني اللبيب', 'مغني');
  await schedule(s.id, yesterday);
  const queued = [];
  const result = await fallback.activateManually({ stageSeasonId: ss, subjectId: s.id, scheduleDate: yesterday, actorId: 42,
    notice: async (c, lesson, name) => { queued.push(name); return 1; } });
  assert.equal(result.lesson.source_type, 'schedule_fallback');
  assert.deepEqual(queued, ['مغني اللبيب']);
  assert.ok(new Date(result.lesson.active_until) > new Date(), 'the 24 hours start now');
  assert.equal((await db.pool.query("SELECT COUNT(*)::int AS n FROM admin_audit_log WHERE action='activate_scheduled_lesson'")).rows[0].n, 1);
  await assert.rejects(fallback.activateManually({ stageSeasonId: ss, subjectId: s.id, scheduleDate: yesterday, actorId: 42 }), /فُعّلت بالفعل|غير مجدولة/);
  const tomorrow = baghdadDay(new Date(Date.now() + 2 * 86400e3));
  await assert.rejects(fallback.activateManually({ stageSeasonId: ss, subjectId: s.id, scheduleDate: tomorrow, actorId: 42 }), /لم يحن/);
});

test('disabled fallback never opens anything', async () => {
  const off = createScheduledFallback(db, { graceMinutes: null });
  const s = await db.addSubject(stage.id, 'مادة معطلة', 'off');
  await schedule(s.id, today);
  assert.deepEqual((await off.sweepDate(ss, today)).created, []);
  assert.deepEqual(await off.sweepToday(), { created: 0 });
  assert.equal((await lessonsOf(s.id)).length, 0);
});
