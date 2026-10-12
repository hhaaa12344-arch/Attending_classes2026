'use strict';
// ترحيل لمرة واحدة: كان «التحضير الجماعي» بعد انتهاء مهلة الدرس يحفظ الحضور بصفة «طالب» ووقت التأشير بعد المهلة.
// تقرير الطالب وحساب الغياب لا يعدّان حضورًا مؤشَّرًا بعد المهلة إلا إذا كان «حضورًا إداريًا متأخرًا»، فيظهر للأدمن
// 10 من 10 ويظهر للطالب نقص. هنا تُحوَّل تلك الصفوف إلى admin_late (لا يُحذف شيء ولا يتغير وقت التأشير)، مع ملاحظة
// تدل عليها، ثم تُعاد لقطات الغياب للطلبة المتأثرين. الطالب الحقيقي لا يستطيع التأشير بعد المهلة، فأي صف كهذا إداري.
const { refreshAdministrativeAttendance } = require('./absence');

const KEY = 'late_marked_attendance_kind_repair_v1';
const NOTE = 'تصحيح تلقائي: حضور سُجّل بعد انتهاء مهلة الدرس (تحضير جماعي)';

async function repairLateMarkedAttendance(pool, timeZone = process.env.ATTENDANCE_TIME_ZONE || 'Asia/Baghdad') {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // نفس قفل الحضور الإداري: لا يتسابق الترحيل مع تأشير جارٍ.
    await c.query('SELECT pg_advisory_xact_lock(734221,1)');
    if ((await c.query('SELECT 1 FROM applied_migrations WHERE key=$1', [KEY])).rows[0]) {
      await c.query('COMMIT');
      return { skipped: true, repaired: 0 };
    }
    const rows = (await c.query(`UPDATE attendance a SET marking_kind='admin_late', admin_note=COALESCE(a.admin_note,$1)
      FROM effective_lessons l
      WHERE l.id=a.lesson_id AND a.marking_kind='student' AND a.listened_at > l.active_until
      RETURNING a.student_id, l.stage_season_id`, [NOTE])).rows;
    const bySeason = new Map();
    for (const r of rows) {
      if (!bySeason.has(r.stage_season_id)) bySeason.set(r.stage_season_id, new Set());
      bySeason.get(r.stage_season_id).add(r.student_id);
    }
    for (const [seasonId, students] of bySeason) await refreshAdministrativeAttendance(c, [...students], seasonId, timeZone);
    await c.query('INSERT INTO applied_migrations(key) VALUES($1) ON CONFLICT (key) DO NOTHING', [KEY]);
    await c.query('COMMIT');
    return { skipped: false, repaired: rows.length };
  } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
}

module.exports = { repairLateMarkedAttendance, KEY, NOTE };
