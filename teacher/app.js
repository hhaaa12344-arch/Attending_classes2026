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
  const todayIso=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

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
    const pendingReports=n(d.totals?.pendingReports);
    $('#statReports').textContent=pendingReports;$('#statToday').textContent=d.totals?.todayDiscussions??0;
    const navBadge=$('#navReportBadge');
    navBadge.textContent=pendingReports>99?'99+':String(pendingReports);
    navBadge.classList.toggle('hidden',pendingReports===0);
    const pendingNotice=$('#pendingReportsNotice');
    pendingNotice.textContent=pendingReports
      ? `لديك ${pendingReports} تقريرًا بانتظار التقييم. يبقى التنبيه ظاهرًا حتى تسجّل درجة لكل تقرير.`
      : 'لا توجد تقارير بانتظار التقييم حاليًا.';
    pendingNotice.classList.toggle('hidden',pendingReports===0);

    const today=$('#todayList');
    today.innerHTML=(d.today||[]).length?(d.today||[]).map(s=>`
      <article class="list-card">
        <div class="list-card-head"><div><h4>${esc(s.subject_name)}</h4><p>${esc(s.group_title)} · ${esc(timeText(s.hour,s.minute))}</p></div><span class="badge">${esc(dayNames[n(s.day_of_week)]||'اليوم')}</span></div>
      </article>`).join(''):empty('لا توجد مباحثات مجدولة اليوم.');

    const active=d.activeSessions||[];$('#activeSection').classList.toggle('hidden',active.length===0);
    $('#activeSessions').innerHTML=active.map(s=>{
      const canEnd=!s.is_closed&&!s.end_opened_at&&new Date(s.start_attendance_opens_at)<=new Date()&&new Date(s.closes_at)>new Date();
      return `
      <article class="list-card">
        <div class="list-card-head"><div><h4>${esc(s.subject_name)}</h4><p>${esc(s.group_title)} · بدأت ${esc(dateTime(s.opened_at))}</p></div><span class="badge live">مفتوحة</span></div>
        ${canEnd?`<div class="card-actions"><button class="danger-button" type="button" data-end-session="${n(s.id)}">إنهاء المباحثة وفتح حضور النهاية</button></div>`:
          (!s.end_opened_at?`<p class="subtle">يظهر زر الإنهاء بعد فتح الحضور الأول عند ${esc(dateTime(s.start_attendance_opens_at))}.</p>`:'')}
      </article>`;
    }).join('');
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
          <button class="mini-button" type="button" data-subject-action="attendance" data-subject="${n(s.subject_id)}" data-season="${n(s.stage_season_id)}">حضور المباحثات</button>
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
    openSheet(`حضور مباحثات ${sub.subject_name}`,sub.stage_name);
    try{
      const rows=await api(`/api/teacher/attendance?subjectId=${n(sub.subject_id)}&seasonId=${n(sub.stage_season_id)}`);
      if(!rows.length){sheetBody.innerHTML=empty('لا يوجد طلبة في نمط المباحثات لهذه المادة.');return;}
      const total=Math.max(0,...rows.map(r=>n(r.eligible_sessions)));
      const completed=rows.filter(r=>n(r.attended_sessions)>=n(r.eligible_sessions)&&n(r.eligible_sessions)>0).length;
      sheetBody.innerHTML=`
        <div class="detail-grid"><div class="detail-box"><span>أعلى عدد جلسات مؤهلة</span><strong>${total}</strong></div><div class="detail-box"><span>حضور كامل</span><strong>${completed}/${rows.length}</strong></div></div>
        <p class="form-hint">يُحتسب حضور المباحثة كاملًا فقط عند تسجيل حضور البداية وحضور النهاية للجلسة نفسها.</p>
        <div>${rows.map(r=>{const eligible=n(r.eligible_sessions),a=n(r.attended_sessions),incomplete=n(r.incomplete_sessions),ratio=eligible?Math.round(a/eligible*100):0,cls=ratio>=90?'good':ratio>=70?'warn':'bad';return `<div class="attendance-row"><div><h4>${esc(r.full_name)}</h4><small>${ratio}% من جلساته المؤهلة${incomplete?` · ${incomplete} حضور بداية بلا نهاية`:''}</small></div><span class="attendance-ratio ${cls}">${a}/${eligible}</span></div>`;}).join('')}</div>`;
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
      const used=new Set(rows.map(e=>n(e.exam_number)));
      const available=[1,2,3].filter(x=>!used.has(x));
      sheetBody.innerHTML=`
        ${available.length?'<button id="createExamBtn" class="primary-button wide-button" type="button">➕ إنشاء امتحان جديد</button>':''}
        <div class="exam-list">${rows.length?rows.map(e=>`
          <article class="list-card exam-card">
            <div class="list-card-head"><div><h4>${esc(e.title||`الامتحان الشهري ${e.exam_number}`)}</h4><p>الأسئلة: ${n(e.question_count)} · التسليمات: ${n(e.submitted_count)}<br>يفتح: ${esc(dateTime(e.opens_at))}</p></div><span class="badge ${e.status==='published'?'live':''}">${e.status==='published'?'منشور':'مجدول'}</span></div>
            <div class="card-actions"><button class="mini-button" type="button" data-manage-exam="${n(e.id)}">${e.status==='published'?'عرض الامتحان':'إدارة الامتحان'}</button></div>
          </article>`).join(''):empty('لا توجد امتحانات لهذه المادة بعد.')}</div>`;
      $('#createExamBtn')?.addEventListener('click',()=>showExamCreateForm(sub,available));
      $$('[data-manage-exam]',sheetBody).forEach(b=>b.addEventListener('click',()=>openExamEditor(n(b.dataset.manageExam),sub)));
    }catch(err){sheetBody.innerHTML=empty(err.message);}
  }

  function showExamCreateForm(sub,available){
    sheetTitle.textContent=`إنشاء امتحان — ${sub.subject_name}`;
    sheetKicker.textContent=sub.stage_name;
    const choices=(available?.length?available:[1,2,3]).map(x=>`<option value="${x}">الامتحان الشهري ${x}</option>`).join('');
    sheetBody.innerHTML=`
      <form id="examCreateForm" class="form-stack">
        <label><span class="field-label">رقم الامتحان</span><select id="examNumber" class="select-control" required>${choices}</select></label>
        <label><span class="field-label">موضوع الامتحان</span><input id="examTitle" class="text-control" type="text" minlength="3" maxlength="150" placeholder="مثال: أحكام البيع" required></label>
        <label><span class="field-label">تاريخ الامتحان</span><input id="examDate" class="text-control" type="date" value="${todayIso()}" required></label>
        <label><span class="field-label">مدة الإتاحة بالساعات</span><input id="examHours" class="text-control" type="number" min="1" max="720" step="1" value="24" inputmode="numeric" required></label>
        <p class="form-hint">عند إنشاء الامتحان يصل إشعار لطلبة المادة يتضمن الموضوع والموعد. أضف الأسئلة فقط، وسيصبح الامتحان متاحًا تلقائيًا عند الموعد المحدد دون زر نشر.</p>
        <div class="form-actions"><button class="secondary-button" id="cancelExamCreate" type="button">رجوع</button><button class="primary-button" type="submit">إنشاء وجدولة الامتحان</button></div>
      </form>`;
    $('#cancelExamCreate').addEventListener('click',()=>openExams(sub));
    $('#examCreateForm').addEventListener('submit',async e=>{
      e.preventDefault();
      const examNumber=n($('#examNumber').value),dateIso=$('#examDate').value,hours=n($('#examHours').value),title=$('#examTitle').value.trim();
      const submit=e.submitter;submit.disabled=true;submit.textContent='جاري الإنشاء…';
      try{
        const exam=await api('/api/teacher/exams',{method:'POST',body:JSON.stringify({subjectId:n(sub.subject_id),seasonId:n(sub.stage_season_id),examNumber,title,dateIso,hours})});
        notify('تم إنشاء الامتحان وإشعار الطلبة. سيُفتح تلقائيًا في موعده.');await openExamEditor(n(exam.id),sub);
      }catch(err){notify(err.message);submit.disabled=false;submit.textContent='إنشاء وجدولة الامتحان';}
    });
  }

  async function openExamEditor(examId,sub){
    sheetTitle.textContent=`إدارة امتحان ${sub.subject_name}`;sheetKicker.textContent=sub.stage_name;sheetBody.innerHTML=empty('جاري تحميل الامتحان…');
    try{
      const data=await api(`/api/teacher/exams/${examId}`),e=data.exam,questions=data.questions||[],draft=e.status!=='published';
      sheetBody.innerHTML=`
        <div class="detail-grid"><div class="detail-box"><span>الحالة</span><strong>${draft?'مجدول تلقائيًا':'منشور'}</strong></div><div class="detail-box"><span>عدد الأسئلة</span><strong>${questions.length}</strong></div></div>
        <article class="list-card exam-summary"><div class="list-card-head"><div><h4>${esc(e.title||`الامتحان الشهري ${e.exam_number}`)}</h4><p>يفتح: ${esc(dateTime(e.opens_at))}<br>يغلق: ${esc(dateTime(e.closes_at))} · الدرجة: ${esc(e.max_score)}</p></div><span class="badge ${draft?'':'live'}">${draft?'مجدول':'منشور'}</span></div></article>
        ${draft?`<p class="form-hint">تم إشعار الطلبة بالامتحان. أكمل إضافة الأسئلة قبل الموعد، وسيُنشر تلقائيًا عند حلول وقت الفتح.</p><div class="exam-editor-actions"><button class="mini-button" id="addTfQuestion" type="button">➕ صح / خطأ</button><button class="mini-button" id="addMcqQuestion" type="button">➕ اختيار متعدد</button></div>`:''}
        <div class="section-head compact-head"><div><span class="section-kicker">الأسئلة</span><h3>${questions.length} سؤال</h3></div></div>
        <div class="question-list">${questions.length?questions.map((q,i)=>`<article class="question-card"><span class="question-number">${i+1}</span><div><h4>${esc(q.prompt)}</h4><p>${q.question_type==='tf'?'صح / خطأ':(Array.isArray(q.options)?q.options:[]).map(esc).join(' · ')}</p><small>الإجابة الصحيحة: ${esc(q.correct_answer)}</small></div></article>`).join(''):empty('لم تُضف أسئلة بعد.')}</div>
        <button id="backToExamList" class="secondary-button wide-button" type="button">رجوع إلى قائمة الامتحانات</button>`;
      $('#backToExamList').addEventListener('click',()=>openExams(sub));
      if(draft){
        $('#addTfQuestion').addEventListener('click',()=>showTfQuestionForm(examId,sub));
        $('#addMcqQuestion').addEventListener('click',()=>showMcqQuestionForm(examId,sub));
      }
    }catch(err){sheetBody.innerHTML=empty(err.message);}
  }

  function showTfQuestionForm(examId,sub){
    sheetTitle.textContent='إضافة سؤال صح / خطأ';sheetKicker.textContent=sub.subject_name;
    sheetBody.innerHTML=`<form id="questionForm" class="form-stack"><label><span class="field-label">نص السؤال</span><textarea id="questionPrompt" class="text-area" rows="5" maxlength="3000" required></textarea></label><label><span class="field-label">الإجابة الصحيحة</span><select id="tfCorrect" class="select-control"><option value="صح">صح</option><option value="خطأ">خطأ</option></select></label><div class="form-actions"><button id="cancelQuestion" class="secondary-button" type="button">رجوع</button><button class="primary-button" type="submit">إضافة السؤال</button></div></form>`;
    $('#cancelQuestion').addEventListener('click',()=>openExamEditor(examId,sub));
    $('#questionForm').addEventListener('submit',async e=>{
      e.preventDefault();const submit=e.submitter;submit.disabled=true;submit.textContent='جاري الإضافة…';
      try{await api(`/api/teacher/exams/${examId}/questions`,{method:'POST',body:JSON.stringify({type:'tf',prompt:$('#questionPrompt').value.trim(),correct:$('#tfCorrect').value})});notify('تمت إضافة السؤال.');await openExamEditor(examId,sub);}
      catch(err){notify(err.message);submit.disabled=false;submit.textContent='إضافة السؤال';}
    });
  }

  function showMcqQuestionForm(examId,sub){
    sheetTitle.textContent='إضافة سؤال اختيار متعدد';sheetKicker.textContent=sub.subject_name;
    sheetBody.innerHTML=`<form id="questionForm" class="form-stack"><label><span class="field-label">نص السؤال</span><textarea id="questionPrompt" class="text-area" rows="4" maxlength="3000" required></textarea></label><label><span class="field-label">الخيارات — كل خيار في سطر مستقل (2 إلى 6)</span><textarea id="questionOptions" class="text-area" rows="6" maxlength="1800" placeholder="الخيار الأول
الخيار الثاني
الخيار الثالث" required></textarea></label><label><span class="field-label">الإجابة الصحيحة</span><select id="mcqCorrect" class="select-control"><option value="">أدخل الخيارات أولًا</option></select></label><div class="form-actions"><button id="cancelQuestion" class="secondary-button" type="button">رجوع</button><button class="primary-button" type="submit">إضافة السؤال</button></div></form>`;
    const optionsEl=$('#questionOptions'),correctEl=$('#mcqCorrect');
    const syncOptions=()=>{const opts=optionsEl.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).slice(0,6);const old=correctEl.value;correctEl.innerHTML=opts.length?opts.map(o=>`<option value="${esc(o)}">${esc(o)}</option>`).join(''):'<option value="">أدخل الخيارات أولًا</option>';if(opts.includes(old))correctEl.value=old;};
    optionsEl.addEventListener('input',syncOptions);$('#cancelQuestion').addEventListener('click',()=>openExamEditor(examId,sub));
    $('#questionForm').addEventListener('submit',async e=>{
      e.preventDefault();const options=optionsEl.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(options.length<2||options.length>6||new Set(options).size!==options.length){notify('أدخل من خيارين إلى 6 خيارات مختلفة.');return;}const correct=correctEl.value;if(!options.includes(correct)){notify('اختر الإجابة الصحيحة.');return;}
      const submit=e.submitter;submit.disabled=true;submit.textContent='جاري الإضافة…';
      try{await api(`/api/teacher/exams/${examId}/questions`,{method:'POST',body:JSON.stringify({type:'mcq',prompt:$('#questionPrompt').value.trim(),options,correct})});notify('تمت إضافة السؤال.');await openExamEditor(examId,sub);}
      catch(err){notify(err.message);submit.disabled=false;submit.textContent='إضافة السؤال';}
    });
  }

  async function loadReportStudents(){
    const select=$('#reportSubject');const root=$('#reportStudents');
    if(!select.value){root.innerHTML=empty('اختر مادة لعرض طلبة التقارير.');return;}
    const [subjectId,seasonId]=select.value.split(':').map(Number);root.innerHTML=empty('جاري تحميل الطلبة…');
    try{
      const rows=await api(`/api/teacher/reports/students?subjectId=${subjectId}&seasonId=${seasonId}&onlyUngraded=0`);
      root.innerHTML=rows.length?rows.map(r=>`
        <article class="report-student-card ${n(r.pending_report_count)>0?'pending':''}" data-report-student="${n(r.student_id)}" data-subject="${subjectId}" data-season="${seasonId}" data-group="${r.group_id? n(r.group_id):''}">
          <div><h4>${esc(r.full_name)}</h4><p>${esc(r.group_title||'المرحلة كاملة')} · ${r.report_score==null?'الدرجة النهائية غير معتمدة':`الدرجة ${esc(r.report_score)}`}</p></div>
          <div class="report-count"><strong>${n(r.report_count)} تقرير</strong>${n(r.pending_report_count)>0?`<span class="report-pending">${n(r.pending_report_count)} ينتظر التقييم</span>`:'<span class="report-done">مقيّمة</span>'}</div>
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
        <article class="report-item ${r.score==null?'pending':'graded'}" data-report-id="${n(r.id)}">
          <h4>تقرير ${esc(r.group_title_snapshot||'الطالب')} ${r.score==null?'<span class="report-pending">بانتظار التقييم</span>':'<span class="report-done">تم التقييم</span>'}</h4>
          <p>${r.note?esc(r.note):r.file_kind?`تقرير محفوظ كـ ${esc(r.file_kind)} في البوت.`:'تقرير محفوظ في النظام.'}<br>تاريخ الإرسال: ${esc(dateTime(r.submitted_at))}</p>
          <div class="score-row"><label><span class="field-label">الدرجة من 15</span><input class="score-input" type="number" min="0" max="15" step="0.25" value="${r.score==null?'':esc(r.score)}" inputmode="decimal"></label><button class="primary-button score-save" type="button">حفظ التقييم</button></div>
        </article>`).join('');
      $$('.report-item',sheetBody).forEach(item=>$('.score-save',item).addEventListener('click',async()=>{
        const input=$('.score-input',item);const score=Number(input.value);if(!Number.isFinite(score)||score<0||score>15){notify('الدرجة يجب أن تكون بين 0 و15.');return;}
        const btn=$('.score-save',item);btn.disabled=true;btn.textContent='جاري الحفظ…';
        try{
          await api(`/api/teacher/reports/${n(item.dataset.reportId)}/score`,{method:'POST',body:JSON.stringify({score})});
          item.classList.remove('pending');item.classList.add('graded');
          const status=item.querySelector('.report-pending');if(status){status.className='report-done';status.textContent='تم التقييم';}
          btn.textContent='تم الحفظ';notify('حُفظ تقييم التقرير.');
          await refresh();await loadReportStudents();
        }
        catch(err){btn.textContent='حفظ التقييم';notify(err.message);}finally{btn.disabled=false;}
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
