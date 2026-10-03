'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { testDatabase } = require('./helpers.cjs');

let db, studies, adminData, teacher;

test.before(async () => {
  ({ db, studies } = await testDatabase());
  adminData = require('../adminData').createAdminData(db, studies);
  teacher = await db.addTeacher('أستاذ المعاينة');
});
test.after(async () => { if (db) await db.pool.end(); });

async function groupedFixture(name) {
  const st = await db.addStage(name);
  const season = (await db.listStageSeasons(st.id))[0].id;
  const subject = await db.addSubject(st.id, 'مادة ' + name, 'م' + name.length);
  const g1 = await studies.createMubahathaGroup(subject.id, season, { title: 'ج1', capacity: 30 });
  const g2 = await studies.createMubahathaGroup(subject.id, season, { title: 'ج2', capacity: 30 });
  let telegram = 800000 + Math.floor(Math.random() * 90000);
  for (const g of [g1, g1, g2]) {
    const student = await db.createStudent(telegram++, 'طالب ' + telegram + ' ثاني ثالث', st.id);
    await studies.changeParticipationMode(student.id, subject.id, season, 'mubahatha', {});
    await db.pool.query('INSERT INTO group_memberships(student_id,group_id,subject_id,stage_season_id) VALUES($1,$2,$3,$4)', [student.id, g.id, subject.id, season]);
  }
  await db.pool.query(`INSERT INTO schedule_slots(group_id,subject_id,stage_season_id,teacher_id,day_of_week,hour,minute)
    VALUES($1,$2,$3,$4,1,18,0),($5,$2,$3,$4,2,18,0)`, [g1.id, subject.id, season, teacher.id, g2.id]);
  return { st, season, subject };
}
const grouping = async (season) => (await db.pool.query('SELECT discussion_grouping FROM stage_seasons WHERE id=$1', [season])).rows[0].discussion_grouping;

test('the impact preview matches exactly what the confirmed change then does', async () => {
  const f = await groupedFixture('معاينة الأثر');
  const preview = await adminData.groupingImpact(f.season, false);
  assert.deepEqual({ changing: preview.changing, blocked: preview.blocked, groupsToMerge: preview.groupsToMerge,
    subjectsAffected: preview.subjectsAffected, membershipsToMove: preview.membershipsToMove, slotsToPause: preview.slotsToPause },
  { changing: true, blocked: null, groupsToMerge: 1, subjectsAffected: 1, membershipsToMove: 1, slotsToPause: 2 });
  assert.equal(await grouping(f.season), true, 'previewing changes nothing');
  const expectedSettings = { grouped: true, enabledSubjectIds: [f.subject.id] };
  const real = await adminData.saveParticipationSettings(f.season, { grouped: false, enabledSubjectIds: [f.subject.id], expectedSettings }, 42);
  assert.equal(real.mergedGroups, preview.groupsToMerge);
  assert.equal(real.movedMemberships, preview.membershipsToMove);
  assert.equal(real.pausedSlots, preview.slotsToPause);
  assert.equal((await adminData.groupingImpact(f.season, false)).changing, false, 'already whole-stage');
});

test('the impact preview explains why returning to numbered groups is blocked, and the save agrees', async () => {
  const f = await groupedFixture('معاينة الحظر');
  const expectedGrouped = { grouped: true, enabledSubjectIds: [f.subject.id] };
  await adminData.saveParticipationSettings(f.season, { grouped: false, enabledSubjectIds: [f.subject.id], expectedSettings: expectedGrouped }, 42);
  assert.equal((await adminData.groupingImpact(f.season, true)).blocked, null);
  await db.pool.query('UPDATE mubahatha_groups SET capacity=1 WHERE stage_season_id=$1', [f.season]);
  assert.match((await adminData.groupingImpact(f.season, true)).blocked, /سعة/);
  await assert.rejects(adminData.saveParticipationSettings(f.season, { grouped: true, enabledSubjectIds: [f.subject.id],
    expectedSettings: { grouped: false, enabledSubjectIds: [f.subject.id] } }, 42), { code: 'GROUP_CAPACITY' });
  assert.equal(await grouping(f.season), false, 'a refused change leaves the stage whole');
  await assert.rejects(adminData.groupingImpact(f.season, 'x'), /حدد التنظيم/);
  await assert.rejects(adminData.groupingImpact(99999999, true), { code: 'NOT_FOUND' });
});

test('renaming rejects a name that equals another subject name OR hashtag, ignoring spaces and the # sign', async () => {
  const st = await db.addStage('مرحلة تطابق الأسماء');
  const season = (await db.listStageSeasons(st.id))[0].id;
  const a = await db.addSubject(st.id, 'النحو', 'نحو_ا');
  const b = await db.addSubject(st.id, 'الصرف', 'صرف_ب');
  const rename = (id, name, expectedName) => adminData.updateSubject(id, { name, expectedName, stageSeasonId: season }, 42);
  for (const clash of ['صرف_ب', '#صرف_ب', 'ال  صرف', 'الصرف']) {
    await assert.rejects(rename(a.id, clash, 'النحو'), { code: 'DUPLICATE' }, `"${clash}" must be refused`);
  }
  assert.equal((await db.pool.query('SELECT name FROM subjects WHERE id=$1', [a.id])).rows[0].name, 'النحو', 'every refusal left the name alone');
  const hit = await db.findSubjectByHashtag(st.id, '#صرف_ب');
  assert.equal(hit.id, b.id, 'a channel post with the other hashtag still reaches its own subject');
  await assert.rejects(rename(a.id, '###', 'النحو'), /حروف أو أرقام/);
});

test('renaming collapses extra spaces, keeps the hashtag, audits once and ignores an unchanged name', async () => {
  const st = await db.addStage('مرحلة تنظيف الاسم');
  const season = (await db.listStageSeasons(st.id))[0].id;
  const a = await db.addSubject(st.id, 'الفقه القديم', 'فقه_قديم');
  const saved = await adminData.updateSubject(a.id, { name: '  الفقه    الجديد ', expectedName: 'الفقه القديم', stageSeasonId: season }, 42);
  assert.equal(saved.name, 'الفقه الجديد');
  assert.equal(saved.hashtag, 'فقه_قديم');
  const audits = async () => (await db.pool.query("SELECT COUNT(*)::int AS n FROM admin_audit_log WHERE action='update_subject' AND entity_id=$1", [a.id])).rows[0].n;
  assert.equal(await audits(), 1);
  await adminData.updateSubject(a.id, { name: 'الفقه الجديد', expectedName: 'الفقه الجديد', stageSeasonId: season }, 42);
  assert.equal(await audits(), 1, 'an unchanged name is not audited again');
  await assert.rejects(adminData.updateSubject(a.id, { name: 'اسم آخر', expectedName: 'الفقه القديم', stageSeasonId: season }, 42), { code: 'CONFLICT' });
});
