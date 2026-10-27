'use strict';
// The timetable is a publication plan, not evidence that a lecture was posted.
// Automatic sweeps stay read-only; an identified post or explicit admin action is required.
const { positiveInt, appError } = require('./integrity');

const SOURCE_TYPE = 'schedule_fallback';
const CHANNEL_SOURCES = ['channel', 'channel_hashtag', 'channel_schedule', 'channel_schedule_recovered'];
const LOCK_NAMESPACE = 734225; // نفس قفل النشر من القناة كي لا يتسابق الاثنان على مادة واحدة
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const baghdadDay = (date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Baghdad', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

// Legacy setting remains parseable; no value enables unverified automatic lessons.
function graceFromEnv(value = process.env.SCHEDULE_FALLBACK_GRACE_MINUTES) {
  if (value === undefined || value === '') return null;
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
        AND NOT EXISTS(SELECT 1 FROM stage_calendar_blocks b WHERE b.stage_season_id=e.stage_season_id
          AND b.kind='holiday' AND e.lesson_date BETWEEN b.start_date AND b.end_date)
        AND NOT EXISTS(SELECT 1 FROM effective_lessons l
          WHERE l.stage_season_id=e.stage_season_id AND l.subject_id=sub.id AND ${dayExpr}=e.lesson_date)
      ORDER BY sub.id`, [stageSeasonId, day, subjectId])).rows;
  }

  async function openSeason(c, stageSeasonId) {
    return (await c.query(`SELECT ss.id FROM stage_seasons ss JOIN stages st ON st.id=ss.stage_id
      WHERE ss.id=$1 AND ss.is_active=true AND st.is_active=true`, [stageSeasonId])).rows[0];
  }

  // Timetable gaps are review candidates, never evidence that a lecture exists.
  // Keep the old timer interface for compatibility, without automatic writes.
  async function sweepDate() { return { created: [], awaitingReview: true }; }
  async function sweepToday() { return { created: 0 }; }

  // تفعيل يدوي من الأدمن لمادة مجدولة بلا منشور (يصلح للأيام السابقة أيضًا).
  async function activateManually({ stageSeasonId, subjectId, scheduleDate, actorId, notice = null }) {
    stageSeasonId = positiveInt(stageSeasonId); subjectId = positiveInt(subjectId); actorId = positiveInt(actorId);
    if (!DATE_RE.test(String(scheduleDate || ''))) throw appError('تاريخ الجدول غير صالح.');
    if (scheduleDate > baghdadDay(new Date())) throw appError('موعد هذا الدرس لم يحن بعد.');
    if(await db.isStageCalendarBlocked(stageSeasonId,scheduleDate,'lesson'))throw appError('هذا التاريخ عطلة؛ لا يُفعّل درس مجدول خلال العطلة.');
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

  // ربط درس موجود (نُشر بتاريخ مختلف) بموعده في الجدول. يغيّر تاريخ الجدول فقط؛ لا يمس الحضور ولا ترقيم الدروس.
  async function linkExisting({ stageSeasonId, subjectId, scheduleDate, lessonId, actorId }) {
    stageSeasonId = positiveInt(stageSeasonId); subjectId = positiveInt(subjectId); lessonId = positiveInt(lessonId); actorId = positiveInt(actorId);
    if (!DATE_RE.test(String(scheduleDate || ''))) throw appError('تاريخ الجدول غير صالح.');
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock($1,$2)', [LOCK_NAMESPACE, stageSeasonId]);
      if (!(await openSeason(c, stageSeasonId))) throw appError('لم يعد موسم المرحلة متاحًا.', 'ARCHIVED', 409);
      if (!(await missingSubjects(c, stageSeasonId, scheduleDate, subjectId))[0]) throw appError('هذا الموعد مغطّى بدرس بالفعل أو غير مجدول.', 'CONFLICT', 409);
      const lesson = (await c.query(`SELECT l.id, (${dayExpr})::text AS day, l.schedule_date::text AS old_schedule_date
        FROM effective_lessons l WHERE l.id=$1 AND l.stage_season_id=$2 AND l.subject_id=$3 FOR UPDATE OF l`, [lessonId, stageSeasonId, subjectId])).rows[0];
      if (!lesson) throw appError('الدرس غير موجود في هذه المادة والموسم.', 'NOT_FOUND', 404);
      const near = (await c.query('SELECT ABS($1::date-$2::date)::int AS gap', [lesson.day, scheduleDate])).rows[0].gap <= 7;
      if (!near) throw appError('تاريخ هذا الدرس بعيد عن الموعد المختار؛ راجع الاختيار.');
      if ((await c.query('SELECT 1 FROM lesson_schedule_entries WHERE stage_season_id=$1 AND subject_id=$2 AND lesson_date=$3::date', [stageSeasonId, subjectId, lesson.day])).rowCount)
        throw appError('هذا الدرس يغطي موعدًا آخر في الجدول ولا يمكن نقله.', 'CONFLICT', 409);
      await c.query('UPDATE lessons SET schedule_date=$2::date WHERE id=$1', [lessonId, scheduleDate]);
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,'link_lesson_to_schedule','lesson',$2,$3::jsonb,$4::jsonb)`,
      [actorId, lessonId, JSON.stringify({ day: lesson.day, scheduleDate: lesson.old_schedule_date }), JSON.stringify({ scheduleDate, attendanceTouched: false })]);
      await c.query('COMMIT');
      return { linked: true, lessonId, scheduleDate };
    } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
  }

  return { sweepDate, sweepToday, activateManually, linkExisting, graceMinutes };
}

module.exports = { createScheduledFallback, graceFromEnv, SOURCE_TYPE, CHANNEL_SOURCES };
