'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
async function setup(){
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../admin/index.html'),'utf8'),{url:'https://test.example/admin/',runScripts:'outside-only'}),w=dom.window;
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.confirm=()=>true;
  w.Telegram={WebApp:{ready(){},expand(){},initData:'signed'}};
  const requests=[];let windows=[],contactHistory=[];
  const stage={id:1,name:'المرحلة',stage_season_id:1,season_name:'الموسم',subjects:[{id:1,name:'العقائد'},{id:2,name:'الفقه'}],groups:[],teachers:[]};
  const item={id:71,subject_id:1,subject_name:'العقائد',stage_season_id:1,source_type:'channel_schedule',activated_at:'2026-01-01T12:00:00Z',active_until:'2026-01-02T12:00:00Z'};
  const exam={id:81,subject_id:1,subject_name:'العقائد',exam_number:1,opens_at:'2026-01-01T12:00:00Z',closes_at:'2026-01-02T12:00:00Z',status:'published',questions:[]};
  w.fetch=async(url,options={})=>{
    requests.push({url,options});const u=new URL(url,'https://test.example');let data;
    if(u.pathname.endsWith('/auth'))data={token:'a'.repeat(64),user:{name:'admin'}};
    else if(u.pathname.endsWith('/seasons'))data=[];
    else if(u.pathname.endsWith('/stages'))data=[stage];
    else if(u.pathname.endsWith('/stages/1'))data=stage;
    else if(u.pathname.endsWith('/students'))data={rows:[],total:0,page:0,size:25};
    else if(u.pathname.endsWith('/students/1'))data={id:1,full_name:'طالب <img src=x>',stage_name:'المرحلة',telegram_id:700001};
    else if(u.pathname.endsWith('/student-contact')){
      if(options.method==='POST'){const b=JSON.parse(options.body);contactHistory=[{id:1,message_text:b.message,created_at:new Date().toISOString(),delivery_status:'pending'}];data={id:1,queued:true};}
      else data={rows:[{id:1,full_name:'طالب <img src=x>',stage_name:'المرحلة',telegram_id:700001}],total:1,page:0,size:20};
    }
    else if(u.pathname.endsWith('/student-contact/1'))data=contactHistory;
    else if(u.pathname.endsWith('/lesson-management'))data={season:{is_active:true},subjects:stage.subjects.map(s=>({...s,total:1,open_count:0})),rows:[{...item,item_number:1,attended_count:1,enrolled_count:30,is_active:false}],total:1,page:0,size:25};
    else if(u.pathname.endsWith('/admin-options')){
      const p=Number(u.searchParams.get('page')||0),isExam=u.pathname.includes('/exams/');
      data={item:isExam?exam:item,subjects:stage.subjects,rows:p?[{id:26,full_name:'طالب الصفحة الثانية'}]:[{id:1,full_name:'طالب <img src=x>'},{id:2,full_name:'طالب حاضر',attendance:isExam?null:{marking_kind:'admin_late',listened_at:'2026-01-03T00:00:00Z',marked_by:42,admin_note:'عذر'}}],total:26,page:p,size:25};
    }else if(u.pathname.endsWith('/subject')){item.subject_id=Number(JSON.parse(options.body).subjectId);item.subject_name='الفقه';data={changed:true};}
    else if(u.pathname.endsWith('/late-attendance'))data={added:2,existing:0};
    else if(u.pathname.endsWith('/exams'))data=[exam];
    else if(u.pathname.endsWith('/exams/81'))data={...exam,studentWindows:windows};
    else if(u.pathname.endsWith('/student-window')){const b=JSON.parse(options.body);windows=[{...b,full_name:'طالب <img src=x>',opens_at:b.opensAt,closes_at:b.closesAt,created_by:42}];data=windows[0];}
    else throw Error('Unexpected request '+url);
    return {ok:true,status:200,json:async()=>data};
  };
  w.eval(fs.readFileSync(path.join(__dirname,'../admin/app.js'),'utf8'));
  async function until(fn){for(let i=0;i<120;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('UI timeout: '+w.document.querySelector('#dialog-notice').textContent);}
  const el=s=>{const v=w.document.querySelector(s);assert.ok(v,s);return v;};
  const click=s=>el(s).click();
  const submit=s=>el(s).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  const choose=s=>{const v=el(s);v.checked=true;v.dispatchEvent(new w.Event('change',{bubbles:true}));};
  await until(()=>w.document.querySelector('.stage-card'));
  return {dom,w,requests,until,el,click,submit,choose};
}
test('UI: schedule provenance, subject correction and stale subject token are sent without replacing lesson',async()=>{
  const h=await setup();try{
    h.click('[data-action="lesson-management"]');await h.until(()=>h.w.document.querySelector('[data-action="lesson-correct"]'));
    assert.match(h.el('#content').textContent,/اعتمادًا على الجدول/);
    h.click('[data-action="lesson-correct"]');await h.until(()=>h.w.document.querySelector('#correct-lesson'));
    h.el('#correct-lesson select').value='2';h.submit('#correct-lesson');
    await h.until(()=>h.requests.some(r=>r.options.method==='PATCH'));
    const r=h.requests.find(r=>r.options.method==='PATCH');assert.equal(r.url,'/api/admin/lessons/71/subject');
    assert.deepEqual(JSON.parse(r.options.body),{expectedSubjectId:'1',subjectId:'2'});
    await h.until(()=>h.el('#notice').textContent.includes('بقيت كل سجلات الحضور'));
  }finally{h.dom.window.close();}
});
test('UI: multiple attendance selections survive pages and search; existing attendance cannot be selected',async()=>{
  const h=await setup();try{
    h.click('[data-action="lesson-management"]');await h.until(()=>h.w.document.querySelector('[data-action="lesson-late"]'));
    h.click('[data-action="lesson-late"]');await h.until(()=>h.w.document.querySelector('#save-override'));
    assert.equal(h.el('input[value="2"]').disabled,true);assert.equal(h.w.document.querySelector('#dialog-body img'),null);
    h.choose('input[name="override-student"][value="1"]');h.el('textarea[name="note"]').value='ملاحظة محفوظة';
    h.click('[data-action="override-next"]');await h.until(()=>h.w.document.querySelector('input[value="26"]'));
    h.choose('input[value="26"]');h.el('#override-search input').value='طالب';h.submit('#override-search');
    await h.until(()=>h.w.document.querySelector('input[value="1"]'));
    assert.equal(h.el('input[value="1"]').checked,true);assert.equal(h.el('textarea[name="note"]').value,'ملاحظة محفوظة');
    assert.match(h.el('#override-selected').textContent,/2/);h.submit('#save-override');
    await h.until(()=>h.requests.some(r=>r.url.endsWith('/late-attendance')));
    const body=JSON.parse(h.requests.find(r=>r.url.endsWith('/late-attendance')).options.body);
    assert.deepEqual(body.studentIds,[1,26]);assert.equal(body.subjectId,1);assert.equal(body.note,'ملاحظة محفوظة');
    await h.until(()=>h.el('#notice').textContent.includes('أضيف حضور'));
  }finally{h.dom.window.close();}
});
test('UI: individual exam window requires explicit ordered Baghdad dates and shows the saved window',async()=>{
  const h=await setup();try{
    h.click('[data-action="stage"]');await h.until(()=>h.w.document.querySelector('[data-tab="exams"]'));
    h.click('[data-tab="exams"]');await h.until(()=>h.w.document.querySelector('[data-action="exam"]'));
    h.click('[data-action="exam"]');await h.until(()=>h.w.document.querySelector('[data-action="exam-student-window"]'));
    h.click('[data-action="exam-student-window"]');await h.until(()=>h.w.document.querySelector('#save-override'));
    assert.equal(h.el('[name="opensAt"]').value,'');h.choose('[name="override-student"][value="1"]');
    h.el('[name="opensAt"]').value='2090-01-01T10:00';h.el('[name="closesAt"]').value='2090-01-01T09:00';h.submit('#save-override');
    await h.until(()=>!h.el('#dialog-notice').hidden);assert.match(h.el('#dialog-notice').textContent,/بعد بدايتها/);
    assert.ok(!h.requests.some(r=>r.url.endsWith('/student-window')));
    h.el('[name="closesAt"]').value='2090-01-01T11:00';h.submit('#save-override');
    await h.until(()=>h.requests.some(r=>r.url.endsWith('/student-window')));
    const b=JSON.parse(h.requests.find(r=>r.url.endsWith('/student-window')).options.body);
    assert.equal(b.studentId,1);assert.equal(b.opensAt,'2090-01-01T10:00:00+03:00');assert.equal(b.closesAt,'2090-01-01T11:00:00+03:00');
    await h.until(()=>h.el('#dialog-body').textContent.includes('نوافذ الفتح الخاصة'));
    assert.equal(h.w.document.querySelector('#dialog-body img'),null);
  }finally{h.dom.window.close();}
});
test('UI: administrator searches a student, opens their profile and queues a private message',async()=>{
  const h=await setup();try{
    h.click('[data-action="student-contact"]');await h.until(()=>h.w.document.querySelector('[data-action="contact-student"]'));
    assert.equal(h.w.document.querySelector('#content img'),null);
    h.click('[data-action="contact-student"]');await h.until(()=>h.w.document.querySelector('#contact-send'));
    assert.equal(h.el('a[href="tg://user?id=700001"]').textContent,'فتح حساب الطالب في تيليغرام');
    h.el('#contact-send textarea').value='رد خاص على الإجازة';h.submit('#contact-send');
    await h.until(()=>h.requests.some(r=>r.url.endsWith('/student-contact')&&r.options.method==='POST'));
    const sent=JSON.parse(h.requests.find(r=>r.url.endsWith('/student-contact')&&r.options.method==='POST').options.body);
    assert.equal(sent.studentId,1);assert.equal(sent.message,'رد خاص على الإجازة');
    await h.until(()=>h.el('#dialog-body').textContent.includes('رد خاص على الإجازة'));
  }finally{h.dom.window.close();}
});
