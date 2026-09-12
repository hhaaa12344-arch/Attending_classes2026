'use strict';
const { pageOptions, positiveInt, appError } = require('./integrity');

function createAdminData(db, studies) {
  const pool = db.pool;
  async function stages() {
    return (await pool.query(`SELECT st.id,st.name,st.stage_type,st.is_active,ss.id AS stage_season_id,se.name AS season_name,
      (SELECT COUNT(*) FROM students s WHERE s.stage_id=st.id AND s.is_active=true) AS student_count,
      (SELECT COUNT(*) FROM subjects s WHERE s.stage_id=st.id) AS subject_count,
      (SELECT COUNT(*) FROM mubahatha_groups g WHERE g.stage_season_id=ss.id AND g.is_active=true) AS group_count
      FROM stages st LEFT JOIN stage_seasons ss ON ss.stage_id=st.id AND ss.is_active=true
      LEFT JOIN seasons se ON se.id=ss.season_id ORDER BY st.sort_order NULLS LAST,st.id`)).rows;
  }
  async function students({ stageId = null, seasonId = null, groupId = null, q = '', status = 'active', page = 0, size = 25 } = {}) {
    const p = pageOptions(page,size);
    if (!['active','archived','all'].includes(status)) throw appError('حالة الطالب غير صالحة.');
    if (String(q).length > 150) throw appError('عبارة البحث طويلة.');
    for (const id of [stageId,seasonId,groupId]) if (id != null) positiveInt(id);
    const args = [stageId,seasonId,groupId,`%${String(q).replace(/[\\%_]/g,'\\$&')}%`,status];
    const where = `FROM students st JOIN stages sg ON sg.id=st.stage_id
      WHERE ($1::int IS NULL OR st.stage_id=$1)
      AND ($2::int IS NULL OR EXISTS(SELECT 1 FROM enrollments e WHERE e.student_id=st.id AND e.stage_season_id=$2))
      AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM group_memberships gm WHERE gm.student_id=st.id AND gm.group_id=$3))
      AND st.full_name ILIKE $4
      AND ($5='all' OR st.is_active=($5='active'))`;
    const total = Number((await pool.query(`SELECT COUNT(*) AS n ${where}`,args)).rows[0].n);
    const rows = (await pool.query(`SELECT st.id,st.full_name,st.telegram_id,st.stage_id,sg.name AS stage_name,st.is_active,
      st.official_confirmed_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('subject',sub.name,'group',g.title,'group_id',g.id) ORDER BY sub.name)
        FROM group_memberships gm JOIN mubahatha_groups g ON g.id=gm.group_id
        JOIN subjects sub ON sub.id=gm.subject_id JOIN stage_seasons ss ON ss.id=gm.stage_season_id
        WHERE gm.student_id=st.id AND (($2::int IS NOT NULL AND ss.id=$2) OR ($2 IS NULL AND ss.is_active=true))), '[]'::jsonb) AS groups
      ${where} ORDER BY st.full_name,st.id LIMIT $6 OFFSET $7`, [...args,p.size,p.offset])).rows;
    return { rows,total,page:p.page,size:p.size };
  }
  async function stage(id) {
    const info = (await stages()).find(x => Number(x.id) === Number(id));
    if (!info) throw appError('المرحلة غير موجودة.','NOT_FOUND',404);
    const subjects = (await pool.query(`SELECT sub.*,
      (SELECT string_agg(t.full_name,'، ' ORDER BY t.id) FROM teaching_assignments ta JOIN teachers t ON t.id=ta.teacher_id AND t.is_active=true
        WHERE ta.subject_id=sub.id AND ta.stage_season_id=$2) AS teacher_name,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'name',t.full_name) ORDER BY t.id)
        FROM teaching_assignments ta JOIN teachers t ON t.id=ta.teacher_id AND t.is_active=true
        WHERE ta.subject_id=sub.id AND ta.stage_season_id=$2),'[]'::jsonb) AS teachers
      FROM subjects sub WHERE sub.stage_id=$1 ORDER BY sub.name,sub.id`,[id,info.stage_season_id])).rows;
    const groups = (await pool.query(`SELECT g.*,sub.name AS subject_name,
      (SELECT COUNT(*) FROM group_memberships m WHERE m.group_id=g.id) AS member_count
      FROM mubahatha_groups g JOIN subjects sub ON sub.id=g.subject_id WHERE g.stage_season_id=$1
      ORDER BY sub.name,g.group_number`,[info.stage_season_id])).rows;
    return { ...info,subjects,groups,seasons:await db.listStageSeasons(id) };
  }
  async function student(id) {
    const raw = await db.getStudentById(id);
    if (!raw) throw appError('الطالب غير موجود.','NOT_FOUND',404);
    const { full_name,telegram_id,stage_id,stage_name,is_active,official_confirmed_at } = raw;
    const activity = await db.getStudentCurrentSeasonActivity(id);
    const groups = await studies.listStudentGroups(id);
    const attendance = activity ? await db.getStudentSeasonReport(id,activity.stageSeasonId) : [];
    const leaves = (await pool.query(`SELECT id,stage_season_id,start_date,end_date,days,status,reason,requested_at,decided_at
      FROM student_leaves WHERE student_id=$1 ORDER BY requested_at DESC,id DESC LIMIT 100`,[id])).rows;
    const grades = await studies.getStudentFinalGrades(id);
    return { id,full_name,telegram_id,stage_id,stage_name,is_active,official_confirmed_at,activity,groups,attendance,leaves,grades };
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
      WHERE r.stage_season_id=$1 AND ($2::int IS NULL OR r.group_id=$2)
      ORDER BY r.submitted_at DESC,r.id DESC LIMIT $3 OFFSET $4`,[seasonId,groupId,p.size,p.offset])).rows;
    return {rows,total:Number(rows[0]?.total_count||0),...p};
  }
  async function sessions(seasonId) {
    return (await pool.query(`SELECT s.*,g.title AS group_title,sub.name AS subject_name,
      (SELECT COUNT(*) FROM (SELECT student_id FROM mubahatha_attendance a WHERE a.session_id=s.id
        GROUP BY student_id HAVING bool_or(phase='start') AND bool_or(phase='end')) x) AS complete_count
      FROM mubahatha_sessions s JOIN mubahatha_groups g ON g.id=s.group_id JOIN subjects sub ON sub.id=g.subject_id
      WHERE g.stage_season_id=$1 ORDER BY s.opened_at DESC,s.id DESC LIMIT 100`,[seasonId])).rows;
  }
  const attendanceHeaders=['معرف التسجيل','معرف الطالب','الطالب','المرحلة','الموسم','المادة','المجموعة','معرف الدرس/الجلسة','نوع الحضور','تاريخ تسجيل الحضور','وقت تسجيل الحضور','وقت التسجيل UTC'];
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
        sub.name AS subject_name,NULL::text AS group_title,l.id AS item_id,'درس' AS phase,
        to_char((${time} AT TIME ZONE 'UTC') AT TIME ZONE $3,'YYYY-MM-DD') AS date,
        to_char((${time} AT TIME ZONE 'UTC') AT TIME ZONE $3,'HH24:MI:SS') AS time,
        to_char(${time},'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS utc
        FROM attendance a JOIN students st ON st.id=a.student_id JOIN lessons l ON l.id=a.lesson_id
        JOIN subjects sub ON sub.id=l.subject_id JOIN stage_seasons ss ON ss.id=l.stage_season_id
        JOIN stages sg ON sg.id=ss.stage_id JOIN seasons se ON se.id=ss.season_id
        WHERE ss.id=$1 AND a.id>$2 AND a.id<=$4 ORDER BY a.id LIMIT 500`:
        `SELECT a.id,st.id AS student_id,st.full_name,sg.name AS stage_name,se.name AS season_name,
        sub.name AS subject_name,g.title AS group_title,s.id AS item_id,a.phase,
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
    for await(const row of attendanceRows(seasonId,kind))yield line(attendanceCells(row));
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
      const values=attendanceCells(row);values[8]=({start:'البداية',end:'النهاية'})[row.phase]||row.phase;
      yield line(values);count++;
    }
    yield count?`\n**عدد تسجيلات الحضور:** ${count}\n`:'\nلا توجد تسجيلات حضور لهذا الموسم.\n';
  }
  return {stages,stage,students,student,updateStudent,leaves,reports,sessions,attendanceCsv,attendanceMarkdown};
}
module.exports={createAdminData};
