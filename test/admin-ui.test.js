'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {JSDOM}=require('jsdom');
const stage={id:1,name:'المرحلة التمهيدية',is_active:true,stage_type:'full',stage_season_id:1,season_name:'الموسم الأول',student_count:35,subject_count:1,group_count:1,
  subjects:[{id:1,name:'الفقه',hashtag:'فقه',teacher_name:'الأستاذ الأول',teachers:[{id:1,name:'الأستاذ الأول'}]}],groups:[{id:1,title:'الأولى',subject_id:1,subject_name:'الفقه',member_count:35,capacity:40}],seasons:[{id:1,name:'الأول',is_active:true}]};
async function setup({authorized=true}={}){
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../admin/index.html'),'utf8'),{url:'https://institute.example/admin/',runScripts:'outside-only'});
  const w=dom.window;w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.confirm=()=>true;
  w.Telegram={WebApp:{ready(){},expand(){},initData:authorized?'signed-test-data':''}};
  const requests=[];let slots=[];
  w.fetch=async(url,options={})=>{
    requests.push({url,options});const u=new URL(url,'https://institute.example');let data,status=200;
    if(u.pathname.endsWith('/auth'))data={token:'a'.repeat(64),user:{name:'إدارة الاختبار'}};
    else if(u.pathname.endsWith('/seasons'))data=[{id:1,name:'الموسم الأول',is_current:true}];
    else if(u.pathname.endsWith('/lesson-attendance'))data={season:{season_name:'الموسم الأول',as_of:'2026-09-14T12:00:00Z'},subjects:[{id:1,name:'الفقه'},{id:2,name:'العقائد'}],rows:[{id:1,sequence:1,full_name:'طالب <img src=x> اسم رباعي',attendance:[{attended:40,total:42},{attended:0,total:0}]}],total:1,page:0,size:50};
    else if(u.pathname.endsWith('/participation-settings'))data={grouped:false,pausedSlots:0};
    else if(u.pathname.endsWith('/stages'))data=[stage];else if(u.pathname.endsWith('/stages/1'))data=stage;
    else if(u.pathname.endsWith('/students/1')){
      if(options.method==='PATCH'){data={error:'أدخل اسمًا رباعيًا'};status=400;}
      else data={id:1,full_name:'طالب <img src=x> اختبار اسم',stage_id:1,stage_name:stage.name,is_active:true,official_confirmed_at:'2026-09-01',activity:{stageSeasonId:1,approvedLeaveDays:4,warnings:[]},groups:[],attendance:[],leaves:[]};
    }else if(u.pathname.endsWith('/students')){const p=Number(u.searchParams.get('page'));data={rows:[{id:1,full_name:'طالب <img src=x> اختبار اسم',groups:[],is_active:true}],total:35,page:p,size:25};}
    else if(u.pathname.endsWith('/exams'))data=[{id:1,subject_name:'الفقه',title:'الشهري الأول',status:'draft'}];
    else if(u.pathname.endsWith('/exams/1'))data={id:1,title:'الشهري الأول',subject_name:'الفقه',status:'draft',questions:[{id:3,prompt:'سؤال <script>bad()</script>',question_type:'tf',correct_answer:'صح'}]};
    else if(u.pathname.endsWith('/schedule')){
      if(options.method==='POST'){
        const b=JSON.parse(options.body);
        if(Number(b.minute)===59){status=409;data={error:'يتداخل الموعد مع مباحثة أخرى'};}
        else{const slot={id:8,group_id:Number(b.groupId),hour:Number(b.hour),minute:Number(b.minute),day_of_week:Number(b.dayOfWeek),teacher_name:'الأستاذ الأول'};slots.push(slot);data={slot};}
      }else data=slots;
    }
    else if(u.pathname.endsWith('/schedule/8/remove')){slots=[];data={removed:true};}
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
test('admin matrix: empty day can add a slot; exact minutes, conflict and removal remain usable',async()=>{
  const {dom,w,click,until,requests}=await setup();
  try{
    await until(()=>w.document.querySelector('.stage-card'));
    click('[data-action="schedule-matrix"]');
    await until(()=>w.document.querySelector('[data-action="matrix-add"]'));
    assert.equal(w.document.querySelectorAll('table.matrix thead th').length,9);
    click('[data-action="matrix-add"][data-hour="17"]');
    w.document.querySelector('#matrix-slot [name="minute"]').value='30';
    w.document.querySelector('#matrix-slot').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    await until(()=>w.document.querySelector('[data-action="matrix-remove"]'));
    await until(()=>w.document.querySelector('#notice').textContent.includes('حُفظ موعد المباحثة'));
    assert.match(w.document.querySelector('[data-action="matrix-remove"]').textContent,/17:30/);
    click('[data-action="matrix-add"][data-hour="18"]');
    w.document.querySelector('#matrix-slot [name="minute"]').value='59';
    w.document.querySelector('#matrix-slot').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    await until(()=>w.document.querySelector('#dialog-notice').textContent.includes('يتداخل'));
    assert.equal(w.document.querySelector('#detail').open,true);
    click('[data-action="close-dialog"]');click('[data-action="matrix-remove"]');
    await until(()=>!w.document.querySelector('[data-action="matrix-remove"]'));
    assert.ok(requests.some(r=>r.url.endsWith('/schedule/8/remove')));
  }finally{dom.window.close();}
});

test('admin attendance matrix: independent stage selection, subject columns and safe LTR ratios',async()=>{
 const {dom,w,requests,until,click}=await setup();try{
  await until(()=>w.document.querySelector('.stage-card'));click('[data-action="lesson-attendance"]');
  await until(()=>w.document.querySelector('#attendance-stage'));
  assert.equal(w.document.querySelectorAll('#content table').length,0);
  const select=w.document.querySelector('#attendance-stage select');select.value='1';select.dispatchEvent(new w.Event('change',{bubbles:true}));
  await until(()=>w.document.querySelector('.attendance-ratio'));
  assert.equal(w.document.querySelectorAll('#content th').length,4);
  assert.equal(w.document.querySelector('.attendance-ratio').getAttribute('dir'),'ltr');
  assert.equal(w.document.querySelector('.attendance-ratio').textContent,'40 / 42');
  assert.equal(w.document.querySelector('#content img'),null);
  assert.ok(requests.some(r=>r.url.includes('/lesson-attendance?stageId=1')));
 }finally{dom.window.close();}
});
test('admin participation settings: explicit subject exclusion and whole-stage option submitted together',async()=>{
 const {dom,w,requests,until,click}=await setup();try{
  await until(()=>w.document.querySelector('.stage-card'));click('[data-action="stage"]');await until(()=>w.document.querySelector('#search'));
  click('[data-tab="subjects"]');await until(()=>w.document.querySelector('#participation-settings'));
  const form=w.document.querySelector('#participation-settings');
  form.querySelector('[name="grouped"]').value='false';form.querySelector('[data-study-id="1"]').value='false';
  form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>requests.some(r=>r.url.includes('/participation-settings')));
  const req=requests.find(r=>r.url.includes('/participation-settings'));assert.equal(req.options.method,'PATCH');assert.deepEqual(JSON.parse(req.options.body),{grouped:false,enabledSubjectIds:[]});
  await until(()=>w.document.querySelector('#notice').textContent.includes('حُفظت إعدادات')); 
 }finally{dom.window.close();}
});
