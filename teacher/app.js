'use strict';
(() => {
  const tg=window.Telegram?.WebApp;
  if(tg){try{tg.ready();tg.expand();tg.setHeaderColor('secondary_bg_color');}catch(_){}}

  const state={token:null,dashboard:null,subjects:[],view:'home',schedule:[],scheduleFilter:'all'};
  const $=(s,root=document)=>root.querySelector(s);
  const $$=(s,root=document)=>[...root.querySelectorAll(s)];
  const app=$('#app');
  const loading=$('#loadingView');
  const errorView=$('#errorView');
  const content=$('#contentViews');
  const bottomNav=$('#bottomNav');
  const sheet=$('#sheet');
  const backdrop=$('#sheetBackdrop');
  const sheetBody=$('#sheetBody');
  const sheetTitle=$('#sheetTitle');
  const sheetKicker=$('#sheetKicker');
  const toast=$('#toast');

  const esc=(v)=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const n=(v)=>Number(v||0);
  const dayNames=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  const timeText=(h,m)=>`${String(n(h)).padStart(2,'0')}:${String(n(m)).padStart(2,'0')}`;
  const dateTime=(v)=>{if(!v)return '—';try{return new Intl.DateTimeFormat('ar-IQ',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Baghdad'}).format(new Date(v));}catch{return '—';}};

  function notify(message){
    toast.textContent=message;toast.classList.remove('hidden');
    clearTimeout(notify.t);notify.t=setTimeout(()=>toast.classList.add('hidden'),2600);
    try{tg?.HapticFeedback?.notificationOccurred('success');}catch(_){ }
  }

  async function api(path,options={}){
    const headers={'Content-Type':'application/json',...(options.headers||{})};
    if(state.token)headers.Authorization=`Bearer ${state.token}`;
    const res=await fetch(path,{...options,headers});
    const type=res.headers.get('content-type')||'';
    const data=type.includes('application/json')?await res.json():null;
    if(!res.ok){
      const err=new Error(data?.error||'تعذر إتمام الطلب.');err.status=res.status;throw err;
    }
    return data;
  }

  async function authenticate(){
    const initData=tg?.initData||'';
    if(!initData)throw new Error('افتح لوحة الأستاذ من زر «فتح لوحة الأستاذ» داخل المحادثة الخاصة مع البوت.');
    const result=await api('/api/teacher/auth',{method:'POST',body:JSON.stringify({initData})});
    state.token=result.token;
  }

  function showError(err){
    loading.classList.add('hidden');content.classList.add('hidden');bottomNav.classList.add('hidden');
    $('#errorMessage').textContent=err?.message||'حدث خطأ غير متوقع.';errorView.classList.remove('hidden');app.setAttribute('aria-busy','false');
  }

  function empty(text){return `<div class="empty-card">${esc(text)}</div>`;}

  function switchView(name){
    state.view=name;
    $$('.view').forEach(v=>v.classList.toggle('active',v.dataset.view===name));
    $$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.nav===name));
    window.scrollTo({top:0,behavior:'smooth'});
    if(name==='discussions'&&!state.schedule.length)loadAllSchedules();
  }

  function renderDashboard(){
    const d=state.dashboard;state.subjects=d.subjects||[];
    $('#teacherName').textContent=d.teacher?.full_name||'—';$('#accountTeacher').textContent=d.teacher?.full_name||'—';
    const season=[...new Set(state.subjects.map(s=>s.season_name).filter(Boolean))].join('، ');
    $('#welcomeMeta').textContent=season?`الموسم: ${season}`:'الموسم الدراسي الحالي';
    $('#statSubjects').textContent=d.totals?.subjects??0;$('#statStudents').textContent=d.totals?.students??0;
    $('#statReports').textContent=d.totals?.pendingReports??0;$('#statToday').textContent=d.totals?.todayDiscussions??0;

    const today=$('#todayList');
    today.innerHTML=(d.today||[]).length?(d.today||[]).map(s=>`
      <article class="list-card">
        <div class="list-card-head"><div><h4>${esc(s.subject_name)}</h4><p>${esc(s.group_title)} · ${esc(timeText(s.hour,s.minute))}</p></div><span class="badge">${esc(dayNames[n(s.day_of_week)]||'اليوم')}</span></div>
      </article>`).join(''):empty('لا توجد مباحثات مجدولة اليوم.');

    const active=d.activeSessions||[];$('#activeSection').classList.toggle('hidden',active.length===0);
    $('#activeSessions').innerHTML=active.map(s=>`
      <article class="list-card">
        <div class="list-card-head"><div><h4>${esc(s.subject_name)}</h4><p>${esc(s.group_title)} · بدأت ${esc(dateTime(s.opened_at))}</p></div><span class="badge live">مفتوحة</span></div>
        <div class="card-actions"><button class="danger-button" type="button" data-end-session="${n(s.id)}">إنهاء المباحثة وفتح حضور النهاية</button></div>
      </article>`).join('');
    $$('[data-end-session]').forEach(b=>b.addEventListener('click',()=>endSession(n(b.dataset.endSession),b)));

    renderSubjects();renderReportSubjectSelect();renderDiscussionFilters();
  }

  function renderSubjects(){
    const root=$('#subjectsList');
    if(!state.subjects.length){root.innerHTML=empty('لم تُسنَد إليك مواد في الموسم الحالي.');return;}
    root.innerHTML=state.subjects.map(s=>`
      <article class="subject-card">
        <div class="subject-head"><div><h3>${esc(s.subject_name)}</h3><p>${esc(s.stage_name)}</p></div><span class="badge">${n(s.student_count)} طالب</span></div>
        <div class="subject-meta"><span class="meta-pill">${esc(s.season_name)}</span></div>
        <div class="card-actions">
          <button class="mini-button" type="button" data-subject-action="attendance" data-subject="${n(s.subject_id)}" data-season="${n(s.stage_season_id)}">الحضور</button>
          <button class="mini-button" type="button" data-subject-action="groups" data-subject="${n(s.subject_id)}" data-season="${n(s.stage_season_id)}">المجموعات</button>
          <button class="mini-button" type="button" data-subject-action="schedule" data-subject="${n(s.subject_id)}" data-season="${n(s.stage_season_id)}">الجدول</button>
          <button class="mini-button" type="button" data-subject-action="exams" data-subject="${n(s.subject_id)}" data-season="${n(s.stage_season_id)}">الامتحانات</button>
        </div>
      </article>`).join('');
    $$('[data-subject-action]',root).forEach(b=>b.addEventListener('click',()=>openSubjectAction(b.dataset.subjectAction,n(b.dataset.subject),n(b.dataset.season))));
  }

  function renderReportSubjectSelect(){
    const select=$('#reportSubject');const old=select.value;
    select.innerHTML='<option value="">اختر المادة</option>'+state.subjects.map(s=>`<option value="${n(s.subject_id)}:${n(s.stage_season_id)}">${esc(s.subject_name)} — ${esc(s.stage_name)}</option>`).join('');
    if([...select.options].some(o=>o.value===old))select.value=old;
  }

  function renderDiscussionFilters(){
    const root=$('#discussionFilters');
    root.innerHTML=`<button type="button" class="chip ${state.scheduleFilter==='all'?'active':''}" data-filter="all">الكل</button>`+state.subjects.map(s=>`<button type="button" class="chip ${state.scheduleFilter===String(s.subject_id)?'active':''}" data-filter="${n(s.subject_id)}">${esc(s.subject_name)}</button>`).join('');
    $$('[data-filter]',root).forEach(b=>b.addEventListener('click',()=>{state.scheduleFilter=b.dataset.filter;renderDiscussionFilters();renderSchedule();}));
  }

  async function loadAllSchedules(){
    const root=$('#scheduleList');root.innerHTML=empty('جاري تحميل جدول المباحثات…');
    try{
      const groups=await Promise.all(state.subjects.map(s=>api(`/api/teacher/schedule?subjectId=${n(s.subject_id)}&seasonId=${n(s.stage_season_id)}`)));
      state.schedule=groups.flat();renderSchedule();
    }catch(err){root.innerHTML=empty(err.message);}
  }

  function renderSchedule(){
    const root=$('#scheduleList');let rows=state.schedule;
    if(state.scheduleFilter!=='all')rows=rows.filter(r=>String(r.subject_id)===state.scheduleFilter);
    if(!rows.length){root.innerHTML=empty('لا توجد مواعيد مباحثات ضمن هذا الاختيار.');return;}
    rows=[...rows].sort((a,b)=>n(a.day_of_week)-n(b.day_of_week)||n(a.hour)-n(b.hour)||n(a.minute)-n(b.minute));
    root.innerHTML=rows.map(s=>`
      <article class="schedule-card">
        <div class="time-box">${esc(timeText(s.hour,s.minute))}</div>
        <div class="schedule-content"><div class="schedule-head"><div><h4>${esc(s.subject_name)}</h4><p>${esc(s.group_title)} · ${esc(dayNames[n(s.day_of_week)]||'—')}</p></div></div><p>مدة المباحثة: ${n(s.duration_hours)||1} ساعة</p></div>
      </article>`).join('');
  }

  async function openSubjectAction(action,subjectId,seasonId){
    const sub=state.subjects.find(s=>n(s.subject_id)===subjectId&&n(s.stage_season_id)===seasonId);
    if(action==='attendance')return openAttendance(sub);
    if(action==='groups')return openGroups(sub);
    if(action==='schedule')return openScheduleSheet(sub);
    if(action==='exams')return openExams(sub);
  }

  function openSheet(title,kicker=''){sheetTitle.textContent=title;sheetKicker.textContent=kicker;sheetBody.innerHTML=empty('جاري التحميل…');sheet.classList.remove('hidden');backdrop.classList.remove('hidden');document.body.style.overflow='hidden';}
  function closeSheet(){sheet.classList.add('hidden');backdrop.classList.add('hidden');document.body.style.overflow='';}

  async function openAttendance(sub){
    openSheet(`حضور ${sub.subject_name}`,sub.stage_name);
    try{
      const rows=await api(`/api/teacher/attendance?subjectId=${n(sub.subject_id)}&seasonId=${n(sub.stage_season_id)}`);
      if(!rows.length){sheetBody.innerHTML=empty('لا يوجد طلبة مسجلون في هذا الموسم.');return;}
      const total=n(rows[0].total_lessons);const completed=rows.filter(r=>n(r.attended_lessons)>=total&&total>0).length;
      sheetBody.innerHTML=`
        <div class="detail-grid"><div class="detail-box"><span>إجمالي الدروس</span><strong>${total}</strong></div><div class="detail-box"><span>أكملوا جميع الدروس</span><strong>${completed}/${rows.length}</strong></div></div>
        <div>${rows.map(r=>{const a=n(r.attended_lessons),ratio=total?Math.round(a/total*100):0,cls=ratio>=90?'good':ratio>=70?'warn':'bad';return `<div class="attendance-row"><div><h4>${esc(r.full_name)}</h4><small>${ratio}% من الدروس</small></div><span class="attendance-ratio ${cls}">${a}/${total}</span></div>`;}).join('')}</div>`;
    }catch(err){sheetBody.innerHTML=empty(err.message);}
  }

  async function openGroups(sub){
    openSheet(`مجموعات ${sub.subject_name}`,sub.stage_name);
    try{
      const rows=await api(`/api/teacher/groups?subjectId=${n(sub.subject_id)}&seasonId=${n(sub.stage_season_id)}`);
      sheetBody.innerHTML=rows.length?rows.map(g=>`
        <article class="list-card"><div class="list-card-head"><div><h4>${esc(g.title)}</h4><p>${g.invite_link?'رابط المجموعة محفوظ':'لا يوجد رابط دعوة محفوظ'}</p></div><span class="badge ${n(g.member_count)>=n(g.capacity)?'warn':''}">${n(g.member_count)}/${n(g.capacity)}</span></div></article>`).join(''):empty('لا توجد مجموعات لهذه المادة.');
    }catch(err){sheetBody.innerHTML=empty(err.message);}
  }

  async function openScheduleSheet(sub){
    openSheet(`جدول ${sub.subject_name}`,sub.stage_name);
    try{
      const rows=await api(`/api/teacher/schedule?subjectId=${n(sub.subject_id)}&seasonId=${n(sub.stage_season_id)}`);
      sheetBody.innerHTML=rows.length?rows.map(s=>`<article class="schedule-card"><div class="time-box">${esc(timeText(s.hour,s.minute))}</div><div class="schedule-content"><h4>${esc(dayNames[n(s.day_of_week)]||'—')}</h4><p>${esc(s.group_title)} · ${n(s.duration_hours)||1} ساعة</p></div></article>`).join(''):empty('لا توجد مواعيد مباحثات لهذه المادة.');
    }catch(err){sheetBody.innerHTML=empty(err.message);}
  }

  async function openExams(sub){
    openSheet(`امتحانات ${sub.subject_name}`,sub.stage_name);
    try{
      const rows=await api(`/api/teacher/exams?subjectId=${n(sub.subject_id)}&seasonId=${n(sub.stage_season_id)}`);
      sheetBody.innerHTML=rows.length?rows.map(e=>`<article class="list-card"><div class="list-card-head"><div><h4>${esc(e.title||`الامتحان ${e.exam_number}`)}</h4><p>الأسئلة: ${n(e.question_count)} · التسليمات: ${n(e.submitted_count)}</p></div><span class="badge">${esc(e.status||'—')}</span></div></article>`).join(''):empty('لا توجد امتحانات لهذه المادة.');
    }catch(err){sheetBody.innerHTML=empty(err.message);}
  }

  async function loadReportStudents(){
    const select=$('#reportSubject');const root=$('#reportStudents');
    if(!select.value){root.innerHTML=empty('اختر مادة لعرض طلبة التقارير.');return;}
    const [subjectId,seasonId]=select.value.split(':').map(Number);root.innerHTML=empty('جاري تحميل الطلبة…');
    try{
      const rows=await api(`/api/teacher/reports/students?subjectId=${subjectId}&seasonId=${seasonId}&onlyUngraded=0`);
      root.innerHTML=rows.length?rows.map(r=>`
        <article class="report-student-card" data-report-student="${n(r.student_id)}" data-subject="${subjectId}" data-season="${seasonId}" data-group="${r.group_id? n(r.group_id):''}">
          <div><h4>${esc(r.full_name)}</h4><p>${esc(r.group_title||'المرحلة كاملة')} · ${r.report_score==null?'الدرجة النهائية غير معتمدة':`الدرجة ${esc(r.report_score)}`}</p></div>
          <div class="report-count"><strong>${n(r.report_count)}</strong><small> تقرير</small></div>
        </article>`).join(''):empty('لا يوجد طلبة تقارير لهذه المادة.');
      $$('[data-report-student]',root).forEach(card=>card.addEventListener('click',()=>openStudentReports(n(card.dataset.reportStudent),subjectId,seasonId,card.dataset.group?Number(card.dataset.group):null,card.querySelector('h4').textContent)));
    }catch(err){root.innerHTML=empty(err.message);}
  }

  async function openStudentReports(studentId,subjectId,seasonId,groupId,name){
    openSheet(`تقارير ${name}`,'التقييم من 15');
    try{
      const query=new URLSearchParams({studentId,subjectId,seasonId});if(groupId)query.set('groupId',groupId);
      const rows=await api(`/api/teacher/reports?${query}`);
      if(!rows.length){sheetBody.innerHTML=empty('لا توجد تقارير لهذا الطالب.');return;}
      sheetBody.innerHTML=rows.map(r=>`
        <article class="report-item" data-report-id="${n(r.id)}">
          <h4>تقرير ${esc(r.group_title_snapshot||'الطالب')}</h4>
          <p>${r.note?esc(r.note):r.file_kind?`تقرير محفوظ كـ ${esc(r.file_kind)} في البوت.`:'تقرير محفوظ في النظام.'}<br>تاريخ الإرسال: ${esc(dateTime(r.submitted_at))}</p>
          <div class="score-row"><label><span class="field-label">الدرجة من 15</span><input class="score-input" type="number" min="0" max="15" step="0.25" value="${r.score==null?'':esc(r.score)}" inputmode="decimal"></label><button class="primary-button score-save" type="button">حفظ</button></div>
        </article>`).join('');
      $$('.report-item',sheetBody).forEach(item=>$('.score-save',item).addEventListener('click',async()=>{
        const input=$('.score-input',item);const score=Number(input.value);if(!Number.isFinite(score)||score<0||score>15){notify('الدرجة يجب أن تكون بين 0 و15.');return;}
        const btn=$('.score-save',item);btn.disabled=true;btn.textContent='جاري الحفظ…';
        try{await api(`/api/teacher/reports/${n(item.dataset.reportId)}/score`,{method:'POST',body:JSON.stringify({score})});btn.textContent='تم الحفظ';notify('حُفظ تقييم التقرير.');}
        catch(err){btn.textContent='حفظ';notify(err.message);}finally{btn.disabled=false;}
      }));
    }catch(err){sheetBody.innerHTML=empty(err.message);}
  }

  async function endSession(id,button){
    if(!confirm('سيتم إنهاء المباحثة وفتح حضور النهاية للطلبة. هل تريد المتابعة؟'))return;
    button.disabled=true;button.textContent='جاري الإنهاء…';
    try{await api(`/api/teacher/sessions/${id}/end`,{method:'POST',body:'{}'});notify('تم إنهاء المباحثة وفتح حضور النهاية.');await refresh();}
    catch(err){notify(err.message);button.disabled=false;button.textContent='إنهاء المباحثة وفتح حضور النهاية';}
  }

  async function refresh(){
    $('#refreshBtn').disabled=true;
    try{state.dashboard=await api('/api/teacher/dashboard');renderDashboard();if(state.view==='discussions'){state.schedule=[];await loadAllSchedules();}}
    finally{$('#refreshBtn').disabled=false;}
  }

  async function init(){
    try{
      await authenticate();state.dashboard=await api('/api/teacher/dashboard');renderDashboard();
      loading.classList.add('hidden');errorView.classList.add('hidden');content.classList.remove('hidden');bottomNav.classList.remove('hidden');app.setAttribute('aria-busy','false');
    }catch(err){showError(err);}
  }

  $$('.nav-item').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.nav)));
  $$('[data-nav-target]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.navTarget)));
  $('#refreshBtn').addEventListener('click',()=>refresh().catch(showError));
  $('#retryBtn').addEventListener('click',()=>{errorView.classList.add('hidden');loading.classList.remove('hidden');app.setAttribute('aria-busy','true');init();});
  $('#reportSubject').addEventListener('change',loadReportStudents);
  $('#sheetClose').addEventListener('click',closeSheet);backdrop.addEventListener('click',closeSheet);
  $('#closeBtn').addEventListener('click',()=>{try{tg?.close();}catch(_){}});
  $$('[data-tool="exams"]').forEach(b=>b.addEventListener('click',()=>{const s=state.subjects[0];if(!s)return notify('لا توجد مواد مسندة إليك.');openExams(s);}));
  $$('[data-tool="attendance"]').forEach(b=>b.addEventListener('click',()=>{const s=state.subjects[0];if(!s)return notify('لا توجد مواد مسندة إليك.');openAttendance(s);}));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!sheet.classList.contains('hidden'))closeSheet();});

  init();
})();
