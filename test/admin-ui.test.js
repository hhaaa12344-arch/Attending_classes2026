'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {JSDOM}=require('jsdom');
const stage={id:1,name:'المرحلة التمهيدية',is_active:true,stage_type:'full',stage_season_id:1,season_name:'الموسم الأول',student_count:35,subject_count:1,group_count:1,
  subjects:[{id:1,name:'الفقه',hashtag:'فقه',teacher_name:'الأستاذ الأول',teachers:[{id:1,name:'الأستاذ الأول'}]}],groups:[{id:1,title:'الأولى',subject_id:1,subject_name:'الفقه',member_count:35,reserved_count:38,capacity:40}],seasons:[{id:1,name:'الأول',is_active:true}]};
async function setup({authorized=true,noticeState=null,grouped=true,impact=null,leaves=[],cleanup=null}={}){
  const fixture=JSON.parse(JSON.stringify(stage));fixture.discussion_grouping=grouped;
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../admin/index.html'),'utf8'),{url:'https://institute.example/admin/',runScripts:'outside-only'});
  const w=dom.window;w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.confirm=()=>true;
  w.Telegram={WebApp:{showConfirm(message,done){done(w.confirm(message));},ready(){},expand(){},initData:authorized?'signed-test-data':''}};
  const requests=[];let slots=[];
  const notifications=noticeState||{sessionId:71,windowOpen:true,until:new Date(Date.now()+600000).toISOString(),eligible:3,audience:[{reason:'eligible',count:3}],counts:{total:3,pending:3,sending:0,sent:0,failed:0,expired:0},errors:[]};
  const subjects=[{subject_id:1,stage_season_id:1,subject_name:'الفقه',mode:'report',participation_enabled:true},{subject_id:2,stage_season_id:1,subject_name:'العقائد',mode:'mubahatha',participation_enabled:true}];
  w.fetch=async(url,options={})=>{
    requests.push({url,options});const u=new URL(url,'https://institute.example');let data,status=200;
    if(u.pathname.endsWith('/auth'))data={token:'a'.repeat(64),user:{name:'إدارة الاختبار'}};
    else if(u.pathname.endsWith('/seasons'))data=[{id:1,name:'الموسم الأول',is_current:true}];
    else if(u.pathname.endsWith('/one-time-lesson-cleanup/status'))data={completed:Boolean(cleanup?.completed)};
    else if(u.pathname.endsWith('/one-time-lesson-cleanup')){
      if(options.method==='POST'){cleanup.completed=true;data={completed:true,removedFromCounting:1,preservedAttendance:14};}
      else data=cleanup;
    }
    else if(u.pathname.endsWith('/lesson-attendance'))data={season:{season_name:'الموسم الأول',as_of:'2026-09-14T12:00:00Z'},subjects:[{id:1,name:'الفقه'},{id:2,name:'العقائد'}],rows:[{id:1,sequence:1,full_name:'طالب <img src=x> اسم رباعي',attendance:[{attended:40,total:42},{attended:0,total:0}]}],total:1,page:0,size:50};
    else if(u.pathname.endsWith('/lesson-attendance.md'))data='حضور الدروس';
    else if(u.pathname.endsWith('/leaves'))data={rows:leaves,total:leaves.length,page:0,size:25};
    else if(/\/leaves\/\d+(?:\/decision|\/cancel)?$/.test(u.pathname)){
      const id=Number(u.pathname.match(/\/leaves\/(\d+)/)[1]),l=leaves.find(l=>l.id===id),body=JSON.parse(options.body);
      if(u.pathname.endsWith('/decision'))l.status=body.approve?'approved':'rejected';
      else if(u.pathname.endsWith('/cancel'))l.status='cancelled';else l.days=body.days;
      data=l;
    }
    else if(u.pathname.endsWith('/lesson-management')||u.pathname.endsWith('/session-management')){
      const subject=u.searchParams.get('subjectId'),page=Number(u.searchParams.get('page')||0);
      data={season:{is_active:true},subjects:[{id:1,name:'الفقه',total:26,open_count:1}],total:subject?1:26,page,size:25,
        rows:[{id:71,item_number:page?1:26,subject_name:'الفقه',title:'جلسة <img src=x>',group_title:'الأولى',activated_at:'2026-09-22T12:00:00Z',opened_at:'2026-09-22T12:00:00Z',active_until:'2026-09-23T12:00:00Z',closes_at:'2026-09-23T12:00:00Z',can_reopen:true,is_active:true,attended_count:3,enrolled_count:5,complete_count:3}]};
    }
    else if(u.pathname.endsWith('/sessions/71/notifications'))data=notifications;
    else if(u.pathname.endsWith('/sessions/71/admin-options'))data={item:{id:71,subject_id:1,subject_name:'الفقه',group_title:'الأولى',opened_at:'2026-09-22T12:00:00Z',closes_at:'2026-09-22T13:00:00Z'},rows:[{id:1,full_name:'طالب البداية فقط',attended_start:true,attended_end:false},{id:2,full_name:'طالب ثان',attended_start:false,attended_end:false},{id:3,full_name:'طالب مكتمل',attended_start:true,attended_end:true}],total:3,page:0,size:25};
    else if(u.pathname.endsWith('/sessions/71/selected-attendance'))data={added:2,records:3,existing:0};
    else if(/\/(lessons|sessions)\/71\/(reopen|retry-notifications|cancel|mark-all)$/.test(u.pathname))data={ok:true,added:2,records:4,attendance_reopen_until:notifications.until,notifications};
    else if(u.pathname.endsWith('/lessons/71/attendance'))data={lesson:{id:71,subject_name:'الفقه',activated_at:'2026-09-22T12:00:00Z'},rows:[{student_id:1,full_name:'طالب اختبار اسم رباعي',listened_at:'2026-09-22T13:00:00Z',marking_kind:'student'}],total:1,page:0,size:25};
    else if(u.pathname.endsWith('/lessons/71/attendance/1/remove'))data={removed:true};
    else if(u.pathname.endsWith('/grouping-impact'))data=impact||{current:true,target:u.searchParams.get('grouped')==='true',changing:true,blocked:null,subjectsAffected:1,groupsToMerge:2,membershipsToMove:14,slotsToPause:3,studentsWithNumbers:9};
    else if(u.pathname.endsWith('/participation-settings'))data={grouped:false,pausedSlots:0};
    else if(u.pathname.endsWith('/subjects/1')&&options.method==='PATCH'){const body=JSON.parse(options.body);fixture.subjects[0].name=body.name;data=fixture.subjects[0];}
    else if(u.pathname.endsWith('/stages'))data=[fixture];else if(u.pathname.endsWith('/stages/1'))data=fixture;
    else if(u.pathname.endsWith('/students/1/subjects/1/participation')){subjects[0].mode=JSON.parse(options.body).mode;data=subjects[0];}
    else if(u.pathname.endsWith('/students/1')){
      if(options.method==='PATCH'){data={error:'أدخل اسمًا رباعيًا'};status=400;}
      else data={id:1,full_name:'طالب <img src=x> اختبار اسم',stage_id:1,stage_name:stage.name,is_active:true,official_confirmed_at:'2026-09-01',activity:{stageSeasonId:1,approvedLeaveDays:4,warnings:[]},subjects,groups:[],attendance:[],leaves:[]};
    }else if(u.pathname.endsWith('/students')){const p=Number(u.searchParams.get('page'));data={rows:[{id:1,full_name:'طالب <img src=x> اختبار اسم',groups:[],is_active:true}],total:35,page:p,size:25};}
    else if(u.pathname.endsWith('/exams'))data=[{id:1,subject_name:'الفقه',title:'الشهري الأول',status:'draft'}];
    else if(u.pathname.endsWith('/exams/1'))data={id:1,title:'الشهري الأول',subject_name:'الفقه',status:'draft',questions:[{id:3,prompt:'سؤال <script>bad()</script>',question_type:'tf',correct_answer:'صح'}]};
    else if(u.pathname.endsWith('/exams/1/delete'))data={deleted:true};
    else if(u.pathname.endsWith('/lesson-schedule/audit'))data={stage_season_id:1,subjects:[]};
    else if(u.pathname.endsWith('/schedule-batch-import'))data={completed:true,available:false,teacherAvailability:[]};
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
    return {ok:status===200,status,json:async()=>data,blob:async()=>new w.Blob([String(data)])};
  };
  w.eval(fs.readFileSync(path.join(__dirname,'../admin/app.js'),'utf8'));
  async function until(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('UI did not reach expected state: '+w.document.querySelector('#notice').textContent);}
  const click=selector=>{const el=w.document.querySelector(selector);assert.ok(el,selector);el.click();};
  return {dom,w,requests,until,click};
}
test('one-time lesson cleanup previews counts, escapes content, submits selected IDs and permanently hides its button',async()=>{
  const cleanup={available:true,completed:false,token:'reviewed-preview',subjects:[{stageSeasonId:1,subjectId:1,stage:'المرحلة',subject:'المسائل',before:2,scheduledDue:1}],groups:[{stage:'المرحلة',subject:'المسائل',date:'2026-10-26',lessons:[
    {id:20,stage_season_id:1,subject_id:1,source_message_id:284,content_text:'محاضرة <img src=x>',attendance_count:15,recommended:false},
    {id:21,stage_season_id:1,subject_id:1,source_type:'schedule_fallback',attendance_count:14,recommended:true}]}]};
  const {dom,w,requests,until,click}=await setup({cleanup});
  try{
    await until(()=>w.document.querySelector('.stage-card'));
    assert.equal(w.document.querySelector('#one-time-cleanup-button').hidden,false);
    click('#one-time-cleanup-button');await until(()=>w.document.querySelector('#one-time-lesson-cleanup'));
    assert.equal(w.document.querySelector('#dialog-body img'),null);
    assert.equal(w.document.querySelectorAll('input[name="lessonId"]:checked').length,1);
    assert.match(w.document.querySelector('#cleanup-counts').textContent,/بعد الاختيار/);
    const form=w.document.querySelector('#one-time-lesson-cleanup');form.elements.confirmed.checked=true;
    form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    await until(()=>w.document.querySelector('#notice').textContent.includes('اختفى الزر'));
    const post=requests.find(r=>r.url.endsWith('/one-time-lesson-cleanup')&&r.options.method==='POST');
    assert.deepEqual(JSON.parse(post.options.body),{token:'reviewed-preview',lessonIds:[21],confirmed:true});
    assert.equal(w.document.querySelector('#one-time-cleanup-button').hidden,true);
    assert.ok(requests.filter(r=>r.url.endsWith('/one-time-lesson-cleanup/status')).length>=2);
  }finally{dom.window.close();}
});
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
test('admin DOM: emergency request has explicit approval; reduce and cancel use reviewed current values and unlock the UI',async()=>{
  const {dom,w,requests,until,click}=await setup({leaves:[{id:7,student_id:1,full_name:'طالب <img src=x> إجازة',stage_name:'التمهيدية',days:3,status:'pending',is_exception:true,reason:'حالة طارئة <script>bad()</script>',start_date:'2026-10-05',end_date:'2026-10-07'}]});
  try{
    await until(()=>w.document.querySelector('.stage-card'));click('[data-action="all-leaves"]');await until(()=>w.document.querySelector('#leave-filter'));
    assert.match(w.document.querySelector('[data-action="leave"][data-approve="true"]').textContent,/موافقة استثنائية/);assert.equal(w.document.querySelector('#content script'),null);
    click('[data-action="leave"][data-approve="true"]');await until(()=>requests.some(r=>r.url.endsWith('/7/decision')));await until(()=>w.document.querySelector('#content').textContent.includes('معتمدة'));
    assert.equal(JSON.parse(requests.find(r=>r.url.endsWith('/7/decision')).options.body).exceptionApproval,true);
    click('[data-action="leave-reduce"]');await until(()=>w.document.querySelector('#reduce-leave'));
    const form=w.document.querySelector('#reduce-leave');form.querySelector('[name="days"]').value='1';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    await until(()=>!w.document.querySelector('#detail').open);await until(()=>w.document.querySelector('[data-action="leave-cancel-admin"]')?.dataset.days==='1');
    click('[data-action="leave-cancel-admin"]');await until(()=>requests.some(r=>r.url.endsWith('/7/cancel')));await until(()=>w.document.querySelector('#content').textContent.includes('ملغاة'));
    const cancel=JSON.parse(requests.find(r=>r.url.endsWith('/7/cancel')).options.body);assert.equal(cancel.expectedDays,1);assert.equal(cancel.expectedStatus,'approved');
    const select=w.document.querySelector('#leave-filter select');select.value='all';select.dispatchEvent(new w.Event('change',{bubbles:true}));w.document.querySelector('#leave-filter').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    await until(()=>requests.some(r=>r.url.includes('status=all')));
    await until(()=>w.document.querySelector('#leave-filter select')!==select);
    await new Promise(r=>setTimeout(r,10));
  }finally{dom.window.close();}
});
test('admin DOM: each subject has its own confirmation and switch; the other row stays unchanged',async()=>{
  const {dom,w,requests,until,click}=await setup();try{
    await until(()=>w.document.querySelector('.stage-card'));click('[data-action="stage"]');await until(()=>w.document.querySelector('#search'));
    click('[data-action="student"]');await until(()=>w.document.querySelector('[data-action="student-participation"]'));
    const selector='[data-action="student-participation"][data-subject="1"]';
    const other='[data-action="student-participation"][data-subject="2"]';
    assert.equal(w.document.querySelector(selector).textContent,'تحويل إلى مباحثات');
    assert.equal(w.document.querySelector(other).textContent,'تحويل إلى تقارير');
    w.confirm=()=>false;click(selector);
    assert.equal(requests.filter(r=>r.url.endsWith('/participation')).length,0);
    await new Promise(resolve=>setTimeout(resolve,0));
    let confirmation;w.confirm=text=>{confirmation=text;return true;};click(selector);
    await until(()=>w.document.querySelector(selector)?.textContent==='تحويل إلى تقارير');
    assert.match(confirmation,/الفقه/);assert.match(confirmation,/بقية مواده/);
    const writes=requests.filter(r=>r.url.endsWith('/participation'));assert.equal(writes.length,1);
    assert.equal(writes[0].options.method,'PATCH');assert.deepEqual(JSON.parse(writes[0].options.body),{seasonId:1,mode:'mubahatha',expectedMode:'report'});
    assert.equal(w.document.querySelector(other).textContent,'تحويل إلى تقارير');
  }finally{dom.window.close();}
});

test('admin save uses a non-blocking Telegram confirmation and repeated save/cancel keeps controls usable',async()=>{
  const {dom,w,requests,until,click}=await setup();try{
    await until(()=>w.document.querySelector('.stage-card'));click('[data-action="stage"]');await until(()=>w.document.querySelector('#search'));
    click('[data-action="student"]');await until(()=>w.document.querySelector('[data-action="student-participation"]'));
    w.confirm=()=>{throw Error('Blocking browser confirmation must never run');};
    let decide;w.Telegram.WebApp.showConfirm=(message,done)=>{decide=done;};
    const selector='[data-action="student-participation"][data-subject="1"]';
    click(selector);assert.ok(decide);assert.equal(requests.filter(r=>r.url.endsWith('/participation')).length,0);
    decide(false);await new Promise(r=>setTimeout(r,0));
    click(selector);decide(true);await until(()=>w.document.querySelector(selector)?.textContent==='تحويل إلى تقارير');
    click(selector);decide(true);await until(()=>w.document.querySelector(selector)?.textContent==='تحويل إلى مباحثات');
    assert.equal(requests.filter(r=>r.url.endsWith('/participation')).length,2);
    click('[data-action="close-dialog"]');assert.equal(w.document.querySelector('#detail').open,false);
    const select=w.document.querySelector('[name="status"]');select.value='all';
    w.document.querySelector('#search').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    await until(()=>requests.some(r=>r.url.includes('status=all')));
    await until(()=>w.document.querySelector('[name="status"]').value==='all');
    await new Promise(r=>setTimeout(r,0));
    click('[data-action="home"]');await until(()=>w.document.querySelector('.stage-card'));
  }finally{dom.window.close();}
});

test('admin panel stays usable when Telegram never calls the confirmation back',async()=>{
  const {dom,w,requests,until,click}=await setup();try{
    await until(()=>w.document.querySelector('.stage-card'));click('[data-action="stage"]');await until(()=>w.document.querySelector('#search'));
    click('[data-action="student"]');await until(()=>w.document.querySelector('[data-action="student-participation"]'));
    const calls=[];let decide;w.Telegram.WebApp.showConfirm=(message,done)=>{calls.push(done);decide=done;};
    const selector='[data-action="student-participation"][data-subject="1"]';
    click(selector);assert.equal(calls.length,1);
    // The popup is lost: no callback ever arrives. The next tap must not be ignored.
    click(selector);assert.equal(calls.length,2,'a stale confirmation must not swallow later taps');
    calls[0](true);await new Promise(r=>setTimeout(r,0));
    assert.equal(requests.filter(r=>r.url.endsWith('/participation')).length,0,'an abandoned confirmation never saves');
    decide(true);await until(()=>requests.filter(r=>r.url.endsWith('/participation')).length===1);
    await until(()=>w.document.querySelector(selector)?.textContent==='تحويل إلى تقارير');
  }finally{dom.window.close();}
});

test('lesson schedule: only the current month is open, days are named and each weekday has its own colour',async()=>{
  const {dom,w,until,click}=await setup();try{
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
    const at=(offset)=>{const d=new Date(Date.UTC(Number(parts.year),Number(parts.month)-1+offset,1));return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;};
    const [prev,cur,next]=[at(-1),at(0),at(1)];
    const dates=[`${prev}-05`,`${prev}-06`,`${cur}-05`,`${cur}-06`,`${cur}-07`,`${next}-05`];
    const base=w.fetch;w.fetch=async(url,options={})=>{
      const u=new URL(url,'https://institute.example');
      if(!u.pathname.endsWith('/lesson-schedule'))return base(url,options);
      const data=options.method==='POST'?{ok:true}:{stage_season_id:1,start_date:dates[0],end_date_exclusive:`${next}-28`,dates,subjects:[{id:1,name:'الفقه'},{id:2,name:'العقائد'}],entries:[{subject_id:1,lesson_date:`${cur}-05`}]};
      return {ok:true,status:200,json:async()=>data};
    };
    await until(()=>w.document.querySelector('.stage-card'));
    click('[data-action="lesson-schedule"]');await until(()=>w.document.querySelector('.lesson-schedule .month-toggle'));
    const rowsOf=key=>[...w.document.querySelectorAll(`.lesson-schedule tr[data-month="${key}"]`)];
    const open=key=>w.document.querySelector(`.month-toggle[data-month="${key}"]`).getAttribute('aria-expanded')==='true';
    assert.equal(w.document.querySelectorAll('.month-toggle').length,3);
    assert.ok(open(cur)&&!open(prev)&&!open(next));
    assert.ok(rowsOf(cur).every(r=>!r.hidden)&&rowsOf(prev).every(r=>r.hidden)&&rowsOf(next).every(r=>r.hidden));
    // weekday names and one colour class per weekday
    const names=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
    for(const row of w.document.querySelectorAll('.lesson-schedule tbody tr[data-month]')){
      const iso=row.querySelector('.schedule-check').dataset.date,wd=new Date(iso+'T00:00:00Z').getUTCDay();
      assert.equal(row.querySelector('.day-cell').textContent,names[wd]);assert.ok(row.classList.contains('day-'+wd));
    }
    // another month opens on demand and closes again
    click(`.month-toggle[data-month="${prev}"]`);assert.ok(open(prev)&&rowsOf(prev).every(r=>!r.hidden));
    click(`.month-toggle[data-month="${prev}"]`);assert.ok(!open(prev)&&rowsOf(prev).every(r=>r.hidden));
    // open all / back to the current month only
    click('[data-action="schedule-months-all"]');assert.ok(open(prev)&&open(cur)&&open(next));
    click('[data-action="schedule-months-all"]');assert.ok(!open(prev)&&open(cur)&&!open(next));
    // the per-month counter follows a toggle
    const counter=w.document.querySelector(`.month-toggle[data-month="${cur}"] .month-planned`);assert.equal(counter.textContent,'1');
    click(`.lesson-schedule tr[data-month="${cur}"] .schedule-check[data-checked="false"]`);
    await until(()=>counter.textContent==='2');
  }finally{dom.window.close();}
});

test('admin confirmation falls back inside the page when Telegram cannot show its popup',async()=>{
  const {dom,w,requests,until,click}=await setup();try{
    await until(()=>w.document.querySelector('.stage-card'));click('[data-action="stage"]');await until(()=>w.document.querySelector('#search'));
    click('[data-action="student"]');await until(()=>w.document.querySelector('[data-action="student-participation"]'));
    w.Telegram.WebApp.showConfirm=()=>{throw Error('Unsupported');};w.confirm=()=>{throw Error('Must not block');};
    const selector='[data-action="student-participation"][data-subject="1"]';
    click(selector);await until(()=>w.document.querySelector('[role="alertdialog"]'));
    w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await until(()=>!w.document.querySelector('[role="alertdialog"]'));
    await new Promise(r=>setTimeout(r,0));assert.equal(requests.filter(r=>r.url.endsWith('/participation')).length,0);
    click(selector);await until(()=>w.document.querySelector('[data-confirm-choice="yes"]'));click('[data-confirm-choice="yes"]');
    await until(()=>w.document.querySelector(selector)?.textContent==='تحويل إلى تقارير');
    assert.equal(w.document.querySelector('[role="alertdialog"]'),null);
    click('[data-action="close-dialog"]');assert.equal(w.document.querySelector('#detail').open,false);
  }finally{dom.window.close();}
});

for(const stalled of ['fetch','body'])test(`admin ${stalled} timeout releases save and close controls even when abort is ignored`,async()=>{
  const {dom,w,requests,until,click}=await setup();try{
    await until(()=>w.document.querySelector('.stage-card'));click('[data-action="stage"]');await until(()=>w.document.querySelector('#search'));
    click('[data-action="student"]');await until(()=>w.document.querySelector('#edit-student'));
    const original=w.fetch;let resolveLate,signal;
    w.fetch=(url,options={})=>{
      if(url.endsWith('/students/1')&&options.method==='PATCH'){
        signal=options.signal;const pending=new Promise(resolve=>{resolveLate=resolve;});
        return stalled==='fetch'?pending:Promise.resolve({ok:true,json:()=>pending});
      }return original(url,options);
    };
    const schedule=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>schedule(fn,ms===20000?40:ms,...args);
    const form=w.document.querySelector('#edit-student');form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    assert.equal(form.querySelector('button').disabled,true);
    click('[data-action="close-dialog"]');assert.equal(w.document.querySelector('#detail').open,false,'closing does not wait for the save');
    await until(()=>w.document.querySelector('#notice').textContent.includes('تأخر رد الخادم'));
    assert.equal(signal.aborted,true);assert.equal(form.querySelector('button').disabled,false);
    click('[data-action="home"]');await until(()=>w.document.querySelector('.stage-card'));
    resolveLate(stalled==='fetch'?{ok:true,json:async()=>({})}:{});await new Promise(r=>setTimeout(r,0));
    assert.equal(w.document.querySelector('#detail').open,false,'late responses do not reopen the form');
  }finally{dom.window.close();}
});

test('admin: a slow successful save cannot reopen a dialog the user has dismissed',async()=>{
  const {dom,w,until,click}=await setup();try{
    await until(()=>w.document.querySelector('.stage-card'));click('[data-action="stage"]');await until(()=>w.document.querySelector('#search'));
    click('[data-action="student"]');await until(()=>w.document.querySelector('[data-action="student-participation"]'));
    const original=w.fetch;let release;
    w.fetch=async(url,options)=>{if(url.endsWith('/participation'))await new Promise(r=>{release=r;});return original(url,options);};
    click('[data-action="student-participation"][data-subject="1"]');await until(()=>release);
    click('[data-action="close-dialog"]');assert.equal(w.document.querySelector('#detail').open,false);
    release();await until(()=>w.document.querySelector('#notice').textContent.includes('حُفظ نوع المتابعة'));
    assert.equal(w.document.querySelector('#detail').open,false);
    click('[data-action="student"]');await until(()=>w.document.querySelector('#detail').open);
    assert.equal(w.document.querySelector('[data-subject="1"][data-action="student-participation"]').textContent,'تحويل إلى تقارير');
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
  assert.equal(w.document.querySelectorAll('#content th').length,5);
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
  assert.match(w.document.querySelector('#content').textContent,/الأعضاء \/ المحجوز \/ السعة/);
  assert.match(w.document.querySelector('#content').textContent,/35 \/ 38 \/ 40/);
  const form=w.document.querySelector('#participation-settings');
  form.querySelector('[name="grouped"]').value='false';form.querySelector('[data-study-id="1"]').value='false';
  form.querySelector('[name="grouped"]').dispatchEvent(new w.Event('change',{bubbles:true}));
  assert.match(w.document.querySelector('#participation-status').textContent,/غير محفوظ/);assert.ok(!requests.some(r=>r.url.includes('/participation-settings')));
  form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>w.document.querySelector('#apply-participation-settings'));assert.ok(!requests.some(r=>r.url.includes('/participation-settings')));
  const impactRequest=requests.find(r=>r.url.includes('/grouping-impact'));assert.match(impactRequest.url,/grouped=false/);
  const impactText=w.document.querySelector('.settings-impact').textContent;
  assert.match(impactText,/2 مجموعة في 1 مادة/);assert.match(impactText,/ينتقل 14 طالبًا/);assert.match(impactText,/يتوقف 3 موعد/);
  const review=w.document.querySelector('#apply-participation-settings');review.elements.acknowledged.checked=true;review.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>requests.some(r=>r.url.includes('/participation-settings')));
  const req=requests.find(r=>r.url.includes('/participation-settings'));assert.equal(req.options.method,'PATCH');assert.deepEqual(JSON.parse(req.options.body),{grouped:false,enabledSubjectIds:[],expectedSettings:{grouped:true,enabledSubjectIds:[1]},confirmGroupingChange:true});
  await until(()=>w.document.querySelector('#notice').textContent.includes('حُفظت إعدادات')); 
 }finally{dom.window.close();}
});
test('admin settings: review cancellation and a declined confirmation never save; numbered mode also requires review',async()=>{
 const {dom,w,requests,until,click}=await setup({grouped:false});try{
  await until(()=>w.document.querySelector('.stage-card'));click('[data-action="stage"]');await until(()=>w.document.querySelector('#search'));click('[data-tab="subjects"]');await until(()=>w.document.querySelector('#participation-settings'));
  const form=w.document.querySelector('#participation-settings');form.elements.grouped.value='true';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>w.document.querySelector('#apply-participation-settings'));assert.match(w.document.querySelector('#dialog-body').textContent,/لن يُعاد توزيع/);click('[data-action="close-dialog"]');assert.ok(!requests.some(r=>r.url.includes('/participation-settings')));
  form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>w.document.querySelector('#detail').open);
  let review=w.document.querySelector('#apply-participation-settings');review.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>w.document.querySelector('#dialog-notice').textContent.includes('علامة التأكيد'));
  w.confirm=()=>false;review.elements.acknowledged.checked=true;review.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,10));assert.ok(!requests.some(r=>r.url.includes('/participation-settings')));
  w.confirm=()=>true;review.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>requests.some(r=>r.url.includes('/participation-settings')));assert.equal(JSON.parse(requests.find(r=>r.url.includes('/participation-settings')).options.body).grouped,true);
 }finally{dom.window.close();}
});
test('admin settings: a blocked grouping change explains why and offers no way to save it',async()=>{
 const impact={current:false,target:true,changing:true,blocked:'ارفع سعة المجموعات لتناسب أعداد الطلبة قبل تفعيل التقسيم.',studentsWithNumbers:0};
 const {dom,w,requests,until,click}=await setup({impact});try{
  await until(()=>w.document.querySelector('.stage-card'));click('[data-action="stage"]');await until(()=>w.document.querySelector('#search'));
  click('[data-tab="subjects"]');await until(()=>w.document.querySelector('#participation-settings'));
  const form=w.document.querySelector('#participation-settings');
  form.querySelector('[name="grouped"]').value='false';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>w.document.querySelector('.blocked-note'));
  assert.match(w.document.querySelector('.blocked-note').textContent,/ارفع سعة المجموعات/);
  assert.equal(w.document.querySelector('#apply-participation-settings'),null,'no form to submit while blocked');
  assert.ok(!requests.some(r=>r.url.includes('/participation-settings')));
 }finally{dom.window.close();}
});
test('admin settings: a subjects-only change never asks for grouping impact',async()=>{
 const {dom,w,requests,until,click}=await setup();try{
  await until(()=>w.document.querySelector('.stage-card'));click('[data-action="stage"]');await until(()=>w.document.querySelector('#search'));
  click('[data-tab="subjects"]');await until(()=>w.document.querySelector('#participation-settings'));
  const form=w.document.querySelector('#participation-settings');
  form.querySelector('[data-study-id="1"]').value='false';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>w.document.querySelector('#apply-participation-settings'));
  assert.ok(!requests.some(r=>r.url.includes('/grouping-impact')),'impact is requested only when the grouping changes');
 }finally{dom.window.close();}
});
test('admin subject: the name can be edited explicitly and the refreshed screen uses the saved name',async()=>{
 const {dom,w,requests,until,click}=await setup();try{
  await until(()=>w.document.querySelector('.stage-card'));click('[data-action="stage"]');await until(()=>w.document.querySelector('#search'));click('[data-tab="subjects"]');await until(()=>w.document.querySelector('[data-action="edit-subject"]'));
  click('[data-action="edit-subject"]');const form=w.document.querySelector('#edit-subject');assert.match(w.document.querySelector('#dialog-body').textContent,/#فقه/);form.elements.name.value='الفقه الميسر';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>requests.some(r=>r.url.endsWith('/subjects/1')));const saved=requests.find(r=>r.url.endsWith('/subjects/1'));assert.equal(saved.options.method,'PATCH');assert.deepEqual(JSON.parse(saved.options.body),{name:'الفقه الميسر',expectedName:'الفقه',stageSeasonId:'1'});
  await until(()=>w.document.querySelector('#content').textContent.includes('الفقه الميسر'));assert.equal(w.document.querySelector('#detail').open,false);
 }finally{dom.window.close();}
});

test('admin DOM: lesson counters, subject filters, pagination, fixed deadline action and MD download',async()=>{
 const {dom,w,requests,until,click}=await setup();try{
  await until(()=>w.document.querySelector('.stage-card'));click('[data-action="lesson-management"]');
  await until(()=>w.document.querySelector('#lesson-mgt-subject'));
  assert.match(w.document.querySelector('#content').textContent,/26/);assert.match(w.document.querySelector('#content').textContent,/رقم الدرس/);
  click('[data-action="management-page"][data-page="1"]');await until(()=>w.document.querySelector('[data-action="management-page"][data-page="0"]'));
  assert.ok(requests.some(r=>r.url.includes('/lesson-management?')&&r.url.includes('page=1')));
  const filter=w.document.querySelector('#lesson-mgt-subject');filter.value='1';filter.dispatchEvent(new w.Event('change',{bubbles:true}));
  await until(()=>requests.some(r=>r.url.includes('/lesson-management?')&&r.url.includes('subjectId=1')&&r.url.includes('page=0')));
  await until(()=>!w.document.querySelector('[data-action="management-page"]'));
  click('[data-action="lesson-reopen"]');await until(()=>requests.some(r=>r.url.endsWith('/lessons/71/reopen')));
  assert.deepEqual(JSON.parse(requests.find(r=>r.url.endsWith('/lessons/71/reopen')).options.body),{});
  await until(()=>w.document.querySelector('#notice').textContent.includes('أُعيد فتح'));
  click('[data-action="lesson-attendance"]');await until(()=>w.document.querySelector('#attendance-stage'));
  const select=w.document.querySelector('#attendance-stage select');select.value='1';select.dispatchEvent(new w.Event('change',{bubbles:true}));
  await until(()=>w.document.querySelector('[data-action="attendance-export"]'));
  let download='';w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){download=this.download;};
  click('[data-action="attendance-export"]');await until(()=>download.endsWith('.md'));
  assert.ok(requests.some(r=>r.url.includes('/lesson-attendance.md?stageId=1')));
 }finally{dom.window.close();}
});
test('admin DOM: discussion management exposes numbered sessions, complete attendance and deletion',async()=>{
 const {dom,w,requests,until,click}=await setup();try{
  await until(()=>w.document.querySelector('.stage-card'));click('[data-action="stage"]');await until(()=>w.document.querySelector('#search'));
  click('[data-action="tab"][data-tab="schedule"]');await until(()=>w.document.querySelector('[data-action="session-reopen"]'));
  assert.match(w.document.querySelector('#content').textContent,/رقم المباحثة/);assert.equal(w.document.querySelector('#content img'),null);
  assert.match(w.document.querySelector('#content').textContent,/10 دقائق من لحظة إعادة الفتح/);
  assert.doesNotMatch(w.document.querySelector('#content').textContent,/24 ساعة/);
  let confirmation='';w.confirm=message=>{confirmation=message;return true;};
  click('[data-action="session-reopen"]');await until(()=>requests.some(r=>r.url.endsWith('/sessions/71/reopen')));
  assert.match(confirmation,/10 دقائق من الآن/);assert.doesNotMatch(confirmation,/24 ساعة|النشر الأصلي/);
  await until(()=>w.document.querySelector('#notice').textContent.includes('أُعيد فتح'));
  click('[data-action="session-markall"]');await until(()=>w.document.querySelector('#notice').textContent.includes('اكتمل حضور 2'));
  assert.ok(requests.some(r=>r.url.endsWith('/sessions/71/mark-all')));
  click('[data-action="session-cancel"]');await until(()=>w.document.querySelector('#notice').textContent.includes('حُذفت المباحثة'));
  assert.ok(requests.some(r=>r.url.endsWith('/sessions/71/cancel')));
 }finally{dom.window.close();}
});

test('admin displays zero queued notices honestly and exposes recipient diagnostics and retry',async()=>{
 const state={sessionId:71,windowOpen:true,until:new Date(Date.now()+600000).toISOString(),eligible:0,
   audience:[{reason:'joined_group_later',count:1}],counts:{total:0,pending:0,sending:0,sent:0,failed:0,expired:0},errors:[]};
 const {dom,w,requests,until,click}=await setup({noticeState:state});try{
  await until(()=>w.document.querySelector('.stage-card'));click('[data-action="stage"]');await until(()=>w.document.querySelector('#search'));
  click('[data-action="tab"][data-tab="schedule"]');await until(()=>w.document.querySelector('[data-action="session-reopen"]'));
  click('[data-action="session-reopen"]');await until(()=>w.document.querySelector('#notice').textContent.includes('لم يُجهّز أي إشعار'));
  assert.equal(w.document.querySelector('#notice').className,'error');
  click('[data-action="session-notifications"]');await until(()=>w.document.querySelector('#detail').open);
  assert.match(w.document.querySelector('#dialog-body').textContent,/نُقل إلى المجموعة بعد موعد المباحثة الأصلي/);
  click('[data-action="session-retry-notifications"]');await until(()=>requests.some(r=>r.url.endsWith('/sessions/71/retry-notifications')));
  await until(()=>!w.document.querySelector('#dialog-notice').hidden);
  assert.match(w.document.querySelector('#dialog-notice').textContent,/لم يُجهّز أي إشعار/);
 }finally{dom.window.close();}
});

test('admin selected discussion attendance uses checkboxes and the session endpoint only',async()=>{
 const {dom,w,requests,until,click}=await setup();try{
  await until(()=>w.document.querySelector('.stage-card'));click('[data-action="stage"]');await until(()=>w.document.querySelector('#search'));
  click('[data-action="tab"][data-tab="schedule"]');await until(()=>w.document.querySelector('[data-action="session-selected"]'));
  click('[data-action="session-selected"]');await until(()=>w.document.querySelector('#save-override'));
  assert.match(w.document.querySelector('#dialog-title').textContent,/لمباحثة/);
  assert.equal(w.document.querySelector('[name="opensAt"]'),null);
  assert.equal(w.document.querySelector('[name="override-student"][value="3"]').disabled,true);
  for(const id of [1,2]){const cb=w.document.querySelector(`[name="override-student"][value="${id}"]`);assert.equal(cb.type,'checkbox');cb.checked=true;cb.dispatchEvent(new w.Event('change',{bubbles:true}));}
  w.document.querySelector('#save-override').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>requests.some(r=>r.url.endsWith('/sessions/71/selected-attendance')));
  assert.deepEqual(JSON.parse(requests.find(r=>r.url.endsWith('/sessions/71/selected-attendance')).options.body).studentIds,[1,2]);
  assert.ok(!requests.some(r=>r.url.includes('/lessons/')||r.url.includes('/exams/')));
  await until(()=>w.document.querySelector('#notice').textContent.includes('أضيف 3 تسجيلًا'));
 }finally{dom.window.close();}
});
test('admin controls remain responsive while lesson deletion is saving and after exam deletion',async()=>{
  const {dom,w,requests,until,click}=await setup();
  try{
    await until(()=>w.document.querySelector('.stage-card'));
    click('[data-action="lesson-management"]');await until(()=>w.document.querySelector('#lesson-mgt-subject'));
    const originalFetch=w.fetch;let release,started=false;
    w.fetch=async(url,options)=>{
      if(url.endsWith('/lessons/71/cancel')){started=true;await new Promise(resolve=>{release=resolve;});}
      return originalFetch(url,options);
    };
    click('[data-action="lesson-cancel"]');await until(()=>started);
    const filter=w.document.querySelector('#lesson-mgt-subject');filter.value='1';filter.dispatchEvent(new w.Event('change',{bubbles:true}));
    await until(()=>requests.some(r=>r.url.includes('/lesson-management?')&&r.url.includes('subjectId=1')));
    release();await until(()=>w.document.querySelector('#notice').textContent.includes('أُلغي تفعيل'));
    click('[data-action="home"]');await until(()=>w.document.querySelector('.stage-card'));
    click('[data-action="stage"]');await until(()=>w.document.querySelector('#search'));
    click('[data-action="tab"][data-tab="exams"]');await until(()=>w.document.querySelector('[data-action="exam"]'));
    click('[data-action="exam"]');await until(()=>w.document.querySelector('[data-action="delete-exam"]'));
    click('[data-action="delete-exam"]');await until(()=>w.document.querySelector('#notice').textContent.includes('حُذف الامتحان'));
    assert.equal(w.document.querySelector('#detail').open,false);
    click('[data-action="lesson-management"]');await until(()=>w.document.querySelector('#lesson-mgt-subject'));
    const count=requests.filter(r=>r.url.includes('/lesson-management?')).length;
    const after=w.document.querySelector('#lesson-mgt-subject');after.value='';after.dispatchEvent(new w.Event('change',{bubbles:true}));
    await until(()=>requests.filter(r=>r.url.includes('/lesson-management?')).length>count);
  }finally{dom.window.close();}
});
test('admin lesson management removes one selected student attendance',async()=>{
  const {dom,w,requests,until,click}=await setup();
  try{
    await until(()=>w.document.querySelector('.stage-card'));
    click('[data-action="lesson-management"]');await until(()=>w.document.querySelector('[data-action="lesson-attendance-remove"]'));
    click('[data-action="lesson-attendance-remove"]');await until(()=>w.document.querySelector('[data-action="remove-lesson-attendance"]'));
    assert.match(w.document.querySelector('#dialog-body').textContent,/طالب اختبار اسم رباعي/);
    click('[data-action="remove-lesson-attendance"]');
    await until(()=>requests.some(r=>r.url.endsWith('/lessons/71/attendance/1/remove')));
    assert.equal(requests.find(r=>r.url.endsWith('/lessons/71/attendance/1/remove')).options.method,'POST');
    await until(()=>w.document.querySelector('#dialog-notice').textContent.includes('حُذف حضور الطالب'));
  }finally{dom.window.close();}
});
