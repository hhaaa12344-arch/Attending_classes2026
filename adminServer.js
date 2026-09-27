'use strict';
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {validateInitData,createSessions}=require('./adminAuth');
const {positiveInt,appError,validScore,pageOptions}=require('./integrity');
const {enqueueNotification}=require('./outbox');

async function readJson(req) {
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw appError('أرسل البيانات بصيغة JSON.','CONTENT_TYPE',415);
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>32768)throw appError('الطلب أكبر من الحد المسموح.','TOO_LARGE',413);chunks.push(chunk);}
  try{const result=JSON.parse(Buffer.concat(chunks).toString());if(!result||Array.isArray(result)||typeof result!=='object')throw Error();return result;}
  catch{throw appError('بيانات غير صالحة.');}
}
function createAdminServer({db,studies,adminData,scheduler,botToken,adminIds,origin,wakeNotifications}) {
  const overrides=require('./adminOverrides').createAdminOverrides(db.pool);
  const discussionAttendance=require('./discussionAttendance').createDiscussionAttendance(db.pool);
  const lessonRecovery=require('./lessonRecovery').createLessonRecovery(db);
  const historicalRepair=require('./historicalLessonRepair').createHistoricalLessonRepair(db);
  const studentContact=require('./studentContact').createStudentContact(db.pool);
  const oneTimeCohortMove=require('./oneTimeCohortMove').createOneTimeCohortMove(db.pool);
  const scheduleBatchImport=require('./scheduleBatchImport').createScheduleBatchImport(db.pool);
  const sessions=createSessions();const authLimits=new Map();let active=0;
  const teacherWeb=require('./teacherWeb').createTeacherWeb({db,studies,scheduler,botToken,origin,readJson});
  const json=(res,code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  async function audit(actor,action,type,id,before,after) {
    await db.pool.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,[actor,action,type,id,JSON.stringify(before??null),JSON.stringify(after??null)]);
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org");
    let acquired=false;
    try{
      const url=new URL(req.url,'http://local.invalid');
      if(await teacherWeb(req,res,url))return;
      const files={'/admin':'index.html','/admin/':'index.html','/admin/app.js':'app.js','/admin/styles.css':'styles.css'};
      if(req.method==='GET'&&files[url.pathname]) {
        const filename=files[url.pathname];res.setHeader('Content-Type',filename.endsWith('.js')?'text/javascript; charset=utf-8':filename.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');
        return res.end(await fs.readFile(path.join(__dirname,'admin',filename)));
      }
      if(req.method==='GET'&&url.pathname==='/healthz')return json(res,200,{ok:true});
      if(!url.pathname.startsWith('/api/admin/'))throw appError('الصفحة غير موجودة.','NOT_FOUND',404);
      if(req.headers.origin&&req.headers.origin!==origin)throw appError('مصدر الطلب غير مسموح.','FORBIDDEN',403);
      if(active>=16)throw appError('اللوحة مشغولة لحظيًا. حاول مجددًا.','BUSY',503);
      active++;acquired=true;
      if(req.method==='POST'&&url.pathname==='/api/admin/auth'){
        const key=req.socket.remoteAddress;const now=Date.now();
        for(const [ip,r]of authLimits)if(r.until<=now)authLimits.delete(ip);
        const limit=authLimits.get(key)||{count:0,until:now+60000};
        if(++limit.count>30)throw appError('محاولات دخول كثيرة. انتظر دقيقة.','RATE_LIMIT',429);
        authLimits.set(key,limit);
        const body=await readJson(req);const user=validateInitData(body.initData,botToken,adminIds);
        return json(res,200,{token:sessions.issue(user),user});
      }
      const token=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'')?.[1];
      const actor=sessions.get(token);
      if(!actor||!adminIds.includes(actor.id))throw appError('أعد فتح لوحة الإدارة من البوت.','UNAUTHORIZED',401);
      const route=url.pathname.slice('/api/admin'.length);const q=Object.fromEntries(url.searchParams);
      let result,m;
      if(req.method==='POST'&&route==='/logout'){sessions.revoke(token);return json(res,200,{ok:true});}
      if(req.method==='GET'){
        if(route==='/stages')result=await adminData.stages(q.seasonId?positiveInt(q.seasonId):null);
        else if(/^\/stages\/\d+$/.test(route))result=await adminData.stage(positiveInt(route.split('/')[2]),q.seasonId?positiveInt(q.seasonId):null);
        else if(route==='/lesson-attendance.md'){
          const content=await adminData.lessonAttendanceMarkdown(q);
          res.setHeader('Content-Type','text/markdown; charset=utf-8');
          res.setHeader('Content-Disposition',`attachment; filename="lesson-attendance-${positiveInt(q.stageId)}.md"`);
          res.end(content);return;
        }
        else if(/^\/lessons\/\d+\/admin-options$/.test(route))result=await overrides.options('lesson',positiveInt(route.split('/')[2]),q);
        else if(/^\/exams\/\d+\/admin-options$/.test(route))result=await overrides.options('exam',positiveInt(route.split('/')[2]),q);
        else if(/^\/sessions\/\d+\/admin-options$/.test(route))result=await discussionAttendance.options(positiveInt(route.split('/')[2]),q);
        else if(route==='/lesson-publication-repair')result=await historicalRepair.preview(positiveInt(q.stageId));
        else if(route==='/lesson-management')result=await adminData.managedItems('lessons',q);
        else if(route==='/session-management')result=await adminData.managedItems('sessions',q);
        else if(route==='/lesson-attendance')result=await adminData.lessonAttendance(q);
        else if(route==='/students')result=await adminData.students(q);
        else if(route==='/lesson-publication-repair'&&req.method==='POST'){
          result=await historicalRepair.apply(positiveInt(body.stageId),body.token,actor.id);
          if(wakeNotifications)Promise.resolve().then(wakeNotifications).catch(err=>console.error('Corrected lesson delivery failed:',err.code||'DELIVERY_ERROR'));
        }
        else if(route==='/one-time-cohort-move')result=await oneTimeCohortMove.status();
        else if(route==='/student-contact')result=await studentContact.search({actorId:actor.id,role:'admin',q:q.q||'',page:q.page||0});
        else if(/^\/student-contact\/\d+$/.test(route))result=await studentContact.history({actorId:actor.id,role:'admin',studentId:positiveInt(route.split('/')[2])});
        else if(/^\/students\/\d+$/.test(route))result=await adminData.student(positiveInt(route.split('/')[2]));
        else if(route==='/leaves')result=await adminData.leaves(q);
        else if(route==='/reports')result=await adminData.reports(q);
        else if(route==='/sessions')result=await adminData.sessions(positiveInt(q.seasonId));
        else if(route==='/schedule')result=await studies.listStageSeasonSlots(positiveInt(q.seasonId));
        else if(route==='/schedule-batch-import')result=await scheduleBatchImport.status();
        else if(route==='/lesson-schedule')result=await db.getLessonSchedule(positiveInt(q.stageSeasonId));
        else if(/^\/exams\/\d+$/.test(route)){
          const id=positiveInt(route.split('/')[2]);const exam=await studies.getExamById(id);
          if(!exam)throw appError('الامتحان غير موجود.','NOT_FOUND',404);
          const studentWindows=(await db.pool.query(`SELECT w.*,st.full_name FROM exam_student_windows w
            JOIN students st ON st.id=w.student_id WHERE w.exam_id=$1 ORDER BY w.updated_at DESC`,[id])).rows;
          result={...exam,questions:await studies.listExamQuestions(id),studentWindows};
        }
        else if(route==='/exams')result=(await db.pool.query(`SELECT e.*,sub.name AS subject_name FROM exams e JOIN subjects sub ON sub.id=e.subject_id
          WHERE e.stage_season_id=$1 ORDER BY sub.name,e.exam_number`,[positiveInt(q.seasonId)])).rows;
        else if(route==='/teachers')result=(await db.listTeachers()).map(t=>({id:t.id,full_name:t.full_name,phone:t.phone,is_active:t.is_active,linked:Boolean(t.telegram_id),linked_at:t.linked_at,active_subject_count:Number(t.active_subject_count),link_code:t.telegram_id?null:t.link_code}));
        else if(/^\/teachers\/\d+\/subjects$/.test(route))result=await db.listTeacherSubjects(positiveInt(route.split('/')[2]));
        else if(/^\/teachers\/\d+\/performance$/.test(route)){
          const id=positiveInt(route.split('/')[2]);
          const [sessions,reportStats,examStats]=await Promise.all([db.getTeacherSessionLog(id),db.getTeacherReportStats(id),db.getTeacherExamStats(id)]);
          result={sessions,reportStats,examStats};
        }
        else if(route==='/seasons')result=await db.listSeasons();
        else if(route==='/stats/stage-breakdown')result=await db.getStageStudentBreakdown();
        else if(route==='/stats/watchlist'){
          const watchlist=await db.getAbsenceWatchlist();
          const missed=await db.getMissedLessonsBySubject(watchlist.map(w=>w.student_id));
          result=watchlist.map(w=>({...w,missed_subjects:missed.filter(m=>m.student_id===w.student_id).map(({subject_name,total_lessons,attended})=>({subject_name,total_lessons,attended,missed:total_lessons-attended}))}));
        }
        else if(route==='/audit'){const p=pageOptions(q.page||0,25);result=(await db.pool.query('SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT $1 OFFSET $2',[p.size,p.offset])).rows;}
        else if(route==='/notifications')result=(await db.pool.query('SELECT status,COUNT(*) AS count FROM notification_outbox GROUP BY status')).rows;
        else if((m=/^\/sessions\/(\d+)\/notifications$/.exec(route)))result=await adminData.sessionNotifications(positiveInt(m[1]));
        else if(route==='/lessons')result=await db.getRecentLessonsForStage(positiveInt(q.stageId),q.limit?positiveInt(q.limit):15);
        else if((m=/^\/lessons\/(\d+)\/attendance$/.exec(route)))result=await overrides.lessonAttendance(positiveInt(m[1]),q);
        else if(route==='/channel-diagnostics'){
          const [alerts,channels,deep]=await Promise.all([
            db.listUnlinkedChannelAlerts(),db.listChannelsWithStage(),db.getDeepChannelDiagnostics()
          ]);
          result={
            alerts,channels,deep,
            summary:{
              total:deep.length,
              ok:deep.filter(x=>x.health==='ok').length,
              warn:deep.filter(x=>x.health==='warn').length,
              error:deep.filter(x=>x.health==='error').length,
              unknown:deep.filter(x=>x.health==='unknown').length
            }
          };
        }
        else if(route==='/attendance.md'||route==='/attendance.csv'){
          if(!['lessons','discussions'].includes(q.kind||'lessons'))throw appError('نوع التصدير غير صالح.');
          const markdown=route.endsWith('.md');
          res.setHeader('Content-Type',markdown?'text/markdown; charset=utf-8':'text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="attendance-${positiveInt(q.seasonId)}-${q.kind||'lessons'}.${markdown?'md':'csv'}"`);
          const stream=markdown?adminData.attendanceMarkdown(positiveInt(q.seasonId),q.kind||'lessons'):adminData.attendanceCsv(positiveInt(q.seasonId),q.kind||'lessons');
          await pipeline(Readable.from(stream),res);return;
        }
        else throw appError('الصفحة غير موجودة.','NOT_FOUND',404);
      } else if(req.method==='POST'||req.method==='PATCH') {
        const body=await readJson(req);
        if(route==='/student-contact'&&req.method==='POST')result=await studentContact.send({...body,actorId:actor.id,role:'admin'});
        else if(route==='/one-time-cohort-move'&&req.method==='POST')result=await oneTimeCohortMove.execute(body.studentIds,actor.id);
        else if((m=/^\/students\/(\d+)$/.exec(route))&&req.method==='PATCH')result=await adminData.updateStudent(positiveInt(m[1]),body,actor.id);
        else if((m=/^\/students\/(\d+)\/subjects\/(\d+)\/participation$/.exec(route))&&req.method==='PATCH'){
          if(!Object.prototype.hasOwnProperty.call(body,'expectedMode'))throw appError('أعد تحميل نوع المتابعة الحالي.');
          result=await studies.changeParticipationMode(positiveInt(m[1]),positiveInt(m[2]),positiveInt(body.seasonId),body.mode,{actorId:actor.id,expectedMode:body.expectedMode});
        }
        else if((m=/^\/stage-seasons\/(\d+)\/participation-settings$/.exec(route))&&req.method==='PATCH')result=await adminData.saveParticipationSettings(positiveInt(m[1]),body,actor.id);
        else if(route==='/teachers'&&req.method==='POST'){
          if(typeof body.fullName!=='string'||body.fullName.trim().length<3||body.fullName.length>200)throw appError('اسم الأستاذ غير صالح.');
          if(body.phone&&(typeof body.phone!=='string'||body.phone.length>30))throw appError('رقم الهاتف غير صالح.');
          result=await db.addTeacher(body.fullName.trim(),body.phone?.trim()||null);
          await audit(actor.id,'create_teacher','teacher',result.id,null,{full_name:result.full_name});
        }
        else if((m=/^\/teachers\/(\d+)$/.exec(route))&&req.method==='PATCH'){
          const id=positiveInt(m[1]);const before=await db.getTeacherById(id);
          if(!before)throw appError('الأستاذ غير موجود.','NOT_FOUND',404);
          if(typeof body.fullName!=='string'||body.fullName.trim().length<3||body.fullName.length>200)throw appError('اسم الأستاذ غير صالح.');
          result=await db.updateTeacherName(id,body.fullName.trim());
          await audit(actor.id,'update_teacher','teacher',id,{full_name:before.full_name},{full_name:result.full_name});
        }
        else if((m=/^\/teachers\/(\d+)\/toggle$/.exec(route))&&req.method==='POST'){
          const id=positiveInt(m[1]);if(typeof body.active!=='boolean')throw appError('الحالة غير صالحة.');
          const before=await db.getTeacherById(id);if(!before)throw appError('الأستاذ غير موجود.','NOT_FOUND',404);
          result=await db.setTeacherActive(id,body.active);
          await audit(actor.id,'toggle_teacher','teacher',id,{is_active:before.is_active},{is_active:result.is_active});
        }
        else if((m=/^\/teachers\/(\d+)\/regenerate-code$/.exec(route))&&req.method==='POST'){
          const id=positiveInt(m[1]);const before=await db.getTeacherById(id);if(!before)throw appError('الأستاذ غير موجود.','NOT_FOUND',404);
          const updated=await db.regenerateTeacherCode(id);result={id:updated.id,link_code:updated.link_code};
          await audit(actor.id,'regenerate_code','teacher',id,null,{regenerated:true});
        }
        else if((m=/^\/assignments\/(\d+)\/remove$/.exec(route))&&req.method==='POST'){
          const id=positiveInt(m[1]);result={removed:await db.unassignTeacherFromSubject(id)};
          if(result.removed)await audit(actor.id,'unassign_teacher','assignment',id,null,result);
        }
        else if((m=/^\/groups\/(\d+)$/.exec(route))&&req.method==='PATCH'){
          const id=positiveInt(m[1]);const before=await studies.getGroupById(id);
          if(!before)throw appError('المجموعة غير موجودة.','NOT_FOUND',404);
          result=await studies.updateGroupSettings(id,body);
          await audit(actor.id,'update_group','group',id,before,result);
        }
        else if((m=/^\/students\/(\d+)\/stage$/.exec(route))&&req.method==='POST'){
          const id=positiveInt(m[1]),stageId=positiveInt(body.stageId);const before=await db.getStudentById(id);
          await db.updateStudentStage(id,stageId);result={id,stageId};
          await audit(actor.id,'move_stage','student',id,{stage_id:before.stage_id},result);
        }
        else if(route==='/assignments'&&req.method==='POST'){
          const teacher=await db.getTeacherById(positiveInt(body.teacherId));
          if(!teacher?.is_active)throw appError('اختر أستاذًا نشطًا.');
          result=await db.assignTeacherToSubject(teacher.id,positiveInt(body.subjectId));
          if(result)await audit(actor.id,'assign_teacher','subject',Number(body.subjectId),null,{teacher_id:teacher.id});
        }
        else if(route==='/lesson-schedule'&&req.method==='POST'){
          result=await db.setLessonScheduleEntry(positiveInt(body.stageSeasonId),positiveInt(body.subjectId),body.lessonDate,body.checked===true);
          await audit(actor.id,body.checked===true?'set_lesson_schedule':'remove_lesson_schedule','lesson_schedule',
            Number(body.subjectId),null,{stage_season_id:Number(body.stageSeasonId),lesson_date:body.lessonDate,checked:body.checked===true});
        }
        else if(route==='/schedule'&&req.method==='POST'){
          result=await studies.addScheduleSlot(positiveInt(body.groupId),{dayOfWeek:body.dayOfWeek,hour:body.hour,minute:body.minute,teacherId:positiveInt(body.teacherId)});
          await audit(actor.id,'create_slot','slot',result.slot.id,null,result.slot);
        }
        else if(route==='/schedule-batch-import'&&req.method==='POST')result=await scheduleBatchImport.execute(actor.id);
        else if((m=/^\/schedule\/(\d+)\/remove$/.exec(route))&&req.method==='POST'){
          const id=positiveInt(m[1]);result={removed:await studies.removeScheduleSlot(id)};
          if(result.removed)await audit(actor.id,'remove_slot','slot',id,null,result);
        }
        else if(route==='/exams'&&req.method==='POST'){
          const subjectId=positiveInt(body.subjectId),seasonId=positiveInt(body.seasonId),teacherId=positiveInt(body.teacherId);
          const allowed=(await db.pool.query(`SELECT 1 FROM teaching_assignments ta JOIN teachers t ON t.id=ta.teacher_id AND t.is_active=true
            JOIN subjects sub ON sub.id=ta.subject_id JOIN stage_seasons ss ON ss.id=ta.stage_season_id AND ss.is_active=true AND ss.stage_id=sub.stage_id
            JOIN stages st ON st.id=ss.stage_id AND st.stage_type<>'lessons_only'
            WHERE ta.teacher_id=$1 AND ta.subject_id=$2 AND ta.stage_season_id=$3`,[teacherId,subjectId,seasonId])).rows[0];
          if(!allowed)throw appError('اختر مادة وأستاذًا مسندًا إليها في الموسم النشط.');
          if(typeof body.title!=='string'||body.title.length>150||!/^\d{4}-\d{2}-\d{2}$/.test(body.dateIso||''))throw appError('عنوان أو تاريخ غير صالح.');
          result=await studies.createExam(subjectId,seasonId,teacherId,body);
          await audit(actor.id,'create_exam','exam',result.id,null,result);
        }
        else if((m=/^\/exams\/(\d+)\/(question|publish|postpone|cancel)$/.exec(route))&&req.method==='POST'){
          const id=positiveInt(m[1]);const before=await studies.getExamById(id);
          if(!before||(await db.pool.query('SELECT 1 FROM stage_seasons WHERE id=$1 AND is_active=true',[before.stage_season_id])).rowCount!==1)throw appError('الامتحان غير موجود أو موسمه مؤرشف.');
          if(m[2]==='question')result=await studies.addExamQuestion(id,body);
          else if(m[2]==='publish')result=await studies.publishExam(id);
          else if(m[2]==='cancel')result=await studies.cancelExam(id,actor.id,body.reason);
          else {if(!/^\d{4}-\d{2}-\d{2}$/.test(body.dateIso||''))throw appError('التاريخ غير صالح.');result=await studies.postponeExam(id,body.dateIso,before.available_hours);}
          await audit(actor.id,'exam_'+m[2],'exam',id,{status:before.status},m[2]==='question'?{question_id:result.id}:result);
        }
        else if((m=/^\/questions\/(\d+)\/remove$/.exec(route))&&req.method==='POST'){
          const id=positiveInt(m[1]);result={removed:await studies.deleteExamQuestion(id)};
          if(result.removed)await audit(actor.id,'remove_question','question',id,null,result);
        }
        else if((m=/^\/exams\/(\d+)\/(update|delete)$/.exec(route))&&req.method==='POST'){
          const id=positiveInt(m[1]),before=await studies.getExamById(id);
          result=m[2]==='update'?await studies.updateExam(id,body):await studies.deleteExam(id);
          await audit(actor.id,m[2]+'_exam','exam',id,before,result);
        }
        else if((m=/^\/questions\/(\d+)\/update$/.exec(route))&&req.method==='POST'){
          const id=positiveInt(m[1]),before=await studies.getQuestionById(id);
          result=await studies.updateExamQuestion(id,body);
          await audit(actor.id,'update_question','question',id,before,result);
        }
        else if((m=/^\/leaves\/(\d+)\/decision$/.exec(route))&&req.method==='POST'){
          if(typeof body.approve!=='boolean')throw appError('حدد الموافقة أو الرفض.');
          const id=positiveInt(m[1]);result=await db.decideLeave(id,body.approve,actor.id);
          if(!result)throw appError('سبق اتخاذ قرار في الطلب. حدّث الصفحة.','CONFLICT',409);
          const st=await db.getStudentById(result.student_id);
          if(st)await enqueueNotification(db.pool,{key:`leave:${id}:decision`,chatId:st.telegram_id,text:body.approve?'✅ تمت الموافقة على إجازتك.':'لم تتم الموافقة على طلب الإجازة. راجع الإدارة عند الحاجة.'});
        }
        else if((m=/^\/stages\/(\d+)\/registration-visibility$/.exec(route))&&req.method==='PATCH'){
          const id=positiveInt(m[1]);
          if(typeof body.visible!=='boolean')throw appError('حالة ظهور المرحلة للتسجيل الجديد غير صالحة.');
          const before=await db.getStageById(id);
          if(!before)throw appError('المرحلة غير موجودة.','NOT_FOUND',404);
          result=await db.setStageRegistrationVisible(id,body.visible);
          await audit(actor.id,'toggle_stage_registration_visibility','stage',id,
            {registration_visible:before.registration_visible},{registration_visible:result.registration_visible});
        }
        else if((m=/^\/students\/(\d+)\/group$/.exec(route))&&req.method==='POST'){
          const id=positiveInt(m[1]);const group=await studies.getGroupById(positiveInt(body.groupId));
          if(!group)throw appError('المجموعة غير موجودة.');
          const before=await studies.getStudentGroup(id,group.subject_id,group.stage_season_id);
          result=await studies.moveStudentToGroup(id,group.subject_id,group.stage_season_id,group.id);
          await audit(actor.id,'move_group','student',id,before,result);
        }
        else if((m=/^\/reports\/(\d+)\/score$/.exec(route))&&req.method==='POST'){
          const id=positiveInt(m[1]);const before=(await db.pool.query(`SELECT r.* FROM student_reports r JOIN stage_seasons ss ON ss.id=r.stage_season_id AND ss.is_active=true WHERE r.id=$1`,[id])).rows[0];
          if(!before)throw appError('التقرير غير موجود أو موسمه مؤرشف.');
          result=await studies.setReportItemScore(id,validScore(body.score,15),actor.id);
          await audit(actor.id,'grade_report','report',id,before,result);
        }
        else if((m=/^\/reports\/(\d+)\/send$/.exec(route))&&req.method==='POST'){
          const r=(await db.pool.query('SELECT * FROM student_reports WHERE id=$1',[positiveInt(m[1])])).rows[0];
          if(!r)throw appError('التقرير غير موجود.');
          result=await enqueueNotification(db.pool,{key:`admin-report:${actor.id}:${r.id}:${Math.floor(Date.now()/60000)}`,chatId:actor.id,
            method:r.file_kind==='document'?'sendDocument':r.file_kind==='photo'?'sendPhoto':'sendMessage',text:r.telegram_file_id||r.note||'تقرير بلا نص',extra:r.telegram_file_id?{caption:r.group_title_snapshot||'تقرير قديم بلا مجموعة'}:{}});
          result={queued:true};
        }
        else if((m=/^\/sessions\/(\d+)\/end$/.exec(route))&&req.method==='POST'){
          result=await scheduler.openEnd(positiveInt(m[1]));if(!result)throw appError('الجلسة أُغلقت مسبقًا أو انتهت مهلتها.','CONFLICT',409);
          await audit(actor.id,'end_session','session',Number(m[1]),null,result);
        }
        else if(route==='/stages'&&req.method==='POST'){
          if(typeof body.name!=='string'||body.name.trim().length<2||body.name.length>100)throw appError('اسم المرحلة غير صالح.');
          result=await db.addStage(body.name.trim());await audit(actor.id,'create_stage','stage',result.id,null,result);
        }
        else if(route==='/subjects'&&req.method==='POST'){
          if(typeof body.name!=='string'||body.name.trim().length<2||body.name.length>100||typeof body.hashtag!=='string'||body.hashtag.length>100)throw appError('بيانات المادة غير صالحة.');
          result=await db.addSubject(positiveInt(body.stageId),body.name.trim(),body.hashtag);await audit(actor.id,'create_subject','subject',result.id,null,result);
        }
        else if(route==='/groups'&&req.method==='POST'){
          if(typeof body.title!=='string'||body.title.length>100)throw appError('اسم المجموعة غير صالح.');
          if(positiveInt(body.capacity)>10000)throw appError('السعة لا تتجاوز 10000 طالب.');
          if(body.inviteLink&&!/^https:\/\/t\.me\/[A-Za-z0-9_+/?=-]+$/.test(body.inviteLink))throw appError('رابط المجموعة يجب أن يكون رابط تليجرام https://t.me/');
          result=await studies.createMubahathaGroup(positiveInt(body.subjectId),positiveInt(body.seasonId),{title:body.title,capacity:positiveInt(body.capacity),inviteLink:body.inviteLink||null});
          await audit(actor.id,'create_group','group',result.id,null,result);
        }
        else if((m=/^\/sessions\/(\d+)\/selected-attendance$/.exec(route))&&req.method==='POST')result=await discussionAttendance.mark(positiveInt(m[1]),body,actor.id);
        else if((m=/^\/pending-lessons\/(\d+)\/restore$/.exec(route))&&req.method==='POST'){
          result=await lessonRecovery.restore(positiveInt(m[1]),positiveInt(body.subjectId),{actorId:actor.id,originalPublishedAt:body.originalPublishedAt,targetScheduleDate:body.scheduleDate});
          if(wakeNotifications)Promise.resolve().then(wakeNotifications).catch(err=>console.error('Lesson recovery delivery failed:',err.code||'DELIVERY_ERROR'));
        }
        else if((m=/^\/sessions\/(\d+)\/(reopen|retry-notifications|mark-all|cancel)$/.exec(route))&&req.method==='POST'){
          result=await adminData.manageSession(positiveInt(m[1]),m[2],actor.id);
          if(wakeNotifications&&['reopen','retry-notifications'].includes(m[2])){
            Promise.resolve().then(wakeNotifications).catch(err=>console.error('Reopened attendance delivery failed:',err.code||'DELIVERY_ERROR'));
          }
        }
        else if((m=/^\/lessons\/(\d+)\/republish$/.exec(route))&&req.method==='POST'){
          result=await lessonRecovery.restoreExisting(positiveInt(m[1]),body,actor.id);
          if(wakeNotifications)Promise.resolve().then(wakeNotifications).catch(err=>console.error('Lesson republish delivery failed:',err.code||'DELIVERY_ERROR'));
        }
        else if((m=/^\/lessons\/(\d+)\/subject$/.exec(route))&&req.method==='PATCH')result=await overrides.correctSubject(positiveInt(m[1]),body,actor.id);
        else if((m=/^\/lessons\/(\d+)\/late-attendance$/.exec(route))&&req.method==='POST')result=await overrides.lateAttendance(positiveInt(m[1]),body,actor.id);
        else if((m=/^\/lessons\/(\d+)\/attendance\/(\d+)\/remove$/.exec(route))&&req.method==='POST')
          result=await overrides.removeLessonAttendance(positiveInt(m[1]),positiveInt(m[2]),actor.id);
        else if((m=/^\/exams\/(\d+)\/student-window$/.exec(route))&&req.method==='POST')result=await overrides.reopenExam(positiveInt(m[1]),body,actor.id);
        else if((m=/^\/lessons\/(\d+)\/reopen$/.exec(route))&&req.method==='POST'){
          const id=positiveInt(m[1]);
          const reopened=await db.reopenLesson(id);
          if(!reopened)throw appError('لا يمكن إعادة الفتح: الدرس غير موجود أو موسمه مؤرشف أو مضت 24 ساعة على نشره.','EXPIRED',409);
          result=reopened;await audit(actor.id,'reopen_lesson','lesson',id,null,{active_until:reopened.active_until});
        }
        else if((m=/^\/lessons\/(\d+)\/mark-all$/.exec(route))&&req.method==='POST'){
          const id=positiveInt(m[1]);const added=await db.markAllPresentForLesson(id);
          result={added};await audit(actor.id,'mark_all_present','lesson',id,null,{added});
        }
        else if((m=/^\/lessons\/(\d+)\/cancel$/.exec(route))&&req.method==='POST'){
          const id=positiveInt(m[1]);const cancelled=await db.cancelLesson(id);
          if(!cancelled)throw appError('الدرس غير موجود.','NOT_FOUND',404);
          result={ok:true};await audit(actor.id,'cancel_lesson','lesson',id,cancelled,null);
        }
        else if((m=/^\/channels\/(\d+)\/unlink$/.exec(route))&&req.method==='POST'){
          const id=positiveInt(m[1]);await db.unlinkChannel(id);
          result={ok:true};await audit(actor.id,'unlink_channel','channel',id,null,null);
        }
        else throw appError('العملية غير متاحة في هذه الواجهة.','NOT_FOUND',404);
      }else throw appError('طريقة طلب غير مسموحة.','METHOD_NOT_ALLOWED',405);
      return json(res,200,result??null);
    }catch(e){
      if(res.headersSent){res.destroy();return;}
      const businessMessage=/^[\p{Script=Arabic}]/u.test(e.message||'');
      const status=e.status||(['23505','23503'].includes(e.code)?409:businessMessage?400:500);
      if(status===500)console.error('Admin API error:',e.code||e.name);
      json(res,status,{error:status===500?'تعذر إتمام العملية. أعد المحاولة أو راجع سجل التشغيل.':e.status||businessMessage?e.message:'السجل مكرر أو مرتبط ببيانات أخرى.',code:e.code||'SERVER_ERROR'});
    }finally{if(acquired)active--;}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  return server;
}
async function startAdminServer(options) {
  const configured=new URL(process.env.ADMIN_WEB_URL||'');
  if(configured.protocol!=='https:'||configured.username||configured.password||!['/admin','/admin/'].includes(configured.pathname)||configured.search||configured.hash)throw new Error('ADMIN_WEB_URL must be a public HTTPS /admin/ URL');
  const server=createAdminServer({...options,origin:configured.origin});
  const port=Number(process.env.PORT||3000);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});return server;
}
module.exports={createAdminServer,startAdminServer,readJson};
