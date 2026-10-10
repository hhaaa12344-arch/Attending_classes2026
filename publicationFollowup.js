'use strict';
// متابعة نشر الدروس: إذا كان الجدول لليوم فيه أربع مواد ونُشرت ثلاث فقط، يصل الأدمن تنبيه في البوت
// بعد مرور ساعة (PUBLICATION_FOLLOWUP_MINUTES) على أول منشور درس في ذلك اليوم، يذكر المواد التي لم يظهر لها منشور.
// - «المنشور» هو درس ارتبط بمنشور فعلي من القناة (مصدره من CHANNEL_SOURCES). الدرس الذي فتحه التفعيل الاحتياطي
//   بلا منشور لا يُحسب منشورًا؛ يبقى ضمن «الناقص» حتى يصل منشوره. (إن وصل المنشور لاحقًا يُربط بالدرس نفسه.)
// - لا يرسل التنبيه إلا مرة واحدة لكل (موسم مرحلة، تاريخ). لا يغيّر شيئًا من الدروس ولا يفتح حضورًا.
// - لا يعمل في يوم لم يُنشر فيه أي درس بعد (لا نقطة بداية للساعة).
const { enqueueNotification } = require('./outbox');
const { CHANNEL_SOURCES } = require('./scheduledFallback');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ = 'Asia/Baghdad';
const baghdadDay = (date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

// PUBLICATION_FOLLOWUP_MINUTES: الدقائق بعد أول منشور قبل التنبيه (الافتراضي 60، off = تعطيل)
function minutesFromEnv(value = process.env.PUBLICATION_FOLLOWUP_MINUTES) {
  if (value === undefined || value === '') return 60;
  if (String(value).toLowerCase() === 'off') return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error('PUBLICATION_FOLLOWUP_MINUTES must be an integer from 1 to 1440, or "off"');
  }
  return minutes;
}

async function initSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS publication_followup_alerts (
    stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
    lesson_date DATE NOT NULL,
    scheduled_count INTEGER NOT NULL,
    published_count INTEGER NOT NULL,
    missing_subject_ids INTEGER[] NOT NULL,
    alerted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (stage_season_id, lesson_date)
  )`);
}

function createPublicationFollowup(db, { adminIds = [], minutes = minutesFromEnv() } = {}) {
  const dayExpr = "COALESCE(l.schedule_date,(l.activated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Baghdad')::date)";

  function buildText({ stageName, day, anchorAt, scheduled, published, missing }) {
    const at = new Date(anchorAt).toLocaleTimeString('ar-IQ', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
    const lines = missing.map((m) => `• ${m.name}${m.opened_by_fallback ? ' — فُتحت تلقائيًا من الجدول بلا رابط' : ' — لم تُفتح بعد'}`);
    return `⚠️ متابعة النشر — المرحلة «${stageName}»\n` +
      `مرّ ${minutes} دقيقة على أول منشور درس اليوم (${day}، الساعة ${at} بتوقيت بغداد) ولم تُنشر كل المواد المجدولة.\n\n` +
      `المجدول: ${scheduled} • المنشور: ${published} • الناقص: ${missing.length}\n` +
      `مواد لم يظهر لها منشور في القناة:\n${lines.join('\n')}\n\n` +
      'تأكد من نشرها في القناة (ومن صحة الاسم أو الوسم). إذا وصل المنشور لاحقًا يُربط بالدرس تلقائيًا.';
  }

  // يفحص موسمًا وتاريخًا واحدًا. يعيد { alerted, ... } ولا يرسل أكثر من تنبيه واحد لنفس الموسم واليوم.
  async function sweepDate(stageSeasonId, day, { now = null } = {}) {
    if (minutes === null || !DATE_RE.test(String(day || ''))) return { alerted: false, reason: 'disabled' };
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      const season = (await c.query(`SELECT ss.id, st.name AS stage_name FROM stage_seasons ss JOIN stages st ON st.id=ss.stage_id
        WHERE ss.id=$1 AND ss.is_active=true AND st.is_active=true`, [stageSeasonId])).rows[0];
      if (!season) { await c.query('COMMIT'); return { alerted: false, reason: 'inactive' }; }
      const anchor = (await c.query(`SELECT MIN(COALESCE(l.attendance_opened_at,l.activated_at)) AS at,
          (MIN(COALESCE(l.attendance_opened_at,l.activated_at)) + make_interval(mins => ${minutes}) <= now()) AS due
        FROM effective_lessons l
        WHERE l.stage_season_id=$1 AND l.source_type = ANY($2::text[]) AND ${dayExpr}=$3::date`,
      [stageSeasonId, CHANNEL_SOURCES, day])).rows[0];
      if (!anchor || !anchor.at) { await c.query('COMMIT'); return { alerted: false, reason: 'no-posts-yet' }; }
      if (!anchor.due) { await c.query('COMMIT'); return { alerted: false, reason: 'not-due' }; }

      const scheduled = (await c.query(`SELECT sub.id, sub.name,
          EXISTS(SELECT 1 FROM effective_lessons l WHERE l.stage_season_id=e.stage_season_id AND l.subject_id=sub.id
            AND ${dayExpr}=e.lesson_date AND l.source_type = ANY($3::text[])) AS has_post,
          EXISTS(SELECT 1 FROM effective_lessons l WHERE l.stage_season_id=e.stage_season_id AND l.subject_id=sub.id
            AND ${dayExpr}=e.lesson_date AND l.source_type='schedule_fallback') AS opened_by_fallback
        FROM lesson_schedule_entries e JOIN subjects sub ON sub.id=e.subject_id
        JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.stage_id=sub.stage_id
        WHERE e.stage_season_id=$1 AND e.lesson_date=$2::date ORDER BY sub.id`,
      [stageSeasonId, day, CHANNEL_SOURCES])).rows;
      const missing = scheduled.filter((s) => !s.has_post);
      if (!missing.length) { await c.query('COMMIT'); return { alerted: false, reason: 'complete', scheduled: scheduled.length }; }

      const inserted = (await c.query(`INSERT INTO publication_followup_alerts(stage_season_id,lesson_date,scheduled_count,published_count,missing_subject_ids)
        VALUES($1,$2::date,$3,$4,$5::int[]) ON CONFLICT DO NOTHING RETURNING stage_season_id`,
      [stageSeasonId, day, scheduled.length, scheduled.length - missing.length, missing.map((m) => m.id)])).rows[0];
      if (!inserted) { await c.query('COMMIT'); return { alerted: false, reason: 'already-alerted' }; }

      const text = buildText({ stageName: season.stage_name, day, anchorAt: anchor.at, scheduled: scheduled.length,
        published: scheduled.length - missing.length, missing });
      const expiresAt = new Date((now ? now.getTime() : Date.now()) + 12 * 3600e3);
      for (const adminId of adminIds) {
        await enqueueNotification(c, { key: `publication-followup:${stageSeasonId}:${day}:${adminId}`, chatId: adminId, text, expiresAt, priority: 2 });
      }
      await c.query('COMMIT');
      return { alerted: true, text, scheduled: scheduled.length, published: scheduled.length - missing.length, missing: missing.map((m) => m.id) };
    } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
  }

  // يوم اليوم بتوقيت بغداد لكل موسم نشط له جدول فيه.
  async function sweepToday(now = new Date()) {
    if (minutes === null) return { alerted: 0 };
    const day = baghdadDay(now);
    const seasons = (await db.pool.query(`SELECT DISTINCT e.stage_season_id FROM lesson_schedule_entries e
      JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
      JOIN stages st ON st.id=ss.stage_id AND st.is_active=true WHERE e.lesson_date=$1::date`, [day])).rows;
    let alerted = 0;
    for (const { stage_season_id: id } of seasons) if ((await sweepDate(id, day, { now })).alerted) alerted += 1;
    return { alerted };
  }

  return { sweepDate, sweepToday, minutes };
}

module.exports = { createPublicationFollowup, initSchema, minutesFromEnv };
