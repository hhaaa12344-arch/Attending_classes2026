'use strict';
const {randomUUID}=require('node:crypto');
const {appError,positiveInt,pageOptions}=require('./integrity');
const {enqueueNotification}=require('./outbox');
function createStudentContact(pool){
  const sameRequest=(row,{actorId,role,studentId,subjectId,contextKind,contextId,body})=>
    Number(row.actor_id)===actorId&&Number(row.student_id)===studentId&&row.actor_role===role&&
    Number(row.subject_id||0)===Number(subjectId||0)&&row.context_kind===contextKind&&
    Number(row.context_id||0)===Number(contextId||0)&&row.message_text===body;
  async function teacherRecord(c,actorId){
    const t=(await c.query('SELECT id,full_name FROM teachers WHERE telegram_id=$1 AND is_active=true',[actorId])).rows[0];
    if(!t)throw appError('حساب الأستاذ غير مفعّل.','FORBIDDEN',403);
    return t;
  }
  async function eligible(c,studentId,actorId,role,subjectId){
    if(role==='admin')return;
    const t=await teacherRecord(c,actorId);
    if(!subjectId)throw appError('اختر مادة الأستاذ أولًا.');
    const allowed=(await c.query(`SELECT sub.name FROM teaching_assignments ta
      JOIN stage_seasons ss ON ss.id=ta.stage_season_id AND ss.is_active=true
      JOIN subjects sub ON sub.id=ta.subject_id AND sub.stage_id=ss.stage_id
      JOIN enrollments en ON en.stage_season_id=ss.id AND en.student_id=$3 AND en.status='active'
      JOIN students st ON st.id=en.student_id AND st.is_active=true AND st.stage_id=ss.stage_id
      WHERE ta.teacher_id=$1 AND ta.subject_id=$2 AND en.started_at<=now()
        AND (en.ended_at IS NULL OR en.ended_at>now())`,[t.id,subjectId,studentId])).rows[0];
    if(!allowed)throw appError('هذا الطالب ليس ضمن مادة الأستاذ وموسمها النشط.','FORBIDDEN',403);
    return {teacher:t,subjectName:allowed.name};
  }
  async function search({actorId,role,subjectId=null,q='',page=0}={}){
    actorId=positiveInt(actorId);if(!['admin','teacher'].includes(role))throw appError('الجهة غير صالحة.');
    const p=pageOptions(page,20),query=String(q).trim();
    if(query.length>150)throw appError('عبارة البحث طويلة.');
    const pattern='%'+query.replace(/[\\%_]/g,'\\$&')+'%';
    if(role==='teacher'){
      subjectId=positiveInt(subjectId);
      const t=await teacherRecord(pool,actorId);
      const where=`FROM students st JOIN enrollments en ON en.student_id=st.id AND en.status='active'
        JOIN stage_seasons ss ON ss.id=en.stage_season_id AND ss.is_active=true AND ss.stage_id=st.stage_id
        JOIN subjects sub ON sub.stage_id=ss.stage_id AND sub.id=$2
        JOIN teaching_assignments ta ON ta.stage_season_id=ss.id AND ta.subject_id=sub.id AND ta.teacher_id=$1
        WHERE st.is_active=true AND st.full_name ILIKE $3 ESCAPE '\\'
          AND en.started_at<=now() AND (en.ended_at IS NULL OR en.ended_at>now())`;
      const args=[t.id,subjectId,pattern];
      const total=Number((await pool.query(`SELECT COUNT(*) AS n ${where}`,args)).rows[0].n);
      const rows=(await pool.query(`SELECT st.id,st.full_name,st.telegram_id,sub.name AS subject_name ${where}
        ORDER BY st.full_name,st.id LIMIT $4 OFFSET $5`,[...args,p.size,p.offset])).rows;
      return {rows,total,...p};
    }
    const where=`FROM students st JOIN stages sg ON sg.id=st.stage_id
      WHERE st.full_name ILIKE $1 ESCAPE '\\'`;
    const total=Number((await pool.query(`SELECT COUNT(*) AS n ${where}`,[pattern])).rows[0].n);
    const rows=(await pool.query(`SELECT st.id,st.full_name,st.telegram_id,sg.name AS stage_name,st.is_active ${where}
      ORDER BY st.full_name,st.id LIMIT $2 OFFSET $3`,[pattern,p.size,p.offset])).rows;
    return {rows,total,...p};
  }
  async function send({actorId,role,studentId,subjectId=null,message,contextKind=null,contextId=null,requestKey=null}){
    actorId=positiveInt(actorId);studentId=positiveInt(studentId);
    if(!['admin','teacher'].includes(role))throw appError('الجهة غير صالحة.');
    if(typeof message!=='string'||message.trim().length<1||message.length>3000)throw appError('أدخل رسالة نصية من 1 إلى 3000 حرف.');
    const body=message.trim();if(body.length>3000)throw appError('الرسالة طويلة جدًا.');
    if(requestKey!=null&&(typeof requestKey!=='string'||!/^[a-zA-Z0-9:_-]{8,120}$/.test(requestKey)))throw appError('معرّف الإرسال غير صالح.');
    const key=requestKey||randomUUID();
    if(contextKind!=null&&!['leave','report'].includes(contextKind))throw appError('نوع المرجع غير صالح.');
    if(contextKind)contextId=positiveInt(contextId);
    if(role==='teacher')subjectId=positiveInt(subjectId);
    else if(subjectId!=null)subjectId=positiveInt(subjectId);
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      const previous=(await c.query('SELECT * FROM student_contact_messages WHERE request_key=$1 FOR UPDATE',[key])).rows[0];
      if(previous){
        if(!sameRequest(previous,{actorId,role,studentId,subjectId,contextKind,contextId,body}))
          throw appError('معرّف الطلب مستخدم لرسالة أخرى.','CONFLICT',409);
        await c.query('COMMIT');return {id:previous.id,queued:true,duplicate:true};
      }
      const st=(await c.query('SELECT id,telegram_id,full_name FROM students WHERE id=$1 FOR SHARE',[studentId])).rows[0];
      if(!st)throw appError('الطالب غير موجود.','NOT_FOUND',404);
      const scope=await eligible(c,studentId,actorId,role,subjectId);
      if(contextKind==='leave'){
        if(role!=='admin')throw appError('طلب الإجازة للإدارة فقط.','FORBIDDEN',403);
        if(!(await c.query('SELECT 1 FROM student_leaves WHERE id=$1 AND student_id=$2',[contextId,studentId])).rowCount)
          throw appError('طلب الإجازة لا يخص هذا الطالب.','CONFLICT',409);
      }
      if(contextKind==='report'){
        if(role!=='teacher')throw appError('رد التقرير للأستاذ فقط.','FORBIDDEN',403);
        if(!(await c.query(`SELECT 1 FROM student_reports r JOIN stage_seasons ss ON ss.id=r.stage_season_id AND ss.is_active=true
          WHERE r.id=$1 AND r.student_id=$2 AND r.subject_id=$3`,[contextId,studentId,subjectId])).rowCount)
          throw appError('التقرير لا يخص هذا الطالب أو المادة.','CONFLICT',409);
      }
      const heading=role==='admin'?'📩 رسالة من إدارة المعهد':`📩 رسالة من الأستاذ ${scope.teacher.full_name} — ${scope.subjectName}`;
      const context=contextKind==='leave'?`\nرد على طلب الإجازة #${contextId}`:contextKind==='report'?`\nرد على التقرير #${contextId}`:'';
      const text=`${heading}${context}\n\n${body}`;
      const row=(await c.query(`INSERT INTO student_contact_messages
        (student_id,actor_id,actor_role,teacher_id,subject_id,context_kind,context_id,message_text,request_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(request_key) DO NOTHING RETURNING *`,
        [studentId,actorId,role,scope?.teacher?.id||null,subjectId,contextKind,contextId,body,key])).rows[0];
      if(!row){
        const existing=(await c.query('SELECT * FROM student_contact_messages WHERE request_key=$1',[key])).rows[0];
        if(!existing||!sameRequest(existing,{actorId,role,studentId,subjectId,contextKind,contextId,body}))
          throw appError('معرّف الطلب مستخدم لرسالة أخرى.','CONFLICT',409);
        await c.query('COMMIT');return {id:existing.id,queued:true,duplicate:true};
      }
      const job=(await enqueueNotification(c,{key:`student-contact:${row.id}`,chatId:st.telegram_id,text,priority:2})).rows[0];
      if(!job)throw appError('تعذر حفظ رسالة الطالب.','CONFLICT',409);
      await c.query('UPDATE student_contact_messages SET outbox_id=$2 WHERE id=$1',[row.id,job.id]);
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,$2,'student',$3,NULL,$4::jsonb)`,[actorId,role==='admin'?'contact_student_admin':'contact_student_teacher',studentId,
        JSON.stringify({contact_id:row.id,subject_id:subjectId,context_kind:contextKind,context_id:contextId})]);
      await c.query('COMMIT');return {id:row.id,queued:true,duplicate:false};
    }catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
  }
  async function history({actorId,role,studentId,subjectId=null}){
    actorId=positiveInt(actorId);studentId=positiveInt(studentId);
    if(role==='teacher')subjectId=positiveInt(subjectId);
    await eligible(pool,studentId,actorId,role,subjectId);
    return (await pool.query(`SELECT m.id,m.actor_role,m.subject_id,m.context_kind,m.context_id,m.message_text,m.created_at,
      COALESCE(o.status,'archived') AS delivery_status
      FROM student_contact_messages m LEFT JOIN notification_outbox o ON o.id=m.outbox_id
      WHERE m.student_id=$1 AND ($2='admin' OR (m.actor_role='teacher' AND m.subject_id=$3))
      ORDER BY m.id DESC LIMIT 20`,[studentId,role,subjectId])).rows;
  }
  return {search,send,history};
}
module.exports={createStudentContact};
