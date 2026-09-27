'use strict';
const { pageOptions, positiveInt, appError } = require('./integrity');

function createAdminData(db, studies) {
  const pool = db.pool;
  // The same audience powers delivery and diagnostics; reopening does not change historical eligibility.
  const sessionAudienceSql=`SELECT st.id AS student_id,st.telegram_id,
    CASE WHEN NOT st.is_active THEN 'inactive'
      WHEN e.student_id IS NULL THEN 'not_enrolled'
      WHEN pm.mode IS DISTINCT FROM 'mubahatha' THEN 'not_mubahatha'
      WHEN m.assigned_at > s.opened_at THEN 'joined_group_later'
      WHEN pm.joined_mubahatha_at IS NULL OR pm.joined_mubahatha_at > s.opened_at THEN 'joined_mode_later'
      ELSE 'eligible' END AS reason
    FROM mubahatha_sessions s JOIN mubahatha_groups g ON g.id=s.group_id
    JOIN group_memberships m ON m.group_id=g.id JOIN students st ON st.id=m.student_id
    LEFT JOIN enrollments e ON e.student_id=st.id AND e.stage_season_id=g.stage_season_id AND e.status='active'
    LEFT JOIN participation_modes pm ON pm.student_id=st.id AND pm.subject_id=g.subject_id AND pm.stage_season_id=g.stage_season_id
    WHERE s.id=$1`;
  async function sessionNotifications(id,c=pool){
    id=positiveInt(id);
    const session=(await c.query(`SELECT id,attendance_reopen_count,attendance_reopen_until,
      attendance_reopen_until>now() AS window_open FROM mubahatha_sessions WHERE id=$1`,[id])).rows[0];
    if(!session)throw appError('المباحثة غير موجودة.','NOT_FOUND',404);
    const audience=(await c.query(`WITH audience AS (${sessionAudienceSql}) SELECT reason,COUNT(*)::int AS count FROM audience GROUP BY reason`,[id])).rows;
    const prefix='session:'+id+':reopen:'+session.attendance_reopen_count+':%';
    const counts=(await c.query(`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER(WHERE status='sent')::int AS sent,
      COUNT(*) FILTER(WHERE status='pending' AND expires_at>now())::int AS pending,
      COUNT(*) FILTER(WHERE status='sending' AND expires_at>now())::int AS sending,
      COUNT(*) FILTER(WHERE status='failed')::int AS failed,
      COUNT(*) FILTER(WHERE status='expired' OR (status IN ('pending','sending') AND expires_at<=now()))::int AS expired
      FROM notification_outbox WHERE dedupe_key LIKE $1`,[prefix])).rows[0];
    const errors=(await c.query(`SELECT last_error AS code,COUNT(*)::int AS count FROM notification_outbox
      WHERE dedupe_key LIKE $1 AND status IN ('pending','sending','failed') AND last_error IS NOT NULL GROUP BY last_error`,[prefix])).rows;
    return {sessionId:id,windowOpen:!!session.window_open,until:session.attendance_reopen_until,
      eligible:audience.find(x=>x.reason==='eligible')?.count||0,audience,counts,errors};
  }
  async function stages(seasonId = null) {
    if (seasonId != null) {
      positiveInt(seasonId);
      return (await pool.query(`SELECT st.id,st.name,st.stage_type,st.is_active,st.registration_visible,ss.discussion_grouping,ss.id AS stage_season_id,se.name AS season_name,true AS is_historical,
        (SELECT COUNT(*) FROM enrollments e WHERE e.stage_season_id=ss.id) AS student_count,
        (SELECT COUNT(*) FROM subjects s WHERE s.stage_id=st.id) AS subject_count,
        (SELECT COUNT(*) FROM mubahatha_groups g WHERE g.stage_season_id=ss.id AND g.merged_into_id IS NULL) AS group_count
        FROM stages st JOIN stage_seasons ss ON ss.stage_id=st.id AND ss.season_id=$1
        LEFT JOIN seasons se ON se.id=ss.season_id ORDER BY st.sort_order NULLS LAST,st.id`,[seasonId])).rows;
    }
    return (await pool.query(`SELECT st.id,st.name,st.stage_type,st.is_active,st.registration_visible,ss.discussion_grouping,ss.id AS stage_season_id,se.name AS season_name,false AS is_historical,
      (SELECT COUNT(*) FROM students s WHERE s.stage_id=st.id AND s.is_active=true) AS student_count,
      (SELECT COUNT(*) FROM subjects s WHERE s.stage_id=st.id) AS subject_count,
      (SELECT COUNT(*) FROM mubahatha_groups g WHERE g.stage_season_id=ss.id AND g.is_active=true) AS group_count
      FROM stages st LEFT JOIN stage_seasons ss ON ss.stage_id=st.id AND ss.is_active=true
      LEFT JOIN seasons se ON se.id=ss.season_id ORDER BY st.sort_order NULLS LAST,st.id`)).rows;
  }
  async function students({ stageId = null, seasonId = null, groupId = null, q = '', status = 'active', mode = null, page = 0, size = 25 } = {}) {
    const p = pageOptions(page,size);
    if (!['active','archived','all'].includes(status)) throw appError('حالة الطالب غير صالحة.');
    if (mode != null && !['mubahatha','report'].includes(mode)) throw appError('وضع المشاركة غير صالح.');
    if (String(q).length > 150) throw appError('عبارة البحث طويلة.');
    for (const id of [stageId,seasonId,groupId]) if (id != null) positiveInt(id);
    const args = [stageId,seasonId,groupId,`%${String(q).replace(/[\\%_]/g,'\\$&')}%`,status,mode];
    const where = `FROM students st JOIN stages sg ON sg.id=st.stage_id
      WHERE ($1::int IS NULL OR ($2::int IS NULL AND st.stage_id=$1) OR EXISTS(SELECT 1 FROM enrollments eh JOIN stage_seasons sh ON sh.id=eh.stage_season_id WHERE eh.student_id=st.id AND sh.id=$2 AND sh.stage_id=$1))
      AND ($2::int IS NULL OR EXISTS(SELECT 1 FROM enrollments e WHERE e.student_id=st.id AND e.stage_season_id=$2))
      AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM group_memberships gm WHERE gm.student_id=st.id AND gm.group_id=$3))
      AND st.full_name ILIKE $4
      AND ($5='all' OR st.is_active=($5='active'))
      AND ($6::text IS NULL OR EXISTS(SELECT 1 FROM participation_modes pm2 WHERE pm2.student_id=st.id AND pm2.mode=$6
        AND (($2::int IS NOT NULL AND pm2.stage_season_id=$2) OR ($2::int IS NULL AND pm2.stage_season_id IN (SELECT id FROM stage_seasons WHERE is_active=true)))))`;
    const total = Number((await pool.query(`SELECT COUNT(*) AS n ${where}`,args)).rows[0].n);
    const rows = (await pool.query(`SELECT st.id,st.full_name,st.telegram_id,st.stage_id,sg.name AS stage_name,st.is_active,
      st.official_confirmed_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('subject',sub.name,'group',CASE WHEN ss.discussion_grouping THEN g.title ELSE 'المرحلة كاملة' END,'group_id',g.id,'group_number',CASE WHEN ss.discussion_grouping THEN g.group_number END,'mode',pm.mode) ORDER BY sub.name)
        FROM group_memberships gm JOIN mubahatha_groups g ON g.id=gm.group_id
        JOIN subjects sub ON sub.id=gm.subject_id JOIN stage_seasons ss ON ss.id=gm.stage_season_id
        LEFT JOIN participation_modes pm ON pm.student_id=st.id AND pm.subject_id=gm.subject_id AND pm.stage_season_id=gm.stage_season_id
        WHERE gm.student_id=st.id AND (($2::int IS NOT NULL AND ss.id=$2) OR ($2 IS NULL AND ss.is_active=true))), '[]'::jsonb) AS groups
      ${where} ORDER BY st.full_name,st.id LIMIT $7 OFFSET $8`, [...args,p.size,p.offset])).rows;
    return { rows,total,page:p.page,size:p.size };
  }
  async function stage(id, seasonId = null) {
    const info = (await stages(seasonId)).find(x => Number(x.id) === Number(id));
    if (!info) throw appError(seasonId?'لا توجد بيانات لهذه المرحلة في الموسم المختار.':'المرحلة غير موجودة.','NOT_FOUND',404);
    const subjects = (await pool.query(`SELECT sub.*,participation_enabled(sub.id,$2) AS participation_enabled,
      (SELECT string_agg(t.full_name,'، ' ORDER BY t.id) FROM teaching_assignments ta JOIN teachers t ON t.id=ta.teacher_id AND t.is_active=true
        WHERE ta.subject_id=sub.id AND ta.stage_season_id=$2) AS teacher_name,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'name',t.full_name) ORDER BY t.id)
        FROM teaching_assignments ta JOIN teachers t ON t.id=ta.teacher_id AND t.is_active=true
        WHERE ta.subject_id=sub.id AND ta.stage_season_id=$2),'[]'::jsonb) AS teachers,
      (SELECT COUNT(*) FROM participation_modes pm WHERE pm.subject_id=sub.id AND pm.stage_season_id=$2 AND pm.mode='mubahatha')::int AS mubahatha_count,
      (SELECT COUNT(*) FROM participation_modes pm WHERE pm.subject_id=sub.id AND pm.stage_season_id=$2 AND pm.mode='report')::int AS report_count,
      (SELECT COUNT(*) FROM enrollments e WHERE e.stage_season_id=$2 AND e.status='active' AND participation_enabled(sub.id,$2)
        AND NOT EXISTS(SELECT 1 FROM participation_modes pm WHERE pm.student_id=e.student_id AND pm.subject_id=sub.id AND pm.stage_season_id=$2))::int AS undecided_count
      FROM subjects sub WHERE sub.stage_id=$1 ORDER BY sub.name,sub.id`,[id,info.stage_season_id])).rows;
    const groups = (await pool.query(`SELECT g.*,sub.name AS subject_name,
      (SELECT COUNT(*) FROM group_memberships m WHERE m.group_id=g.id) AS member_count,
      group_reserved_count(g.stage_season_id,g.group_number) AS reserved_count
      FROM mubahatha_groups g JOIN subjects sub ON sub.id=g.subject_id WHERE g.stage_season_id=$1 AND g.merged_into_id IS NULL
      ORDER BY sub.name,g.group_number`,[info.stage_season_id])).rows;
    if(info.discussion_grouping===false)for(const g of groups){g.title='المرحلة كاملة';g.group_number=null;}
    return { ...info,subjects,groups,seasons:await db.listStageSeasons(id) };
  }
  async function student(id) {
    const raw = await db.getStudentById(id);
    if (!raw) throw appError('الطالب غير موجود.','NOT_FOUND',404);
    const { full_name,telegram_id,stage_id,stage_name,is_active,official_confirmed_at } = raw;
    const activity = await db.getStudentCurrentSeasonActivity(id);
    const groups = await studies.listStudentGroups(id);
    const subjects = await studies.listStudentSubjects(id,{includeDisabled:true});
    const attendance = activity ? await db.getStudentSeasonReport(id,activity.stageSeasonId) : [];
    const leaves = (await pool.query(`SELECT id,stage_season_id,start_date,end_date,days,status,reason,requested_at,decided_at
      FROM student_leaves WHERE student_id=$1 ORDER BY requested_at DESC,id DESC LIMIT 100`,[id])).rows;
    const grades = await studies.getStudentFinalGrades(id);
    return { id,full_name,telegram_id,stage_id,stage_name,is_active,official_confirmed_at,activity,groups,subjects,attendance,leaves,grades };
  }
  async function updateStudent(id, { fullName, active, expectedName }, actor) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const before = (await c.query('SELECT id,full_name,is_active FROM students WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if (!before) throw appError('الطالب غير موجود.','NOT_FOUND',404);
      if (expectedName !== undefined && before.full_name !== expectedName) throw appError('تغيّر السجل من مسؤول آخر. أعد تحميله.','CONFLICT',409);
      if (fullName !== undefined && (typeof fullName !== 'string' || fullName.trim().split(/\s+/).length < 4 || fullName.length>200)) throw appError('أدخل اسمًا رباعيًا، لا يتجاوز 200 حرف.');
      if (active !== undefined && typeof active !== 'boolean') throw appError('الحالة غير صالحة.');
      const after = (await c.query(`UPDATE students SET full_name=COALESCE($2,full_name),is_active=COALESCE($3,is_active)
        WHERE id=$1 RETURNING id,full_name,is_active`,[id,fullName?.trim(),active])).rows[0];
      if (active === false) {
        await c.query(`UPDATE enrollments SET status='archived',ended_at=COALESCE(ended_at,now()) WHERE student_id=$1 AND status='active'`,[id]);
        await c.query(`UPDATE student_transitions SET status='cancelled',decision='student_archived',decided_at=now() WHERE student_id=$1 AND status='pending'`,[id]);
        await c.query(`UPDATE student_leaves SET status='cancelled',decided_at=now(),decided_by=$2 WHERE student_id=$1 AND status='pending'`,[id,actor]);
      } else if (active === true && !before.is_active) {
        const ss = (await c.query(`SELECT ss.id FROM students st JOIN stage_seasons ss ON ss.stage_id=st.stage_id AND ss.is_active=true
          WHERE st.id=$1`,[id])).rows[0];
        if (!ss) throw appError('لا يوجد موسم نشط لإعادة التفعيل.');
        await c.query(`INSERT INTO enrollments(student_id,stage_season_id,status) VALUES($1,$2,'active')
          ON CONFLICT(student_id,stage_season_id) DO UPDATE SET status='active',ended_at=NULL`,[id,ss.id]);
      }
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,'update_student','student',$2,$3::jsonb,$4::jsonb)`,[actor,id,JSON.stringify(before),JSON.stringify(after)]);
      await c.query('COMMIT');
      return after;
    } catch(e) {await c.query('ROLLBACK');throw e;} finally {c.release();}
  }
  async function leaves({stageId=null,page=0,status='pending'}={}) {
    if (!['pending','approved','rejected','ended','cancelled','all'].includes(status)) throw appError('الحالة غير صالحة.');
    const p=pageOptions(page,25);
    const rows=(await pool.query(`SELECT l.*,st.full_name,sg.name AS stage_name,COUNT(*) OVER() AS total_count
      FROM student_leaves l JOIN students st ON st.id=l.student_id
      LEFT JOIN stage_seasons ss ON ss.id=l.stage_season_id JOIN stages sg ON sg.id=COALESCE(ss.stage_id,st.stage_id)
      WHERE ($1::int IS NULL OR sg.id=$1) AND ($2='all' OR l.status=$2)
      ORDER BY l.requested_at DESC,l.id DESC LIMIT $3 OFFSET $4`,[stageId,status,p.size,p.offset])).rows;
    return {rows,total:Number(rows[0]?.total_count||0),...p};
  }
  async function reports({seasonId,groupId=null,page=0}={}) {
    positiveInt(seasonId); const p=pageOptions(page,25);
    const rows=(await pool.query(`SELECT r.*,st.full_name,sub.name AS subject_name,COUNT(*) OVER() AS total_count
      FROM student_reports r JOIN students st ON st.id=r.student_id JOIN subjects sub ON sub.id=r.subject_id
      WHERE r.stage_season_id=$1 AND ($2::int IS NULL OR discussion_group_root(r.group_id)=$2)
      ORDER BY r.submitted_at DESC,r.id DESC LIMIT $3 OFFSET $4`,[seasonId,groupId,p.size,p.offset])).rows;
    return {rows,total:Number(rows[0]?.total_count||0),...p};
  }
  async function sessions(seasonId) {
    return (await pool.query(`SELECT s.*,discussion_group_label(g.id) AS group_title,sub.name AS subject_name,
      (SELECT COUNT(*) FROM (SELECT student_id FROM mubahatha_attendance a WHERE a.session_id=s.id
        GROUP BY student_id HAVING bool_or(phase='start') AND bool_or(phase='end')) x) AS complete_count
      FROM mubahatha_sessions s JOIN mubahatha_groups g ON g.id=s.group_id JOIN subjects sub ON sub.id=g.subject_id
      WHERE g.stage_season_id=$1 ORDER BY s.opened_at DESC,s.id DESC LIMIT 100`,[seasonId])).rows;
  }
  // Lists and summaries share one database snapshot; totals never depend on the page.
  async function managedItems(kind,{stageId,seasonId=null,subjectId=null,page=0,size=25}={}){
    stageId=positiveInt(stageId);if(seasonId)seasonId=positiveInt(seasonId);if(subjectId)subjectId=positiveInt(subjectId);
    const p=pageOptions(page,size),c=await pool.connect();
    try{
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const season=(await c.query(`SELECT ss.*,se.name AS season_name FROM stage_seasons ss JOIN seasons se ON se.id=ss.season_id
        WHERE ss.stage_id=$1 AND (($2::int IS NULL AND ss.is_active=true) OR ss.season_id=$2)`,[stageId,seasonId])).rows[0];
      if(!season)throw appError('لا يوجد موسم لهذه المرحلة.','NOT_FOUND',404);
      const lesson=kind==='lessons';
      const source=lesson?`SELECT l.*,l.subject_id AS item_subject_id,l.activated_at AS published_at FROM lessons l WHERE l.stage_season_id=$1`:
        `SELECT s.*,g.subject_id AS item_subject_id,s.opened_at AS published_at,discussion_group_label(g.id) AS group_title
         FROM mubahatha_sessions s JOIN mubahatha_groups g ON g.id=s.group_id WHERE g.stage_season_id=$1`;
      const subjects=(await c.query(`WITH items AS (${source}) SELECT sub.id,sub.name,COUNT(i.id)::int AS total,
        COUNT(i.id) FILTER (WHERE ${lesson?'i.active_until > now()':`((i.attendance_reopened_at <= now() AND i.attendance_reopen_until > now()) OR
          (i.attendance_reopened_at IS NULL AND ((i.is_closed=false AND i.closes_at > now()) OR i.end_closes_at > now())))`})::int AS open_count
        FROM subjects sub LEFT JOIN items i ON i.item_subject_id=sub.id WHERE sub.stage_id=$2
        GROUP BY sub.id ORDER BY sub.name,sub.id`,[season.id,stageId])).rows;
      if(subjectId&&!subjects.some(s=>s.id===subjectId))throw appError('المادة ليست ضمن المرحلة.');
      const total=subjects.filter(s=>!subjectId||s.id===subjectId).reduce((n,s)=>n+s.total,0);
      const rows=(await c.query(`WITH items AS (${source}), numbered AS (
        SELECT i.*,ROW_NUMBER() OVER (PARTITION BY item_subject_id ORDER BY published_at,id)::int AS item_number FROM items i)
        SELECT i.*,sub.name AS subject_name,${lesson?"i.published_at + interval '24 hours'":'i.attendance_reopen_until'} AS reopen_until,
          (i.published_at <= now() AND ${lesson?"i.published_at + interval '24 hours' > now()":'(i.attendance_reopen_until IS NULL OR i.attendance_reopen_until <= now())'} AND $5::boolean) AS can_reopen,
          ${lesson?`(i.active_until > now()) AS is_active,
            (SELECT COUNT(*)::int FROM attendance a WHERE a.lesson_id=i.id) AS attended_count,
            (SELECT COUNT(*)::int FROM enrollments e WHERE e.stage_season_id=$1 AND e.status='active') AS enrolled_count`:
            `(SELECT COUNT(*)::int FROM (SELECT student_id FROM mubahatha_attendance a WHERE a.session_id=i.id
              GROUP BY student_id HAVING bool_or(phase='start') AND bool_or(phase='end')) a) AS complete_count`}
        FROM numbered i JOIN subjects sub ON sub.id=i.item_subject_id
        WHERE ($2::int IS NULL OR i.item_subject_id=$2) ORDER BY i.published_at DESC,i.id DESC LIMIT $3 OFFSET $4`,
        [season.id,subjectId,p.size,p.offset,season.is_active])).rows;
      await c.query('COMMIT');return {season,subjects,rows,total,...p,
        ...(kind==='sessions'?{startAttendanceDelayMinutes:studies.START_ATTENDANCE_DELAY_MINUTES,
          endAttendanceMinutes:studies.END_ATTENDANCE_MINUTES}:{})};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async function manageSession(id,action,actor){
    id=positiveInt(id);const c=await pool.connect();
    try{
      await c.query('BEGIN');
      const session=(await c.query(`SELECT s.*,g.subject_id,g.stage_season_id,ss.is_active AS season_active,g.is_active AS group_active,
        sub.name AS subject_name,discussion_group_label(g.id) AS group_title,
        participation_enabled(g.subject_id,g.stage_season_id) AS enabled,
        (s.opened_at <= now()) AS can_reopen,
        (s.attendance_reopened_at <= now() AND s.attendance_reopen_until > now()) AS recovery_open
        FROM mubahatha_sessions s JOIN mubahatha_groups g ON g.id=s.group_id JOIN stage_seasons ss ON ss.id=g.stage_season_id
        JOIN subjects sub ON sub.id=g.subject_id
        WHERE s.id=$1 FOR UPDATE OF s FOR SHARE OF ss`,[id])).rows[0];
      if(!session)throw appError('المباحثة غير موجودة.','NOT_FOUND',404);
      if(!session.season_active)throw appError('لا يمكن تعديل مباحثة من موسم مؤرشف.','ARCHIVED',409);
      let result;
      if(action==='cancel'){
        // Prevent the scheduler recreating this occurrence after its FK is cleared.
        await c.query("UPDATE slot_decisions SET decision='postponed' WHERE session_id=$1",[id]);
        await c.query("UPDATE notification_outbox SET status='expired',expires_at=now() WHERE dedupe_key LIKE $1 AND status IN ('pending','sending')",['session:'+id+':%']);
        await c.query('DELETE FROM mubahatha_sessions WHERE id=$1',[id]);result={ok:true};
      }else if(action==='reopen'||action==='retry-notifications'){
        if(!session.can_reopen)throw appError('لم يبدأ موعد المباحثة بعد.','NOT_STARTED',409);
        if(!session.group_active||!session.enabled)throw appError('المجموعة أو المادة غير مفعلة.');
        if(action==='retry-notifications'&&!session.recovery_open)throw appError('انتهت الفرصة؛ أعد فتح الحضور أولًا لمدة 10 دقائق.','EXPIRED',409);
        // Reconcile missing notices on repeat without extending the window or duplicating sent notices.
        result=session.recovery_open?session:(await c.query(`UPDATE mubahatha_sessions SET attendance_reopened_at=now(),
          attendance_reopen_until=now()+make_interval(mins=>$2::int),attendance_reopen_count=attendance_reopen_count+1
          WHERE id=$1 RETURNING *`,[id,studies.DISCUSSION_REOPEN_MINUTES])).rows[0];
        if(!session.recovery_open)await c.query("UPDATE notification_outbox SET status='expired',expires_at=now() WHERE dedupe_key LIKE $1 AND status IN ('pending','sending')",['session:'+id+':%']);
        // Reopened attendance must be reachable even if the old Telegram buttons were consumed.
        const payload=JSON.stringify(['أُعيد فتح حضور مباحثة «'+session.subject_name+'» — '+session.group_title+' ('+session.title+') لمدة 10 دقائق من إعادة الفتح، حتى '+new Date(result.attendance_reopen_until).toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad'})+'؛ استخدم الزرين لتسجيل البداية والنهاية. التسجيل السابق محفوظ.',
          {reply_markup:{inline_keyboard:[[{text:'حضرت البداية',callback_data:'mub_attend:'+id},{text:'حضرت النهاية',callback_data:'mub_end_attend:'+id}]]}}]);
        const prefix='session:'+id+':reopen:'+result.attendance_reopen_count+':';
        const queued=(await c.query(`WITH audience AS (${sessionAudienceSql})
          INSERT INTO notification_outbox(dedupe_key,chat_id,payload,expires_at,priority)
          SELECT $3||student_id,telegram_id,$2::jsonb,$4::timestamptz,2 FROM audience WHERE reason='eligible'
          ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,[id,payload,prefix,result.attendance_reopen_until])).rows.length;
        let retried=0;
        if(action==='retry-notifications'){
          retried=(await c.query(`WITH audience AS (${sessionAudienceSql})
            UPDATE notification_outbox n SET status='pending',available_at=now(),lease_until=NULL,attempts=0,priority=2
            FROM audience a WHERE a.reason='eligible' AND n.dedupe_key=$2||a.student_id
              AND n.status IN ('failed','expired') AND n.expires_at>now() RETURNING n.id`,[id,prefix])).rows.length;
        }
        result={...result,queued,retried,notifications:await sessionNotifications(id,c)};
        if(session.recovery_open&&action==='reopen'&&!queued){await c.query('COMMIT');return result;}
      }else if(action==='mark-all'){
        if(!session.group_active||!session.enabled)throw appError('المجموعة أو المادة غير مفعلة.');
        const added=(await c.query(`INSERT INTO mubahatha_attendance(session_id,student_id,phase,marked_by)
          SELECT s.id,st.id,phase,'admin:'||$2::text FROM mubahatha_sessions s
          JOIN mubahatha_groups g ON g.id=s.group_id
          JOIN group_memberships m ON m.group_id=g.id AND m.assigned_at <= s.opened_at
          JOIN students st ON st.id=m.student_id AND st.is_active=true
          JOIN enrollments e ON e.student_id=st.id AND e.stage_season_id=g.stage_season_id AND e.status='active'
          JOIN participation_modes pm ON pm.student_id=st.id AND pm.subject_id=g.subject_id AND pm.stage_season_id=g.stage_season_id
            AND pm.mode='mubahatha' AND pm.joined_mubahatha_at <= s.opened_at
          CROSS JOIN unnest(ARRAY['start','end']) AS phase
          WHERE s.id=$1 AND s.opened_at <= now()
          ON CONFLICT(session_id,student_id,phase) DO NOTHING RETURNING student_id`,[id,actor])).rows;
        result={added: new Set(added.map(a=>a.student_id)).size,records:added.length};
      }else throw appError('العملية غير صالحة.');
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,$2,'session',$3,$4::jsonb,$5::jsonb)`,[actor,action+'_session',id,JSON.stringify(session),JSON.stringify(result)]);
      await c.query('COMMIT');return result;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  const attendanceHeaders=['تسلسل','معرف التسجيل','معرف الطالب','الطالب','المرحلة','الموسم','المادة','المجموعة','معرف الدرس/الجلسة','نوع الحضور','تاريخ تسجيل الحضور','وقت تسجيل الحضور','وقت التسجيل UTC'];
  const attendanceCells=x=>[x.id,x.student_id,x.full_name,x.stage_name,x.season_name,x.subject_name,x.group_title,x.item_id,x.phase,x.date,x.time,x.utc];
  async function* attendanceRows(seasonId, kind='lessons') {
    positiveInt(seasonId);
    if(!['lessons','discussions'].includes(kind))throw appError('نوع الحضور غير صالح.');
    const upper=Number((await pool.query(`SELECT COALESCE(MAX(id),0) AS id FROM ${kind==='lessons'?'attendance':'mubahatha_attendance'}`)).rows[0].id);
    let cursor=0;
    while(true) {
      const isLesson=kind==='lessons';
      const time=isLesson?'a.listened_at':'a.marked_at';
      const r=await pool.query(isLesson?`SELECT a.id,st.id AS student_id,st.full_name,sg.name AS stage_name,se.name AS season_name,
        sub.name AS subject_name,NULL::text AS group_title,l.id AS item_id,CASE WHEN a.marking_kind='admin_late' THEN 'حضور إداري متأخر' ELSE 'درس' END AS phase,
        to_char((${time} AT TIME ZONE 'UTC') AT TIME ZONE $3,'YYYY-MM-DD') AS date,
        to_char((${time} AT TIME ZONE 'UTC') AT TIME ZONE $3,'HH24:MI:SS') AS time,
        to_char(${time},'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS utc
        FROM attendance a JOIN students st ON st.id=a.student_id JOIN lessons l ON l.id=a.lesson_id
        JOIN subjects sub ON sub.id=l.subject_id JOIN stage_seasons ss ON ss.id=l.stage_season_id
        JOIN stages sg ON sg.id=ss.stage_id JOIN seasons se ON se.id=ss.season_id
        WHERE ss.id=$1 AND a.id>$2 AND a.id<=$4 ORDER BY a.id LIMIT 500`:
        `SELECT a.id,st.id AS student_id,st.full_name,sg.name AS stage_name,se.name AS season_name,
        sub.name AS subject_name,discussion_group_label(g.id) AS group_title,s.id AS item_id,a.phase,
        to_char((${time} AT TIME ZONE 'UTC') AT TIME ZONE $3,'YYYY-MM-DD') AS date,
        to_char((${time} AT TIME ZONE 'UTC') AT TIME ZONE $3,'HH24:MI:SS') AS time,
        to_char(${time},'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS utc
        FROM mubahatha_attendance a JOIN students st ON st.id=a.student_id JOIN mubahatha_sessions s ON s.id=a.session_id
        JOIN mubahatha_groups g ON g.id=s.group_id JOIN subjects sub ON sub.id=g.subject_id
        JOIN stage_seasons ss ON ss.id=g.stage_season_id JOIN stages sg ON sg.id=ss.stage_id JOIN seasons se ON se.id=ss.season_id
        WHERE ss.id=$1 AND a.id>$2 AND a.id<=$4 ORDER BY a.id LIMIT 500`,[seasonId,cursor,process.env.ATTENDANCE_TIME_ZONE||'Asia/Baghdad',upper]);
      if (!r.rows.length) break;
      for (const x of r.rows) yield x;
      cursor=r.rows.at(-1).id;
    }
  }
  async function* attendanceCsv(seasonId,kind='lessons') {
    const cell=v=>`"${String(v??'').replace(/^[\s]*[=+\-@\t\r]/,"'$&").replace(/"/g,'""')}"`;
    const line=row=>row.map(cell).join(',')+'\r\n';
    yield '\uFEFF'+line(attendanceHeaders);
    let sequence=0;
    for await(const row of attendanceRows(seasonId,kind))yield line([++sequence,...attendanceCells(row)]);
  }
  async function* attendanceMarkdown(seasonId,kind='lessons') {
    positiveInt(seasonId);
    if(!['lessons','discussions'].includes(kind))throw appError('نوع الحضور غير صالح.');
    const cell=v=>String(v??'—').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/[\\`*_{}\[\]|]/g,'\\$&').replace(/[\r\n]+/g,' ');
    const line=row=>'| '+row.map(cell).join(' | ')+' |\n';
    const season=(await pool.query(`SELECT se.name AS season_name,COALESCE(ss.stage_name_snapshot,st.name) AS stage_name
      FROM stage_seasons ss JOIN seasons se ON se.id=ss.season_id JOIN stages st ON st.id=ss.stage_id WHERE ss.id=$1`,[seasonId])).rows[0];
    if(!season)throw appError('الموسم غير موجود.','NOT_FOUND',404);
    yield '# تقرير حضور '+(kind==='lessons'?'الدروس':'المباحثات')+'\n\n';
    yield `**المرحلة:** ${cell(season.stage_name)}\n\n**الموسم:** ${cell(season.season_name)}\n\n`;
    yield `**توقيت التسجيل:** ${cell(process.env.ATTENDANCE_TIME_ZONE||'Asia/Baghdad')}، مع عمود مستقل لوقت UTC.\n\n`;
    if(kind==='discussions')yield 'لا يكتمل حضور المباحثة إلا بتسجيل البداية والنهاية. يعرض الجدول كل تسجيل على حدة.\n\n';
    yield line(attendanceHeaders)+'| '+attendanceHeaders.map(()=>'---').join(' | ')+' |\n';
    let count=0;
    for await(const row of attendanceRows(seasonId,kind)){
      const values=[++count,...attendanceCells(row)];values[9]=({start:'البداية',end:'النهاية'})[row.phase]||row.phase;
      yield line(values);
    }
    yield count?`\n**عدد تسجيلات الحضور:** ${count}\n`:'\nلا توجد تسجيلات حضور لهذا الموسم.\n';
  }
  return {stages,stage,students,student,updateStudent,leaves,reports,sessions,attendanceCsv,attendanceMarkdown,managedItems,manageSession,sessionNotifications,
    lessonAttendanceMarkdown:require('./lessonAttendance').createLessonAttendance(pool).markdown,
    lessonAttendance:require('./lessonAttendance').createLessonAttendance(pool).matrix,
    saveParticipationSettings:require('./participationSettings').createParticipationSettings(pool).save};
}
module.exports={createAdminData};
