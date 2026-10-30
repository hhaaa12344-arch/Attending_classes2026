'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHmac}=require('node:crypto');
const {testDatabase}=require('./helpers.cjs');const {createAdminServer}=require('../adminServer');
const token='12345:TEST';
function signed(id){const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id,first_name:'طالب'})});const secret=createHmac('sha256','WebAppData').update(token).digest();p.set('hash',createHmac('sha256',secret).update([...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));return p.toString();}
test('student panel authenticates, resumes, submits and shows only the result',async()=>{
 const {db,studies}=await testDatabase();let server;try{
 const stage=await db.addStage('مرحلة اللوحة'),sub=await db.addSubject(stage.id,'مادة اللوحة','panel'),ss=(await db.listStageSeasons(stage.id))[0].id;
 await db.createStudent(771234,'طالب اللوحة الأول',stage.id);await db.createStudent(771235,'طالب اللوحة الثاني',stage.id);
 const exam=await studies.createExam(sub.id,ss,null,{examNumber:1,title:'تجربة اللوحة',dateIso:'2033-01-01',hours:2,time:'10:00'});
 await studies.addExamQuestion(exam.id,{type:'tf',prompt:'السؤال الأول صحيح؟',correct:'صح'});await studies.addExamQuestion(exam.id,{type:'tf',prompt:'السؤال الثاني صحيح؟',correct:'خطأ'});await studies.publishExam(exam.id);
 await db.pool.query("UPDATE exams SET opens_at=now()-interval '1 hour',closes_at=now()+interval '1 hour' WHERE id=$1",[exam.id]);
 server=createAdminServer({db,studies,adminData:require('../adminData').createAdminData(db,studies),scheduler:require('../scheduler').createScheduler({pool:db.pool,studies}),botToken:token,adminIds:[42],origin:'https://institute.example'});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port+'/api/student-exam/';
 const req=(action,body,session)=>fetch(base+action,{method:'POST',headers:{'Content-Type':'application/json',...(session?{Authorization:'Bearer '+session}:{})},body:JSON.stringify(body)});
 assert.equal((await req('start',{examId:exam.id})).status,401);
 assert.equal((await req('auth',{initData:signed(771234).replace('771234','771235')})).status,401);
 const auth=await (await req('auth',{initData:signed(771234)})).json();let r=await (await req('start',{examId:exam.id},auth.token)).json();assert.equal(r.question.number,1);assert.ok(!JSON.stringify(r).includes('correct_answer'));
 r=await (await req('answer',{examId:exam.id,questionId:r.question.id,answer:'صح'},auth.token)).json();assert.equal(r.question.number,2);
 let resume=await (await req('start',{examId:exam.id},auth.token)).json();assert.equal(resume.question.number,2);
 assert.equal((await req('submit',{examId:exam.id},auth.token)).status,400);
 r=await (await req('answer',{examId:exam.id,questionId:r.question.id,answer:'خطأ'},auth.token)).json();assert.equal(r.question,null);
 r=await (await req('submit',{examId:exam.id},auth.token)).json();assert.equal(r.done,true);assert.equal(r.score,5);assert.equal(r.correct,2);
 r=await (await req('start',{examId:exam.id},auth.token)).json();assert.equal(r.done,true);assert.equal(r.question,undefined);
 const other=await (await req('auth',{initData:signed(771235)})).json();r=await (await req('start',{examId:exam.id},other.token)).json();assert.equal(r.question.number,1);
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await db.pool.end();}
});
