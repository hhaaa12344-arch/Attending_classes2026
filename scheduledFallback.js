'use strict';
// التفعيل الاحتياطي من الجدول.
// إذا تعرّف البوت على درس واحد على الأقل من القناة في يوم مجدول، ولم يستطع مطابقة منشورات بقية
// مواد ذلك اليوم، فلا تبقى «بانتظار تحديد المنشور»: تُفتح تلقائيًا لمدة 24 ساعة بعد مهلة قصيرة
// (الملفات المتتابعة تصل عادةً معًا). وأي منشور يصل بعدها يُربط بالدرس المفتوح ولا ينشئ درسًا مكررًا
// (db.activateLesson يتولى الربط)، فيظهر رابط الدرس للطلبة تلقائيًا.
const { positiveInt, appError } = require('./integrity');

const SOURCE_TYPE = 'schedule_fallback';
const CHANNEL_SOURCES = ['channel', 'channel_hashtag', 'channel_schedule', 'channel_schedule_recovered'];
const LOCK_NAMESPACE = 734225; // نفس قفل النشر من القناة كي لا يتسابق الاثنان على مادة واحدة
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const baghdadDay = (date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Baghdad', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

// SCHEDULE_FALLBACK_GRACE_MINUTES: عدد الدقائق بعد أول درس معروف قبل فتح بقية المواد (0 = فورًا، off = تعطيل)
function graceFromEnv(value = process.env.SCHEDULE_FALLBACK_GRACE_MINUTES) {
  if (value === undefined || value === '') return 30;
  if (String(value).toLowerCase() === 'off') return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 720) {
    throw new Error('SCHEDULE_FALLBACK_GRACE_MINUTES must be an integer from 0 to 720, or "off"');
  }
  return minutes;
}

function createScheduledFallback(db, { graceMinutes = graceFromEnv() } = {}) {
  const dayExpr = "COALESCE(l.schedule_date,(l.activated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Baghdad')::date)";

  // مواد مجدولة لهذا اليوم ليس لها أي درس فعّال إطلاقًا (لا درس من منشور ولا درس احتياطي).
  async function missingSubjects(c, stageSeasonId, day, subjectId = null) {
    return (await c.query(`
      SELECT sub.id, sub.name, sub.stage_id
      FROM lesson_schedule_entries e
      JOIN subjects sub ON sub.id=e.subject_id
      JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.stage_id=sub.stage_id
      WHERE e.stage_season_id=$1 AND e.lesson_date=$2::date AND ($3::int IS NULL OR sub.id=$3)
        AND NOT EXISTS(SELECT 1 FROM effective_lessons l
          WHERE l.stage_season_id=e.stage_season_id AND l.subject_id=sub.id AND ${dayExpr}=e.lesson_date)
      ORDER BY sub.id`, [stageSeasonId, day, subjectId])).rows;
  }

  async function openSeason(c, stageSeasonId) {
    return (await c.query(`SELECT ss.id FROM stage_seasons ss JOIN stages st ON st.id=ss.stage_id
      WHERE ss.id=$1 AND ss.is_active=true AND st.is_active=true`, [stageSeasonId])).rows[0];
  }

  // الفتح التلقائي ليوم واحد. لا يعمل إلا بعد وجود درس معروف من القناة في اليوم نفسه ومرور المهلة.
  async function sweepDate(stageSeasonId, day, { grace = graceMinutes } = {}) {
    if (grace === null || !DATE_RE.test(String(day || ''))) return { created: [] };
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock($1,$2)', [LOCK_NAMESPACE, stageSeasonId]);
      if (!(await openSeason(c, stageSeasonId))) { await c.query('COMMIT'); return { created: [] }; }
      const anchor = (await c.query(`
        SELECT MIN(COALESCE(l.attendance_opened_at,l.activated_at)) AS at
        FROM effective_lessons l
        WHERE l.stage_season_id=$1 AND l.source_type = ANY($2::text[]) AND ${dayExpr}=$3::date`,
      [stageSeasonId, CHANNEL_SOURCES, day])).rows[0];
      const ready = anchor && anchor.at && (await c.query(
        "SELECT ($1::timestamp + ($2 || ' minutes')::interval) <= now() AS ok", [anchor.at, String(grace)])).rows[0].ok;
      if (!ready) { await c.query('COMMIT'); return { created: [] }; }
      const created = [];
      for (const subject of await missingSubjects(c, stageSeasonId, day)) {
        const lesson = await db.activateLesson(subject.id, 24, SOURCE_TYPE, null, null, null, null, { client: c, scheduleDate: day });
        if (lesson) created.push({ lesson, subject });
      }
      await c.query('COMMIT');
      return { created };
    } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
  }

  // يوم اليوم بتوقيت بغداد لكل المراحل التي لها جدول فيه.
  async function sweepToday(now = new Date()) {
    if (graceMinutes === null) return { created: 0 };
    const day = baghdadDay(now);
    const seasons = (await db.pool.query(`SELECT DISTINCT e.stage_season_id FROM lesson_schedule_entries e
      JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
      JOIN stages st ON st.id=ss.stage_id AND st.is_active=true WHERE e.lesson_date=$1::date`, [day])).rows;
    let total = 0;
    for (const { stage_season_id: id } of seasons) total += (await sweepDate(id, day)).created.length;
    return { created: total };
  }

  // تفعيل يدوي من الأدمن لمادة مجدولة بلا منشور (يصلح للأيام السابقة أيضًا).
  async function activateManually({ stageSeasonId, subjectId, scheduleDate, actorId, notice = null }) {
    stageSeasonId = positiveInt(stageSeasonId); subjectId = positiveInt(subjectId);
    if (!DATE_RE.test(String(scheduleDate || ''))) throw appError('تاريخ الجدول غير صالح.');
    if (scheduleDate > baghdadDay(new Date())) throw appError('موعد هذا الدرس لم يحن بعد.');
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock($1,$2)', [LOCK_NAMESPACE, stageSeasonId]);
      if (!(await openSeason(c, stageSeasonId))) throw appError('لم يعد موسم المرحلة متاحًا.', 'ARCHIVED', 409);
      const subject = (await missingSubjects(c, stageSeasonId, scheduleDate, subjectId))[0];
      if (!subject) throw appError('هذه المادة غير مجدولة في هذا التاريخ أو فُعّلت بالفعل.', 'CONFLICT', 409);
      const now = (await c.query('SELECT now() AS at')).rows[0].at;
      const lesson = await db.activateLesson(subject.id, 24, SOURCE_TYPE, null, null, null, null,
        { client: c, scheduleDate, attendanceOpenedAt: now });
      if (!lesson) throw appError('لم يعد موسم المرحلة متاحًا.', 'ARCHIVED', 409);
      const queued = notice ? await notice(c, lesson, subject.name, subject.stage_id, 'schedule-fallback') : 0;
      if (actorId) {
        await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
          VALUES($1,'activate_scheduled_lesson','lesson',$2,$3::jsonb,$4::jsonb)`,
        [positiveInt(actorId), lesson.id, JSON.stringify({ stageSeasonId, subjectId, scheduleDate }), JSON.stringify(lesson)]);
      }
      await c.query('COMMIT');
      return { lesson, created: true, queued };
    } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
  }

  return { sweepDate, sweepToday, activateManually, graceMinutes };
}

module.exports = { createScheduledFallback, graceFromEnv, SOURCE_TYPE, CHANNEL_SOURCES };
