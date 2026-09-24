'use strict';

function reminderText(row) {
  const tasks=[];
  if (!row.official_confirmed_at) tasks.push('أرسل /start إلى البوت، ثم اضغط زر تأكيد التسجيل الرسمي.');
  if (row.missing_modes?.length) tasks.push(`افتح «📖 المباحثات والتقارير»، واختر نوع مشاركتك (مباحثة أو تقرير) في: ${row.missing_modes.join('، ')}.`);
  if (row.missing_groups?.length) tasks.push(`افتح «📖 المباحثات والتقارير» ثم «👥 الدخول إلى المباحثة» للانضمام إلى مجموعة: ${row.missing_groups.join('، ')}.`);
  if (row.missing_reports?.length) tasks.push(`أرسل تقريرًا في: ${row.missing_reports.join('، ')}. افتح «📄 إرسال تقرير»، واختر المادة ثم أرسل نص التقرير أو ملفه.`);
  if (row.pending_transition) tasks.push('أرسل /start إلى البوت وحدد حالتك للموسم الجديد: إعادة المرحلة أو الانتقال.');
  return tasks.length ? `📌 تنويه من إدارة المعهد\n\n${tasks.map((task,i)=>`${i+1}. ${task}`).join('\n')}\n\nبعد إكمال الإجراءات لن يصلك هذا التنويه مرة أخرى في الإرسال القادم.` : null;
}

async function incompleteStudents(pool) {
  const {rows}=await pool.query(`WITH active AS (
    SELECT DISTINCT ON (e.student_id) e.student_id,e.stage_season_id,ss.stage_id
    FROM enrollments e JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
    WHERE e.status='active' AND e.started_at<=now() AND (e.ended_at IS NULL OR e.ended_at>now())
    ORDER BY e.student_id,e.started_at DESC
  ) SELECT st.id,st.telegram_id,st.official_confirmed_at,
      EXISTS(SELECT 1 FROM student_transitions tr WHERE tr.student_id=st.id AND tr.status='pending') AS pending_transition,
      COALESCE((SELECT array_agg(sub.name ORDER BY sub.name) FROM subjects sub
        WHERE sub.stage_id=a.stage_id AND participation_enabled(sub.id,a.stage_season_id)
          AND NOT EXISTS(SELECT 1 FROM participation_modes pm WHERE pm.student_id=st.id
            AND pm.subject_id=sub.id AND pm.stage_season_id=a.stage_season_id)),ARRAY[]::text[]) AS missing_modes,
      COALESCE((SELECT array_agg(sub.name ORDER BY sub.name) FROM participation_modes pm
        JOIN subjects sub ON sub.id=pm.subject_id
        WHERE pm.student_id=st.id AND pm.stage_season_id=a.stage_season_id AND pm.mode='mubahatha'
          AND participation_enabled(pm.subject_id,pm.stage_season_id)
          AND NOT EXISTS(SELECT 1 FROM group_memberships gm WHERE gm.student_id=st.id
            AND gm.subject_id=pm.subject_id AND gm.stage_season_id=pm.stage_season_id)),ARRAY[]::text[]) AS missing_groups
      ,COALESCE((SELECT array_agg(sub.name ORDER BY sub.name) FROM participation_modes pm
        JOIN subjects sub ON sub.id=pm.subject_id
        WHERE pm.student_id=st.id AND pm.stage_season_id=a.stage_season_id AND pm.mode='report'
          AND participation_enabled(pm.subject_id,pm.stage_season_id)
          AND NOT EXISTS(SELECT 1 FROM student_reports r WHERE r.student_id=st.id
            AND r.subject_id=pm.subject_id AND r.stage_season_id=pm.stage_season_id)),ARRAY[]::text[]) AS missing_reports
    FROM students st LEFT JOIN active a ON a.student_id=st.id
    WHERE st.is_active=true AND (a.student_id IS NOT NULL OR EXISTS(
      SELECT 1 FROM student_transitions tr WHERE tr.student_id=st.id AND tr.status='pending'))
    ORDER BY st.id`);
  return rows.map(row=>({studentId:row.id,chatId:row.telegram_id,text:reminderText(row)})).filter(row=>row.text);
}

async function queueIncompleteStudents(pool,campaignId) {
  const rows=await incompleteStudents(pool);
  let queued=0;
  for(let offset=0;offset<rows.length;offset+=250){
    const chunk=rows.slice(offset,offset+250).map(row=>({student_id:row.studentId,chat_id:row.chatId,payload:JSON.stringify([row.text,{}])}));
    const result=await pool.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload)
      SELECT $1||':'||x.student_id::text,x.chat_id,x.payload::jsonb
      FROM jsonb_to_recordset($2::jsonb) AS x(student_id int,chat_id bigint,payload text)
      ON CONFLICT(dedupe_key) DO NOTHING`,[`student-incomplete:${campaignId}`,JSON.stringify(chunk)]);
    queued+=result.rowCount;
  }
  return {eligible:rows.length,queued};
}

module.exports={reminderText,incompleteStudents,queueIncompleteStudents};
