'use strict';
// تذكير أسبوعي بالتقارير: آخر يوم من أيام الإرسال (الجمعة) ثم اليوم التالي (السبت).
// يصل فقط لمن اختار «تقرير» في مادة ولم يرسل تقرير الأسبوع فيها، ومرة واحدة في اليوم لكل طالب.
const DEFAULT_FRIDAY_HOUR = Number(process.env.REPORT_REMINDER_LAST_DAY_HOUR ?? 12);
const DEFAULT_SATURDAY_HOUR = Number(process.env.REPORT_REMINDER_AFTER_HOUR ?? 10);

function lastDayText(subjects) {
  return `⏰ تذكير من إدارة المعهد\n\nاليوم آخر يوم لإرسال التقارير هذا الأسبوع، ولم يصلنا تقريرك في:\n${subjects.map((s) => `• ${s}`).join('\n')}\n\nافتح «🗂️ المباحثات والتقارير» ثم «📄 إرسال تقرير»، واختر المادة وأرسل التقرير قبل نهاية اليوم.\nيُحتسب تقرير واحد لكل مادة في الأسبوع.`;
}

function missedText(subjects, daysLabel) {
  return `📌 تنويه من إدارة المعهد\n\nانتهت أيام إرسال التقارير لهذا الأسبوع (${daysLabel})، ولم يصلنا تقريرك في:\n${subjects.map((s) => `• ${s}`).join('\n')}\n\nلا يمكن إرسال تقرير هذا الأسبوع الآن، فاحرص على إرسال تقرير الأسبوع القادم في موعده. وإن كان لديك عذر فتواصل مع إدارة المعهد.`;
}

function createWeeklyReportReminders(pool, { sendDays, tz, dayNames, fridayHour = DEFAULT_FRIDAY_HOUR, saturdayHour = DEFAULT_SATURDAY_HOUR }) {
  const lastDay = Math.max(...sendDays);
  const nextDay = (lastDay % 7) + 1;
  const daysLabel = sendDays.map((d) => dayNames[d]).join(' والـ');

  async function sweep({ at = null } = {}) {
    const now = (await pool.query(
      `SELECT EXTRACT(ISODOW FROM (t.at AT TIME ZONE $1))::int AS dow,
              EXTRACT(HOUR FROM (t.at AT TIME ZONE $1))::int AS hour,
              to_char(t.at AT TIME ZONE $1,'YYYY-MM-DD') AS day
       FROM (SELECT COALESCE($2::timestamptz, now()) AS at) t`, [tz, at])).rows[0];
    let kind = null;
    if (now.dow === lastDay && now.hour >= fridayHour) kind = 'last-day';
    else if (now.dow === nextDay && now.hour >= saturdayHour) kind = 'missed';
    if (!kind) return { kind: null, queued: 0 };

    const rows = (await pool.query(
      `WITH t AS (SELECT COALESCE($2::timestamptz, now()) AS at),
       active AS (
         SELECT DISTINCT ON (e.student_id) e.student_id,e.stage_season_id,ss.stage_id
         FROM enrollments e JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
         WHERE e.status='active' AND e.started_at<=(SELECT at FROM t) AND (e.ended_at IS NULL OR e.ended_at>(SELECT at FROM t))
         ORDER BY e.student_id,e.started_at DESC)
       SELECT st.id AS student_id,st.telegram_id,array_agg(sub.name ORDER BY sub.name) AS subjects
       FROM students st
       JOIN active a ON a.student_id=st.id
       JOIN participation_modes pm ON pm.student_id=st.id AND pm.stage_season_id=a.stage_season_id AND pm.mode='report'
       JOIN subjects sub ON sub.id=pm.subject_id AND sub.stage_id=a.stage_id
       WHERE st.is_active=true AND st.telegram_id IS NOT NULL
         AND participation_enabled(pm.subject_id,pm.stage_season_id)
         AND NOT EXISTS(SELECT 1 FROM stage_calendar_blocks b WHERE b.stage_season_id=a.stage_season_id
           AND b.kind='discussion_end' AND (((SELECT at FROM t) AT TIME ZONE $1)::date)>=b.start_date)
         AND NOT EXISTS(SELECT 1 FROM student_leaves sl WHERE sl.student_id=st.id AND sl.status='approved'
           AND sl.stage_season_id=a.stage_season_id
           AND (((SELECT at FROM t) AT TIME ZONE $1)::date) BETWEEN sl.start_date AND sl.end_date)
         AND NOT EXISTS(SELECT 1 FROM student_reports r
           WHERE r.student_id=st.id AND r.subject_id=pm.subject_id AND r.stage_season_id=pm.stage_season_id
             AND EXTRACT(ISODOW FROM ((r.submitted_at AT TIME ZONE 'UTC') AT TIME ZONE $1))::int = ANY($3::int[])
             AND date_trunc('week',((r.submitted_at AT TIME ZONE 'UTC') AT TIME ZONE $1)+interval '1 day')
               = date_trunc('week',(((SELECT at FROM t)) AT TIME ZONE $1)+interval '1 day'))
       GROUP BY st.id,st.telegram_id ORDER BY st.id`, [tz, at, sendDays])).rows;

    // ينتهي صلاحية التذكير بنهاية يوم المعهد الحالي
    const expires = (await pool.query(
      `SELECT ((((COALESCE($2::timestamptz,now())) AT TIME ZONE $1)::date+1)::timestamp AT TIME ZONE $1) AS e`, [tz, at])).rows[0].e;
    let queued = 0;
    for (const row of rows) {
      const text = kind === 'last-day' ? lastDayText(row.subjects) : missedText(row.subjects, daysLabel);
      const r = await pool.query(
        `INSERT INTO notification_outbox(dedupe_key,chat_id,payload,priority,expires_at)
         VALUES($1,$2,$3::jsonb,5,$4) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
        [`weekly-report:${kind}:${now.day}:${row.student_id}`, row.telegram_id, JSON.stringify([text, {}]), expires]);
      queued += r.rowCount;
    }
    return { kind, eligible: rows.length, queued };
  }
  return { sweep };
}

module.exports = { createWeeklyReportReminders, lastDayText, missedText };
