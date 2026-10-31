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
    const table=kind==='lesson'?'effective_lessons':'exams';
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
      if(!(await c.query('SELECT 1 FROM effective_lessons WHERE id=$1 AND activated_at<=now()',[id])).rowCount)
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
      if(!(await c.query('SELECT 1 FROM effective_lessons WHERE id=$1 AND activated_at<=now() AND active_until<=now()',[id])).rowCount)
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
  async function lessonAttendance(id,q={}) {
    const lesson=await parent(pool,'lesson',id);
    const page=pageOptions(q.page||0,25);
    const search=String(q.q||'').trim();
    if(search.length>150)throw appError('عبارة البحث طويلة.');
    const args=[id,`%${search.replace(/[\\%_]/g,'\\$&')}%`];
    const filter=`FROM attendance a JOIN students st ON st.id=a.student_id
      WHERE a.lesson_id=$1 AND st.full_name ILIKE $2`;
    const total=Number((await pool.query(`SELECT COUNT(*) AS n ${filter}`,args)).rows[0].n);
    const rows=(await pool.query(`SELECT a.student_id,st.full_name,a.listened_at,a.marking_kind,a.marked_by,a.admin_note
      ${filter} ORDER BY st.full_name,st.id LIMIT $3 OFFSET $4`,[...args,page.size,page.offset])).rows;
    return {lesson:{id:lesson.id,subject_name:lesson.subject_name,activated_at:lesson.activated_at},rows,total,page:page.page,size:page.size};
  }
  async function removeLessonAttendance(id,studentId,actor) {
    studentId=positiveInt(studentId);
    return transaction(async c=>{
      await c.query('SELECT pg_advisory_xact_lock(734221,1)');
      const lesson=await parent(c,'lesson',id);
      const removed=(await c.query('DELETE FROM attendance WHERE lesson_id=$1 AND student_id=$2 RETURNING *',[id,studentId])).rows[0];
      if(!removed)throw appError('لم يعد لهذا الطالب حضور في الدرس المحدد. حدّث القائمة.','NOT_FOUND',404);
      await require('./absence').refreshAdministrativeAttendance(c,[studentId],lesson.stage_season_id,
        process.env.ATTENDANCE_TIME_ZONE||'Asia/Baghdad');
      await audit(c,actor,'remove_lesson_attendance','lesson',id,
        {student_id:studentId,attendance:removed},null);
      return {removed:true,studentId,lessonId:id};
    });
  }
  // الدروس المنشورة في موسم الطالب الحالي التي لا حضور له فيها، وفق قاعدة تقرير الطالب نفسها (ما ينقصه فعلًا في تقريره).
  async function studentMissingLessons(studentId) {
    studentId=positiveInt(studentId);
    const student=(await pool.query('SELECT id,full_name,is_active,stage_id FROM students WHERE id=$1',[studentId])).rows[0];
    if(!student)throw appError('الطالب غير موجود.','NOT_FOUND',404);
    const season=(await pool.query(`SELECT ss.id,ss.stage_id,COALESCE(ss.stage_name_snapshot,sg.name) AS stage_name,se.name AS season_name
      FROM enrollments e JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
      JOIN stages sg ON sg.id=ss.stage_id AND sg.is_active=true JOIN seasons se ON se.id=ss.season_id
      WHERE e.student_id=$1 AND e.status='active' AND ss.stage_id=$2`,[studentId,student.stage_id])).rows[0];
    if(!season||!student.is_active)return {student,season:null,subjects:[],totalMissing:0,openCount:0,notCounted:0};
    const {REPORT_LESSON_ELIGIBILITY}=require('./db');
    const rows=(await pool.query(`WITH numbered AS (
        SELECT l.id,ROW_NUMBER() OVER (PARTITION BY l.subject_id ORDER BY l.activated_at,l.id)::int AS lesson_number
        FROM effective_lessons l WHERE l.stage_season_id=$2)
      SELECT l.id,l.subject_id,sub.name AS subject_name,numbered.lesson_number,l.activated_at,l.active_until,
        (l.active_until>now()) AS is_open,l.source_type
      FROM enrollments e JOIN students st ON st.id=e.student_id
      JOIN effective_lessons l ON l.stage_season_id=e.stage_season_id
      JOIN numbered ON numbered.id=l.id
      JOIN subjects sub ON sub.id=l.subject_id AND sub.stage_id=$3
      WHERE e.student_id=$1 AND e.stage_season_id=$2 AND e.status='active'
        AND ${REPORT_LESSON_ELIGIBILITY}
        AND NOT EXISTS(SELECT 1 FROM attendance a WHERE a.lesson_id=l.id AND a.student_id=st.id)
      ORDER BY sub.name,sub.id,l.activated_at,l.id`,[studentId,season.id,season.stage_id])).rows;
    const published=Number((await pool.query(`SELECT COUNT(*) AS n FROM effective_lessons l JOIN subjects sub ON sub.id=l.subject_id AND sub.stage_id=$3
      WHERE l.stage_season_id=$2 AND COALESCE(l.attendance_opened_at,l.activated_at)<=now()
        AND NOT EXISTS(SELECT 1 FROM attendance a WHERE a.lesson_id=l.id AND a.student_id=$1)`,[studentId,season.id,season.stage_id])).rows[0].n);
    const subjects=[];
    for(const r of rows){
      let group=subjects[subjects.length-1];
      if(!group||group.subject_id!==r.subject_id){group={subject_id:r.subject_id,subject_name:r.subject_name,lessons:[]};subjects.push(group);}
      group.lessons.push({id:r.id,lesson_number:r.lesson_number,activated_at:r.activated_at,active_until:r.active_until,is_open:r.is_open,source_type:r.source_type});
    }
    // «غير محتسبة»: دروس منشورة بلا حضور له لكنها خارج تقريره (نُشرت وانتهت قبل التحاقه أو بعد نقله).
    return {student,season,subjects,totalMissing:rows.length,openCount:rows.filter(r=>r.is_open).length,notCounted:Math.max(0,published-rows.length)};
  }
  // تسجيل حضور إداري متأخر لطالب واحد في عدة دروس منتهية بعملية واحدة: إمّا كلها أو لا شيء.
  async function studentLateAttendance(studentId,body,actor) {
    studentId=positiveInt(studentId);
    if(!Array.isArray(body.lessonIds)||!body.lessonIds.length||body.lessonIds.length>100)throw appError('اختر من درس واحد إلى 100 درس في العملية.');
    const ids=[...new Set(body.lessonIds.map(x=>positiveInt(x)))].sort((a,b)=>a-b),note=noteValue(body.note);
    return transaction(async c=>{
      await c.query('SELECT pg_advisory_xact_lock(734221,1)');
      const seasons=new Set();let added=0,existing=0;
      for(const id of ids){
        const lesson=await parent(c,'lesson',id,true);
        if(!(await c.query('SELECT 1 FROM effective_lessons WHERE id=$1 AND activated_at<=now() AND active_until<=now()',[id])).rowCount)
          throw appError(`الدرس #${id} ما زال مفتوحًا أو لم يُنشر بعد؛ يسجّل الطالب حضوره بنفسه. لم يُحفظ أي تغيير.`,'NOT_EXPIRED',409);
        await validateStudents(c,lesson,[studentId]);
        const rows=(await c.query(`INSERT INTO attendance(student_id,lesson_id,marking_kind,marked_by,admin_note)
          VALUES($1,$2,'admin_late',$3,$4) ON CONFLICT(student_id,lesson_id) DO NOTHING RETURNING *`,[studentId,id,positiveInt(actor),note])).rows;
        if(!rows.length){existing++;continue;}
        added++;seasons.add(lesson.stage_season_id);
        await audit(c,actor,'late_lesson_attendance','lesson',lesson.id,null,
          {subject_id:lesson.subject_id,subject_name:lesson.subject_name,student_ids:[studentId],note,source:'student_profile'});
      }
      for(const seasonId of seasons)await require('./absence').refreshAdministrativeAttendance(c,[studentId],seasonId,
        process.env.ATTENDANCE_TIME_ZONE||'Asia/Baghdad');
      return {added,existing};
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
      // إعلان فوري للطالب بموعد فتح الامتحان له؛ زر الدخول يصله عند بدء النافذة من إشعارات الامتحان.
      // النافذة التي تبدأ الآن لا تحتاج إعلانًا مسبقًا لأن إشعار «فُتح لك الامتحان» يصل بزره مباشرة.
      let announced=0;
      if(start>new Date()){
        const student=(await c.query('SELECT telegram_id FROM students WHERE id=$1 AND is_active=true AND telegram_id IS NOT NULL',[studentId])).rows[0];
        if(student){
          const fmt=d=>d.toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad',hour12:false});
          const text=`📝 أُعيد فتح الامتحان «${exam.title||'الشهري '+exam.exam_number}» في مادة «${exam.subject_name}» لك بقرار من الإدارة.\nسيُفتح لك يوم ${fmt(start)} (بغداد)، وينتهي ${fmt(end)} (بغداد).\nعند بدء الموعد سيصلك زر أداء الامتحان.`;
          announced=(await c.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,expires_at)
            VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(dedupe_key) DO NOTHING`,[
            `exam-reopen-student:${id}:${studentId}:${Math.floor(start.getTime()/1000)}:${Math.floor(end.getTime()/1000)}`,
            student.telegram_id,JSON.stringify([text,{}]),end])).rowCount;
        }
      }
      await audit(c,actor,'reopen_student_exam','exam',exam.id,{window:before,attempt:attempt||null},{...result,announced});
      return result;
    });
  }
  async function reopenExamForMissing(id,body,actor){
    const {start,end}=windowDates(body),note=noteValue(body.note);
    if(end<=new Date())throw appError('حدد نهاية مستقبلية للنافذة.');
    if(end.getTime()-start.getTime()>30*86400000)throw appError('الحد الأقصى للنافذة 30 يومًا.');
    return transaction(async c=>{
      const exam=await parent(c,'exam',id,true);
      if(exam.status!=='published')throw appError('يجب نشر الامتحان أولًا.');
      if(new Date(exam.closes_at)>new Date() || start<new Date(exam.closes_at))
        throw appError('إعادة الفتح متاحة بعد انتهاء الامتحان الأصلي، ولا تبدأ قبله.','INVALID_WINDOW',409);
      const affected=(await c.query(`INSERT INTO exam_student_windows(exam_id,student_id,opens_at,closes_at,note,created_by)
        SELECT $1,st.id,$2,$3,$4,$5
        FROM students st JOIN enrollments en ON en.student_id=st.id
        WHERE st.stage_id=$6 AND en.stage_season_id=$7 AND en.status='active'
          AND st.is_active=true AND st.telegram_id IS NOT NULL
          AND en.started_at<=now() AND (en.ended_at IS NULL OR en.ended_at>now())
          AND NOT EXISTS (SELECT 1 FROM exam_attempts a
            WHERE a.exam_id=$1 AND a.student_id=st.id AND a.submitted_at IS NOT NULL)
        ON CONFLICT(exam_id,student_id) DO UPDATE SET
          opens_at=EXCLUDED.opens_at,closes_at=EXCLUDED.closes_at,note=EXCLUDED.note,
          created_by=EXCLUDED.created_by,updated_at=now()
        RETURNING student_id`,[id,start,end,note,positiveInt(actor),exam.stage_id,exam.stage_season_id])).rows;
      if(!affected.length)throw appError('لا يوجد طلبة مؤهلون لم يسلموا الامتحان.','NOT_FOUND',409);
      const opens=start.toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad',hour12:false});
      const closes=end.toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad',hour12:false});
      const text=`📝 أعلنت الإدارة إعادة فتح الامتحان «${exam.title||'الشهري '+exam.exam_number}» في مادة «${exam.subject_name}» لمن لم يؤدّه.\nالبداية: ${opens} (بغداد)\nالنهاية: ${closes} (بغداد).\nعند بدء النافذة سيصلك زر أداء الامتحان.`;
      const signature=`exam-reopen:${id}:${Math.floor(start.getTime()/1000)}:${Math.floor(end.getTime()/1000)}`;
      const notices=await c.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,expires_at)
        SELECT $1||':'||st.id::text,st.telegram_id,$2::jsonb,$3
        FROM students st WHERE st.id=ANY($4::integer[])
        ON CONFLICT(dedupe_key) DO NOTHING`,[signature,JSON.stringify([text,{}]),end,affected.map(x=>x.student_id)]);
      await audit(c,actor,'reopen_exam_for_missing','exam',id,null,
        {studentCount:affected.length,notified:notices.rowCount,opensAt:start,closesAt:end,note});
      return {studentCount:affected.length,notified:notices.rowCount,opensAt:start,closesAt:end};
    });
  }
  return {options,correctSubject,lateAttendance,lessonAttendance,removeLessonAttendance,reopenExam,reopenExamForMissing,studentMissingLessons,studentLateAttendance};
}
module.exports={createAdminOverrides,windowDates};
