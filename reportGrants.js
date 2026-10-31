'use strict';
// استثناء إداري: قبول تقرير طالب في مادة لأسبوع محدد في أي يوم.
// الأسبوع من الأحد إلى السبت. يُستهلك الاستثناء بأول تقرير يرسله الطالب في المادة،
// ويُحتسب ذلك التقرير للأسبوع الممنوح لا لأسبوع تاريخ الإرسال.
const {appError,positiveInt}=require('./integrity');
const {enqueueNotification}=require('./outbox');

function createReportGrants(pool,{tz,acceptDays}) {
  const WEEK_START="(date_trunc('week',($1::date+1)::timestamp)-interval '1 day')::date";

  async function grant(studentId,body,actor) {
    studentId=positiveInt(studentId);const subjectId=positiveInt(body.subjectId);actor=positiveInt(actor);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(body.week||'')))throw appError('اختر تاريخًا يقع ضمن الأسبوع المطلوب.');
    const note=body.note==null||String(body.note).trim()===''?null:String(body.note).trim().slice(0,300);
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      const week=(await c.query(`SELECT ${WEEK_START} AS w,
        (date_trunc('week',(now() AT TIME ZONE $2)::date::timestamp+interval '1 day')-interval '1 day')::date AS current_week`,[body.week,tz])).rows[0];
      if(!week.w)throw appError('التاريخ غير صالح.');
      if(week.w>week.current_week)throw appError('لا يمكن السماح بتقرير لأسبوع لم يبدأ بعد.');
      const info=(await c.query(`SELECT st.telegram_id,st.full_name,sub.name AS subject_name,ss.id AS stage_season_id,pm.mode,
          participation_enabled(sub.id,ss.id) AS enabled,to_char($3::date,'YYYY-MM-DD') AS week_from,to_char($3::date+6,'YYYY-MM-DD') AS week_to
        FROM students st
        JOIN enrollments e ON e.student_id=st.id AND e.status='active'
        JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
        JOIN subjects sub ON sub.id=$2 AND sub.stage_id=ss.stage_id
        LEFT JOIN participation_modes pm ON pm.student_id=st.id AND pm.subject_id=sub.id AND pm.stage_season_id=ss.id
        WHERE st.id=$1 AND st.is_active=true FOR UPDATE OF st`,[studentId,subjectId,week.w])).rows[0];
      if(!info)throw appError('الطالب أو المادة غير صالح في الموسم الحالي.','NOT_FOUND',404);
      if(info.mode!=='report'||!info.enabled)throw appError('هذا الطالب لا يتابع هذه المادة بنظام التقارير.','CONFLICT',409);
      const done=(await c.query(`SELECT 1 FROM student_reports r WHERE r.student_id=$1 AND r.subject_id=$2 AND r.stage_season_id=$3
        AND COALESCE(r.counted_week,(date_trunc('week',((r.submitted_at AT TIME ZONE 'UTC') AT TIME ZONE $5)+interval '1 day')-interval '1 day')::date)=$4::date
        AND (r.counted_week IS NOT NULL OR EXTRACT(ISODOW FROM ((r.submitted_at AT TIME ZONE 'UTC') AT TIME ZONE $5))::int = ANY($6::int[])) LIMIT 1`,
        [studentId,subjectId,info.stage_season_id,week.w,tz,acceptDays])).rowCount;
      if(done)throw appError('للطالب تقرير محتسب في هذا الأسبوع أصلًا.','CONFLICT',409);
      const row=(await c.query(`INSERT INTO report_week_grants(student_id,subject_id,stage_season_id,week_start,granted_by,note)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(student_id,subject_id,stage_season_id,week_start) DO UPDATE
          SET cancelled_at=NULL,granted_by=EXCLUDED.granted_by,note=EXCLUDED.note,created_at=now()
          WHERE report_week_grants.used_at IS NULL AND report_week_grants.cancelled_at IS NOT NULL RETURNING *`,
        [studentId,subjectId,info.stage_season_id,week.w,actor,note])).rows[0];
      if(!row)throw appError('هذا الأسبوع ممنوح لهذا الطالب في هذه المادة من قبل.','CONFLICT',409);
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,'grant_report_week','student',$2,NULL,$3::jsonb)`,[actor,studentId,JSON.stringify({subject_id:subjectId,week_start:info.week_from,note})]);
      if(info.telegram_id)await enqueueNotification(c,{key:`report-grant:${row.id}:${row.created_at.getTime?row.created_at.getTime():Date.now()}`,chatId:info.telegram_id,
        text:`✅ سمحت لك إدارة المعهد بإرسال تقرير مادة «${info.subject_name}» لأسبوع ${info.week_from} إلى ${info.week_to}، في أي يوم.\n\nافتح «🗂️ المباحثات والتقارير» ثم «📄 إرسال تقرير»، واختر المادة وأرسل تقريرك. أول تقرير ترسله لهذه المادة سيُحتسب لذلك الأسبوع.`});
      await c.query('COMMIT');
      return {id:row.id,weekFrom:info.week_from,weekTo:info.week_to,subjectName:info.subject_name};
    }catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
  }

  async function cancel(id,actor) {
    id=positiveInt(id);actor=positiveInt(actor);
    const row=(await pool.query(`UPDATE report_week_grants SET cancelled_at=now() WHERE id=$1 AND used_at IS NULL AND cancelled_at IS NULL RETURNING *`,[id])).rows[0];
    if(!row)throw appError('الاستثناء مستخدم أو ملغى سابقًا.','CONFLICT',409);
    await pool.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
      VALUES($1,'cancel_report_week_grant','student',$2,$3::jsonb,NULL)`,[actor,row.student_id,JSON.stringify({grant_id:id,week_start:row.week_start})]);
    return {id};
  }

  const listForStudent=(studentId)=>pool.query(`SELECT g.id,g.subject_id,sub.name AS subject_name,to_char(g.week_start,'YYYY-MM-DD') AS week_from,
      to_char(g.week_start+6,'YYYY-MM-DD') AS week_to,g.created_at,g.used_at,g.cancelled_at,g.note
    FROM report_week_grants g JOIN subjects sub ON sub.id=g.subject_id
    WHERE g.student_id=$1 ORDER BY g.created_at DESC,g.id DESC LIMIT 50`,[studentId]).then(r=>r.rows);

  return {grant,cancel,listForStudent};
}
module.exports={createReportGrants};
