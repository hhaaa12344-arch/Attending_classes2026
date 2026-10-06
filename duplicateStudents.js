'use strict';
// كشف سجلات الطلبة المتشابهة بالاسم. النظام يعرّف الطالب بحساب تليجرام لا بالاسم، فمن يسجّل من حساب ثانٍ
// يصير له سجل ثانٍ. هذه الوحدة تُظهر ذلك للأدمن فقط؛ لا تدمج ولا تحذف ولا تغيّر أي سجل.
// مفتاح الاسم (student_name_key في قاعدة البيانات) يتجاهل الفراغات المتكررة وفروق الهمزات والياء والتاء المربوطة.
const { positiveInt, pageOptions } = require('./integrity');

const ACTIVITY = `((SELECT COUNT(*) FROM attendance a WHERE a.student_id=o.id)
  +(SELECT COUNT(*) FROM mubahatha_attendance ma WHERE ma.student_id=o.id))::int`;
const GROUPS = '(SELECT COUNT(*) FROM group_memberships gm WHERE gm.student_id=o.id)::int';

function createDuplicateStudents(pool) {
  // سجلات أخرى بالاسم نفسه (نشطة ومؤرشفة) لعرضها في ملف الطالب.
  async function twins(studentId) {
    positiveInt(studentId);
    return (await pool.query(`SELECT o.id,o.full_name,o.telegram_id,o.is_active,sg.name AS stage_name,
        ${GROUPS} AS groups_count, ${ACTIVITY} AS activity_count
      FROM students me
      JOIN students o ON o.id<>me.id AND student_name_key(o.full_name)=student_name_key(me.full_name)
      JOIN stages sg ON sg.id=o.stage_id
      WHERE me.id=$1 ORDER BY o.is_active DESC, o.id`, [studentId])).rows;
  }

  // مجموعات الأسماء المتكررة بين الطلبة النشطين فقط؛ السجل المؤرشف يعني أن المشكلة عولجت.
  async function clusters({ page = 0, size = 5 } = {}) {
    const p = pageOptions(page, size);
    const keys = 'SELECT student_name_key(full_name) AS k FROM students WHERE is_active=true GROUP BY 1 HAVING COUNT(*)>1';
    const total = Number((await pool.query(`SELECT COUNT(*) AS n FROM (${keys}) x`)).rows[0].n);
    const pageKeys = (await pool.query(`${keys} ORDER BY k LIMIT $1 OFFSET $2`, [p.size, p.offset])).rows.map((r) => r.k);
    if (!pageKeys.length) return { total, page: p.page, size: p.size, rows: [] };
    const members = (await pool.query(`SELECT student_name_key(o.full_name) AS k,o.id,o.full_name,o.telegram_id,o.is_active,
        sg.name AS stage_name, ${GROUPS} AS groups_count, ${ACTIVITY} AS activity_count
      FROM students o JOIN stages sg ON sg.id=o.stage_id
      WHERE o.is_active=true AND student_name_key(o.full_name)=ANY($1::text[])
      ORDER BY k, o.id`, [pageKeys])).rows;
    const byKey = new Map(pageKeys.map((k) => [k, []]));
    for (const m of members) byKey.get(m.k).push(m);
    return { total, page: p.page, size: p.size, rows: pageKeys.map((k) => ({ key: k, members: byKey.get(k) })) };
  }

  return { twins, clusters };
}

module.exports = { createDuplicateStudents };
