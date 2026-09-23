'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
test('teacher panel searches within a subject and sends a private report reply for one student',async()=>{
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../teacher/index.html'),'utf8'),{url:'https://test.example/teacher/',runScripts:'outside-only'});
  const w=dom.window,requests=[];let history=[];
  w.Telegram={WebApp:{initData:'signed',ready(){},expand(){},setHeaderColor(){}}};
  w.fetch=async(url,options={})=>{
    requests.push({url,options});const u=new URL(url,'https://test.example');let data;
    if(u.pathname.endsWith('/auth'))data={token:'session'};
    else if(u.pathname.endsWith('/dashboard'))data={teacher:{full_name:'أستاذ فقه'},subjects:[{subject_id:5,stage_season_id:7,subject_name:'الفقه',stage_name:'المرحلة الأولى',season_name:'موسم',student_count:1}],totals:{subjects:1,students:1,pendingReports:0,todayDiscussions:0},today:[],activeSessions:[]};
    else if(u.pathname.endsWith('/student-contact')){
      if(options.method==='POST'){const body=JSON.parse(options.body);history=[{id:1,message_text:body.message,created_at:new Date().toISOString(),delivery_status:'pending'}];data={id:1,queued:true};}
      else data={rows:[{id:9,full_name:'طالب <img src=x>',telegram_id:700009,subject_name:'الفقه'}],total:1,page:0,size:20};
    }else if(u.pathname.endsWith('/student-contact/9'))data=history;
    else throw Error('Unexpected request '+url);
    return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>data};
  };
  w.eval(fs.readFileSync(path.join(__dirname,'../teacher/app.js'),'utf8'));
  async function until(fn){for(let i=0;i<120;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('Teacher UI timeout');}
  try{
    await until(()=>!w.document.querySelector('#contentViews').classList.contains('hidden'));
    w.document.querySelector('[data-tool="contact"]').click();await until(()=>w.document.querySelector('[data-contact-student]'));
    assert.equal(w.document.querySelector('#sheetBody img'),null);
    w.document.querySelector('[data-contact-student]').click();await until(()=>w.document.querySelector('#contactSend'));
    assert.ok(w.document.querySelector('a[href="tg://user?id=700009"]'));
    const form=w.document.querySelector('#contactSend');form.querySelector('textarea').value='راجعت تقريرك';
    form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    await until(()=>requests.some(r=>r.url.endsWith('/student-contact')&&r.options.method==='POST'));
    const body=JSON.parse(requests.find(r=>r.url.endsWith('/student-contact')&&r.options.method==='POST').options.body);
    assert.equal(body.studentId,9);assert.equal(body.subjectId,5);assert.equal(body.message,'راجعت تقريرك');
  }finally{dom.window.close();}
});
