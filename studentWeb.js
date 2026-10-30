'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {validateTeacherInitData}=require('./teacherAuth');
const {createSessions}=require('./adminAuth');
const {appError,positiveInt}=require('./integrity');
function createStudentWeb({db,studies,botToken,origin,readJson}){
 const sessions=createSessions({ttlMs:30*60*1000,max:2000});
 const authLimits=new Map();
 const json=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
 return async function(req,res,url){
  const files={'/student-exam/':'index.html','/student-exam':'index.html','/student-exam/app.js':'app.js','/student-exam/styles.css':'styles.css'};
  if(req.method==='GET'&&files[url.pathname]){const file=files[url.pathname];res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');res.end(await fs.readFile(path.join(__dirname,'student',file)));return true;}
  if(!url.pathname.startsWith('/api/student-exam/'))return false;
  if(req.headers.origin&&req.headers.origin!==origin)throw appError('مصدر الطلب غير مسموح.','FORBIDDEN',403);
  if(req.method==='POST'&&url.pathname==='/api/student-exam/auth'){
   const now=Date.now(),ip=req.socket.remoteAddress;for(const [key,value] of authLimits)if(value.until<=now)authLimits.delete(key);const limit=authLimits.get(ip)||{count:0,until:now+60000};if(++limit.count>30)throw appError('محاولات دخول كثيرة. انتظر دقيقة.','RATE_LIMIT',429);authLimits.set(ip,limit);
   const body=await readJson(req),user=validateTeacherInitData(body.initData,botToken);
   const student=await db.getStudentByTelegramId(user.id);
   if(!student||!student.is_active)throw appError('سجّل في البوت أولًا.','FORBIDDEN',403);
   json(res,200,{token:sessions.issue({telegramId:user.id,studentId:student.id})});return true;
  }
  const token=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'')?.[1],actor=sessions.get(token);
  if(!actor)throw appError('أعد فتح الامتحان من البوت.','UNAUTHORIZED',401);
  const student=await db.getStudentByTelegramId(actor.telegramId);
  if(!student||!student.is_active||Number(student.id)!==Number(actor.studentId))throw appError('الحساب غير متاح.','FORBIDDEN',403);
  if(req.method!=='POST')throw appError('طلب غير صالح.');
  const body=await readJson(req),examId=positiveInt(body.examId);
  const exam=await studies.getExamById(examId);
  if(!exam)throw appError('الامتحان غير موجود.');
  const existing=(await db.pool.query('SELECT * FROM exam_attempts WHERE exam_id=$1 AND student_id=$2',[examId,student.id])).rows[0];
  if(existing?.submitted_at){json(res,200,{done:true,score:Number(existing.score),maxScore:Number(exam.max_score),correct:Number(existing.correct_count),total:Number(existing.total_questions)});return true;}
  if(!await studies.isExamAvailable(examId,student.id)){
   if(existing){const done=await studies.finalizeAttempt(existing.id,{onlyIfClosed:true});if(done){json(res,200,{done:true,expired:true,score:Number(done.score),maxScore:Number(exam.max_score),correct:Number(done.correct_count),total:Number(done.total_questions)});return true;}}
   throw appError('الامتحان غير متاح الآن.','EXAM_CLOSED',403);
  }
  const attempt=await studies.startOrResumeAttempt(examId,student.id);
  if(url.pathname==='/api/student-exam/answer')await studies.submitAnswer(attempt.id,positiveInt(body.questionId),body.answer);
  if(url.pathname==='/api/student-exam/submit'){
   if(await studies.getNextUnansweredQuestion(attempt.id))throw appError('أجب عن جميع الأسئلة قبل التسليم.');
   const done=await studies.finalizeAttempt(attempt.id);
   json(res,200,{done:true,score:Number(done.score),maxScore:Number(exam.max_score),correct:Number(done.correct_count),total:Number(done.total_questions)});return true;
  }
  if(!['/api/student-exam/start','/api/student-exam/answer'].includes(url.pathname))throw appError('طلب غير صالح.');
  const q=await studies.getNextUnansweredQuestion(attempt.id);
  json(res,200,{done:false,title:exam.title,subject:exam.subject_name,question:q?{id:q.id,prompt:q.prompt,number:Number(q.display_no),total:Number(q.total),options:q.question_type==='tf'?['صح','خطأ']:q.options}:null});return true;
 };
}
module.exports={createStudentWeb};
