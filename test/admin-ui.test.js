'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {JSDOM}=require('jsdom');
const stage={id:1,name:'المرحلة التمهيدية',is_active:true,stage_type:'full',stage_season_id:1,season_name:'الموسم الأول',student_count:35,subject_count:1,group_count:1,
  subjects:[{id:1,name:'الفقه',hashtag:'فقه',teacher_name:'الأستاذ الأول',teachers:[{id:1,name:'الأستاذ الأول'}]}],groups:[{id:1,title:'الأولى',subject_id:1,subject_name:'الفقه',member_count:35,capacity:40}],seasons:[{id:1,name:'الأول',is_active:true}]};
async function setup({authorized=true}={}){
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../admin/index.html'),'utf8'),{url:'https://institute.example/admin/',runScripts:'outside-only'});
  const w=dom.window;w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.confirm=()=>true;
  w.Telegram={WebApp:{ready(){},expand(){},initData:authorized?'signed-test-data':''}};
  const requests=[];
  w.fetch=async(url,options={})=>{
    requests.push({url,options});const u=new URL(url,'https://institute.example');let data,status=200;
    if(u.pathname.endsWith('/auth'))data={token:'a'.repeat(64),user:{name:'إدارة الاختبار'}};
    else if(u.pathname.endsWith('/stages'))data=[stage];else if(u.pathname.endsWith('/stages/1'))data=stage;
    else if(u.pathname.endsWith('/students/1')){
      if(options.method==='PATCH'){data={error:'أدخل اسمًا رباعيًا'};status=400;}
      else data={id:1,full_name:'طالب <img src=x> اختبار اسم',stage_id:1,stage_name:stage.name,is_active:true,official_confirmed_at:'2026-09-01',activity:{stageSeasonId:1,approvedLeaveDays:4,warnings:[]},groups:[],attendance:[],leaves:[]};
    }else if(u.pathname.endsWith('/students')){const p=Number(u.searchParams.get('page'));data={rows:[{id:1,full_name:'طالب <img src=x> اختبار اسم',groups:[],is_active:true}],total:35,page:p,size:25};}
    else if(u.pathname.endsWith('/exams'))data=[{id:1,subject_name:'الفقه',title:'الشهري الأول',status:'draft'}];
    else if(u.pathname.endsWith('/exams/1'))data={id:1,title:'الشهري الأول',subject_name:'الفقه',status:'draft',questions:[{id:3,prompt:'سؤال <script>bad()</script>',question_type:'tf',correct_answer:'صح'}]};
    else if(u.pathname.endsWith('/teachers'))data=[{id:1,full_name:'الأستاذ الأول',is_active:true}];
    else if(u.pathname.endsWith('/logout'))data={ok:true};
    else throw Error('Unexpected UI request '+url);
    return {ok:status===200,status,json:async()=>data};
  };
  w.eval(fs.readFileSync(path.join(__dirname,'../admin/app.js'),'utf8'));
  async function until(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('UI did not reach expected state: '+w.document.querySelector('#notice').textContent);}
  const click=selector=>{const el=w.document.querySelector(selector);assert.ok(el,selector);el.click();};
  return {dom,w,requests,until,click};
}
test('admin DOM: Telegram entry, stages, pagination, escaped names and visible modal errors',async()=>{
  const {dom,w,requests,until,click}=await setup();try{
    await until(()=>w.document.querySelector('.stage-card'));click('[data-action="stage"]');await until(()=>w.document.querySelector('#search'));
    assert.match(w.document.querySelector('#content').textContent,/طالب <img src=x>/);assert.equal(w.document.querySelector('#content img'),null);
    click('[data-action="next"]');await until(()=>requests.some(r=>r.url.includes('page=1')));
    await until(()=>w.document.querySelector('.pagination').textContent.includes('الصفحة 2'));
    click('[data-action="student"]');await until(()=>w.document.querySelector('#edit-student'));
    assert.ok(w.document.querySelector('#detail').open);assert.match(w.document.querySelector('#dialog-body').textContent,/4\/10/);
    const form=w.document.querySelector('#edit-student');form.querySelector('input').value='اسم';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    await until(()=>!w.document.querySelector('#dialog-notice').hidden);assert.match(w.document.querySelector('#dialog-notice').textContent,/رباعيًا/);
    click('[data-action="close-dialog"]');click('[data-action="tab"][data-tab="exports"]');await until(()=>w.document.querySelector('#export-season'));
    assert.match(w.document.querySelector('#content').textContent,/بصيغة MD/);assert.ok(!w.document.querySelector('#content').textContent.includes('CSV'));
    click('[data-action="tab"][data-tab="exams"]');await until(()=>w.document.querySelector('[data-action="exam"]'));
    click('[data-action="exam"]');await until(()=>w.document.querySelector('#exam-question'));assert.equal(w.document.querySelector('#dialog-body script'),null);
    click('[data-action="close-dialog"]');click('[data-action="logout"]');await until(()=>w.document.querySelector('#content').textContent.includes('انتهت جلسة'));
    assert.ok(!w.document.querySelector('#content').textContent.includes('طالب <img'));
  }finally{dom.window.close();}
});
test('admin DOM: opening a bare link never requests student data',async()=>{
  const {dom,w,requests}=await setup({authorized:false});try{assert.equal(requests.length,0);assert.match(w.document.querySelector('#content').textContent,/افتح اللوحة من البوت/);}finally{dom.window.close();}
});
