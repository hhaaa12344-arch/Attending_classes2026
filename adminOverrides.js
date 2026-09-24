'use strict';
const {positiveInt,pageOptions,appError}=require('./integrity');

function windowDates(body) {
  const parse=value=>{
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
      throw appError('أدخل بداية ونهاية صريحتين مع المنطقة الزمنية.');
    const d=new Date(value);
    const [year,month,day]=value.slice(0,10).split('-').map(Number);
    if(!Number.isFinite(d.getTime())||year<1||month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()
      ||Number(value.slice(11,13))>23||Number(value.slice(14,16))>59||(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:/.test(value)&&Number(value.slice(17,19))>59))
      throw appError('الوقت أو التاريخ غير صالح.');
    return d;
  };
  const start=parse(body.opensAt),end=parse(body.closesAt);
  if(end<=start)throw appError('نهاية النافذة يجب أن تكون بعد بدايتها.');
  return {start,end};
}
function noteValue(value) {
  if(value!=null&&(typeof value!=='string'||value.length>500))throw appError('الملاحظة لا تتجاوز 500 حرف.');
  return value?.trim()||null;
}
function createAdminOverrides(pool) {
  async function transaction(fn) {
    const c=await pool.connect();
    try {await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}
    catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async function parent(c,kind,id,lock=false) {
    const table=kind==='lesson'?'lessons':'exams';
    const row=(await c.query(`SELECT p.*,sub.name AS subject_name,ss.stage_id,ss.is_active AS season_active,
      sg.is_active AS stage_active FROM ${table} p JOIN subjects sub ON sub.id=p.subject_id
      JOIN stage_seasons ss ON ss.id=p.stage_season_id AND ss.stage_id=sub.stage_id
      JOIN stages sg ON sg.id=ss.stage_id WHERE p.id=$1 ${lock?'FOR UPDATE OF p FOR SHARE OF ss,sg,sub':''}`,[positiveInt(id)])).rows[0];
    if(!row)throw appError('الدرس أو الامتحان غير موجود.','NOT_FOUND',404);
    if(lock&&(!row.season_active||!row.stage_active))throw appError('لا يمكن تعديل موسم مؤرشف أو مرحلة غير نشطة.','ARCHIVED',409);
    return row;
  }
  async function audit(c,actor,action,kind,id,before,after) {
    await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,[positiveInt(actor),action,kind,id,JSON.stringify(before),JSON.stringify(after)]);
  }
  const eligible=`FROM enrollments en JOIN students st ON st.id=en.student_id
    WHERE en.stage_season_id=$1 AND en.status='active' AND st.is_active=true AND st.stage_id=$2
      AND en.started_at<=now() AND (en.ended_at IS NULL OR en.ended_at>now())`;
  async function options(kind,id,q={}) {
    const item=await parent(pool,kind,id),p=pageOptions(q.page||0,25);
    if(String(q.q||'').length>150)throw appError('عبارة البحث طويلة.');
    const args=[item.stage_season_id,item.stage_id,`%${String(q.q||'').replace(/[\\%_]/g,'\\$&')}%`];
    const filter=eligible+' AND st.full_name ILIKE $3';
    const total=Number((await pool.query(`SELECT COUNT(*) AS n ${filter}`,args)).rows[0].n);
    const rows=(await pool.query(`SELECT st.id,st.full_name,
      ${kind==='lesson'?`(SELECT to_jsonb(a)||jsonb_build_object('listened_at',a.listened_at AT TIME ZONE 'UTC')
         FROM attendance a WHERE a.student_id=st.id AND a.lesson_id=$6) AS attendance`:
        `(SELECT row_to_json(w) FROM exam_student_windows w WHERE w.student_id=st.id AND w.exam_id=$6) AS student_window,
         (SELECT a.submitted_at FROM exam_attempts a WHERE a.student_id=st.id AND a.exam_id=$6) AS submitted_at`}
      ${filter} ORDER BY st.full_name,st.id LIMIT $4 OFFSET $5`,[...args,p.size,p.offset,item.id])).rows;
    const subjects=(await pool.query('SELECT id,name FROM subjects WHERE stage_id=$1 ORDER BY name,id',[item.stage_id])).rows;
    return {item,subjects,rows,total,page:p.page,size:p.size};
  }
  async function validateStudents(c,item,ids) {
    const found=(await c.query(`SELECT st.id ${eligible} AND st.id=ANY($3::int[]) ORDER BY st.id FOR SHARE OF st,en`,
      [item.stage_season_id,item.stage_id,ids])).rows;
    if(found.length!==ids.length)throw appError('أحد الطلبة غير نشط أو ليس مسجلًا حاليًا في مرحلة وموسم الدرس أو الامتحان. لم يُحفظ أي تغيير.','NOT_ENROLLED',409);
  }
  async function correctSubject(id,body,actor) {
    const subjectId=positiveInt(body.subjectId),expected=positiveInt(body.expectedSubjectId);
    return transaction(async c=>{
      const before=await parent(c,'lesson',id,true);
      if(!(await c.query('SELECT 1 FROM lessons WHERE id=$1 AND activated_at<=now()',[id])).rowCount)
        throw appError('لا يمكن تصحيح درس لم يُنشر بعد.');
      if(before.subject_id!==expected)throw appError('تغيرت مادة الدرس منذ فتح الشاشة. حدّث الصفحة.','CONFLICT',409);
      const target=(await c.query('SELECT id,name FROM subjects WHERE id=$1 AND stage_id=$2 FOR SHARE',[subjectId,before.stage_id])).rows[0];
      if(!target)throw appError('المادة الصحيحة يجب أن تكون ضمن مرحلة الدرس.');
      if(subjectId===before.subject_id)return {changed:false,lesson:before};
      const after=(await c.query('UPDATE lessons SET subject_id=$2 WHERE id=$1 RETURNING *',[id,subjectId])).rows[0];
      await audit(c,actor,'correct_lesson_subject','lesson',before.id,
        {subject_id:before.subject_id,subject_name:before.subject_name},
        {subject_id:target.id,subject_name:target.name});
      return {changed:true,lesson:after};
    });
  }
  async function lateAttendance(id,body,actor) {
    if(!Array.isArray(body.studentIds)||!body.studentIds.length||body.studentIds.length>500)throw appError('اختر من طالب واحد إلى 500 طالب في العملية.');
    const ids=[...new Set(body.studentIds.map(x=>positiveInt(x)))].sort((a,b)=>a-b);
    const subjectId=positiveInt(body.subjectId),note=noteValue(body.note);
    return transaction(async c=>{
      // Same lock as absence processing: never leave a stale absence snapshot after marking.
      await c.query('SELECT pg_advisory_xact_lock(734221,1)');
      const lesson=await parent(c,'lesson',id,true);
      if(lesson.subject_id!==subjectId)throw appError('تغيرت مادة الدرس. حدّث الصفحة وحدد الدرس مجددًا.','CONFLICT',409);
      if(!(await c.query('SELECT 1 FROM lessons WHERE id=$1 AND activated_at<=now() AND active_until<=now()',[id])).rowCount)
        throw appError('الحضور الإداري المتأخر متاح بعد انتهاء وقت الدرس فقط.','NOT_EXPIRED',409);
      await validateStudents(c,lesson,ids);
      const rows=(await c.query(`INSERT INTO attendance(student_id,lesson_id,marking_kind,marked_by,admin_note)
        SELECT unnest($1::int[]),$2,'admin_late',$3,$4
        ON CONFLICT(student_id,lesson_id) DO NOTHING RETURNING *`,[ids,id,positiveInt(actor),note])).rows;
      if(rows.length){
        await require('./absence').refreshAdministrativeAttendance(c,rows.map(r=>r.student_id),lesson.stage_season_id,
          process.env.ATTENDANCE_TIME_ZONE||'Asia/Baghdad');
        await audit(c,actor,'late_lesson_attendance','lesson',lesson.id,null,
          {subject_id:subjectId,subject_name:lesson.subject_name,student_ids:rows.map(r=>r.student_id),note});
      }
      return {added:rows.length,existing:ids.length-rows.length};
    });
  }
  async function reopenExam(id,body,actor) {
    const studentId=positiveInt(body.studentId),subjectId=positiveInt(body.subjectId);
    const {start,end}=windowDates(body),note=noteValue(body.note);
    return transaction(async c=>{
      const exam=await parent(c,'exam',id,true);
      if(exam.subject_id!==subjectId)throw appError('الامتحان لا ينتمي للمادة المختارة.');
      if(exam.status!=='published')throw appError('لا يمكن فتح امتحان غير منشور.');
      if(!(await c.query('SELECT 1 FROM exams WHERE id=$1 AND closes_at<=now() AND $2::timestamptz>now() AND $3::timestamptz>=closes_at',
        [id,end,start])).rowCount)throw appError('يجب انتهاء وقت الامتحان الأصلي، وأن تبدأ النافذة بعده وتنتهي في المستقبل.','INVALID_WINDOW',409);
      await validateStudents(c,exam,[studentId]);
      const before=(await c.query('SELECT * FROM exam_student_windows WHERE exam_id=$1 AND student_id=$2',[id,studentId])).rows[0]||null;
      const attempt=(await c.query('SELECT * FROM exam_attempts WHERE exam_id=$1 AND student_id=$2 FOR UPDATE',[id,studentId])).rows[0];
      if(attempt?.submitted_at){
        const counts=(await c.query(`SELECT (SELECT COUNT(*) FROM exam_questions WHERE exam_id=$1)::int AS total,
          (SELECT COUNT(*) FROM exam_answers WHERE attempt_id=$2)::int AS answered`,[id,attempt.id])).rows[0];
        if(counts.answered>=counts.total)throw appError('الطالب أكمل هذا الامتحان وسلّمه؛ لا يمكن إنشاء محاولة ثانية.','ALREADY_SUBMITTED',409);
        // Resume an incomplete timed-out attempt, preserving its answers and original start.
        await c.query('UPDATE exam_attempts SET submitted_at=NULL,score=NULL,correct_count=NULL WHERE id=$1',[attempt.id]);
      }
      const result=(await c.query(`INSERT INTO exam_student_windows(exam_id,student_id,opens_at,closes_at,note,created_by)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(exam_id,student_id) DO UPDATE
        SET opens_at=EXCLUDED.opens_at,closes_at=EXCLUDED.closes_at,note=EXCLUDED.note,created_by=EXCLUDED.created_by,updated_at=now()
        RETURNING *`,[id,studentId,start,end,note,positiveInt(actor)])).rows[0];
      await audit(c,actor,'reopen_student_exam','exam',exam.id,{window:before,attempt:attempt||null},result);
      return result;
    });
  }
  return {options,correctSubject,lateAttendance,reopenExam};
}
module.exports={createAdminOverrides,windowDates};
