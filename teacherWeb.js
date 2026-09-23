'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createSessions}=require('./adminAuth');
const {validateTeacherInitData}=require('./teacherAuth');
const {positiveInt,appError,validScore}=require('./integrity');

function createTeacherWeb({db,studies,scheduler,botToken,origin,readJson}) {
  const studentContact=require('./studentContact').createStudentContact(db.pool);
  const sessions=createSessions({ttlMs:30*60*1000,max:2000});
  const authLimits=new Map();

  const json=(res,code,value)=>{
    res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});
    res.end(JSON.stringify(value));
  };

  async function teacherSubjects(teacherId){
    return db.listTeacherSubjects(teacherId);
  }

  async function ownsSubject(teacherId,subjectId,seasonId){
    return (await teacherSubjects(teacherId)).some(s=>Number(s.subject_id)===Number(subjectId)&&Number(s.stage_season_id)===Number(seasonId));
  }

  async function requireOwnedSubject(actor,subjectId,seasonId){
    subjectId=positiveInt(subjectId);seasonId=positiveInt(seasonId);
    if(!await ownsSubject(actor.teacherId,subjectId,seasonId))throw appError('هذه المادة ليست ضمن موادك.','FORBIDDEN',403);
    return {subjectId,seasonId};
  }

  async function requireOwnedExam(actor,examId){
    examId=positiveInt(examId);
    const exam=await studies.getExamById(examId);
    if(!exam)throw appError('الامتحان غير موجود.','NOT_FOUND',404);
    if(!await ownsSubject(actor.teacherId,exam.subject_id,exam.stage_season_id))throw appError('هذا الامتحان ليس ضمن موادك.','FORBIDDEN',403);
    return exam;
  }

  // حضور الأستاذ في هذه اللوحة هو حضور المباحثات فقط، وليس حضور الدروس المنشورة.
  // تُعد الجلسة مكتملة للطالب عندما يسجل حضور البداية والنهاية معًا.
  async function discussionAttendance(subjectId,seasonId){
    return (await db.pool.query(`
      WITH memberships AS (
        SELECT student_id,subject_id,stage_season_id,group_id,assigned_at,NULL::timestamp AS ended_at
        FROM group_memberships
        UNION ALL
        SELECT student_id,subject_id,stage_season_id,group_id,assigned_at,ended_at
        FROM group_membership_history
      )
      SELECT st.id AS student_id,st.full_name,
             COUNT(DISTINCT ms.id) AS eligible_sessions,
             COUNT(DISTINCT ms.id) FILTER (
               WHERE start_att.id IS NOT NULL AND end_att.id IS NOT NULL
             ) AS attended_sessions,
             COUNT(DISTINCT ms.id) FILTER (
               WHERE start_att.id IS NOT NULL AND end_att.id IS NULL
             ) AS incomplete_sessions
      FROM participation_modes pm
      JOIN students st ON st.id=pm.student_id AND st.is_active=true
      JOIN enrollments e ON e.student_id=st.id AND e.stage_season_id=pm.stage_season_id AND e.status='active'
      LEFT JOIN memberships gm ON gm.student_id=pm.student_id AND gm.subject_id=pm.subject_id
        AND gm.stage_season_id=pm.stage_season_id
      LEFT JOIN mubahatha_sessions ms ON ms.group_id=gm.group_id
        AND ms.opened_at>=gm.assigned_at AND (gm.ended_at IS NULL OR ms.opened_at<gm.ended_at)
        AND (pm.joined_mubahatha_at IS NULL OR ms.opened_at>=pm.joined_mubahatha_at)
      LEFT JOIN mubahatha_attendance start_att ON start_att.session_id=ms.id
        AND start_att.student_id=pm.student_id AND start_att.phase='start'
      LEFT JOIN mubahatha_attendance end_att ON end_att.session_id=ms.id
        AND end_att.student_id=pm.student_id AND end_att.phase='end'
      WHERE pm.subject_id=$1 AND pm.stage_season_id=$2
        AND (pm.mode='mubahatha' OR pm.joined_mubahatha_at IS NOT NULL)
      GROUP BY st.id,st.full_name
      ORDER BY st.full_name,st.id`,[subjectId,seasonId])).rows;
  }

  async function dashboard(actor){
    const subjects=await teacherSubjects(actor.teacherId);
    const totals={subjects:subjects.length,students:subjects.reduce((n,s)=>n+Number(s.student_count||0),0),pendingReports:0,todayDiscussions:0};
    const pending=(await db.pool.query(`
      SELECT COUNT(*)::int AS n
      FROM student_reports r
      JOIN teaching_assignments ta ON ta.subject_id=r.subject_id AND ta.stage_season_id=r.stage_season_id
      JOIN stage_seasons ss ON ss.id=r.stage_season_id AND ss.is_active=true
      WHERE ta.teacher_id=$1 AND r.score IS NULL`,[actor.teacherId])).rows[0];
    totals.pendingReports=Number(pending?.n||0);
    const today=(await db.pool.query(`
      SELECT sl.id,sl.subject_id,sl.stage_season_id,sl.day_of_week,sl.hour,sl.minute,sl.duration_hours,
             sub.name AS subject_name,discussion_group_label(g.id) AS group_title,g.id AS group_id
      FROM schedule_slots sl
      JOIN teaching_assignments ta ON ta.subject_id=sl.subject_id AND ta.stage_season_id=sl.stage_season_id AND ta.teacher_id=$1
      JOIN stage_seasons ss ON ss.id=sl.stage_season_id AND ss.is_active=true
      JOIN subjects sub ON sub.id=sl.subject_id
      JOIN mubahatha_groups g ON g.id=sl.group_id
      WHERE sl.is_active=true AND participation_enabled(sl.subject_id,sl.stage_season_id)
        AND sl.day_of_week=EXTRACT(DOW FROM (now() AT TIME ZONE 'Asia/Baghdad'))::int
      ORDER BY sl.hour,sl.minute`,[actor.teacherId])).rows;
    totals.todayDiscussions=today.length;
    const activeSessions=(await db.pool.query(`
      SELECT ms.id,ms.title,ms.opened_at,ms.closes_at,ms.end_opened_at,ms.end_closes_at,ms.is_closed,
             ms.opened_at+make_interval(mins=>$2::int) AS start_attendance_opens_at,
             sub.name AS subject_name,discussion_group_label(g.id) AS group_title,g.subject_id,g.stage_season_id
      FROM mubahatha_sessions ms
      JOIN mubahatha_groups g ON g.id=ms.group_id
      JOIN subjects sub ON sub.id=g.subject_id
      JOIN teaching_assignments ta ON ta.subject_id=g.subject_id AND ta.stage_season_id=g.stage_season_id AND ta.teacher_id=$1
      WHERE g.stage_season_id IN (SELECT id FROM stage_seasons WHERE is_active=true)
        AND (ms.is_closed=false OR (ms.end_closes_at IS NOT NULL AND ms.end_closes_at>now()))
      ORDER BY ms.opened_at DESC LIMIT 8`,[actor.teacherId,studies.START_ATTENDANCE_DELAY_MINUTES])).rows;
    return {teacher:{id:actor.teacherId,full_name:actor.teacherName},totals,today,activeSessions,subjects};
  }

  async function serveStatic(res,pathname){
    const files={'/teacher':'index.html','/teacher/':'index.html','/teacher/app.js':'app.js','/teacher/styles.css':'styles.css'};
    const filename=files[pathname];
    if(!filename)return false;
    res.setHeader('Content-Type',filename.endsWith('.js')?'text/javascript; charset=utf-8':filename.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');
    res.end(await fs.readFile(path.join(__dirname,'teacher',filename)));
    return true;
  }

  return async function handleTeacher(req,res,url){
    if(req.method==='GET'&&await serveStatic(res,url.pathname))return true;
    if(!url.pathname.startsWith('/api/teacher/'))return false;
    if(req.headers.origin&&req.headers.origin!==origin)throw appError('مصدر الطلب غير مسموح.','FORBIDDEN',403);

    if(req.method==='POST'&&url.pathname==='/api/teacher/auth'){
      const key=req.socket.remoteAddress;const now=Date.now();
      for(const [ip,r] of authLimits)if(r.until<=now)authLimits.delete(ip);
      const limit=authLimits.get(key)||{count:0,until:now+60000};
      if(++limit.count>30)throw appError('محاولات دخول كثيرة. انتظر دقيقة.','RATE_LIMIT',429);
      authLimits.set(key,limit);
      const body=await readJson(req);
      const user=validateTeacherInitData(body.initData,botToken);
      const teacher=await db.getTeacherByTelegramId(user.id);
      if(!teacher)throw appError('هذه اللوحة متاحة للأستاذ المرتبط بهذا الحساب فقط.','FORBIDDEN',403);
      const actor={id:user.id,name:user.name,teacherId:teacher.id,teacherName:teacher.full_name};
      return json(res,200,{token:sessions.issue(actor),teacher:{id:teacher.id,full_name:teacher.full_name}}),true;
    }

    const token=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'')?.[1];
    const actor=sessions.get(token);
    if(!actor)throw appError('أعد فتح لوحة الأستاذ من البوت.','UNAUTHORIZED',401);
    const currentTeacher=await db.getTeacherByTelegramId(actor.id);
    if(!currentTeacher||Number(currentTeacher.id)!==Number(actor.teacherId)){
      sessions.revoke(token);
      throw appError('حساب الأستاذ غير مفعّل حاليًا. أعد فتح اللوحة من البوت.','UNAUTHORIZED',401);
    }
    const route=url.pathname.slice('/api/teacher'.length);
    const q=Object.fromEntries(url.searchParams);
    let result;

    if(req.method==='POST'&&route==='/logout'){
      sessions.revoke(token);json(res,200,{ok:true});return true;
    }

    if(req.method==='GET'){
      if(route==='/dashboard')result=await dashboard(actor);
      else if(route==='/student-contact')result=await studentContact.search({actorId:actor.id,role:'teacher',subjectId:q.subjectId,q:q.q||'',page:q.page||0});
      else if(/^\/student-contact\/\d+$/.test(route))result=await studentContact.history({actorId:actor.id,role:'teacher',studentId:positiveInt(route.split('/')[2]),subjectId:q.subjectId});
      else if(route==='/subjects')result=await teacherSubjects(actor.teacherId);
      else if(route==='/attendance'){
        const {subjectId,seasonId}=await requireOwnedSubject(actor,q.subjectId,q.seasonId);
        result=await discussionAttendance(subjectId,seasonId);
      }
      else if(route==='/groups'){
        const {subjectId,seasonId}=await requireOwnedSubject(actor,q.subjectId,q.seasonId);
        result=await studies.listGroups(subjectId,seasonId);
      }
      else if(route==='/schedule'){
        const {subjectId,seasonId}=await requireOwnedSubject(actor,q.subjectId,q.seasonId);
        result=(await studies.listStageSeasonSlots(seasonId)).filter(s=>Number(s.subject_id)===subjectId&&Number(s.teacher_id||actor.teacherId)===actor.teacherId);
      }
      else if(route==='/reports/students'){
        const {subjectId,seasonId}=await requireOwnedSubject(actor,q.subjectId,q.seasonId);
        result=await studies.listReportStudentsForGrading(subjectId,seasonId,{page:Number(q.page||0),size:50,onlyUngraded:q.onlyUngraded==='1'});
      }
      else if(route==='/reports'){
        const studentId=positiveInt(q.studentId);
        const {subjectId,seasonId}=await requireOwnedSubject(actor,q.subjectId,q.seasonId);
        result=await studies.listStudentReports(studentId,subjectId,seasonId,{page:Number(q.page||0),size:30,groupId:q.groupId?positiveInt(q.groupId):null});
      }
      else if(route==='/exams'){
        const {subjectId,seasonId}=await requireOwnedSubject(actor,q.subjectId,q.seasonId);
        result=await studies.listExamsForSubject(subjectId,seasonId);
      }
      else if(/^\/exams\/\d+$/.test(route)){
        const exam=await requireOwnedExam(actor,route.split('/')[2]);
        result={exam,questions:await studies.listExamQuestions(exam.id)};
      }
      else throw appError('الصفحة غير موجودة.','NOT_FOUND',404);
      json(res,200,result??null);return true;
    }

    if(req.method==='POST'){
      const body=await readJson(req);let m;
      if(route==='/student-contact')result=await studentContact.send({...body,actorId:actor.id,role:'teacher'});
      else if((m=/^\/sessions\/(\d+)\/end$/.exec(route))){
        const sessionId=positiveInt(m[1]);
        const allowed=(await db.pool.query(`
          SELECT 1 FROM mubahatha_sessions ms
          JOIN mubahatha_groups g ON g.id=ms.group_id
          JOIN teaching_assignments ta ON ta.subject_id=g.subject_id AND ta.stage_season_id=g.stage_season_id
          JOIN stage_seasons ss ON ss.id=g.stage_season_id AND ss.is_active=true
          WHERE ms.id=$1 AND ta.teacher_id=$2`,[sessionId,actor.teacherId])).rows[0];
        if(!allowed)throw appError('هذه الجلسة ليست ضمن صلاحياتك.','FORBIDDEN',403);
        result=await scheduler.openEnd(sessionId);
        if(!result)throw appError('حضور النهاية مفتوح مسبقًا أو الجلسة غير موجودة.','CONFLICT',409);
      }
      else if((m=/^\/reports\/(\d+)\/score$/.exec(route))){
        const reportId=positiveInt(m[1]);
        const report=(await db.pool.query(`
          SELECT r.* FROM student_reports r
          JOIN teaching_assignments ta ON ta.subject_id=r.subject_id AND ta.stage_season_id=r.stage_season_id
          JOIN stage_seasons ss ON ss.id=r.stage_season_id AND ss.is_active=true
          WHERE r.id=$1 AND ta.teacher_id=$2`,[reportId,actor.teacherId])).rows[0];
        if(!report)throw appError('التقرير غير موجود أو ليس ضمن موادك.','FORBIDDEN',403);
        result=await studies.setReportItemScore(reportId,validScore(body.score,15),actor.id);
      }
      else if(route==='/exams'){
        const {subjectId,seasonId}=await requireOwnedSubject(actor,body.subjectId,body.seasonId);
        const examNumber=positiveInt(body.examNumber,'رقم الامتحان');
        const hours=positiveInt(body.hours,'عدد ساعات الإتاحة');
        if(!/^\d{4}-\d{2}-\d{2}$/.test(body.dateIso||''))throw appError('تاريخ الامتحان غير صالح.');
        const title=typeof body.title==='string'?body.title.trim():'';
        if(title.length<3)throw appError('أدخل موضوع الامتحان بوضوح.');
        if(title.length>150)throw appError('موضوع الامتحان طويل جدًا.');
        result=await studies.createExam(subjectId,seasonId,actor.teacherId,{examNumber,title,dateIso:body.dateIso,hours});
      }
      else if((m=/^\/exams\/(\d+)\/questions$/.exec(route))){
        const exam=await requireOwnedExam(actor,m[1]);
        result=await studies.addExamQuestion(exam.id,body);
      }
      else if((m=/^\/exams\/(\d+)\/publish$/.exec(route))){
        const exam=await requireOwnedExam(actor,m[1]);
        result=await studies.publishExam(exam.id);
      }
      else throw appError('العملية غير متاحة في لوحة الأستاذ.','NOT_FOUND',404);
      json(res,200,result??null);return true;
    }

    throw appError('طريقة طلب غير مسموحة.','METHOD_NOT_ALLOWED',405);
  };
}

module.exports={createTeacherWeb};
