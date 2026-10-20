'use strict';
const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=value=>value?new Date(value).toLocaleDateString('ar-IQ',{timeZone:'Asia/Baghdad'}):'—';
const stamp=value=>value?new Date(value).toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad'}):'—';
const baghdadIso=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?'':new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);};
const labels={pending:'بانتظار القرار',approved:'معتمدة',rejected:'مرفوضة',ended:'منتهية',cancelled:'ملغاة',sent:'أُرسلت',sending:'قيد الإرسال',failed:'تعذّر إرسالها',expired:'انتهت المهلة',draft:'مسودة',published:'منشور'};
const actionLabels={cancel_leave:'إلغاء إجازة وتصحيح الرصيد والغياب',reduce_leave:'تقليل أيام الإجازة',change_participation_mode:'تغيير متابعة مادة للطالب',participation_settings:'إعدادات المباحثات والتقارير',update_student:'تعديل طالب',move_stage:'نقل مرحلة',move_group:'نقل مجموعة',leave_decision:'قرار إجازة',grade_report:'تقييم تقرير',end_session:'إنهاء مباحثة',create_stage:'إضافة مرحلة',create_subject:'إضافة مادة',create_group:'إضافة مجموعة',update_group:'تعديل مجموعة',assign_teacher:'إسناد أستاذ',unassign_teacher:'إلغاء إسناد أستاذ',create_slot:'إضافة موعد',remove_slot:'إيقاف موعد',create_exam:'إنشاء امتحان',set_lesson_schedule:'إضافة موعد نشر في جدول الدروس',remove_lesson_schedule:'إزالة موعد نشر من جدول الدروس',exam_question:'إضافة سؤال',exam_publish:'نشر امتحان',exam_postpone:'تغيير موعد امتحان',exam_cancel:'إلغاء امتحان وإشعار الطلبة',remove_question:'حذف سؤال',create_teacher:'إضافة أستاذ',update_teacher:'تعديل أستاذ',toggle_teacher:'تفعيل/إيقاف أستاذ',regenerate_code:'توليد كود ربط',reopen_lesson:'إعادة فتح درس',mark_all_present:'تحضير جميع الطلبة',cancel_lesson:'إلغاء تفعيل درس',unlink_channel:'فكّ ربط قناة',reopen_session:'إعادة فتح مباحثة','mark-all_session':'تحضير طلبة مباحثة',cancel_session:'حذف مباحثة'};
const entityLabels={student:'طالب',stage:'مرحلة',subject:'مادة',group:'مجموعة',leave:'إجازة',report:'تقرير',session:'مباحثة',slot:'موعد',exam:'امتحان',question:'سؤال',teacher:'أستاذ',assignment:'إسناد',lesson_schedule:'جدول الدروس',lesson:'درس',channel:'قناة'};
actionLabels['retry-notifications_session']='إعادة محاولة إشعار المباحثة';
actionLabels.selected_discussion_attendance='حضور إداري لطلبة محددين في المباحثة';
actionLabels.restore_pending_lesson='نشر درس محفوظ';
actionLabels.republish_lesson='إعادة نشر درس لمدة 24 ساعة';
actionLabels.repair_channel_publications='تصحيح ربط منشورات القناة وحفظ الحضور';
actionLabels.stage_correction_approved='الموافقة على تصحيح المرحلة';
actionLabels.stage_correction_rejected='رفض تصحيح المرحلة';
actionLabels.stage_correction_stale='إغلاق طلب تصحيح مرحلة تغيّرت بياناته';
const DAY_NAMES=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const DAY_ORDER=[6,0,1,2,3,4,5];
let token='',stages=[],teachers=[],seasons=[],currentSeasonId='',currentStage=null,currentStudent=null,currentExam=null,currentTeacher=null,matrixStageId=null,matrixDay=new Date().getDay(),matrixEligible=[],tab='students',page=0,view='home',sequence=0,dialogSequence=0,busy=false;
let lessonScheduleStageId=null,lessonScheduleData=null;
let adminSelection=null;
let participationDraft=null;
actionLabels.update_subject='تعديل اسم المادة';
Object.assign(actionLabels,{correct_lesson_subject:'تصحيح مادة الدرس',late_lesson_attendance:'حضور إداري متأخر',remove_lesson_attendance:'حذف حضور طالب من درس',reopen_student_exam:'فتح امتحان لطالب واحد'});
Object.assign(actionLabels,{contact_student_admin:'رسالة إدارية لطالب',contact_student_teacher:'رسالة أستاذ لطالب'});
Object.assign(actionLabels,{one_time_preliminary_22_group_1_to_2:'نقل 13 طالبًا من المجموعة 1 إلى 2'});
Object.assign(actionLabels,{one_time_schedule_import_2026_09_24:'إدخال جداول المباحثات دفعة واحدة',toggle_stage_registration_visibility:'حجب/إظهار مرحلة للتسجيل الجديد'});
let contactQuery='',contactPage=0,contactStudent=null;
const contactRequestKey=prefix=>prefix+':'+(globalThis.crypto?.randomUUID?.()||`${Date.now()}:${Math.random().toString(36).slice(2)}`);
const contactStatuses={pending:'بانتظار الإرسال',sending:'قيد الإرسال',sent:'أُرسلت',failed:'تعذّر الإرسال',expired:'انتهت المهلة',archived:'سجل إرسال مؤرشف'};
const lessonSource=value=>value==='channel_schedule_recovered'?'استرجاع منشور محفوظ؛ الترقيم بتاريخ نشره الأصلي':value==='schedule_fallback'?'فُعّل من الجدول لأن المنشور لم يُعرف؛ يرتبط تلقائيًا بأول منشور مطابق':value==='channel_schedule'?'تم تحديد المادة اعتمادًا على الجدول (دون هاشتاغ)':value==='channel_hashtag'?'تم تحديد المادة من رسالة هاشتاغ':value==='channel'?'تفعيل من القناة':value==='manual'?'تفعيل يدوي':'مصدر التحديد غير موثق';
let filters={q:'',status:'active',groupId:'',mode:''};
function notify(text,error=false){const n=$('#detail').open?$('#dialog-notice'):$('#notice');n.hidden=false;n.className=error?'error':'';n.textContent=text;}
function clearNotice(){$('#notice').hidden=true;$('#dialog-notice').hidden=true;}
function setNav(action){document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.action===action));}
// A rejected deadline releases the UI even if the embedded browser ignores abort.
async function api(route,body,method='GET',format='json'){
  const controller=new AbortController();let timeout;
  const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>{
    reject(Error(method==='GET'?'تأخر تحميل البيانات. يمكنك المحاولة مجددًا؛ لا يلغي ذلك أي حفظ سابق.':'تأخر رد الخادم. تحقق من نتيجة العملية قبل إعادة الحفظ.'));
    controller.abort();
  },20000);});
  try{
    return await Promise.race([deadline,(async()=>{
      const response=await fetch('/api/admin'+route,{method,signal:controller.signal,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
      if(!response.ok){let data;try{data=await response.json();}catch{}throw Error(data?.error||'تعذر الاتصال. حاول مرة أخرى.');}
      return format==='blob'?await response.blob():await response.json();
    })()]);
  }catch(error){
    if(error instanceof TypeError)throw Error('تعذر الاتصال بالخادم. تحقق من الشبكة ثم حاول مجددًا.');
    throw error;
  }finally{clearTimeout(timeout);}
}
let confirmationPending=false,dismissedWhileBusy=false,confirmSerial=0,cancelConfirm=null;
// If Telegram never calls back (popup swallowed, app backgrounded), the panel used to stay locked
// until it was reopened. Any later tap abandons the stale confirmation instead of being ignored.
function abandonConfirm(){
  if(!confirmationPending)return;
  confirmSerial++;confirmationPending=false;
  const cancel=cancelConfirm;cancelConfirm=null;cancel?.();
}
async function confirmAction(message){
  if(confirmationPending)return false;
  confirmationPending=true;const serial=++confirmSerial;
  const focused=document.activeElement;
  focused?.blur?.();
  try{
    const tg=window.Telegram?.WebApp;
    // Use Telegram's asynchronous popup rather than blocking its WebView with confirm().
    if(typeof tg?.showConfirm==='function'&&message.length<=256){
      try{return await new Promise((resolve,reject)=>{
        cancelConfirm=()=>resolve(false);
        try{tg.showConfirm(message,accepted=>resolve(Boolean(accepted)));}catch(e){reject(e);}
      });}catch{}
    }
    // Long messages and older clients keep the entire confirmation inside the page.
    return await new Promise(resolve=>{
      const host=$('#detail').open?$('#dialog-body'):$('#content');
      const panel=document.createElement('section');panel.className='detail-section';
      panel.setAttribute('role','alertdialog');panel.setAttribute('aria-label','تأكيد العملية');
      panel.innerHTML=`<p>${esc(message)}</p><div class="form-actions"><button type="button" class="primary" data-confirm-choice="yes">تأكيد</button><button type="button" data-confirm-choice="no">إلغاء</button></div>`;
      const finish=accepted=>{panel.remove();document.removeEventListener('keydown',onKey,true);resolve(accepted);};
      const onKey=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();finish(false);}};
      panel.addEventListener('click',event=>{const choice=event.target.closest('[data-confirm-choice]');if(choice){event.stopPropagation();finish(choice.dataset.confirmChoice==='yes');}});
      cancelConfirm=()=>finish(false);
      document.addEventListener('keydown',onKey,true);host.prepend(panel);
      panel.scrollIntoView?.({block:'nearest'});panel.querySelector('[data-confirm-choice="no"]').focus();
    });
  }finally{if(serial===confirmSerial){confirmationPending=false;cancelConfirm=null;}if(focused?.isConnected)focused.focus?.({preventScroll:true});}
}
function closeDetail(){
  dialogSequence++;
  if($('#detail').contains(document.activeElement))document.activeElement.blur();
  $('#detail').close();
}
const empty=(title,text='')=>`<div class="empty"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`;
const button=(title,action,extra='',className='')=>`<button type="button" class="${className}" data-action="${action}" ${extra}>${esc(title)}</button>`;
const table=(headers,rows)=>rows.length?`<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:empty('لا توجد سجلات مطابقة','يمكن تغيير المرشّحات أو العودة إلى المرحلة.');
const pager=(total,size=25)=>`<div class="pagination"><span>${esc(total)} سجلًا · الصفحة ${page+1}</span><div>${page>0?button('السابق','prev'):''} ${((page+1)*size<total)?button('التالي','next'):''}</div></div>`;
function head(title,subtitle='',actions=''){return `<div class="page-head"><div><h1>${esc(title)}</h1><p class="subtle">${esc(subtitle)}</p></div><div>${actions}</div></div>`;}
function setContent(html){$('#content').innerHTML=html;$('#content').setAttribute('aria-busy','false');}
function cohortLabel(groups){const numbers=[...new Set(groups.map(g=>Number(g.group_number)).filter(Boolean))];return numbers.length===1?'المجموعة '+numbers[0]:numbers.length>1?'يحتاج توحيد الأرقام':'لم يُحدّد بعد';}
function modeTag(mode){return mode==='mubahatha'?'<span class="tag info">مباحثة</span>':mode==='report'?'<span class="tag warn">تقارير</span>':'<span class="tag">بلا اختيار</span>';}
function groupOptions(groups,selected='',all='جميع المجموعات'){return `<option value="">${all}</option>`+groups.map(g=>`<option value="${g.id}" ${String(g.id)===String(selected)?'selected':''}>${esc(g.subject_name||'')} · ${esc(g.title)}</option>`).join('');}
function stageHeader(){const s=currentStage;return head(s.name,`الموسم: ${s.season_name||'لا يوجد موسم نشط'}${s.is_historical?' — أرشيف':''}`,button('كل المراحل','home'))+
  (s.is_historical?`<div class="empty" style="border-color:#e2b8b8;background:var(--danger-soft);color:var(--danger);text-align:right;padding:.9rem 1.2rem;margin-bottom:1.2rem"><p style="margin:0">تعرض بيانات موسم أرشيفي؛ لا يمكن التعديل عليه من هنا.</p></div>`:'')+
  `<div class="summary"><div><b>${s.student_count}</b>طالب</div><div><b>${s.subject_count}</b>مادة</div><div><b>${s.discussion_grouping===false?'—':s.group_count}</b>${s.discussion_grouping===false?'مباحثات دون تقسيم':'مجموعة مباحثة'}</div></div>`+
  `<div class="tabs" role="navigation" aria-label="أقسام المرحلة">${Object.entries({students:'الطلبة',attendance:'حضور الدروس',subjects:'المواد والمجموعات',leaves:'الإجازات',...(s.stage_type!=='lessons_only'?{reports:'التقارير',schedule:'المباحثات',exams:'الامتحانات'}:{}),exports:'التصدير'}).map(([key,name])=>button(name,'tab',`data-tab="${key}"`,tab===key?'active':'')).join('')}</div>`;}
async function home(){view='home';currentStage=null;page=0;setNav('home');const id=++sequence;stages=await api('/stages'+(currentSeasonId?'?seasonId='+currentSeasonId:''));if(id!==sequence)return;
  $('#breadcrumb').textContent='المعهد / المراحل والطلبة';
  const historical=Boolean(currentSeasonId);
  setContent((historical?`<div class="empty" style="border-color:#e2b8b8;background:var(--danger-soft);color:var(--danger);text-align:right;padding:1rem 1.3rem;margin-bottom:1.2rem"><p style="margin:0">تعرض بيانات موسم سابق للاطلاع فقط؛ أزرار الإضافة والتعديل مخفية.</p></div>`:'')+
    head('المراحل الدراسية','كل ما تحتاجه لمتابعة طلبة المعهد، في مكان واحد.',historical?'':button('إضافة مرحلة','new-stage','','primary'))+
    `<section class="overview-grid" aria-label="ملخص المراحل المعروضة">
      <div class="overview-card overview-primary"><span class="overview-icon" aria-hidden="true"><svg><use href="#i-students"></use></svg></span><p>الطلبة في المراحل المعروضة</p><b class="overview-number">${stages.reduce((n,s)=>n+Number(s.student_count||0),0)}</b><small>متابعة الحضور والتقارير من ملف كل مرحلة</small></div>
      <div class="overview-card overview-pink"><span class="overview-icon" aria-hidden="true"><svg><use href="#i-stages"></use></svg></span><p>المراحل المعروضة</p><b class="overview-number">${stages.length}</b><small>اختر المرحلة لعرض تفاصيلها وإدارتها</small></div>
      <div class="overview-card overview-sage"><span class="overview-icon" aria-hidden="true"><svg><use href="#i-book"></use></svg></span><p>المواد الدراسية</p><b class="overview-number">${stages.reduce((n,s)=>n+Number(s.subject_count||0),0)}</b><small>الدروس والمباحثات والتقارير حسب المادة</small></div>
    </section><div class="section-heading stage-list-heading"><h2>مراحل المعهد</h2><span class="subtle">اختر مرحلة للاطلاع على طلبتها</span></div>`+
    (stages.length?`<div class="cards">${stages.map(s=>`<div class="stage-card-shell ${s.registration_visible===false?'registration-hidden':''}"><button class="stage-card" data-action="stage" data-id="${s.id}"><div><h2>${esc(s.name)}</h2><small>${esc(s.season_name||'لا يوجد موسم نشط')}</small></div><div class="stats"><div><span class="metric">${s.student_count}</span><small>طالب</small></div><div><span class="metric">${s.subject_count}</span><small>مادة</small></div><div><span class="metric">${s.discussion_grouping===false?'—':s.group_count}</span><small>${s.discussion_grouping===false?'دون تقسيم':'مجموعة مباحثة'}</small></div></div><div class="card-footer"><span>${s.is_active?'مرحلة نشطة':'مرحلة مؤرشفة'}</span><span>${s.registration_visible===false?'🚫 محجوبة عن الطلبة الجدد':'👁️ ظاهرة للطلبة الجدد'}</span><span>عرض التفاصيل ←</span></div></button>${!historical&&s.is_active?button(s.registration_visible===false?'👁️ إظهار للطلبة الجدد':'🚫 حجب عن الطلبة الجدد','stage-registration-toggle',`data-id="${s.id}" data-name="${esc(s.name)}" data-visible="${s.registration_visible!==false}"`,s.registration_visible===false?'':'danger'):''}</div>`).join('')}</div>`:empty('لا توجد بيانات لهذا الموسم','اختر موسمًا آخر أو أضف المرحلة الأولى.')));
}
let studentSearch={q:'',status:'all'};
// البحث عن أي طالب في أي مرحلة، ثم فتح ملفه (الدروس غير المسجّل حضورها وتسجيلها إداريًا).
async function loadStudentSearch(){
  view='student-search';setNav('student-search');currentStage=null;const n=++sequence;
  $('#breadcrumb').textContent='المعهد / البحث عن طالب';
  const q=studentSearch.q.trim();let body;
  if(q.length>=2){
    const data=await api('/students?'+new URLSearchParams({q,status:studentSearch.status,page}));
    if(n!==sequence)return;
    body=table(['الطالب','المرحلة','الحالة','الإجراء'],data.rows.map(st=>[esc(st.full_name)+(st.same_name_active_others?' <span class="tag">⚠️ اسم مكرر</span>':''),esc(st.stage_name),`<span class="tag ${st.is_active?'ok':''}">${st.is_active?'نشط':'مؤرشف'}</span>`,button('بياناته وحضوره','search-student',`data-id="${st.id}" data-stage="${st.stage_id}"`,'primary')]))+pager(data.total);
  }else body=empty('ابدأ بكتابة اسم الطالب','اكتب حرفين على الأقل من أي جزء من الاسم. يبحث في جميع مراحل المعهد، ولا تؤثر الهمزة والتاء المربوطة في النتيجة.');
  setContent(head('البحث عن طالب','ابحث في كل مراحل المعهد، وافتح ملف الطالب لترى الدروس التي لم يُسجَّل حضورها وتسجّلها له.')+
    `<form id="student-search-form" class="toolbar"><label>اسم الطالب<input name="q" value="${esc(studentSearch.q)}" placeholder="أي جزء من الاسم" maxlength="150" autocomplete="off"></label><label class="compact">الحالة<select name="status">${Object.entries({all:'الجميع',active:'نشطون',archived:'مؤرشفون'}).map(([v,t])=>`<option value="${v}" ${studentSearch.status===v?'selected':''}>${t}</option>`).join('')}</select></label><button class="primary" type="submit">بحث</button></form>`+body);
}
// الدروس التي ينقصها حضور الطالب بحسب تقريره نفسه، مع تسجيلها حضورًا إداريًا متأخرًا.
function missingLessonsSection(data,ro){
  if(ro||!data)return '';
  if(!data.season)return `<section class="detail-section"><h3>دروس لم يُسجَّل حضورها</h3><p class="subtle">لا يوجد للطالب تسجيل نشط في موسم حالي، فلا يمكن تسجيل حضور إداري له.</p></section>`;
  const closed=data.subjects.reduce((n,sub)=>n+sub.lessons.filter(l=>!l.is_open).length,0);
  const rows=sub=>table(['اختيار','الدرس','نُشر','الحالة'],sub.lessons.map(l=>[`<input type="checkbox" name="lesson" value="${l.id}" aria-label="اختيار الدرس ${l.lesson_number} من ${esc(sub.subject_name)}" ${l.is_open?'disabled':''}>`,`الدرس ${esc(l.lesson_number)} · #${l.id}`,stamp(l.activated_at),l.is_open?`مفتوح حتى ${stamp(l.active_until)} — يسجّل الطالب حضوره بنفسه`:'انتهت مهلته']));
  return `<section class="detail-section" id="missing-lessons"><h3>دروس لم يُسجَّل حضورها (${data.totalMissing})</h3>`+
    `<p class="subtle">هذه الدروس هي نقص الطالب في تقرير الحضور الذي يراه (${esc(data.season.season_name)}). حدّد ما تريد تسجيله له كحضور إداري متأخر؛ يُحفظ بوقت التأشير الفعلي واسم المسؤول، ويتغير تقريره وحساب غيابه فورًا.</p>`+
    (data.totalMissing?`<form id="student-late-form" data-student="${data.student.id}" data-name="${esc(data.student.full_name)}">${data.subjects.map(sub=>`<h4>${esc(sub.subject_name)} <span class="subtle">(${sub.lessons.length})</span></h4>${rows(sub)}`).join('')}`+
      `<label>ملاحظة (اختياري)<textarea name="note" maxlength="500" placeholder="مثال: استمع إلى الدرس خارج المهلة"></textarea></label><div class="form-actions">${closed?button('تحديد كل الدروس المنتهية','select-all-missing'):''}<button class="primary" type="submit" ${closed?'':'disabled'}>تسجيل الحضور للدروس المحددة</button></div></form>`:`<p>🎉 لا توجد دروس ناقصة؛ حضر الطالب كل دروس تقريره.</p>`)+
    (data.notCounted?`<p class="subtle">${esc(data.notCounted)} درسًا منشورًا لا يُحتسب عليه لأنه نُشر وانتهى قبل التحاقه أو بعد نقله، فلا يظهر هنا.</p>`:'')+`</section>`;
}
let attendanceStageId='',attendanceFilters={q:'',status:'all'};
async function attendanceHome(){
  view='lesson-attendance';setNav('lesson-attendance');const n=++sequence;
  const available=await api('/stages'+(currentSeasonId?'?seasonId='+currentSeasonId:''));
  if(n!==sequence)return;
  if(!available.some(s=>String(s.id)===String(attendanceStageId)))attendanceStageId='';
  $('#breadcrumb').textContent='المعهد / حضور الدروس';
  const selector=`<form id="attendance-stage" class="toolbar"><label>المرحلة الدراسية<select name="stageId"><option value="">اختر المرحلة</option>${available.filter(s=>s.stage_season_id).map(s=>`<option value="${s.id}" ${String(s.id)===String(attendanceStageId)?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label></form>`;
  const body=attendanceStageId?await attendanceContent(attendanceStageId):empty('اختر مرحلة لعرض حضور الدروس','جميع طلبة المرحلة في جدول واحد، مهما اختلفت مجموعات المباحثات.');
  if(n===sequence)setContent(head('حضور الدروس','حضور الدروس المفتوحة والمنتهية في الموسم المختار.')+selector+body);
}
async function attendanceContent(stageId){
  const data=await api('/lesson-attendance?'+new URLSearchParams({stageId,page,...attendanceFilters,...(currentSeasonId?{seasonId:currentSeasonId}:{})}));
  return `<p class="subtle">${esc(data.season.season_name)} · الإحصاء حتى ${stamp(data.season.as_of)}</p><p>العدد بصيغة <bdi dir="ltr">40 / 42</bdi> يعني حضور 40 من أصل 42 درسًا منشورًا، بما فيها الدروس المفتوحة والحضور الذي سجله المدير. تسجيلات المباحثات مستقلة عن هذه الأعداد. إجمالي الدروس المنشورة موحّد للمرحلة؛ الفرق ليس حكمًا بالغياب، فقد يشمل إجازة أو دروسًا قبل التحاق الطالب.</p>`+
    button('⬇ تنزيل البيانات MD','attendance-export',`data-stage="${stageId}"`,'primary')+
    `<form id="attendance-filter" class="toolbar"><label>الاسم الرباعي<input name="q" maxlength="150" value="${esc(attendanceFilters.q)}" placeholder="بحث بالاسم"></label><label>الطلبة<select name="status">${Object.entries({all:'جميع المسجلين في الموسم',active:'التسجيلات النشطة',archived:'التسجيلات المنتهية والمؤرشفة'}).map(([v,t])=>`<option value="${v}" ${attendanceFilters.status===v?'selected':''}>${t}</option>`).join('')}</select></label><button type="submit">عرض</button></form>`+
    (data.subjects.length?table(['تسلسل','الاسم الرباعي للطالب',...data.subjects.map(sub=>sub.name),'إجمالي الحضور'],data.rows.map(st=>[esc(st.sequence),esc(st.full_name),...st.attendance.map(a=>`<bdi class="attendance-ratio" dir="ltr" title="حضر ${Number(a.attended)} من أصل ${Number(a.total)}">${Number(a.attended)} / ${Number(a.total)}</bdi>`),`<bdi dir="ltr">${st.attendance.reduce((n,a)=>n+Number(a.attended),0)} / ${st.attendance.reduce((n,a)=>n+Number(a.total),0)}</bdi>`])):empty('لا توجد مواد لهذه المرحلة'))+pager(data.total,data.size);
}
function participationForm(s){
  return `<form id="participation-settings" class="detail-section settings-panel"><h2>تنظيم المباحثات والتقارير</h2>
    <p class="subtle">إعدادات الموسم: ${esc(s.season_name)}. حضور الدروس يشمل جميع المواد.</p>
    <p class="settings-status" id="participation-status" role="status">التنظيم المحفوظ: ${s.discussion_grouping!==false?'مجموعات مرقمة':'المرحلة كاملة'}. تغيير الخيارات لا يحفظها؛ راجع التغييرات ثم أكّد الحفظ.</p>
    <label>تنظيم المباحثات<select name="grouped"><option value="true" ${s.discussion_grouping!==false?'selected':''}>تقسيم الطلبة إلى مجموعات مرقمة</option><option value="false" ${s.discussion_grouping===false?'selected':''}>المرحلة كاملة — دون تقسيم</option></select></label>
    <fieldset><legend>المواد المشمولة بالمباحثات والتقارير</legend>${s.subjects.map(sub=>`<label class="study-choice">${esc(sub.name)}<select name="study-${sub.id}" data-study-id="${sub.id}"><option value="true" ${sub.participation_enabled!==false?'selected':''}>تشمل مباحثات وتقارير</option><option value="false" ${sub.participation_enabled===false?'selected':''}>بدون مباحثات وتقارير</option></select></label>`).join('')}</fieldset>
    <button class="primary" type="submit">مراجعة التغييرات قبل الحفظ</button></form>`;
}
function participationChanges(form){
  const s=currentStage,grouped=form.elements.grouped.value==='true';
  const enabledSubjectIds=[...form.querySelectorAll('[data-study-id]')].filter(el=>el.value==='true').map(el=>Number(el.dataset.studyId));
  const expectedSettings={grouped:s.discussion_grouping!==false,enabledSubjectIds:s.subjects.filter(sub=>sub.participation_enabled!==false).map(sub=>sub.id)};
  const rows=[];
  if(grouped!==expectedSettings.grouped)rows.push(['تنظيم المباحثات',expectedSettings.grouped?'مجموعات مرقمة':'المرحلة كاملة',grouped?'مجموعات مرقمة':'المرحلة كاملة']);
  for(const sub of s.subjects){const enabled=enabledSubjectIds.includes(sub.id),before=sub.participation_enabled!==false;if(enabled!==before)rows.push([sub.name,before?'تشمل مباحثات وتقارير':'بدون مباحثات وتقارير',enabled?'تشمل مباحثات وتقارير':'بدون مباحثات وتقارير']);}
  return {seasonId:s.stage_season_id,stageName:s.name,seasonName:s.season_name,grouped,enabledSubjectIds,expectedSettings,rows};
}
async function reviewParticipation(form){
  const draft=participationChanges(form);
  if(!draft.rows.length){notify('لم تتغير الإعدادات المحفوظة.');return;}
  participationDraft=draft;
  const groupingChanged=draft.grouped!==draft.expectedSettings.grouped;
  const subjectChanged=draft.rows.length>(groupingChanged?1:0);
  const effects=[];let blocked=null;
  if(groupingChanged){
    // أرقام الأثر الفعلية من الخادم (قراءة فقط؛ لا يتغير شيء قبل التأكيد).
    const impact=await api('/stage-seasons/'+draft.seasonId+'/grouping-impact?grouped='+draft.grouped);
    const num=n=>String(Number(n)||0);
    blocked=impact.blocked||null;
    if(draft.grouped){
      effects.push(`تُحذف أرقام المجموعات المحفوظة للطلبة في هذا الموسم (${num(impact.studentsWithNumbers)} سجلًا) ويُفعّل التقسيم على المجموعات الحالية.`,'لن يُعاد توزيع الطلبة إلى مجموعاتهم السابقة تلقائيًا، ويُرفض الحفظ إذا كانت السعات أو أرقام المجموعات غير متوافقة.');
    }else{
      effects.push(`تُدمج مجموعات كل مادة في مجموعة واحدة: ${num(impact.groupsToMerge)} مجموعة في ${num(impact.subjectsAffected)} مادة، وينتقل ${num(impact.membershipsToMove)} طالبًا إلى المجموعة المتبقية.`,`يتوقف ${num(impact.slotsToPause)} موعد مباحثة حتى تحدد موعدًا موحدًا لكل مادة مدمجة. يُستخدم رابط أول مجموعة نشطة.`,'تبقى سجلات الحضور والتقارير السابقة محفوظة، لكن لا يمكن استرجاع توزيع المجموعات القديم تلقائيًا.');
    }
  }
  if(subjectChanged)effects.push('المادة المستبعدة تختفي من خيارات المباحثات والتقارير، وتبقى سجلاتها السابقة محفوظة.');
  const apply=blocked
    ?`<p class="blocked-note" role="alert">لا يمكن الحفظ الآن: ${esc(blocked)}</p><div class="form-actions">${button('إغلاق','close-dialog')}</div>`
    :`<form id="apply-participation-settings"><label class="acknowledgement"><input type="checkbox" name="acknowledged" required>راجعت التغييرات وأفهم أثرها على الطلبة والمواعيد.</label>
    <div class="form-actions"><button class="primary" type="submit">تأكيد وحفظ التغييرات</button>${button('إلغاء دون حفظ','close-dialog')}</div></form>`;
  dialog('مراجعة إعدادات الموسم',`<p>${esc(draft.stageName)} · ${esc(draft.seasonName)}</p>${table(['الإعداد','المحفوظ حاليًا','بعد الحفظ'],draft.rows.map(row=>row.map(esc)))}
    <div class="settings-impact"><h3>أثر التغيير</h3><ul>${effects.map(t=>`<li>${esc(t)}</li>`).join('')}</ul><p>لا يُسمح بدمج المجموعات أو استبعاد مادة أثناء حضور مباحثة مفتوح.</p></div>${apply}`);
}
async function openStage(id){view='stage';tab='students';page=0;sessionSubjectId='';sessionPage=0;filters={q:'',status:'active',groupId:'',mode:''};const n=++sequence;const s=await api('/stages/'+id+(currentSeasonId?'?seasonId='+currentSeasonId:''));if(n!==sequence)return;currentStage=s;await renderStage();}
async function renderStage(){
  if(!currentStage)return;view='stage';const n=++sequence,s=currentStage,ro=Boolean(s.is_historical);$('#breadcrumb').textContent='المعهد / '+s.name;
  let body='';const query=new URLSearchParams({stageId:s.id,page,...filters});if(!filters.groupId)query.delete('groupId');if(!filters.mode)query.delete('mode');if(s.is_historical){query.set('seasonId',s.stage_season_id);query.set('status','all');}
  if(tab==='students'){
    const [data,oneTime]=await Promise.all([api('/students?'+query),!ro&&s.name==='المرحلة التمهيدية الدورة 22'?api('/one-time-cohort-move'):Promise.resolve(null)]);
    body=(oneTime?.available?`<section class="detail-section"><h2>تصحيح توزيع المجموعة 1</h2><p>المحجوزون حاليًا: ${esc(oneTime.sourceCount)}. اختر بنفسك 13 طالبًا تحققت من عدم انضمامهم إلى مجموعات تليجرام. قاعدة البيانات لا تسجل العضوية الفعلية في تليجرام.</p>${button('نقل 13 طالبًا إلى المجموعة 2 لمرة واحدة','one-time-cohort-move','','primary')}</section>`:'')+
    `<form id="search" class="toolbar"><label>اسم الطالب<input name="q" value="${esc(filters.q)}" placeholder="بحث داخل المرحلة" maxlength="150"></label><label class="compact">الحالة<select name="status">${Object.entries({active:'نشطون',archived:'مؤرشفون',all:'الجميع'}).map(([v,t])=>`<option value="${v}" ${filters.status===v?'selected':''}>${t}</option>`).join('')}</select></label><label class="compact">${s.discussion_grouping===false?'مباحثة المادة':'مجموعة المباحثة'}<select name="groupId">${groupOptions(s.groups,filters.groupId)}</select></label><label class="compact">وضع المشاركة<select name="mode">${[['','الكل'],['mubahatha','مباحثة'],['report','تقارير']].map(([v,t])=>`<option value="${v}" ${filters.mode===v?'selected':''}>${t}</option>`).join('')}</select></label><button class="primary" type="submit">عرض</button></form>`+
    table(['الطالب','تنظيم المباحثات','المواد ووضع المشاركة','الحالة','ملف الطالب'],data.rows.map(st=>[esc(st.full_name),s.discussion_grouping===false?'المرحلة كاملة':esc(cohortLabel(st.groups)),st.groups.map(g=>`<div>${esc(g.subject)}: ${esc(g.group)}${g.group_number?' · رقم '+esc(g.group_number):''} ${modeTag(g.mode)}</div>`).join('')||'<span class="subtle">لم يُوزّع بعد</span>',`<span class="tag ${st.is_active?'ok':''}">${st.is_active?'نشط':'مؤرشف'}</span>`,button(ro?'عرض':'عرض وتعديل','student',`data-id="${st.id}"`)]))+pager(data.total);
  }else if(tab==='attendance'){body=await attendanceContent(s.id);
  }else if(tab==='subjects'){
    body=(ro?'':`<div class="toolbar">${button('إضافة مادة','new-subject','','primary')}${s.stage_type!=='lessons_only'?(s.discussion_grouping!==false?button('إضافة مجموعة','new-group'):'')+button('إسناد أستاذ لمادة','new-assignment'):''}</div>`)+
      (!ro&&s.stage_type!=='lessons_only'?participationForm(s):'')+s.subjects.map(sub=>`<section class="detail-section subject-panel"><div class="section-heading"><h2>${esc(sub.name)}</h2>${ro?'':button('تعديل اسم المادة','edit-subject',`data-id="${sub.id}"`)}</div><p class="subtle">الأستاذ: ${esc(sub.teacher_name||'لم يُسنَد')} · الهاشتاغ: #${esc(sub.hashtag)}</p><p>${sub.participation_enabled===false?'غير مشمولة بالمباحثات والتقارير · سجلاتها السابقة محفوظة<br>':''}${modeTag('mubahatha')} ${sub.mubahatha_count} طالب · ${modeTag('report')} ${sub.report_count} طالب · ${modeTag(null)} ${sub.undecided_count} طالب</p>`+table([s.discussion_grouping===false?'مباحثة المادة':'المجموعة',s.discussion_grouping===false?'عدد الطلبة':'الأعضاء / المحجوز / السعة','رابط المجموعة','الحالة',...(ro?[]:['الإجراء'])],s.groups.filter(g=>g.subject_id===sub.id).map(g=>[esc(g.title),s.discussion_grouping===false?esc(g.member_count):`${esc(g.member_count)} / ${esc(g.reserved_count)} / ${esc(g.capacity)}`,g.invite_link&&/^https:\/\/t\.me\//.test(g.invite_link)?`<a href="${esc(g.invite_link)}" target="_blank" rel="noopener noreferrer">فتح المجموعة</a>`:'لم يُضف',g.is_active?'<span class="tag ok">نشطة</span>':'<span class="tag danger">معطّلة</span>',...(ro?[]:[button('تعديل','edit-group',`data-id="${g.id}"`)])]))+'</section>').join('');
    if(!s.subjects.length)body+=empty('لا توجد مواد في المرحلة');
  }else if(tab==='leaves')body=await leavesContent(s.id,ro);
  else if(tab==='reports'){
    const data=await api('/reports?'+new URLSearchParams({seasonId:s.stage_season_id,page,...(filters.groupId?{groupId:filters.groupId}:{})}));
    body=`<form id="report-filter" class="toolbar"><label>المجموعة<select name="groupId">${groupOptions(s.groups,filters.groupId)}</select></label><button>عرض</button></form>`+
      table(['الطالب والمادة','المجموعة وقت الإرسال','التاريخ','الدرجة / 15','المراجعة'],data.rows.map(r=>[`${esc(r.full_name)}<div class="subtle">${esc(r.subject_name)}</div>`,esc(r.group_title_snapshot||'قديم: بلا مجموعة موثقة'),stamp(r.submitted_at),r.score==null?'لم يُقيّم':esc(r.score),button(ro?'عرض':'عرض وتقييم','report',`data-id="${r.id}"`)]))+pager(data.total);
    if(n===sequence)window.currentReports=data.rows;
  }else if(tab==='schedule'){
    const [slots,management]=await Promise.all([api('/schedule?seasonId='+s.stage_season_id),sessionManagementContent(s,ro)]);
    body=(ro?'':`<div class="toolbar">${button('إضافة موعد مباحثة','new-slot','','primary')}</div>`)+`<h2>الجدول الأسبوعي</h2>`+table(['المادة','المجموعة والأستاذ','اليوم','الموعد',...(ro?[]:['الإجراء'])],slots.map(sl=>[esc(sl.subject_name),`${esc(sl.group_title)}<div class="subtle">${esc(sl.teacher_name)}</div>`,['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'][sl.day_of_week],`${sl.hour}:${String(sl.minute).padStart(2,'0')} · ساعة`,...(ro?[]:[button('إيقاف الموعد','remove-slot',`data-id="${sl.id}"`)])]))+
      management;
  }else if(tab==='exams'){
    const exams=await api('/exams?seasonId='+s.stage_season_id);
    body=(ro?'':`<div class="toolbar">${button('إنشاء امتحان','new-exam','','primary')}</div>`)+table(['المادة','الامتحان','الفتح','الإغلاق','الحالة','الأسئلة والنشر'],exams.map(ex=>[esc(ex.subject_name),esc(ex.title||'الشهري '+ex.exam_number),stamp(ex.opens_at),stamp(ex.closes_at),esc(labels[ex.status]),button('فتح الامتحان','exam',`data-id="${ex.id}"`)]));
  }else if(tab==='exports'){
    body=`<section class="empty"><h2>سجلات الحضور بصيغة MD</h2><p>صف مستقل لكل تسجيل حضور، مع عمود للتاريخ وآخر للوقت بتوقيت بغداد ووقت UTC. حضور البداية والنهاية سجلان منفصلان.</p><div class="toolbar"><label>الموسم<select id="export-season">${s.seasons.map(se=>`<option value="${se.id}">${esc(se.name||se.season_name||'الموسم')} ${se.is_active?'— الحالي':'— أرشيف'}</option>`).join('')}</select></label>${button('تنزيل حضور الدروس','export',`data-kind="lessons"`,'primary')}${s.stage_type!=='lessons_only'?button('تنزيل حضور المباحثات','export','data-kind="discussions"'):''}</div></section>`;
  }
  if(n===sequence)setContent(stageHeader()+body);
}
function leaveActions(l,ro=false,profileId=null){
  if(ro)return '—';
  const attrs=`data-id="${l.id}" data-days="${l.days}" data-status="${esc(l.status)}" data-profile="${profileId||''}"`;
  let html=l.status==='pending'?button(l.is_exception?'موافقة استثنائية':'موافقة','leave',`${attrs} data-approve="true" data-exception="${Boolean(l.is_exception)}"`)+button('رفض','leave',`${attrs} data-approve="false"`):'';
  if(['pending','approved','ended'].includes(l.status))html+=(Number(l.days)>1?button('تقليل الأيام','leave-reduce',attrs):'')+button('إلغاء الإجازة','leave-cancel-admin',attrs,'danger');
  return html;
}
async function leavesContent(stageId,ro=false){
  const data=await api('/leaves?'+new URLSearchParams({page,status:filters.leaveStatus||'pending',...(stageId?{stageId}:{})}));
  return `<form id="leave-filter" class="toolbar"><label>حالة الطلب<select name="leaveStatus">${['pending','approved','ended','rejected','cancelled','all'].map(v=>`<option value="${v}" ${v===(filters.leaveStatus||'pending')?'selected':''}>${labels[v]||'الجميع'}</option>`).join('')}</select></label><button>عرض</button></form>`+
    table(['الطالب / المرحلة','الفترة / نوع الطلب','الأيام','الحالة','الإجراء'],data.rows.map(l=>[`${esc(l.full_name)}<div class="subtle">${esc(l.stage_name)}</div>`,`${date(l.start_date)} — ${date(l.end_date)}<div class="subtle">${l.is_exception?'⚠️ استثناء طارئ من الضوابط':'إجازة اعتيادية'}</div>${l.reason?`<div class="report-note">السبب: ${esc(l.reason)}</div>`:''}`,esc(l.days),esc(labels[l.status]),leaveActions(l,ro)+button('رد برسالة','contact-student',`data-id="${l.student_id}" data-name="${esc(l.full_name)}" data-telegram="${esc(l.telegram_id||'')}" data-context-kind="leave" data-context-id="${l.id}"`)]))+pager(data.total);
}
async function allLeaves(){view='leaves';currentStage=null;setNav('all-leaves');$('#breadcrumb').textContent='المعهد / طلبات الإجازة';const n=++sequence;const html=await leavesContent(null);if(n===sequence)setContent(head('طلبات الإجازة','الرصيد الاعتيادي عشرة أيام للموسم. الاستثناءات الطارئة تتطلب موافقة استثنائية. يمكن تقليل الأيام أو إلغاء الإجازة مع تصحيح الرصيد والغياب.')+html);}
async function loadStudentContact(){
  view='student-contact';currentStage=null;setNav('student-contact');$('#breadcrumb').textContent='المعهد / التواصل مع طالب معين';
  const seq=++sequence,result=await api('/student-contact?'+new URLSearchParams({q:contactQuery,page:contactPage}));
  if(seq!==sequence)return;
  setContent(head('التواصل مع طالب معين','ابحث عن الاسم، ثم افتح حساب الطالب أو أرسل له رسالة خاصة عبر البوت.')+
    `<form id="contact-search" class="toolbar"><label>اسم الطالب<input name="q" value="${esc(contactQuery)}" maxlength="150" placeholder="الاسم أو جزء منه"></label><button class="primary">بحث</button></form>`+
    table(['الطالب','المرحلة','التواصل'],result.rows.map(st=>[esc(st.full_name),esc(st.stage_name),button('التواصل','contact-student',`data-id="${st.id}"`)]))+
    `<div class="pagination"><span>${result.total} طالب · الصفحة ${contactPage+1}</span><div>${contactPage>0?button('السابق','contact-prev'):''}${(contactPage+1)*20<result.total?button('التالي','contact-next'):''}</div></div>`);
}
async function openStudentContact(id,contextKind=null,contextId=null){
  const st=await api('/students/'+id),history=await api('/student-contact/'+id);
  contactStudent={id:Number(id),name:st.full_name,contextKind,contextId};
  const profile=st.telegram_id?`<a class="primary" href="tg://user?id=${encodeURIComponent(st.telegram_id)}">فتح حساب الطالب في تيليغرام</a>`:'<p class="subtle">لا يوجد حساب تيليغرام مربوط بهذا الطالب.</p>';
  dialog('التواصل مع '+st.full_name,`<p class="subtle">${esc(st.stage_name)}${contextKind==='leave'?' · رد على طلب الإجازة #'+esc(contextId):''}</p>${profile}
    <form id="contact-send" class="detail-section"><label>رسالتك للطالب<textarea name="message" rows="5" maxlength="3000" required></textarea></label><div class="form-actions"><button class="primary">إرسال عبر البوت</button></div></form>
    <section class="detail-section"><h3>آخر الرسائل</h3>${history.length?table(['التاريخ','الرسالة','حالة الإرسال'],history.map(m=>[stamp(m.created_at),esc(m.message_text),esc(contactStatuses[m.delivery_status]||m.delivery_status)])):empty('لا توجد رسائل سابقة')}</section>`);
}
async function loadTeachers(){view='teachers';currentStage=null;setNav('teachers');$('#breadcrumb').textContent='المعهد / الأساتذة';const n=++sequence;teachers=await api('/teachers');if(n!==sequence)return;
  setContent(head('الأساتذة','إدارة حسابات الأساتذة وربطها بتليجرام وإسنادها للمواد.',button('إضافة أستاذ','add-teacher','','primary'))+
    table(['الاسم','الهاتف','الربط بتليجرام','المواد النشطة','الحالة','الإجراءات'],teachers.map(t=>[esc(t.full_name),esc(t.phone||'—'),
      t.linked?'<span class="tag ok">مرتبط</span>':t.link_code?`<span class="tag warn">بانتظار الربط</span><div class="subtle">كود: <b>${esc(t.link_code)}</b></div>`:'<span class="tag warn">بانتظار الربط</span>',
      esc(t.active_subject_count),t.is_active?'<span class="tag ok">نشط</span>':'<span class="tag danger">موقوف</span>',
      button('تعديل الاسم','edit-teacher',`data-id="${t.id}"`)+button(t.is_active?'إيقاف':'تفعيل','toggle-teacher',`data-id="${t.id}" data-active="${!t.is_active}"`,t.is_active?'danger':'')+button('كود جديد','regenerate-code',`data-id="${t.id}"`)+button('المواد','teacher-subjects',`data-id="${t.id}"`)+button('الأداء','teacher-performance',`data-id="${t.id}"`)
    ]))+(teachers.length?'':empty('لا يوجد أساتذة بعد','ابدأ بإضافة الأستاذ الأول.')));
}
function statBar(segments,total,maxTotal){const w=v=>maxTotal?Math.round(v/maxTotal*100):0;let x=0;const rects=segments.map(seg=>{const width=w(seg.value);const r=width?`<rect x="${x}%" y="0" width="${width}%" height="100%" fill="${seg.color}"><title>${esc(seg.label)}: ${seg.value}</title></rect>`:'';x+=width;return r;}).join('');return `<svg viewBox="0 0 100 22" preserveAspectRatio="none" style="width:100%;height:22px;display:block;border-radius:4px;overflow:hidden;background:#eef1f4">${rects}</svg>`;}
async function loadStats(){view='stats';currentStage=null;setNav('stats');$('#breadcrumb').textContent='المعهد / الإحصائيات';const n=++sequence;
  const rows=await api('/stats/stage-breakdown');if(n!==sequence)return;
  const maxTotal=Math.max(1,...rows.map(r=>r.total));
  const legend=`<div class="toolbar" style="gap:1.4rem"><span><span class="matrix-check" style="background:#1f6f66;color:#fff;width:14px;height:14px;display:inline-block;border-radius:3px;vertical-align:middle"></span> مستمر</span><span><span style="background:#a5680f;width:14px;height:14px;display:inline-block;border-radius:3px;vertical-align:middle"></span> متلكئ</span><span><span style="background:#a52f2f;width:14px;height:14px;display:inline-block;border-radius:3px;vertical-align:middle"></span> تارك</span></div>`;
  const chart=rows.map(r=>`<div style="margin-bottom:.9rem"><div style="display:flex;justify-content:space-between;font-size:.85rem;margin-bottom:.25rem"><b>${esc(r.stage_name)}</b><span class="subtle">${r.total} طالب</span></div>${statBar([{label:'مستمر',value:r.continuing,color:'#1f6f66'},{label:'متلكئ',value:r.lagging,color:'#a5680f'},{label:'تارك',value:r.dropped,color:'#a52f2f'}],r.total,maxTotal)}</div>`).join('');
  const totals=rows.reduce((sum,r)=>({
    total:sum.total+Number(r.total||0),
    continuing:sum.continuing+Number(r.continuing||0),
    lagging:sum.lagging+Number(r.lagging||0),
    dropped:sum.dropped+Number(r.dropped||0),
  }),{total:0,continuing:0,lagging:0,dropped:0});
  const statRows=rows.map(r=>[esc(r.stage_name),esc(r.total),esc(r.continuing),esc(r.lagging),esc(r.dropped)]);
  statRows.push(['<strong>المجموع الكلي</strong>',`<strong>${esc(totals.total)}</strong>`,`<strong>${esc(totals.continuing)}</strong>`,`<strong>${esc(totals.lagging)}</strong>`,`<strong>${esc(totals.dropped)}</strong>`]);
  const table1=table(['المرحلة','الإجمالي','مستمر','متلكئ','تارك'],statRows);
  setContent(head('الإحصائيات','مقارنة استمرار الطلبة بين المراحل. «متلكؤ» يعني غيابًا متتاليًا 3 أيام فأكثر دون بلوغ حد التوقف؛ «تارك» يعني موسمًا 10 أيام غياب متتالية أو أرشفة صريحة.')+
    (rows.length?legend+`<div class="table-wrap" style="padding:1.2rem 1.3rem;margin-bottom:1.3rem">${chart}</div>`+table1:empty('لا توجد بيانات بعد')));
}
async function loadWatchlist(){view='watchlist';currentStage=null;setNav('watchlist');$('#breadcrumb').textContent='المعهد / التنبيهات والإنذارات';const n=++sequence;
  const rows=await api('/stats/watchlist');if(n!==sequence)return;
  setContent(head('التنبيهات والإنذارات','الطلبة النشطون الذين بلغ غيابهم المتتالي 3 أيام فأكثر، مرتّبون من الأكثر غيابًا.')+
    table(['الطالب','المرحلة','يوزر تيليجرام','أيام الغياب المتتالي','الدروس الفائتة لكل مادة'],rows.map(r=>[esc(r.full_name),esc(r.stage_name),r.telegram_username?'@'+esc(r.telegram_username):'<span class="subtle">لا يوجد يوزر</span>',`<span class="tag ${r.absence_streak>=10?'danger':'warn'}">${esc(r.absence_streak)} يوم</span>`,r.missed_subjects.length?r.missed_subjects.map(m=>`<div>${esc(m.subject_name)}: ${esc(m.missed)}/${esc(m.total_lessons)}</div>`).join(''):'<span class="subtle">لا يوجد دروس مسجَّلة</span>'])));
}
async function showTeacherPerformance(id){
  const t=teachers.find(x=>String(x.id)===String(id));if(!t)return;
  const n=++dialogSequence;const perf=await api('/teachers/'+id+'/performance');if(n!==dialogSequence)return;
  dialog('أداء '+t.full_name,
    `<div class="summary"><div><b>${perf.reportStats.graded_by_teacher}</b>تقرير دقّقه بنفسه</div><div><b>${perf.reportStats.ungraded}</b>تقرير بلا درجة</div><div><b>${perf.examStats.published}</b>امتحان أنجزه من ${perf.examStats.total}</div></div>`+
    `<section class="detail-section"><h3>سجل المباحثات (آخر ${perf.sessions.length})</h3>`+
    table(['المادة','المجموعة','التاريخ','هل عُقدت','حضروا كاملًا'],perf.sessions.map(s=>[esc(s.subject_name),esc(s.group_title),date(s.scheduled_date),s.held==null?'<span class="subtle">بلا قرار</span>':s.held?'<span class="tag ok">عُقدت</span>':'<span class="tag warn">أُجِّلت</span>',s.full_attendees==null?'<span class="subtle">—</span>':esc(s.full_attendees)]))+'</section>');
}
async function loadScheduleMatrix(){view='schedule-matrix';currentStage=null;setNav('schedule-matrix');$('#breadcrumb').textContent='المعهد / جداول المباحثات';const n=++sequence;
  if(!stages.length)stages=await api('/stages');if(n!==sequence)return;
  matrixEligible=stages.filter(s=>s.stage_type!=='lessons_only'&&s.stage_season_id);
  if(!matrixEligible.length){setContent(head('جداول المباحثات','مصفوفة المجموعات والساعات المعتمدة لكل يوم.')+empty('لا توجد مراحل مباحثات نشطة','أضف مرحلة موسمها نشط وليست من نوع الدروس فقط.'));return;}
  if(!matrixStageId||!matrixEligible.some(s=>String(s.id)===String(matrixStageId)))matrixStageId=matrixEligible[0].id;
  await renderScheduleMatrix();
}
let matrixDetail=null;
const scheduleFreeTable=items=>table(['الأستاذ','مواعيد مشغولة','الأوقات المتبقية من السبت إلى الأربعاء (7 و8 مساءً)'],items.map(t=>[
  esc(t.teacherName),esc(t.used),t.free.map(x=>`${DAY_NAMES[x.dayOfWeek]} ${x.hour===19?'7':'8'} مساءً`).join('، ')||'لا يوجد وقت متبقٍ'
]));
async function renderScheduleMatrix(){
  const n=++sequence;const [s,importState]=await Promise.all([api('/stages/'+matrixStageId),api('/schedule-batch-import')]);
  const slots=await api('/schedule?seasonId='+s.stage_season_id);if(n!==sequence)return;
  const dayTabs=DAY_NAMES.map((d,i)=>button(d,'matrix-day',`data-day="${i}"`,String(i)===String(matrixDay)?'active':'')).join('');
  const daySlots=slots.filter(sl=>Number(sl.day_of_week)===Number(matrixDay));
  const hours=Array.from({length:8},(_,i)=>i+16);matrixDetail=s;
  let body=(importState.completed?`<section class="detail-section"><h2>الأوقات المتبقية للأساتذة</h2><p>بحسب المواعيد النشطة الحالية، ضمن الأيام والساعات المحددة في الإكسل. تحقق من جدول المجموعة عند إضافة مادة جديدة.</p>${scheduleFreeTable(importState.teacherAvailability)}</section>`:
    importState.available?`<section class="detail-section"><h2>إدخال جدول الإكسل لمرة واحدة</h2><p>${esc(importState.sourceRows)} مادة في الإكسل، ${esc(importState.groups)} مجموعة، ${esc(importState.appointments)} موعدًا أسبوعيًا. يلزم إضافة ${esc(importState.assignmentsToAdd)} إسناد أستاذ كما ورد في الملف؛ تبقى الإسنادات السابقة محفوظة.</p>${button('إدخال جميع مواعيد المباحثات دفعة واحدة','schedule-batch-import','','primary')}</section>`:
      `<section class="detail-section"><h2>يلزم مراجعة جدول الإكسل قبل الإدخال</h2><p>${esc((importState.errors||[]).join(' '))}</p></section>`)+
    `<form id="matrix-stage" class="toolbar"><label>المرحلة<select name="stageId">${matrixEligible.map(e=>`<option value="${e.id}" ${String(e.id)===String(matrixStageId)?'selected':''}>${esc(e.name)}</option>`).join('')}</select></label></form>`+
    `<div class="tabs" role="navigation" aria-label="أيام الأسبوع">${dayTabs}</div>`;
  if(!s.groups.length)body+=empty('لا توجد مجموعات في هذه المرحلة');
  else body+=`<div class="matrix-wrap"><table class="matrix"><thead><tr><th scope="col">المجموعة</th>${hours.map(h=>`<th scope="col">${String(h).padStart(2,'0')}:00</th>`).join('')}</tr></thead><tbody>${
    s.groups.filter(g=>s.subjects.find(sub=>sub.id===g.subject_id)?.participation_enabled!==false).map(g=>`<tr><td>${esc(g.subject_name)} · ${esc(g.title)}</td>${hours.map(h=>{
      const matches=daySlots.filter(sl=>Number(sl.group_id)===Number(g.id)&&Number(sl.hour)===h);
      return `<td>${matches.map(sl=>button('✓ '+String(sl.hour).padStart(2,'0')+':'+String(sl.minute).padStart(2,'0'),'matrix-remove',`data-id="${sl.id}" title="${esc(sl.teacher_name||'')} — إيقاف الموعد"`,'matrix-check')).join('')}${g.is_active!==false?button('+','matrix-add',`data-group="${g.id}" data-hour="${h}" aria-label="إضافة موعد ${esc(g.title)} الساعة ${h}"`):'—'}</td>`;
    }).join('')}</tr>`).join('')
  }</tbody></table></div>`;
  if(n===sequence)setContent(head('جداول المباحثات','الأوقات بتوقيت بغداد. اضغط + لإضافة موعد أو ✓ لإيقافه؛ يظهر وقت كل موعد بالدقيقة.')+body);
}
function dialog(title,html){if(busy&&dismissedWhileBusy)return;clearNotice();$('#dialog-title').textContent=title;$('#dialog-body').innerHTML=html;if(!$('#detail').open)$('#detail').showModal();}
async function showStudent(id){
  const n=++dialogSequence;const [st,missing]=await Promise.all([api('/students/'+id),api('/students/'+id+'/missing-lessons').catch(()=>null)]);if(n!==dialogSequence)return;currentStudent=st;const ro=Boolean(currentStage?.is_historical);
  const budget=st.activity?.approvedLeaveDays||0;const pending=st.leaves.filter(l=>l.status==='pending'&&!l.is_exception&&l.stage_season_id===st.activity?.stageSeasonId).reduce((sum,l)=>sum+Number(l.days),0);
  dialog(st.full_name,`<p class="subtle">${esc(st.stage_name)} · ${st.is_active?'نشط':'مؤرشف'} · ${st.official_confirmed_at?'أكّد التسجيل الرسمي':'لم يؤكد التسجيل الرسمي'}${ro?' · عرض بيانات موسم أرشيفي':''}</p>`+
    button('💬 التواصل مع هذا الطالب','contact-student',`data-id="${st.id}" data-name="${esc(st.full_name)}" data-telegram="${esc(st.telegram_id||'')}"`)+
    (ro?'':`<form id="edit-student"><label>الاسم الرباعي<input name="fullName" value="${esc(st.full_name)}" maxlength="200" required></label><div class="form-actions"><button class="primary">حفظ الاسم</button>${button(st.is_active?'أرشفة الطالب':'إعادة تفعيل الطالب','archive',`data-id="${st.id}" data-active="${!st.is_active}"`,st.is_active?'danger':'')}</div></form>`+
    `<section class="detail-section"><h3>المرحلة الدراسية</h3><form id="move-stage" class="toolbar"><label>النقل إلى مرحلة<select name="stageId" required>${stages.filter(s=>s.is_active&&s.stage_season_id).map(s=>`<option value="${s.id}" ${s.id===st.stage_id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label><button>نقل الطالب</button></form></section>`)+
    `<section class="detail-section"><h3>نظام المتابعة لكل مادة</h3><p class="subtle">التغيير يخص المادة المختارة من الآن فصاعدًا. تبقى التقارير والمباحثات والحضور السابق محفوظة.</p>${table(['المادة','نظام المتابعة الحالي','الإجراء'],(st.subjects||[]).map(s=>[esc(s.subject_name),s.participation_enabled===false?'غير مشمولة بالمتابعة':modeTag(s.mode),ro||!st.is_active||s.participation_enabled===false?'—':(s.mode?[s.mode==='report'?'mubahatha':'report']:['report','mubahatha']).map(mode=>button(mode==='report'?'تحويل إلى تقارير':'تحويل إلى مباحثات','student-participation',`data-subject="${s.subject_id}" data-season="${s.stage_season_id}" data-mode="${mode}"`)).join(' ')]))}</section>`+
    `<section class="detail-section"><h3>تنظيم المباحثات حسب المادة</h3>${st.groups.map(g=>`<p>${esc(g.subject_name)}: ${esc(g.group_title)}${g.group_number?' · رقم '+esc(g.group_number):''} ${modeTag(g.mode)}</p>`).join('')||'<p>لم يُوزّع بعد.</p>'}${!ro&&currentStage?.discussion_grouping!==false&&currentStage?.groups.length?`<form id="move-group" class="toolbar"><label>توحيد رقم المجموعة في جميع المواد<select name="groupId" required>${groupOptions(currentStage.groups.filter(g=>currentStage.subjects.find(sub=>sub.id===g.subject_id)?.participation_enabled!==false),'','اختر مباحثة المادة')}</select></label><button>حفظ المجموعة</button></form>`:''}<p class="subtle">في المراحل المقسمة، اختيار المجموعة يوحّد رقم مباحثات الطالب في مواده لهذا الموسم. لا يؤثر ذلك في حضور الدروس. لا تتغير التقارير السابقة؛ تبدأ أهلية الحضور من وقت النقل في المجموعات التي تغيّرت فقط.</p></section>`+
    `<section class="detail-section"><h3>المتغيرات في الموسم الحالي</h3><div class="summary"><div><b>${budget}/10</b>إجازات معتمدة</div><div><b>${pending}</b>أيام محجوزة لطلبات معلقة</div><div><b>${Math.max(0,10-budget-pending)}</b>أيام متبقية</div></div>${st.activity?.warnings?.length?`<p>التنبيهات المستلمة: ${st.activity.warnings.length}</p>`:''}</section>`+
    `<section class="detail-section"><h3>حضور الدروس في الموسم الحالي</h3><p class=\"subtle\">الأرقام نفسها التي يراها الطالب في «تقرير الحضور».</p>${table(['المادة','الحضور','عدد الدروس'],st.attendance.map(r=>[esc(r.subject_name),esc(r.attended_lessons),esc(r.total_lessons)]))}</section>`+missingLessonsSection(missing,ro)+
    `<section class="detail-section"><h3>آخر 100 طلب إجازة، بما فيها المواسم السابقة</h3><p class="subtle">الإجازات الاستثنائية المعتمدة في الموسم الحالي: ${st.activity?.exceptionLeaveDays||0} يومًا، خارج الرصيد الاعتيادي.</p>${table(['البداية','النهاية','الأيام / النوع','الحالة','الإجراء'],st.leaves.map(l=>[date(l.start_date),date(l.end_date),`${esc(l.days)} · ${l.is_exception?'استثناء طارئ':'اعتيادية'}${l.reason?'<div class="report-note">'+esc(l.reason)+'</div>':''}`,esc(labels[l.status]),leaveActions(l,ro,st.id)]))}</section>`);
}
async function newForm(kind){
  const id=++dialogSequence;
  const subjectOptions=currentStage?.subjects.filter(s=>!['group','slot'].includes(kind)||s.participation_enabled!==false).map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');
  let fields=kind==='stage'?'<label>اسم المرحلة<input name="name" required maxlength="100"></label>':kind==='subject'?'<label>اسم المادة<input name="name" required maxlength="100"></label><label>الهاشتاغ<input name="hashtag" required maxlength="100"></label>':`<label>المادة<select name="subjectId" required>${subjectOptions||''}</select></label><label>عنوان المجموعة<input name="title" required maxlength="100" placeholder="المجموعة الأولى"></label><label>السعة<input name="capacity" type="number" min="1" max="10000" value="50" required></label><label>رابط المجموعة (اختياري)<input name="inviteLink" type="url" placeholder="https://t.me/..."></label>`;
  if(['assignment','slot','exam'].includes(kind)){
    const teachers=(await api('/teachers')).filter(t=>t.is_active);if(id!==dialogSequence)return;
    const teacherField=`<label>الأستاذ<select name="teacherId" required>${teachers.map(t=>`<option value="${t.id}">${esc(t.full_name)}</option>`).join('')}</select></label>`;
    const subjectField=`<label>المادة<select name="subjectId" required>${subjectOptions}</select></label>`;
    fields=kind==='assignment'?subjectField+teacherField:kind==='slot'?`<label>المجموعة<select name="groupId" required>${groupOptions(currentStage.groups.filter(g=>currentStage.subjects.find(sub=>sub.id===g.subject_id)?.participation_enabled!==false),'','اختر مباحثة المادة')}</select></label>${teacherField}<label>اليوم<select name="dayOfWeek">${DAY_ORDER.map(i=>`<option value="${i}">${DAY_NAMES[i]}</option>`).join('')}</select></label><label>الساعة (16–23، أي 4 عصرًا حتى 11 ليلًا)<input name="hour" type="number" min="16" max="23" required></label><label>الدقيقة<input name="minute" type="number" min="0" max="59" value="0" required></label><p class="subtle">المدة ساعة. اختر أستاذًا مسندًا لهذه المادة؛ يمنع النظام تداخل مواعيده.</p>`:
      subjectField+teacherField+'<label>رقم الامتحان<input name="examNumber" type="number" min="1" max="3" required></label><label>العنوان<input name="title" maxlength="150" required></label><label>التاريخ<input name="dateIso" type="date" required></label><label>ساعات الإتاحة<input name="hours" type="number" min="1" max="720" value="24" required></label><p class="subtle">يبدأ الامتحان في الساعة المحددة بإعدادات المعهد (الافتراضي 22:00 بتوقيت بغداد). يُحفظ مسودة حتى تضيف الأسئلة وتنشره.</p>';
  }
  dialog({stage:'إضافة مرحلة',subject:'إضافة مادة',group:'إضافة مجموعة',assignment:'إسناد أستاذ لمادة',slot:'إضافة موعد',exam:'إنشاء امتحان'}[kind],`<form id="create-${kind}"><div class="form-grid">${fields}</div><div class="form-actions"><button class="primary">حفظ</button></div></form>`);
}
async function showExam(id){
  const n=++dialogSequence;const exam=await api('/exams/'+id);if(n!==dialogSequence)return;currentExam=exam;
  const editable=exam.status!=='cancelled'&&Number(exam.attempt_count||0)===0&&!currentStage?.is_historical;
  dialog(exam.title||'الامتحان الشهري '+exam.exam_number,`<p>${esc(exam.subject_name)} · ${esc(labels[exam.status])}</p><p>يفتح: ${stamp(exam.opens_at)} · يغلق: ${stamp(exam.closes_at)}</p>`+
    (editable?`<form id="update-exam" class="detail-section"><h3>تعديل الامتحان</h3><label>الموضوع<input name="title" value="${esc(exam.title)}" minlength="3" maxlength="150" required></label><label>التاريخ<input name="dateIso" type="date" value="${baghdadIso(exam.opens_at)}" required></label><label>مدة الإتاحة بالساعات<input name="hours" type="number" min="1" max="720" value="${Number(exam.available_hours)}" required></label><div class="form-actions"><button class="primary">حفظ التعديل</button>${button('حذف الامتحان','delete-exam',`data-id="${exam.id}"`,'danger')}</div></form>`:'<p class="subtle">بدأ أحد الطلبة الامتحان أو أُرشف الموسم؛ لا يمكن تعديل الامتحان أو حذفه.</p>')+
    (exam.status==='published'&&!currentStage?.is_historical&&new Date(exam.closes_at)<=new Date()?`<div class="form-actions">${button('إعادة فتح لطالب محدد','exam-student-window',`data-id="${exam.id}"`,'primary')}</div>`:'')+
    ((exam.studentWindows||[]).length?'<h3>نوافذ الفتح الخاصة بالطلبة — بتوقيت بغداد</h3>'+table(['الطالب','بداية الفتح','نهاية الفتح','الملاحظة','المسؤول'],exam.studentWindows.map(w=>[esc(w.full_name),stamp(w.opens_at),stamp(w.closes_at),esc(w.note||'—'),esc(w.created_by)])):'')+
    table(['السؤال','الخيارات','الصحيح','الإجراء'],exam.questions.map(q=>[esc(q.prompt),esc((q.options||['صح','خطأ']).join(' / ')),esc(q.correct_answer),editable?button('تعديل','edit-question',`data-id="${q.id}"`)+button('حذف','remove-question',`data-id="${q.id}"`):'محمي بعد بدء المحاولات']))+
    (editable?`<form id="exam-question" class="detail-section"><h3>إضافة سؤال</h3><label>النوع<select name="type"><option value="tf">صح أو خطأ</option><option value="mcq">اختيار من متعدد</option></select></label><label>نص السؤال<textarea name="prompt" maxlength="3000" required></textarea></label><label>الخيارات: كل خيار في سطر (للاختيار المتعدد فقط)<textarea name="options"></textarea></label><label>الإجابة الصحيحة بالنص المطابق للخيار<input name="correct" maxlength="300" required placeholder="صح أو خطأ أو نص أحد الخيارات"></label><div class="form-actions"><button class="primary">إضافة السؤال</button></div></form>${exam.status==='draft'?`<div class="form-actions">${button('نشر الامتحان وإشعار الطلبة','publish-exam','','primary')}</div>`:''}`:'')+
    (exam.status==='cancelled'?`<p class="subtle">أُلغي هذا الامتحان، ولا يظهر للطلبة.${exam.cancellation_reason?' السبب: '+esc(exam.cancellation_reason):''}</p>`:
      `<form id="postpone-exam" class="detail-section"><h3>تغيير الموعد</h3><p class="subtle">متاح فقط قبل بدء أي طالب محاولة. تُحفظ الإجابات السابقة.</p><label>التاريخ الجديد<input name="dateIso" type="date" required></label><div class="form-actions"><button>حفظ الموعد</button></div></form>`+
      `<form id="cancel-exam" class="detail-section"><h3>إلغاء الامتحان وإشعار الطلبة</h3><p class="subtle">متاح قبل بدء أي طالب محاولة. يبقى سجل الامتحان محفوظًا.</p><label>سبب الإلغاء (اختياري)<input name="reason" maxlength="500"></label><div class="form-actions"><button>إلغاء الامتحان وإشعار الطلبة</button></div></form>`));
}

function isoDateLabel(iso){return new Date(`${iso}T00:00:00Z`).toLocaleDateString('ar-IQ',{timeZone:'UTC',day:'numeric',month:'numeric',year:'numeric'});}
function monthLabel(iso){return new Date(`${iso}T00:00:00Z`).toLocaleDateString('ar-IQ',{timeZone:'UTC',month:'long',year:'numeric'});}
async function loadLessonSchedule(){
  view='lesson-schedule';currentStage=null;setNav('lesson-schedule');$('#breadcrumb').textContent='المعهد / جدول الدروس';const n=++sequence;
  if(!stages.length)stages=await api('/stages');if(n!==sequence)return;
  const eligible=stages.filter(s=>s.stage_season_id);
  if(!eligible.length){setContent(head('جدول الدروس','خطة نشر مكملة للهاشتاك؛ عند غياب الهاشتاك يمكن للجدول تحديد المادة تلقائيًا إذا كانت مادة واحدة مجدولة في ذلك اليوم.')+empty('لا توجد مراحل مرتبطة بموسم نشط.'));return;}
  if(!lessonScheduleStageId||!eligible.some(s=>String(s.id)===String(lessonScheduleStageId)))lessonScheduleStageId=eligible[0].id;
  await renderLessonSchedule(eligible);
}
const WEEKDAY_NAMES=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const weekdayIndex=iso=>new Date(`${iso}T00:00:00Z`).getUTCDay();
// The month opened by default: today's month in Baghdad, else the nearest upcoming one, else the last.
function scheduleOpenMonth(months){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
  const current=`${parts.year}-${parts.month}`;
  return months.includes(current)?current:(months.find(m=>m>current)||months[months.length-1]||'');
}
async function renderLessonSchedule(eligible){
  const stage=eligible.find(x=>String(x.id)===String(lessonScheduleStageId));if(!stage)return;
  const data=await api('/lesson-schedule?stageSeasonId='+stage.stage_season_id);lessonScheduleData=data;
  const checked=new Set(data.entries.map(e=>`${e.subject_id}:${e.lesson_date}`));
  const byMonth=new Map();for(const iso of data.dates||[]){const key=iso.slice(0,7);if(!byMonth.has(key))byMonth.set(key,[]);byMonth.get(key).push(iso);}
  const months=[...byMonth.keys()],openMonth=scheduleOpenMonth(months),span=2+data.subjects.length;
  const rows=months.map(key=>{
    const days=byMonth.get(key),open=key===openMonth;
    const planned=days.reduce((n,iso)=>n+data.subjects.filter(sub=>checked.has(`${sub.id}:${iso}`)).length,0);
    const head=`<tr class="month-row"><td class="month-row-cell" colspan="${span}"><button type="button" class="month-toggle" data-action="schedule-month-toggle" data-month="${key}" aria-expanded="${open}"><span class="month-arrow">${open?'▾':'◂'}</span> ${esc(monthLabel(days[0]))} <span class="subtle">· ${days.length} يومًا · <span class="month-planned">${planned}</span> موعد</span></button></td></tr>`;
    return head+days.map(iso=>{
      const wd=weekdayIndex(iso);
      const cells=data.subjects.map(sub=>{const k=`${sub.id}:${iso}`,on=checked.has(k);
        return `<td><button type="button" class="schedule-check ${on?'checked':''}" data-action="lesson-schedule-toggle" data-subject-id="${sub.id}" data-date="${iso}" data-checked="${on?'true':'false'}" aria-label="${esc(sub.name)} ${esc(WEEKDAY_NAMES[wd])} ${esc(isoDateLabel(iso))}">${on?'✓':'·'}</button></td>`;}).join('');
      return `<tr class="day-${wd}" data-month="${key}" ${open?'':'hidden'}><td class="day-cell">${WEEKDAY_NAMES[wd]}</td><td class="date-cell">${esc(isoDateLabel(iso))}</td>${cells}</tr>`;
    }).join('');
  }).join('');
  setContent(head('جدول الدروس','ضع علامة ✓ في تاريخ نشر كل مادة. هذا الجدول التخطيطي لا يفعّل الدرس ولا يرسل الإشعارات.')+
    `<div class="toolbar"><label>المرحلة الدراسية<select id="lesson-schedule-stage">${eligible.map(e=>`<option value="${e.id}" ${String(e.id)===String(lessonScheduleStageId)?'selected':''}>${esc(e.name)}</option>`).join('')}</select></label>
    <div class="subtle">من ${esc(isoDateLabel(data.start_date))} إلى ما قبل ${esc(isoDateLabel(data.end_date_exclusive))} · الخميس والجمعة مستبعدان تلقائيًا.</div>
    ${months.length>1?`<button type="button" data-action="schedule-months-all" data-current="${openMonth}">فتح كل الأشهر</button>`:''}</div>`+
    `<div class="summary"><div><b>${data.dates.length}</b> يومًا دراسيًا</div><div><b>${data.subjects.length}</b> مادة</div><div><b class="lesson-schedule-summary-count">${data.entries.length}</b> موعد نشر مخطط</div></div>`+
    `<div class="table-wrap lesson-schedule-wrap"><table class="lesson-schedule"><thead><tr><th>اليوم</th><th>التاريخ</th>${data.subjects.map(s=>`<th>${esc(s.name)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`);
}
let mgtStageId='',mgtSubjectId='',mgtPage=0,sessionSubjectId='',sessionPage=0;
function managementSummary(data,kind){
  return `<div class="summary"><div><b>${data.subjects.reduce((n,s)=>n+Number(s.total),0)}</b> ${kind} في المرحلة</div><div><b>${data.subjects.reduce((n,s)=>n+Number(s.open_count),0)}</b> مفتوحة الآن</div></div>`+
    table(['المادة','العدد المفعّل في الموسم','المفتوح الآن'],data.subjects.map(sub=>[esc(sub.name),esc(sub.total),esc(sub.open_count)]));
}
function managementPager(data,kind){
  return `<div class="pagination"><span>${data.total} سجلًا · الصفحة ${data.page+1}</span><div>`+
    (data.page>0?button('السابق','management-page',`data-kind="${kind}" data-page="${data.page-1}"`):'')+
    ((data.page+1)*data.size<data.total?button('التالي','management-page',`data-kind="${kind}" data-page="${data.page+1}"`):'')+'</div></div>';
}
function subjectSelector(data,kind,selected){
  return `<label>حسب المادة<select id="${kind}-subject"><option value="">جميع المواد</option>${data.subjects.map(sub=>`<option value="${sub.id}" ${String(sub.id)===String(selected)?'selected':''}>${esc(sub.name)} (${sub.total})</option>`).join('')}</select></label>`;
}
async function loadLessonManagement(){
  view='lesson-management';currentStage=null;setNav('lesson-management');const n=++sequence;
  const available=await api('/stages'+(currentSeasonId?'?seasonId='+currentSeasonId:''));
  if(n!==sequence)return;
  if(!available.some(s=>String(s.id)===String(mgtStageId))){mgtStageId=available[0]?String(available[0].id):'';mgtSubjectId='';mgtPage=0;}
  $('#breadcrumb').textContent='المعهد / الدروس المفعّلة';
  const selector=`<form id="lesson-mgt-stage" class="toolbar"><label>المرحلة الدراسية<select name="stageId">${available.map(s=>`<option value="${s.id}" ${String(s.id)===String(mgtStageId)?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label></form>`;
  const body=mgtStageId?await lessonManagementContent(mgtStageId):empty('لا توجد مراحل بعد');
  if(n===sequence)setContent(head('الدروس المفعّلة','جميع الدروس حسب المرحلة والمادة والموسم. الترقيم بحسب النشر الأصلي. الدرس المسترجع متاح 24 ساعة من استرجاعه؛ بقية الدروس تبقى بمهلتها الأصلية.')+selector+body);
}
async function lessonManagementContent(stageId){
  const data=await api('/lesson-management?'+new URLSearchParams({stageId,page:mgtPage,...(mgtSubjectId?{subjectId:mgtSubjectId}:{}),...(currentSeasonId?{seasonId:currentSeasonId}:{})}));
  if(data.total&&mgtPage>0&&!data.rows.length){mgtPage--;return lessonManagementContent(stageId);}
  const ro=!data.season.is_active;
  return ((!ro&&data.repairAvailable)?'<section class="card" role="status"><p><strong>'+ (data.repairApplied?'تم تطبيق تصحيح نشر 26 و27 سبتمبر وحفظ السجلات الأصلية.':'تصحيح نشر 26 و27 سبتمبر لم يُطبّق بعد.')+'</strong></p>'+(data.repairApplied?'':'<p>تحديث الملفات وحده لا يغيّر السجلات السابقة. افتح المراجعة وتحقق من روابط الدروس ثم اضغط «تطبيق التصحيح وحفظ الحضور».</p>')+button('مراجعة تصحيح نشر 26 و27 سبتمبر','lesson-publication-repair')+'</section>':'')+managementSummary(data,'درسًا')+subjectSelector(data,'lesson-mgt',mgtSubjectId)+
    table(['رقم الدرس في المادة','المادة','النشر المسجّل','نهاية التسجيل','الحضور','الإجراءات'],[...(mgtPage===0?(data.scheduledRows||[]).map(x=>['—',esc(x.subject_name),'موعد الجدول: '+esc(x.lesson_date),'بانتظار تحديد المنشور','—',ro?'':button('نشر لمدة 24 ساعة','scheduled-lesson-publish',`data-subject="${x.subject_id}" data-date="${esc(x.lesson_date)}"`)]):[]),...data.rows.map(l=>[`${l.item_number}<div class="subtle">المعرف #${l.id}</div>`,`${esc(l.subject_name)}<div class="subtle">${esc(lessonSource(l.source_type))}</div>${/^https:\/\//i.test(l.source_url||'')?`<a href="${esc(l.source_url)}" target="_blank" rel="noopener noreferrer">فتح منشور الدرس</a>`:''}`,stamp(l.activated_at),`${stamp(l.active_until)}<div>${l.is_active?'مفتوح':'انتهت المهلة'}</div>`,`${l.attended_count} / ${l.enrolled_count}`,
      button('حذف حضور طالب','lesson-attendance-remove',`data-id="${l.id}"`)+(ro?'':(l.can_reopen?button('إعادة فتح للوقت المتبقي','lesson-reopen',`data-id="${l.id}" data-subject="${esc(l.subject_name)}" data-recovered="${l.republished_at||l.attendance_opened_at?1:0}"`):'<span class="subtle">انتهت المهلة</span>')+
      (!l.is_active&&!l.republished_at?button('إعادة نشر لمدة 24 ساعة','lesson-republish',`data-id="${l.id}" data-subject="${l.subject_id}"`):'')+
      button('تصحيح المادة','lesson-correct',`data-id="${l.id}"`)+
      (!l.is_active?button('حضور إداري متأخر لطلبة محددين','lesson-late',`data-id="${l.id}"`):'')+
      button('تحضير الجميع','lesson-markall',`data-id="${l.id}" data-subject="${esc(l.subject_name)}"`)+button('حذف الدرس','lesson-cancel',`data-id="${l.id}" data-subject="${esc(l.subject_name)}"`,'danger'))])])+managementPager(data,'lessons');
}
let publicationRepairState=null;
async function publicationRepairDialog(){
  const n=++dialogSequence,data=await api('/lesson-publication-repair?stageId='+encodeURIComponent(mgtStageId));if(n!==dialogSequence)return;
  publicationRepairState=data;
  dialog('تصحيح نشر يومي 26 و27 سبتمبر',`<p>${data.applied?'سبق تنفيذ التصحيح؛ لن يتكرر.':`العدد قبل التصحيح: ${data.beforeCount}، وبعده: ${data.afterCount}.`}</p>
    ${table(['اليوم','المادة الصحيحة','منشور المحاضرة'],data.plan.map(p=>[esc(p.day),esc(p.subject),`<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">فتح الملف #${p.media||p.message}</a>`]))}
    <p>يُجمع حضور رابط المسائل وصوتها في درس واحد. تبقى التسجيلات الأصلية محفوظة. تُصحح المواد وتواريخ النشر، وتتاح الملفات التي لم تُفعّل 24 ساعة.</p>
    <p>الرسائل التالية ستُستبعد من عداد الدروس بوصفها تعليمات أو إعلانات. افتحها وتأكد من محتواها قبل التنفيذ. حضورها السابق يبقى محفوظًا في سجل التصحيح، ولا يُنقل إلى محاضرة لم يستمع إليها الطالب.</p>
    ${table(['السجل','الرسالة','الحضور المحفوظ'],data.excluded.map(x=>[esc(x.id),`<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">فتح الرسالة #${x.message}</a>`,esc(x.attendance)]))}
    ${data.applied?'':`<form id="apply-publication-repair"><label><input type="checkbox" name="reviewed" required> راجعت الروابط والمواد وأؤكد استبعاد الرسائل الإرشادية المذكورة.</label><button class="primary">تطبيق التصحيح وحفظ الحضور</button></form>`}`);
}
async function publishScheduledLessonDialog(subjectId,date){
  const n=++dialogSequence,data=await api('/lesson-management?'+new URLSearchParams({stageId:mgtStageId}));
  if(n!==dialogSequence)return;
  const subject=data.subjects.find(s=>String(s.id)===String(subjectId));if(!subject)throw Error('المادة غير موجودة.');
  dialog('نشر درس من الجدول',`<p>${esc(subject.name)} · موعد الجدول ${esc(date)}</p>
    <p>اختر منشور هذا الدرس بعد فتحه والتأكد من محتواه. لن يتغير أي درس آخر أو حضور سابق.</p>
    <form class="activate-scheduled-lesson"><input type="hidden" name="stageSeasonId" value="${esc(data.season.id)}"><input type="hidden" name="subjectId" value="${subject.id}"><input type="hidden" name="scheduleDate" value="${esc(date)}">
    <button type="submit">تفعيل بدون منشور لمدة 24 ساعة</button><p class="subtle">للمادة التي لم يُعرف منشورها؛ يُربط أي منشور يصل لاحقًا بالدرس تلقائيًا.</p></form>
        ${data.pendingRows?.length?`<form class="restore-pending-lesson"><input type="hidden" name="subjectId" value="${subject.id}"><input type="hidden" name="scheduleDate" value="${esc(date)}">
    ${table(['اختيار','المنشور المحفوظ'],data.pendingRows.map(x=>[`<input type="radio" name="id" value="${x.id}" required aria-label="المنشور ${x.source_message_id}">`,
      `الرسالة #${esc(x.source_message_id)} · ${esc(x.content_kind||'')} · وقت محفوظ: ${stamp(x.received_at)}${/^https:\/\//i.test(x.source_url||'')?` · <a href="${esc(x.source_url)}" target="_blank" rel="noopener noreferrer">فتح المنشور</a>`:''}<div>${esc(x.content_text||'')}</div>`]))}
    <label>تاريخ النشر الأصلي بتوقيت بغداد — إن كان الوقت المحفوظ غير صحيح<input type="datetime-local" name="originalPublishedAt"></label>
    <button type="submit">نشر لمدة 24 ساعة</button></form>`:'<p>لا يوجد منشور محفوظ غير مربوط. أرسل ملف الدرس مع هاشتاغ المادة ليُعرف بصورة صريحة.</p>'}`);
}
let removeAttendanceState=null;
async function removeAttendanceDialog(id,page=0,q=''){
  const n=++dialogSequence;
  const data=await api('/lessons/'+id+'/attendance?'+new URLSearchParams({page,q}));
  if(n!==dialogSequence)return;
  removeAttendanceState={id:Number(id),page:data.page,q};
  dialog('حذف حضور طالب من درس',`<p>${esc(data.lesson.subject_name)} · الدرس #${data.lesson.id} · نشر ${stamp(data.lesson.activated_at)}</p>
    <p>اختر الطالب الذي سُجِّل حضوره بالخطأ. يُحذف حضور هذا الدرس فقط ويُعاد حساب حالة الغياب.</p>
    <form id="remove-attendance-search" class="toolbar"><label>بحث باسم الطالب<input name="q" maxlength="150" value="${esc(q)}"></label><button>بحث</button></form>
    ${table(['الطالب','الحضور المسجل','الإجراء'],data.rows.map(st=>[
      `${esc(st.full_name)} <span class="subtle">#${st.student_id}</span>`,
      `${st.marking_kind==='admin_late'?'حضور إداري متأخر':'حضور مسجل'} · ${stamp(st.listened_at)}`,
      button('حذف هذا الحضور','remove-lesson-attendance',`data-id="${id}" data-student="${st.student_id}" data-name="${esc(st.full_name)}"`,'danger')]))}
    <div class="pagination"><span>${data.total} حضورًا · الصفحة ${data.page+1}</span><div>
      ${data.page?button('السابق','remove-attendance-page',`data-page="${data.page-1}"`):''}
      ${(data.page+1)*data.size<data.total?button('التالي','remove-attendance-page',`data-page="${data.page+1}"`):''}</div></div>`);
}
async function correctLessonDialog(id){
  const n=++dialogSequence,data=await api('/lessons/'+id+'/admin-options');if(n!==dialogSequence)return;
  const l=data.item;
  dialog('تصحيح مادة الدرس',`<p>الدرس #${l.id} · ${esc(l.subject_name)} · النشر الأصلي: ${stamp(l.activated_at)}</p><p>${esc(lessonSource(l.source_type))}</p>${/^https:\/\//i.test(l.source_url||'')?`<p><a href="${esc(l.source_url)}" target="_blank" rel="noopener noreferrer">فتح منشور الدرس للتحقق من مادته</a></p>`:''}
    <p>يبقى الدرس وكل سجلات حضوره محفوظة. تتغير المادة في التقارير ويُحسب رقم الدرس ضمن المادة الصحيحة.</p>
    <form id="correct-lesson" data-id="${l.id}"><input type="hidden" name="expectedSubjectId" value="${l.subject_id}">
    <label>المادة الصحيحة<select name="subjectId" required>${data.subjects.map(s=>`<option value="${s.id}" ${s.id===l.subject_id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label>
    <div class="form-actions"><button class="primary">حفظ تصحيح المادة</button></div></form>`);
}
const overrideRoute=kind=>({lesson:'lessons',session:'sessions',exam:'exams'})[kind];
async function studentOverrideDialog(kind,id){
  const n=++dialogSequence,data=await api(`/${overrideRoute(kind)}/${id}/admin-options`);if(n!==dialogSequence)return;
  adminSelection={kind,id:Number(id),item:data.item,selected:new Map(),page:0,query:'',request:0};
  const l=data.item,late=kind==='lesson',discussion=kind==='session',attendance=late||discussion;
  dialog(discussion?'حضور إداري لمباحثة':late?'حضور إداري متأخر':'فتح الامتحان لطالب واحد',`<p>${esc(l.subject_name)} · ${discussion?'المباحثة':late?'الدرس':'الامتحان'} #${l.id}</p>
    <p>${discussion?'المجموعة: '+esc(l.group_title)+' · موعد المباحثة: '+stamp(l.opened_at):late?'النشر الأصلي: '+stamp(l.activated_at):'الامتحان الشهري '+l.exam_number+' · '+esc(l.title||'')} · نهاية الوقت الأصلي: ${stamp(late?l.active_until:l.closes_at)}</p>
    <p>${discussion?'اختر طلبة المباحثة المحددين. تضاف تسجيلات البداية والنهاية الناقصة فقط، ويحفظ الحضور السابق. القائمة تخص المؤهلين لهذه المجموعة وقت المباحثة.':late?'اختر طالبًا أو عدة طلاب (حتى 500). يُحفظ التسجيل كحضور إداري متأخر بوقت التأشير الحقيقي.':'اختر طالبًا واحدًا. يحتفظ بإجاباته ويكمل المحاولة غير المكتملة؛ لا تُنشأ محاولة ثانية لمن أكمل الامتحان.'}</p>
    <form id="override-search" class="toolbar"><label>البحث باسم الطالب<input name="q" maxlength="150"></label><button>بحث</button></form>
    <div id="override-students"></div><p id="override-selected" role="status"></p>
    <form id="save-override"><div class="form-grid">${attendance?'':`<label>بداية الفتح الجديدة — بتوقيت بغداد<input name="opensAt" type="datetime-local" required></label><label>نهاية الفتح الجديدة — بتوقيت بغداد<input name="closesAt" type="datetime-local" required></label>`}
    <label>السبب أو الملاحظة (اختياري)<textarea name="note" maxlength="500"></textarea></label></div>
    <div class="form-actions"><button class="primary">${attendance?'تسجيل الحضور للطلبة المحددين':'حفظ نافذة الطالب الخاصة'}</button></div></form>`);
  renderOverrideStudents(data);
}
function updateOverrideSelected(){
  if(!adminSelection||!$('#override-selected'))return;
  const names=[...adminSelection.selected.values()];
  $('#override-selected').textContent=`المحددون: ${names.length}${names.length?' — '+names.slice(0,10).join('، '):''}${names.length>10?' …':''}`;
}
function renderOverrideStudents(data){
  const state=adminSelection,late=state.kind==='lesson',discussion=state.kind==='session';
  state.page=data.page;
  $('#override-students').innerHTML=table(['اختيار','الطالب','الحالة الحالية'],data.rows.map(st=>[
    `<input type="${late||discussion?'checkbox':'radio'}" name="override-student" value="${st.id}" data-name="${esc(st.full_name)}" aria-label="اختيار ${esc(st.full_name)}" ${state.selected.has(st.id)?'checked':''} ${(late&&st.attendance)||(discussion&&st.attended_start&&st.attended_end)?'disabled':''}>`,
    `${esc(st.full_name)} <span class="subtle">#${st.id}</span>`,discussion?`البداية: ${st.attended_start?'مسجلة':'غير مسجلة'} · النهاية: ${st.attended_end?'مسجلة':'غير مسجلة'}`:late?(st.attendance?`${st.attendance.marking_kind==='admin_late'?'حضور إداري متأخر':'حضور مسجل'} · ${stamp(st.attendance.listened_at)}${st.attendance.marked_by?' · المسؤول '+esc(st.attendance.marked_by):''}${st.attendance.admin_note?' · '+esc(st.attendance.admin_note):''}`:'لم يسجل الحضور'):
      `${st.student_window?'نافذة خاصة: '+stamp(st.student_window.opens_at)+' ← '+stamp(st.student_window.closes_at):'لا توجد نافذة خاصة'}${st.submitted_at?' · سبق تسليم المحاولة':''}`]))+
    `<div class="pagination"><span>${data.total} طالبًا · الصفحة ${data.page+1}</span><div>${data.page?button('السابق','override-prev'):''}${(data.page+1)*data.size<data.total?button('التالي','override-next'):''}</div></div>`;
  updateOverrideSelected();
}
async function loadOverrideStudents(page){
  const state=adminSelection,n=++state.request;
  const data=await api(`/${overrideRoute(state.kind)}/${state.id}/admin-options?`+new URLSearchParams({page,q:state.query}));
  if(adminSelection===state&&n===state.request&&$('#override-students'))renderOverrideStudents(data);
}
async function sessionManagementContent(stage,ro){
  const data=await api('/session-management?'+new URLSearchParams({stageId:stage.id,page:sessionPage,...(sessionSubjectId?{subjectId:sessionSubjectId}:{}),...(currentSeasonId?{seasonId:currentSeasonId}:{})}));
  if(data.total&&sessionPage>0&&!data.rows.length){sessionPage--;return sessionManagementContent(stage,ro);}
  const startDelay=Number(data.startAttendanceDelayMinutes||10),autoLead=Number(data.endAttendanceMinutes||10);
  const addMinutes=(value,mins)=>value?new Date(new Date(value).getTime()+mins*60000):null;
  return '<section class="detail-section"><h2>المباحثات المفعّلة</h2><p>إعادة الفتح تتيح تسجيل البداية والنهاية لمدة 10 دقائق من لحظة إعادة الفتح، وتحفظ موعد المباحثة والحضور السابق. يصل للطالب إشعار واحد بزرّي البداية والنهاية. التحضير الإداري يكمل البداية والنهاية لطلبة المجموعة المؤهلين.</p>'+
    managementSummary(data,'مباحثة')+subjectSelector(data,'session-mgt',sessionSubjectId)+
    table(['رقم المباحثة في المادة','المادة والمجموعة','موعد المباحثة','نوافذ تسجيل الحضور','الحضور المكتمل',...(ro?[]:['الإجراءات'])],data.rows.map(x=>{
      const firstOpen=addMinutes(x.opened_at,startDelay),autoEnd=addMinutes(x.closes_at,-autoLead),lastMinute=addMinutes(x.closes_at,-1);
      const canEnd=!x.attendance_reopened_at&&!x.is_closed&&!x.end_opened_at&&x.start_notifications_queued&&new Date(x.closes_at)>new Date()&&firstOpen&&firstOpen<=new Date();
      return [
      `${x.item_number}<div class="subtle">المعرف #${x.id}</div>`,`${esc(x.subject_name)}<div>${esc(x.group_title)}</div><div>${esc(x.title)}</div>`,stamp(x.opened_at),
      x.attendance_reopened_at?`فرصة إضافية للبداية والنهاية: من ${stamp(x.attendance_reopened_at)}<div>حتى ${stamp(x.attendance_reopen_until)}</div><div>${new Date(x.attendance_reopen_until)>new Date()?'مفتوحة':'انتهت الفرصة الإضافية'}</div>`:
        `الحضور الأول: يبدأ ${stamp(firstOpen)}<div>ويبقى حتى ${stamp(lastMinute)}</div>`+
        `<div style="margin-top:.35rem">الحضور الثاني: ${x.end_opened_at?'بدأ '+stamp(x.end_opened_at):'يفتح عند إنهاء الأستاذ أو تلقائيًا '+stamp(autoEnd)}</div><div>ويبقى حتى ${stamp(lastMinute)}</div>`,esc(x.complete_count),
      ...(ro?[]:[(canEnd?button('إنهاء وفتح الحضور الثاني','end-session',`data-id="${x.id}"`):'')+
        (x.can_reopen?button('إعادة فتح الحضور 10 دقائق','session-reopen',`data-id="${x.id}"`):`<span class="subtle">${new Date(x.attendance_reopen_until)>new Date()?'الفرصة الإضافية مفتوحة':'إعادة الفتح غير متاحة الآن'}</span>`)+
        button('حالة إشعارات إعادة الفتح','session-notifications',`data-id="${x.id}"`)+
        button('حضور إداري لطلبة محددين','session-selected',`data-id="${x.id}"`)+
        button('تحضير طلبة المجموعة','session-markall',`data-id="${x.id}"`)+button('حذف المباحثة','session-cancel',`data-id="${x.id}"`,'danger')])];
    }))+
    managementPager(data,'sessions')+'</section>';
}
function sessionNoticeSummary(n){
  if(!n)return 'يمكنك متابعة الإرسال من حالة إشعارات إعادة الفتح.';
  const c=n.counts;
  if(!c.total)return 'لم يُجهّز أي إشعار؛ راجع حالة الإشعارات لمعرفة سبب استبعاد الطلبة.';
  return `جُهّز ${c.total} إشعارًا؛ أُرسل ${c.sent}، بانتظار الإرسال ${c.pending+c.sending}، تعذّر ${c.failed}، وانتهت مهلة ${c.expired}.`;
}
async function showSessionNotifications(id){
  const n=await api('/sessions/'+id+'/notifications'),c=n.counts;
  const reasons={eligible:'مؤهل لتلقي الإشعار',inactive:'حساب الطالب غير نشط',not_enrolled:'غير مسجل في الموسم الحالي',not_mubahatha:'المادة بنظام التقارير أو لم يُحدد اختيارها',joined_group_later:'نُقل إلى المجموعة بعد موعد المباحثة الأصلي',joined_mode_later:'بدأ نظام المباحثات بعد الموعد الأصلي أو تاريخه غير مسجل'};
  const errors={'403':'تليجرام رفض الإرسال: قد يكون البوت محظورًا لدى الطالب أو بلا صلاحية للإرسال.','400':'تليجرام رفض الطلب أو المحادثة غير متاحة.','429':'حد الإرسال في تليجرام؛ تُعاد المحاولة تلقائيًا.'};
  dialog('إشعارات إعادة فتح المباحثة',`<p>${esc(sessionNoticeSummary(n))}</p><p>الإشعار يصل إلى محادثة الطالب الخاصة مع البوت. «أُرسل» يعني أن تليجرام قبل الرسالة، وليس أن الطالب قرأها.</p><p>نهاية الفرصة: ${stamp(n.until)} — ${n.windowOpen?'مفتوحة':'مغلقة'}</p>`+
    table(['حالة الإرسال','العدد'],[['أُرسلت',c.sent],['بانتظار الإرسال',c.pending],['قيد الإرسال',c.sending],['تعذّر الإرسال',c.failed],['انتهت المهلة',c.expired]].map(x=>x.map(esc)))+
    '<h3>أهلية الطلبة الحاليين في المجموعة</h3>'+table(['الحالة','العدد'],n.audience.map(x=>[esc(reasons[x.reason]||x.reason),esc(x.count)]))+
    (!n.audience.length?'<p>لا يوجد طلبة في هذه المجموعة.</p>':'')+
    (n.errors.length?table(['سبب تعذّر الإرسال','العدد'],n.errors.map(x=>[esc(errors[x.code]||('خطأ الإرسال: '+x.code)),esc(x.count)])):'')+
    '<div class="form-actions">'+button('تحديث الحالة','session-notifications',`data-id="${id}"`)+
    (n.windowOpen?button('إعادة محاولة إرسال الإشعارات','session-retry-notifications',`data-id="${id}"`):'')+'</div>');
}
async function loadChannels(){
  view='channels';currentStage=null;setNav('channels');$('#breadcrumb').textContent='المعهد / القنوات';const n=++sequence;
  const data=await api('/channel-diagnostics');if(n!==sequence)return;
  const outcomeLabels={received:'وصل — قيد المعالجة',activated:'تم تفعيل الدرس',activated_after_schedule:'تم التفعيل بعد إدخال الجدول',duplicate_post:'وصل — سبق تفعيله',ignored_non_lesson:'وصل — ليس درسًا',hashtag_no_match:'وصل — الهاشتاغ لا يطابق مواد المرحلة',schedule_no_match:'وصل — لا توجد مادة مجدولة متبقية',schedule_pending:'محفوظ مؤقتًا بانتظار جدول اليوم',no_subject:'وصل — تعذر تحديد المادة',unlinked:'وصل — Chat ID غير مرتبط',season_inactive:'وصل — الموسم المرتبط غير نشط',processing_error:'وصل — خطأ أثناء المعالجة',activated_notification_error:'فُعّل الدرس لكن حدث خطأ لاحق في الإشعارات'};
  const contentLabels={voice:'رسالة صوتية',audio:'ملف صوتي',audio_document:'ملف صوتي كمستند',video:'فيديو',link:'رابط',hashtag_only:'هاشتاغ مستقل',text:'نص',document:'مستند',other:'محتوى آخر'};
  const healthTag=h=>h==='ok'?'<span class="tag ok">سليم</span>':h==='error'?'<span class="tag danger">خلل مؤكد</span>':h==='warn'?'<span class="tag warn">يحتاج انتباه</span>':'<span class="tag info">بانتظار أول منشور</span>';
  const alertsBody=data.alerts.length?table(['القناة','السبب','منشورات لم تُفعَّل','آخر منشور'],data.alerts.map(a=>[esc(a.chat_title||a.telegram_chat_id),a.reason==='season_inactive'?'مرتبطة بموسم متوقف':'غير مرتبطة إطلاقًا',esc(a.post_count),stamp(a.last_seen_at)])):empty('لا توجد قنوات أرسلت دروسًا غير مُفعّلة مؤخرًا');
  const deep=data.deep||[],summary=data.summary||{total:deep.length,ok:0,warn:0,error:0,unknown:0};
  const deepBody=deep.length?table(
    ['القناة وTelegram Chat ID','الربط الفعلي في قاعدة البيانات','الرابط الظاهر','آخر منشور استلمه البوت','آخر درس فُعّل من القناة','نتيجة الفحص'],
    deep.map(c=>{
      const tags=Array.isArray(c.last_hashtags)?c.last_hashtags:[];
      const received=c.last_received_at?`${stamp(c.last_received_at)}<div class="subtle">${esc(contentLabels[c.last_content_kind]||c.last_content_kind||'محتوى غير معروف')} · الرسالة #${esc(c.last_message_id||'—')}${c.observed_username?' · '+esc(c.observed_username):''}</div>${tags.length?`<div class="subtle">${tags.map(t=>'#'+esc(t)).join('، ')}</div>`:''}<div>${esc(outcomeLabels[c.last_outcome]||c.last_outcome||'—')}</div>${c.last_detail?`<div class="subtle">${esc(c.last_detail)}</div>`:''}`:'<span class="subtle">لم يُسجّل البوت منشورًا من هذه القناة بعد تثبيت هذا التحديث.</span>';
      const lastLesson=c.latest_lesson_id?`${esc(c.lesson_subject_name||'—')}<div class="subtle">الدرس #${esc(c.latest_lesson_id)} · ${stamp(c.latest_lesson_at)} · الرسالة #${esc(c.latest_lesson_message_id||'—')}</div>${Number(c.lesson_stage_id)!==Number(c.stage_id)?`<div><span class="tag danger">فُعّل سابقًا لمرحلة ${esc(c.lesson_stage_name||c.lesson_stage_id)}</span></div>`:''}`:'<span class="subtle">لا يوجد درس مفعّل تلقائيًا من هذا Chat ID.</span>';
      const problems=(c.problems||[]).map(p=>`<div style="margin:.25rem 0"><span class="tag ${p.severity==='error'?'danger':'warn'}">${p.severity==='error'?'خلل':'تنبيه'}</span> ${esc(p.text)}</div>`).join('');
      return [
        `<b>${esc(c.observed_title||c.title||'قناة بلا عنوان')}</b><div class="subtle">DB title: ${esc(c.title||'—')}</div><div><bdi dir="ltr">${esc(c.telegram_chat_id)}</bdi></div>`,
        `${esc(c.stage_name)} <span class="subtle">(stage_id ${esc(c.stage_id)})</span><div>${esc(c.season_name||'لا يوجد موسم')} <span class="subtle">(stage_season_id ${esc(c.stage_season_id||'—')})</span></div>${Number(c.season_stage_id)!==Number(c.stage_id)?'<div><span class="tag danger">الموسم لا يطابق المرحلة</span></div>':''}`,
        c.public_link?`<bdi dir="ltr">${esc(c.public_link)}</bdi>${c.public_username?`<div class="subtle">username المتوقع: @${esc(c.public_username)}</div>`:''}`:'<span class="subtle">لا يوجد رابط ظاهر محفوظ</span>',
        received,
        lastLesson,
        `${healthTag(c.health)}${problems||'<div class="subtle">لا يظهر تعارض في المرحلة أو الموسم أو آخر درس.</div>'}`
      ];
    })
  ):empty('لا توجد قنوات مرتبطة بعد');
  const channelsBody=data.channels.length?table(['القناة','المرحلة','الحالة','الإجراء'],data.channels.map(c=>[esc(c.title||c.telegram_chat_id),esc(c.stage_name),c.season_is_active?'<span class="tag ok">نشطة</span>':'<span class="tag danger">متوقفة — انتهى موسمها</span>',button('فكّ الربط','channel-unlink',`data-id="${c.id}" data-title="${esc(c.title||c.telegram_chat_id)}"`,'danger')])):empty('لا توجد قنوات مرتبطة بعد');
  setContent(head('القنوات','الفحص العميق يطابق Telegram Chat ID مع المرحلة والموسم والرابط، ويعرض آخر منشور وصل فعليًا للبوت وآخر درس فُعّل من القناة.',button('إعادة الفحص الآن','channels-refresh','','primary'))+
    `<div class="summary"><div><b>${esc(summary.total)}</b>قناة</div><div><b>${esc(summary.ok)}</b>سليمة</div><div><b>${esc(summary.warn)}</b>تنبيه</div><div><b>${esc(summary.error)}</b>خلل مؤكد</div><div><b>${esc(summary.unknown)}</b>بانتظار منشور</div></div>`+
    '<div class="empty" style="text-align:right;margin-bottom:1.2rem"><p style="margin:0"><b>طريقة الحسم:</b> أرسل ملفًا صوتيًا أو #هاشتاغ في القناة المشكوك بها، ثم اضغط «إعادة الفحص الآن». إذا ظهر وقت المنشور هنا فالبوت استلمه، وستظهر نتيجة المعالجة وسبب عدم التفعيل. إذا لم يتغير «آخر منشور» فالمشكلة قبل قاعدة البيانات/منطق الدرس، أي في وصول تحديث القناة إلى البوت أو صلاحياته.</p></div>'+
    '<h2>الفحص العميق للقنوات</h2>'+deepBody+'<h2>تنبيهات — منشورات لم تُفعِّل دروسًا</h2>'+alertsBody+'<h2>إدارة القنوات المرتبطة</h2>'+channelsBody);
}
async function refresh(){if(view==='student-search')return loadStudentSearch();if(view==='student-contact')return loadStudentContact();if(view==='lesson-attendance')return attendanceHome();if(view==='stage'){currentStage=await api('/stages/'+currentStage.id+(currentSeasonId?'?seasonId='+currentSeasonId:''));return renderStage();}if(view==='leaves')return allLeaves();if(view==='teachers')return loadTeachers();if(view==='schedule-matrix')return loadScheduleMatrix();if(view==='lesson-schedule')return loadLessonSchedule();if(view==='lesson-management')return loadLessonManagement();if(view==='channels')return loadChannels();return home();}
$('#detail').addEventListener('cancel',()=>{dismissedWhileBusy=busy;dialogSequence++;});
document.addEventListener('click',async event=>{
  const target=event.target.closest('[data-action]');if(!target)return;const a=target.dataset.action;
  if(confirmationPending)abandonConfirm();
  if(a==='close-dialog'){dismissedWhileBusy=busy;closeDetail();return;}
  if(busy){notify('جارٍ إكمال العملية. ستعود الأزرار تلقائيًا عند اكتمال الطلب أو انتهاء مهلة الاتصال.');return;}
  dismissedWhileBusy=false;
  if(target.closest('form')&&target.type==='submit')event.preventDefault();
  clearNotice();
  try{
    if(a==='home')await home();
    else if(a==='lesson-attendance'){page=0;await attendanceHome();}
    else if(a==='student-search'){page=0;await loadStudentSearch();}
    else if(a==='search-student'){
      // نحمّل مرحلة الطالب كي تعمل بقية أدوات ملفه (المجموعات والنقل) كما لو فُتح من المرحلة.
      try{currentStage=await api('/stages/'+target.dataset.stage+(currentSeasonId?'?seasonId='+currentSeasonId:''));}catch{currentStage=null;}
      await showStudent(target.dataset.id);
    }
    else if(a==='select-all-missing'){const boxes=[...target.closest('form').querySelectorAll('input[name="lesson"]:not(:disabled)')];const all=boxes.every(b=>b.checked);boxes.forEach(b=>{b.checked=!all;});}
    else if(a==='stage')await openStage(target.dataset.id);
    else if(a==='stage-registration-toggle'){
      const currentlyVisible=target.dataset.visible==='true';
      const name=target.dataset.name||'هذه المرحلة';
      const question=currentlyVisible
        ? `حجب «${name}» عن الطلبة الذين يسجلون لأول مرة؟\n\nالطلبة الموجودون في المرحلة سيستمرون بشكل طبيعي ولن تتأثر دروسهم أو حضورهم.`
        : `إظهار «${name}» مجددًا ضمن خيارات التسجيل للطلبة الجدد؟`;
      if(!await confirmAction(question))return;
      busy=true;
      await api('/stages/'+target.dataset.id+'/registration-visibility',{visible:!currentlyVisible},'PATCH');
      await home();
      notify(currentlyVisible?'حُجبت المرحلة عن التسجيل الجديد فقط. الطلبة الحاليون لم يتأثروا.':'أصبحت المرحلة ظاهرة مجددًا للطلبة الذين يسجلون لأول مرة.');
    }
    else if(a==='tab'){tab=target.dataset.tab;page=0;await renderStage();}
    else if(a==='prev'||a==='next'){page+=a==='next'?1:-1;await refresh();}
    else if(a==='all-leaves'){page=0;await allLeaves();}
    else if(a==='student-contact'){contactPage=0;await loadStudentContact();}
    else if(a==='contact-prev'||a==='contact-next'){contactPage+=a==='contact-next'?1:-1;await loadStudentContact();}
    else if(a==='contact-student')await openStudentContact(target.dataset.id,target.dataset.contextKind||null,target.dataset.contextId||null);
    else if(a==='student')await showStudent(target.dataset.id);
    else if(a.startsWith('new-'))await newForm(a.slice(4));
    else if(a==='exam')await showExam(target.dataset.id);
    else if(a==='lesson-publication-repair')await publicationRepairDialog();
    else if(a==='scheduled-lesson-publish')await publishScheduledLessonDialog(target.dataset.subject,target.dataset.date);
    else if(a==='lesson-republish'){
      if(!await confirmAction('إعادة نشر هذا الدرس لمدة 24 ساعة من الآن وإشعار الطلبة؟ يبقى رقم الدرس وكل حضوره السابق محفوظًا.'))return;
      const r=await api('/lessons/'+target.dataset.id+'/republish',{expectedSubjectId:target.dataset.subject},'POST');
      await loadLessonManagement();notify(r.created?'أعيد نشر الدرس لمدة 24 ساعة وحُفظ إشعار الطلبة للإرسال.':'سبق استرجاع هذا الدرس؛ لم تُمدد المدة.');
    }
    else if(a==='lesson-correct')await correctLessonDialog(target.dataset.id);
    else if(a==='session-selected')await studentOverrideDialog('session',target.dataset.id);
    else if(a==='lesson-late')await studentOverrideDialog('lesson',target.dataset.id);
    else if(a==='lesson-attendance-remove')await removeAttendanceDialog(target.dataset.id);
    else if(a==='remove-attendance-page'&&removeAttendanceState)
      await removeAttendanceDialog(removeAttendanceState.id,Number(target.dataset.page),removeAttendanceState.q);
    else if(a==='remove-lesson-attendance'){
      if(!await confirmAction(`حذف حضور الطالب «${target.dataset.name}» من الدرس #${target.dataset.id} فقط؟`))return;
      busy=true;
      await api('/lessons/'+target.dataset.id+'/attendance/'+target.dataset.student+'/remove',{},'POST');
      await loadLessonManagement();
      await removeAttendanceDialog(target.dataset.id,removeAttendanceState?.page||0,removeAttendanceState?.q||'');
      notify('حُذف حضور الطالب من هذا الدرس وأُعيد حساب الغياب.');
    }
    else if(a==='exam-student-window')await studentOverrideDialog('exam',target.dataset.id);
    else if(a==='override-prev'||a==='override-next')await loadOverrideStudents(adminSelection.page+(a==='override-next'?1:-1));
    else if(a==='remove-slot'){if(!await confirmAction('إيقاف هذا الموعد الأسبوعي؟ تبقى سجلاته السابقة محفوظة.'))return;busy=true;await api('/schedule/'+target.dataset.id+'/remove',{},'POST');await refresh();}
    else if(a==='remove-question'){if(!await confirmAction('حذف هذا السؤال؟'))return;busy=true;await api('/questions/'+target.dataset.id+'/remove',{},'POST');await showExam(currentExam.id);}
    else if(a==='edit-question'){
      const q=currentExam?.questions.find(item=>String(item.id)===target.dataset.id);if(!q)return;
      dialog('تعديل سؤال',`<form id="update-question" data-id="${q.id}"><label>النوع<select name="type"><option value="tf" ${q.question_type==='tf'?'selected':''}>صح أو خطأ</option><option value="mcq" ${q.question_type==='mcq'?'selected':''}>اختيار متعدد</option></select></label><label>نص السؤال<textarea name="prompt" maxlength="3000" required>${esc(q.prompt)}</textarea></label><label>الخيارات: كل خيار في سطر للاختيار المتعدد<textarea name="options">${esc((q.options||[]).join('\n'))}</textarea></label><label>الإجابة الصحيحة<input name="correct" value="${esc(q.correct_answer)}" maxlength="300" required></label><div class="form-actions"><button class="primary">حفظ السؤال</button></div></form>`);
    }
    else if(a==='delete-exam'){if(!await confirmAction('حذف الامتحان وأسئلته؟'))return;busy=true;await api('/exams/'+target.dataset.id+'/delete',{},'POST');closeDetail();await refresh();notify('حُذف الامتحان.');}
    else if(a==='publish-exam'){if(!await confirmAction('نشر الامتحان وإرسال إشعارات للطلبة؟ تصبح أسئلته محمية من التعديل.'))return;busy=true;await api('/exams/'+currentExam.id+'/publish',{},'POST');await showExam(currentExam.id);notify('نُشر الامتحان وحُفظت إشعارات الطلبة للإرسال.');}
    else if(a==='leave'){
      if(!await confirmAction(target.dataset.approve==='true'?(target.dataset.exception==='true'?'الموافقة استثنائيًا على هذا الطلب الطارئ خارج الأيام العشرة؟':'الموافقة على طلب الإجازة؟'):'رفض طلب الإجازة؟'))return;
      busy=true;await api('/leaves/'+target.dataset.id+'/decision',{approve:target.dataset.approve==='true',exceptionApproval:target.dataset.exception==='true'},'POST');await refresh();if(target.dataset.profile)await showStudent(target.dataset.profile);notify('حُفظ القرار.');
    }else if(a==='leave-reduce'){
      dialog('تقليل أيام الإجازة',`<p>المدة الحالية ${Number(target.dataset.days)} يومًا. تبقى البداية نفسها وتقصّر النهاية تلقائيًا. يُصحح الرصيد والغياب ويُشعَر الطالب.</p><form id="reduce-leave" data-id="${target.dataset.id}" data-days="${target.dataset.days}" data-status="${esc(target.dataset.status)}" data-profile="${target.dataset.profile||''}"><label>عدد الأيام الجديد<input name="days" type="number" min="1" max="${Number(target.dataset.days)-1}" step="1" required></label><div class="form-actions"><button class="primary" type="submit">حفظ تقليل الأيام</button>${button('إلغاء','close-dialog')}</div></form>`);
    }else if(a==='leave-cancel-admin'){
      if(!await confirmAction('إلغاء الإجازة بالكامل؟ يُعاد الرصيد الاعتيادي وتُراجع أيام الغياب ويُشعَر الطالب.'))return;
      busy=true;await api('/leaves/'+target.dataset.id+'/cancel',{expectedDays:Number(target.dataset.days),expectedStatus:target.dataset.status},'POST');await refresh();if(target.dataset.profile)await showStudent(target.dataset.profile);notify('ألغيت الإجازة وصُحح الرصيد والغياب.');
    }else if(a==='archive'){
      if(!await confirmAction(target.dataset.active==='true'?'إعادة تفعيل الطالب؟':'أرشفة الطالب مع الاحتفاظ بسجله؟'))return;
      busy=true;await api('/students/'+target.dataset.id,{active:target.dataset.active==='true'},'PATCH');closeDetail();await refresh();notify('حُفظت حالة الطالب.');
    }else if(a==='end-session'){
      if(!await confirmAction('إنهاء هذه المباحثة وفتح الحضور الثاني؟'))return;busy=true;const result=await api('/sessions/'+target.dataset.id+'/end',{},'POST');await refresh();notify(result.status==='already_open'?'حضور النهاية مفتوح بالفعل؛ لم تتغير مهلته.':'فُتح الحضور الثاني وحُفظت إشعارات الطلبة للإرسال.');
    }else if(a==='report'){
      const r=window.currentReports.find(x=>String(x.id)===target.dataset.id);if(!r)return;
      dialog('مراجعة التقرير',`<h3>${esc(r.full_name)} — ${esc(r.subject_name)}</h3><p>${esc(r.group_title_snapshot||'سجل قديم بلا مجموعة موثقة')} · ${stamp(r.submitted_at)}</p><div class="report-note">${esc(r.note||'التقرير مرفق كملف.')}</div>${button('إرسال المرفق إلى حسابي في البوت','report-send',`data-id="${r.id}"`)}${button('التواصل مع الطالب','contact-student',`data-id="${r.student_id}"`)}<form id="grade-report" data-id="${r.id}" class="detail-section"><label>درجة التقرير من 15<input name="score" type="number" min="0" max="15" step="0.01" value="${esc(r.score??'')}" required></label><div class="form-actions"><button class="primary">حفظ التقييم</button></div></form>`);
    }else if(a==='report-send'){busy=true;await api('/reports/'+target.dataset.id+'/send',{},'POST');notify('أُدرج التقرير للإرسال إلى حسابك في البوت.');}
    else if(a==='attendance-export'){
      busy=true;const query=new URLSearchParams({stageId:target.dataset.stage,...attendanceFilters,...(currentSeasonId?{seasonId:currentSeasonId}:{})});
      const blob=await api('/lesson-attendance.md?'+query,undefined,'GET','blob');
      const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='lesson-attendance-'+target.dataset.stage+'.md';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);notify('تم تنزيل جميع النتائج المطابقة بصيغة MD.');
    }
    else if(a==='export'){
      busy=true;const season=$('#export-season').value;const blob=await api(`/attendance.md?seasonId=${season}&kind=${target.dataset.kind}`,undefined,'GET','blob');
      const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`attendance-${season}-${target.dataset.kind}.md`;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);notify('تم تجهيز ملف MD.');
    }else if(a==='audit'){
      view='audit';setNav('audit');$('#breadcrumb').textContent='المعهد / سجل التعديلات';const id=++sequence;const rows=await api('/audit');if(id===sequence)setContent(head('سجل التعديلات','آخر 25 عملية مسجلة')+table(['التاريخ','المسؤول','العملية','السجل','التفاصيل'],rows.map(r=>[stamp(r.created_at),esc(r.actor_id),esc(actionLabels[r.action]||r.action),`${esc(entityLabels[r.entity_type]||r.entity_type)} #${r.entity_id}`,r.action==='change_participation_mode'?('المادة: '+esc(r.after_data?.subject_name||r.after_data?.subject_id)+' · الموسم #'+esc(r.after_data?.stage_season_id)+' · من '+modeTag(r.before_data?.mode)+' إلى '+modeTag(r.after_data?.mode)):r.action==='correct_lesson_subject'?`${esc(r.before_data?.subject_name)} ← ${esc(r.after_data?.subject_name)}`:r.action==='late_lesson_attendance'?`${esc(r.after_data?.subject_name)} · الطلبة: ${esc(r.after_data?.student_ids?.join('، '))} · ${esc(r.after_data?.note||'')}`:r.action==='reopen_student_exam'?`الطالب #${esc(r.after_data?.student_id)} · ${stamp(r.after_data?.opens_at)} ← ${stamp(r.after_data?.closes_at)} · ${esc(r.after_data?.note||'')}`:r.action==='toggle_stage_registration_visibility'?(r.after_data?.registration_visible?'أصبحت ظاهرة للطلبة الجدد':'حُجبت عن الطلبة الجدد فقط'):'—'])));
    }else if(a==='notifications'){
      view='notifications';setNav('notifications');$('#breadcrumb').textContent='المعهد / حالة الإشعارات';const id=++sequence;const rows=await api('/notifications');if(id===sequence)setContent(head('حالة الإشعارات','الإشعارات المجدولة المحفوظة؛ المحاولات المؤقتة يعاد إرسالها تلقائيًا.')+table(['الحالة','العدد'],rows.map(r=>[esc(labels[r.status]||r.status),esc(r.count)])));
     }else if(a==='matrix-add'){
      const g=matrixDetail?.groups.find(x=>String(x.id)===target.dataset.group);if(!g||g.is_active===false)return;
      const assigned=matrixDetail.subjects.find(x=>x.id===g.subject_id)?.teachers||[];
      if(!assigned.length)throw Error('أسند أستاذًا نشطًا لهذه المادة أولًا.');
      dialog('إضافة موعد — '+g.title,`<form id="matrix-slot"><input type="hidden" name="groupId" value="${g.id}"><input type="hidden" name="dayOfWeek" value="${matrixDay}"><input type="hidden" name="hour" value="${Number(target.dataset.hour)}"><p>${esc(DAY_NAMES[matrixDay])} — الساعة ${Number(target.dataset.hour)} بتوقيت بغداد</p><label>الأستاذ<select name="teacherId" required>${assigned.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label><label>الدقيقة<input name="minute" type="number" min="0" max="59" value="0" required></label><p class="subtle">مدة المباحثة ساعة. يمنع النظام تعارض مواعيد الأستاذ والمجموعة.</p><button class="primary" type="submit">حفظ الموعد ✓</button></form>`);
    }else if(a==='matrix-remove'){
      if(!await confirmAction('إيقاف هذا الموعد الأسبوعي؟ تبقى سجلات الحضور السابقة محفوظة.'))return;
      busy=true;await api('/schedule/'+target.dataset.id+'/remove',{},'POST');await renderScheduleMatrix();
    }else if(a==='teachers')await loadTeachers();
    else if(a==='schedule-matrix')await loadScheduleMatrix();
    else if(a==='lesson-schedule')await loadLessonSchedule();
    else if(a==='lesson-management')await loadLessonManagement();
    else if(a==='management-page'){
      if(target.dataset.kind==='lessons'){mgtPage=Number(target.dataset.page);await loadLessonManagement();}
      else{sessionPage=Number(target.dataset.page);await renderStage();}
    }
    else if(a==='session-notifications')await showSessionNotifications(target.dataset.id);
    else if(a==='session-retry-notifications'){
      if(!await confirmAction('إعادة محاولة إرسال الإشعارات غير المرسلة للطلبة المؤهلين؟ تبقى نهاية الفرصة كما هي ولا تتكرر الرسائل المرسلة.'))return;
      busy=true;const r=await api('/sessions/'+target.dataset.id+'/retry-notifications',{},'POST');
      await showSessionNotifications(target.dataset.id);notify(sessionNoticeSummary(r.notifications),!r.notifications.counts.total);
    }
    else if(['session-reopen','session-markall','session-cancel'].includes(a)){
      const action=a==='session-markall'?'mark-all':a.slice('session-'.length);
      const messages={reopen:'إعادة فتح حضور بداية ونهاية هذه المباحثة لمدة 10 دقائق من الآن؟ يبقى موعد المباحثة والحضور السابق محفوظين.',
        'mark-all':'تسجيل البداية والنهاية لطلبة المجموعة النشطين المؤهلين لهذه المباحثة؟',cancel:'حذف المباحثة نهائيًا مع حضورها؟ لن يعيد الجدول إنشاءها تلقائيًا لهذا الموعد. لا يمكن التراجع.'};
      if(!await confirmAction(messages[action]))return;
      busy=true;const r=await api('/sessions/'+target.dataset.id+'/'+action,{},'POST');await renderStage();
      notify(action==='mark-all'?`اكتمل حضور ${r.added} طالبًا؛ أضيف ${r.records} تسجيلًا جديدًا.`:action==='cancel'?'حُذفت المباحثة وحضورها.':`أُعيد فتح حضور البداية والنهاية حتى ${stamp(r.attendance_reopen_until)} (10 دقائق من إعادة الفتح). ${sessionNoticeSummary(r.notifications)}`,action==='reopen'&&r.notifications?.counts.total===0);
    }
    else if(a==='lesson-reopen'){
      if(!await confirmAction(`إعادة فتح درس «${target.dataset.subject}» للوقت المتبقي من 24 ساعة منذ ${target.dataset.recovered==='1'?'استرجاع الدرس':'النشر الأصلي'}، مع حفظ الحضور السابق؟`))return;
      busy=true;await api('/lessons/'+target.dataset.id+'/reopen',{},'POST');notify('أُعيد فتح الدرس للوقت المتبقي من مهلة حضوره الأصلية.');await loadLessonManagement();
    }else if(a==='lesson-markall'){
      if(!await confirmAction(`تسجيل جميع طلبة المرحلة النشطين حاضرين لدرس «${target.dataset.subject}»، بمن فيهم من لم يستمع فعليًا؟`))return;
      busy=true;const r=await api('/lessons/'+target.dataset.id+'/mark-all',{},'POST');notify(`سُجِّل ${r.added} طالبًا حاضرًا لم يكونوا مؤشَّرين سابقًا.`);await loadLessonManagement();
    }else if(a==='lesson-cancel'){
      if(!await confirmAction(`حذف درس «${target.dataset.subject}» نهائيًا مع كل حضور مسجَّل عليه؟ لا يمكن التراجع.`))return;
      busy=true;await api('/lessons/'+target.dataset.id+'/cancel',{},'POST');notify('أُلغي تفعيل الدرس وحُذف أي حضور مسجَّل عليه.');await loadLessonManagement();
    }else if(a==='channels'||a==='channels-refresh')await loadChannels();
    else if(a==='channel-unlink'){
      if(!await confirmAction(`فكّ ربط قناة «${target.dataset.title}» عن مرحلتها؟ تبقى الدروس والحضور السابقة محفوظة، ولن تُفعّل دروسًا جديدة.`))return;
      busy=true;await api('/channels/'+target.dataset.id+'/unlink',{},'POST');notify('فُكّ ربط القناة.');await loadChannels();
    }
    else if(a==='schedule-month-toggle'){
      const open=target.getAttribute('aria-expanded')!=='true';
      document.querySelectorAll(`.lesson-schedule tr[data-month="${target.dataset.month}"]`).forEach(r=>{r.hidden=!open;});
      target.setAttribute('aria-expanded',String(open));target.querySelector('.month-arrow').textContent=open?'▾':'◂';
    }
    else if(a==='schedule-months-all'){
      const toggles=[...document.querySelectorAll('.lesson-schedule .month-toggle')];
      const openAll=toggles.some(b=>b.getAttribute('aria-expanded')!=='true');
      for(const b of toggles){
        const open=openAll||b.dataset.month===target.dataset.current;
        document.querySelectorAll(`.lesson-schedule tr[data-month="${b.dataset.month}"]`).forEach(r=>{r.hidden=!open;});
        b.setAttribute('aria-expanded',String(open));b.querySelector('.month-arrow').textContent=open?'▾':'◂';
      }
      target.textContent=openAll?'طي الأشهر عدا الحالي':'فتح كل الأشهر';
    }
    else if(a==='lesson-schedule-toggle'){
      busy=true;const next=target.dataset.checked!=='true';
      try{
        await api('/lesson-schedule',{stageSeasonId:lessonScheduleData.stage_season_id,subjectId:Number(target.dataset.subjectId),lessonDate:target.dataset.date,checked:next},'POST');
        target.dataset.checked=next?'true':'false';
        target.classList.toggle('checked',next);
        target.textContent=next?'✓':'·';
        const key=`${target.dataset.subjectId}:${target.dataset.date}`;
        if(next){
          if(!lessonScheduleData.entries.some(e=>`${e.subject_id}:${e.lesson_date}`===key)){
            lessonScheduleData.entries.push({subject_id:Number(target.dataset.subjectId),lesson_date:target.dataset.date});
          }
        }else{
          lessonScheduleData.entries=lessonScheduleData.entries.filter(e=>`${e.subject_id}:${e.lesson_date}`!==key);
        }
        const summary=document.querySelector('.lesson-schedule-summary-count');
        if(summary)summary.textContent=String(lessonScheduleData.entries.length);
        const monthKey=target.closest('tr')?.dataset.month;
        const planned=document.querySelector(`.lesson-schedule .month-toggle[data-month="${monthKey}"] .month-planned`);
        if(planned)planned.textContent=String(document.querySelectorAll(`.lesson-schedule tr[data-month="${monthKey}"] .schedule-check.checked`).length);
        notify(next?'تمت إضافة تاريخ النشر إلى الجدول.':'أزيل تاريخ النشر من الجدول.');
      }catch(e){notify(e.message,true);}finally{busy=false;}
    }
    else if(a==='student-participation'){
      const s=currentStudent?.subjects?.find(s=>String(s.subject_id)===target.dataset.subject&&String(s.stage_season_id)===target.dataset.season);
      if(!s)return;
      const mode=target.dataset.mode;
      if(!await confirmAction(`تحويل متابعة «${s.subject_name}» إلى ${mode==='report'?'تقارير':'مباحثات'} لهذا الطالب فقط؟ تبقى سجلاته السابقة وبقية مواده كما هي.`))return;
      busy=true;const studentId=currentStudent.id;
      await api('/students/'+studentId+'/subjects/'+s.subject_id+'/participation',{seasonId:s.stage_season_id,mode,expectedMode:s.mode??null},'PATCH');
      await refresh();await showStudent(studentId);notify('حُفظ نوع المتابعة لهذه المادة فقط.');
    }
    else if(a==='stats')await loadStats();
    else if(a==='schedule-batch-import'){
      const state=await api('/schedule-batch-import');
      if(!state.available)throw Error(state.completed?'استُخدم زر إدخال الجدول سابقًا.':(state.errors||[]).join(' '));
      dialog('إدخال جداول المباحثات لمرة واحدة',`<p>سيُضاف ${esc(state.appointments)} موعدًا أسبوعيًا لجميع ${esc(state.groups)} مجموعة في الملف. جلستا كل مجموعة في يومين مختلفين، من السبت إلى الأربعاء الساعة 7 أو 8 مساءً بتوقيت بغداد.</p><p>سيُضاف ${esc(state.assignmentsToAdd)} إسناد أستاذ غير موجود في القاعدة. الإسنادات السابقة تبقى محفوظة.</p><h3>مطابقة مواد الإكسل مع قاعدة البيانات</h3>${table(['السطر','المادة في الإكسل','المادة في القاعدة','الأستاذ'],state.mapping.map(x=>[esc(x.workbookRow),esc(x.workbookSubject),`${esc(x.stageName)} · ${esc(x.subjectName)}`,esc(x.teacherName)]))}${state.otherAssignments.length?`<h3>مواد لها إسناد سابق لأستاذ آخر</h3>${table(['سطر الإكسل','المادة','الأستاذ المسند سابقًا'],state.otherAssignments.map(x=>[esc(x.workbookRow),esc(x.subject),esc(x.teacherName)]))}`:''}<h3>الوقت المتبقي لكل أستاذ بعد الإدخال</h3>${scheduleFreeTable(state.plannedAvailability)}<div class="form-actions">${button('تأكيد إدخال جميع المواعيد','schedule-batch-import-confirm','','primary')}</div>`);
    }else if(a==='schedule-batch-import-confirm'){
      busy=true;const done=await api('/schedule-batch-import',{},'POST');closeDetail();await renderScheduleMatrix();notify(`أُدخل ${done.appointments} موعدًا، وأضيف ${done.addedAssignments} إسناد أستاذ. اختفى زر الإدخال لمرة واحدة.`);
    }
    else if(a==='watchlist')await loadWatchlist();
    else if(a==='teacher-performance')await showTeacherPerformance(target.dataset.id);
    else if(a==='matrix-day'){matrixDay=Number(target.dataset.day);await renderScheduleMatrix();}
    else if(a==='add-teacher'){dialog('إضافة أستاذ','<form id="create-teacher"><div class="form-grid"><label>الاسم الرباعي<input name="fullName" maxlength="200" required></label><label>الهاتف (اختياري)<input name="phone" maxlength="30"></label></div><div class="form-actions"><button class="primary">حفظ</button></div></form>');}
    else if(a==='edit-teacher'){const t=teachers.find(x=>String(x.id)===target.dataset.id);if(!t)return;dialog('تعديل اسم الأستاذ',`<form id="edit-teacher" data-id="${t.id}"><label>الاسم الرباعي<input name="fullName" value="${esc(t.full_name)}" maxlength="200" required></label><div class="form-actions"><button class="primary">حفظ</button></div></form>`);}
    else if(a==='toggle-teacher'){
      const active=target.dataset.active==='true';if(!await confirmAction(active?'إعادة تفعيل حساب الأستاذ؟':'إيقاف حساب الأستاذ؟ لن يستطيع الدخول لواجهته حتى إعادة التفعيل.'))return;
      busy=true;await api('/teachers/'+target.dataset.id+'/toggle',{active},'POST');notify('حُفظت حالة الأستاذ.');await loadTeachers();
    }else if(a==='regenerate-code'){
      if(!await confirmAction('توليد كود ربط جديد؟ سيُفصل الحساب المرتبط حاليًا إن وجد، ويحتاج الأستاذ لإرسال الكود الجديد للبوت.'))return;
      busy=true;const r=await api('/teachers/'+target.dataset.id+'/regenerate-code',{},'POST');await loadTeachers();
      dialog('كود الربط الجديد',`<p>أرسل هذا الكود إلى الأستاذ ليُدخله في البوت لربط حسابه:</p><div class="link-code">${esc(r.link_code)}</div>`);
    }else if(a==='teacher-subjects'){
      const t=teachers.find(x=>String(x.id)===target.dataset.id);if(!t)return;currentTeacher=t;
      const subjects=await api('/teachers/'+t.id+'/subjects');
      dialog('مواد '+t.full_name,subjects.length?table(['المادة','المرحلة','الموسم','الطلبة النشطون','إلغاء الإسناد'],subjects.map(sj=>[esc(sj.subject_name),esc(sj.stage_name),esc(sj.season_name),esc(sj.student_count),button('إلغاء','unassign-teacher',`data-id="${sj.assignment_id}"`,'danger')])):empty('لا توجد مواد مسندة لهذا الأستاذ حاليًا','أسند مادة له من تبويب «المواد والمجموعات» داخل المرحلة.'));
    }else if(a==='unassign-teacher'){
      if(!await confirmAction('إلغاء إسناد هذه المادة عن الأستاذ؟'))return;busy=true;await api('/assignments/'+target.dataset.id+'/remove',{},'POST');
      if(currentTeacher){const subjects=await api('/teachers/'+currentTeacher.id+'/subjects');dialog('مواد '+currentTeacher.full_name,subjects.length?table(['المادة','المرحلة','الموسم','الطلبة النشطون','إلغاء الإسناد'],subjects.map(sj=>[esc(sj.subject_name),esc(sj.stage_name),esc(sj.season_name),esc(sj.student_count),button('إلغاء','unassign-teacher',`data-id="${sj.assignment_id}"`,'danger')])):empty('لا توجد مواد مسندة لهذا الأستاذ حاليًا'));}
      notify('أُلغي إسناد المادة.');
    }else if(a==='edit-subject'){
      const sub=currentStage?.subjects.find(x=>String(x.id)===target.dataset.id);if(!sub||currentStage.is_historical)return;
      dialog('تعديل اسم المادة',`<p>يتحدث اسم المادة في الشاشات والتقارير لكل مواسمها. هاشتاغ النشر الحالي: <bdi>#${esc(sub.hashtag)}</bdi>.</p>
        <form id="edit-subject" data-id="${sub.id}"><input type="hidden" name="expectedName" value="${esc(sub.name)}"><input type="hidden" name="stageSeasonId" value="${currentStage.stage_season_id}">
        <label>اسم المادة<input name="name" value="${esc(sub.name)}" minlength="2" maxlength="100" required></label><div class="form-actions"><button class="primary" type="submit">حفظ اسم المادة</button>${button('إلغاء','close-dialog')}</div></form>`);
    }else if(a==='edit-group'){
      const g=currentStage?.groups.find(x=>String(x.id)===target.dataset.id);if(!g)return;
      dialog('تعديل '+g.title,`<p>${currentStage.discussion_grouping===false?`الأعضاء في هذه المادة: ${esc(g.member_count)}`:`الأعضاء في هذه المادة: ${esc(g.member_count)} · المقاعد المحجوزة لرقم المجموعة عبر المواد: ${esc(g.reserved_count)} من ${esc(g.capacity)}`}</p><form id="edit-group" data-id="${g.id}"><div class="form-grid"><label>السعة<input name="capacity" type="number" min="1" max="10000" value="${g.capacity}" required></label><label>رابط المجموعة<input name="inviteLink" type="url" value="${esc(g.invite_link||'')}" placeholder="https://t.me/..."></label></div><div class="form-actions"><button class="primary">حفظ</button>${button(g.is_active?'تعطيل المجموعة':'تفعيل المجموعة','toggle-group',`data-id="${g.id}" data-active="${!g.is_active}"`,g.is_active?'danger':'')}</div></form>`);
    }else if(a==='one-time-cohort-move'){
      const move=await api('/one-time-cohort-move');
      if(!move.available)throw Error(move.completed?'استُخدم زر النقل سابقًا.':'لم تعد شروط النقل متاحة.');
      dialog('نقل 13 طالبًا من المجموعة 1 إلى 2',`<p>هذه قائمة حجوزات النظام، ولا تؤكد العضوية الفعلية في تليجرام. اختر فقط من تحققت بنفسك من عدم انضمامهم إلى مجموعات رقم 1. سيُوحّد الرقم 2 في جميع مواد الطلاب المختارين.</p><form id="one-time-cohort-move"><p id="one-time-move-count">المحدد: 0 من 13</p>${table(['اختيار','الطالب','مواد مسجلة في النظام'],move.students.map(st=>[`<input type="checkbox" name="studentId" value="${esc(st.id)}">`,esc(st.full_name),`${esc(st.subject_count)} · ${esc(st.subjects)}`]))}<div class="form-actions"><button class="primary" type="submit">نقل المحددين لمرة واحدة</button></div></form>`);
    }else if(a==='toggle-group'){
      const active=target.dataset.active==='true';if(!await confirmAction(active?'إعادة تفعيل المجموعة؟':'تعطيل المجموعة؟ يبقى سجلها محفوظًا.'))return;
      busy=true;await api('/groups/'+target.dataset.id,{active},'PATCH');closeDetail();await refresh();notify('حُفظت حالة المجموعة.');
    }else if(a==='logout'){if(token)await api('/logout',{},'POST');token='';sequence++;closeDetail();setContent(empty('انتهت جلسة الإدارة','أغلق النافذة وافتحها مجددًا من البوت للدخول.'));}
  }catch(e){notify(e.message,true);}finally{busy=false;}
});
document.addEventListener('change',async event=>{
  if(confirmationPending)return;
  if(event.target.closest('#participation-settings')){
    const changes=participationChanges(event.target.closest('form'));
    $('#participation-status').textContent=changes.rows.length?`لديك ${changes.rows.length} تغيير غير محفوظ. اضغط «مراجعة التغييرات قبل الحفظ» لعرض أثره.`:'لم تتغير الإعدادات المحفوظة.';
    return;
  }
  if(event.target.name==='studentId'&&event.target.closest('#one-time-cohort-move')){
    const count=document.querySelectorAll('#one-time-cohort-move input[name="studentId"]:checked').length;
    $('#one-time-move-count').textContent=`المحدد: ${count} من 13`;return;
  }
  if(event.target.name==='override-student'&&adminSelection){
    const id=Number(event.target.value);
    if(adminSelection.kind==='exam')adminSelection.selected.clear();
    if(event.target.checked)adminSelection.selected.set(id,event.target.dataset.name);
    else adminSelection.selected.delete(id);
    updateOverrideSelected();return;
  }
  const selected=event.target.value;
  clearNotice();
  try{
    if(event.target.name==='stageId'&&event.target.closest('#attendance-stage')){attendanceStageId=selected;page=0;await attendanceHome();}
    else if(event.target.name==='stageId'&&event.target.closest('#matrix-stage')){matrixStageId=selected;await renderScheduleMatrix();}
    else if(event.target.id==='lesson-schedule-stage'){lessonScheduleStageId=selected;await renderLessonSchedule(stages.filter(s=>s.stage_season_id));}
    else if(event.target.name==='stageId'&&event.target.closest('#lesson-mgt-stage')){mgtStageId=selected;mgtSubjectId='';mgtPage=0;await loadLessonManagement();}
    else if(event.target.id==='lesson-mgt-subject'){mgtSubjectId=selected;mgtPage=0;await loadLessonManagement();}
    else if(event.target.id==='session-mgt-subject'){sessionSubjectId=selected;sessionPage=0;await renderStage();}
    else if(event.target.id==='season-select'){currentSeasonId=selected;mgtSubjectId='';mgtPage=0;sessionSubjectId='';sessionPage=0;if(view==='lesson-management')await loadLessonManagement();else if(view==='stage'&&currentStage)await openStage(currentStage.id);else if(view==='lesson-attendance'){page=0;await attendanceHome();}else await home();}
  }catch(e){notify(e.message,true);}
});
document.addEventListener('submit',async event=>{
  const form=event.target;event.preventDefault();if(busy||confirmationPending)return;clearNotice();const body=Object.fromEntries(new FormData(form));
  busy=true;dismissedWhileBusy=false;const submit=form.querySelector('button[type="submit"],button:not([data-action])');if(submit)submit.disabled=true;
  const pendingText='جارٍ تنفيذ العملية…',pendingTimer=setTimeout(()=>notify(pendingText),300);
  try{
    if(form.id==='contact-search'){contactQuery=String(body.q||'').trim();contactPage=0;await loadStudentContact();}
    else if(form.id==='student-search-form'){studentSearch={q:String(body.q||''),status:['all','active','archived'].includes(body.status)?body.status:'all'};page=0;await loadStudentSearch();}
    else if(form.id==='student-late-form'){
      const ids=[...form.querySelectorAll('input[name="lesson"]:checked')].map(i=>Number(i.value));
      if(!ids.length)throw Error('حدّد درسًا واحدًا على الأقل.');
      if(!await confirmAction(`تسجيل حضور إداري متأخر للطالب «${form.dataset.name}» في ${ids.length} درسًا؟ يظهر في تقريره فورًا ويُسجَّل في سجل التعديلات.`))return;
      const r=await api('/students/'+form.dataset.student+'/late-attendance',{lessonIds:ids,note:String(body.note||'').trim()||null},'POST');
      await showStudent(form.dataset.student);if(view==='stage'||view==='student-search'||view==='lesson-attendance')await refresh();
      notify(`سُجّل حضور ${r.added} درسًا${r.existing?` (سبق تسجيل ${r.existing})`:''}. تغيّر تقرير الطالب وحساب غيابه.`);
    }
    else if(form.id==='remove-attendance-search'&&removeAttendanceState)
      await removeAttendanceDialog(removeAttendanceState.id,0,String(body.q||'').trim());
    else if(form.id==='contact-send'){
      if(!contactStudent)throw Error('اختر الطالب أولًا.');
      const saved=await api('/student-contact',{studentId:contactStudent.id,message:body.message,contextKind:contactStudent.contextKind,contextId:contactStudent.contextId,requestKey:form.dataset.requestKey||(form.dataset.requestKey=contactRequestKey('admin-web'))},'POST');
      await openStudentContact(contactStudent.id,contactStudent.contextKind,contactStudent.contextId);
      notify(`حُفظت الرسالة #${saved.id} للإرسال عبر البوت.`);
    }
    else if(form.id==='apply-publication-repair'){
      if(!body.reviewed||!publicationRepairState)throw Error('راجع الروابط والمواد أولًا.');
      if(!await confirmAction('تطبيق التصحيح المعروض وحفظ التسجيلات الأصلية وإشعار الطلبة بالقائمة الصحيحة؟'))return;
      await api('/lesson-publication-repair',{stageId:publicationRepairState.stageId,token:publicationRepairState.token},'POST');
      closeDetail();await loadLessonManagement();notify('صُححت الدروس وحُفظ الحضور الأصلي وسجل التصحيح.');
    }
    else if(form.id==='correct-lesson'){
      if(!await confirmAction('حفظ المادة الصحيحة مع الاحتفاظ بكل حضور الدرس؟'))return;
      await api('/lessons/'+form.dataset.id+'/subject',body,'PATCH');closeDetail();await loadLessonManagement();notify('حُفظت المادة وبقيت كل سجلات الحضور.');
    }else if(form.classList.contains('activate-scheduled-lesson')){
      if(!await confirmAction('تفعيل هذه المادة من الجدول بدون منشور؟ يُتاح الحضور 24 ساعة من الآن ويُبلَّغ الطلبة.'))return;
      const r=await api('/scheduled-lessons/activate',{stageSeasonId:body.stageSeasonId,subjectId:body.subjectId,scheduleDate:body.scheduleDate},'POST');
      closeDetail();await loadLessonManagement();notify('فُعّل الدرس وأتيح الحضور حتى '+stamp(r.lesson.active_until));
    }else if(form.classList.contains('restore-pending-lesson')){
      if(!body.subjectId)throw Error('اختر المادة الصحيحة.');
      if(!await confirmAction('ربط هذا المنشور بالمادة المختارة واسترجاعه؟ يبقى تاريخ نشره الأصلي للترقيم، ويتاح الحضور 24 ساعة من الآن.'))return;
      const r=await api('/pending-lessons/'+body.id+'/restore',{subjectId:body.subjectId,scheduleDate:body.scheduleDate,...(body.originalPublishedAt?{originalPublishedAt:body.originalPublishedAt+':00+03:00'}:{})},'POST');
      closeDetail();await loadLessonManagement();notify(r.created?'استُرجع الدرس وأتيح الحضور حتى '+stamp(r.lesson.active_until):'هذا المنشور مفعّل بالفعل؛ لم تُمدد مهلته أو يُكرر.');
    }else if(form.id==='override-search'){adminSelection.query=body.q;await loadOverrideStudents(0);}
    else if(form.id==='save-override'){
      const state=adminSelection,ids=[...state.selected.keys()];
      if(!ids.length)throw Error('حدد طالبًا واحدًا على الأقل.');
      if(state.kind==='session'){
        if(ids.length>500)throw Error('الحد الأقصى 500 طالب في العملية.');
        if(!await confirmAction(`إكمال حضور البداية والنهاية لـ ${ids.length} طالبًا في مباحثة ${state.item.subject_name} — ${state.item.group_title}، بتاريخ ${stamp(state.item.opened_at)}؟ يبقى الحضور السابق محفوظًا.`))return;
        const r=await api('/sessions/'+state.id+'/selected-attendance',{subjectId:state.item.subject_id,studentIds:ids,note:body.note},'POST');
        closeDetail();await renderStage();notify(`اكتمل حضور ${r.added} طالبًا في المباحثة؛ أضيف ${r.records} تسجيلًا.`);
      }else if(state.kind==='lesson'){
        if(ids.length>500)throw Error('الحد الأقصى 500 طالب في العملية.');
        if(!await confirmAction(`تسجيل حضور إداري متأخر لـ ${ids.length} طالبًا في ${state.item.subject_name}، الدرس #${state.id} المنشور ${stamp(state.item.activated_at)}؟`))return;
        const result=await api('/lessons/'+state.id+'/late-attendance',{subjectId:state.item.subject_id,studentIds:ids,note:body.note},'POST');
        closeDetail();await loadLessonManagement();notify(`أضيف حضور ${result.added} طالبًا. كان ${result.existing} مسجلًا مسبقًا.`);
      }else{
        if(ids.length!==1)throw Error('حدد طالبًا واحدًا فقط.');
        if(!body.opensAt||!body.closesAt)throw Error('أدخل وقت البداية والنهاية الجديدين.');
        const opensAt=body.opensAt+':00+03:00',closesAt=body.closesAt+':00+03:00';
        if(!(new Date(closesAt)>new Date(opensAt)))throw Error('نهاية النافذة يجب أن تكون بعد بدايتها.');
        if(!await confirmAction(`فتح ${state.item.subject_name} للطالب ${state.selected.get(ids[0])} فقط من ${stamp(opensAt)} إلى ${stamp(closesAt)}؟`))return;
        await api('/exams/'+state.id+'/student-window',{subjectId:state.item.subject_id,studentId:ids[0],opensAt,closesAt,note:body.note},'POST');
        await showExam(state.id);notify('حُفظت نافذة الفتح الخاصة بالطالب. يدخل إليها من الامتحانات الشهرية في البوت.');
      }
    }
    else if(form.id==='attendance-filter'){attendanceFilters={q:body.q,status:body.status};page=0;await refresh();}
    else if(form.id==='participation-settings')await reviewParticipation(form);
    else if(form.id==='apply-participation-settings'){
      const draft=participationDraft;
      if(!draft||!body.acknowledged)throw Error('راجع التغييرات وضع علامة التأكيد أولًا.');
      if(!await confirmAction(`حفظ التغييرات المعروضة في موسم «${draft.seasonName}» للمرحلة «${draft.stageName}»؟`))return;
      const saved=await api('/stage-seasons/'+draft.seasonId+'/participation-settings',{grouped:draft.grouped,enabledSubjectIds:draft.enabledSubjectIds,expectedSettings:draft.expectedSettings,confirmGroupingChange:true},'PATCH');
      participationDraft=null;closeDetail();await refresh();notify(saved.pausedSlots?'حُفظت الإعدادات ونُقل الطلبة. توقفت المواعيد المتعددة؛ حدّد موعدًا موحدًا لكل مادة مدمجة من جداول المباحثات.':'حُفظت إعدادات المباحثات والتقارير لهذا الموسم.');
    }
    else if(form.id==='search'){filters={...filters,...body};page=0;await renderStage();}
    else if(form.id==='leave-filter'){filters.leaveStatus=body.leaveStatus;page=0;await refresh();}
    else if(form.id==='reduce-leave'){
      if(!await confirmAction(`تقليل الإجازة من ${Number(form.dataset.days)} إلى ${Number(body.days)} يومًا؟ تُراجع الأيام التي حُذفت من الإجازة لاحتساب الغياب.`))return;
      await api('/leaves/'+form.dataset.id,{days:Number(body.days),expectedDays:Number(form.dataset.days),expectedStatus:form.dataset.status},'PATCH');closeDetail();await refresh();if(form.dataset.profile)await showStudent(form.dataset.profile);notify('قُلّلت الأيام وصُحح الرصيد والغياب.');
    }
    else if(form.id==='report-filter'){filters.groupId=body.groupId;page=0;await renderStage();}
    else if(form.id==='matrix-slot'){await api('/schedule',body,'POST');closeDetail();await renderScheduleMatrix();notify('حُفظ موعد المباحثة.');}
    else if(form.id==='edit-student'){await api('/students/'+currentStudent.id,{...body,expectedName:currentStudent.full_name},'PATCH');closeDetail();await refresh();notify('حُفظ اسم الطالب.');}
    else if(form.id==='move-group'){if(!await confirmAction('توحيد رقم المجموعة المختارة في جميع مواد الطالب لهذا الموسم؟ سيُرفض النقل كله إذا غابت مجموعة مطابقة أو امتلأت. تبقى التقارير السابقة محفوظة.'))return;await api('/students/'+currentStudent.id+'/group',body,'POST');closeDetail();await refresh();notify('وُحّد رقم المجموعة في مواد الطالب.');}
    else if(form.id==='one-time-cohort-move'){
      const studentIds=[...form.querySelectorAll('input[name="studentId"]:checked')].map(el=>Number(el.value));
      if(studentIds.length!==13)throw Error('اختر 13 طالبًا بالضبط.');
      if(!await confirmAction('تأكيد نقل هؤلاء الطلاب الثلاثة عشر من المجموعة 1 إلى المجموعة 2 في جميع موادهم؟ سيختفي هذا الزر بعد النجاح.'))return;
      const result=await api('/one-time-cohort-move',{studentIds},'POST');closeDetail();await refresh();notify(`نُقل ${result.moved} طالبًا إلى المجموعة 2. اختفى زر النقل لمرة واحدة.`);
    }
    else if(form.id==='move-stage'){if(!await confirmAction('نقل الطالب إلى المرحلة المختارة؟ يُحفظ حضوره السابق وتبدأ أهلية الدروس الجديدة من وقت النقل.'))return;await api('/students/'+currentStudent.id+'/stage',body,'POST');closeDetail();await refresh();notify('حُفظت المرحلة.');}
    else if(form.id==='exam-question'){body.options=body.type==='mcq'?body.options.split(/\r?\n/).map(s=>s.trim()).filter(Boolean):undefined;await api('/exams/'+currentExam.id+'/question',body,'POST');await showExam(currentExam.id);notify('أُضيف السؤال.');}
    else if(form.id==='update-question'){body.options=body.type==='mcq'?body.options.split(/\r?\n/).map(s=>s.trim()).filter(Boolean):undefined;await api('/questions/'+form.dataset.id+'/update',body,'POST');await showExam(currentExam.id);notify('حُفظ السؤال.');}
    else if(form.id==='update-exam'){await api('/exams/'+currentExam.id+'/update',body,'POST');await showExam(currentExam.id);notify('حُفظ الامتحان.');}
    else if(form.id==='postpone-exam'){if(!await confirmAction('تغيير موعد الامتحان؟'))return;await api('/exams/'+currentExam.id+'/postpone',body,'POST');await showExam(currentExam.id);notify('حُفظ الموعد.');}
    else if(form.id==='cancel-exam'){if(!await confirmAction('إلغاء الامتحان وإشعار الطلبة؟ لا يمكن إلغاء امتحان بدأه طالب.'))return;const result=await api('/exams/'+currentExam.id+'/cancel',body,'POST');await showExam(currentExam.id);notify(`أُلغي الامتحان وحُفظ إشعار ${result.recipientCount} طالبًا للإرسال.`);}
    else if(form.id==='grade-report'){await api('/reports/'+form.dataset.id+'/score',body,'POST');closeDetail();await refresh();notify('حُفظ تقييم التقرير.');}
    else if(form.id==='edit-subject'){await api('/subjects/'+form.dataset.id,body,'PATCH');closeDetail();await refresh();notify('حُفظ اسم المادة.');}
    else if(form.id==='edit-teacher'){await api('/teachers/'+form.dataset.id,body,'PATCH');closeDetail();await loadTeachers();notify('حُفظ اسم الأستاذ.');}
    else if(form.id==='edit-group'){await api('/groups/'+form.dataset.id,{capacity:body.capacity,inviteLink:body.inviteLink||null},'PATCH');closeDetail();await refresh();notify('حُفظت بيانات المجموعة.');}
    else if(form.id.startsWith('create-')){
      const kind=form.id.slice(7);const routes={stage:'/stages',subject:'/subjects',group:'/groups',assignment:'/assignments',slot:'/schedule',exam:'/exams',teacher:'/teachers'};
      if(kind==='subject')body.stageId=currentStage.id;if(['group','exam'].includes(kind))body.seasonId=currentStage.stage_season_id;
      await api(routes[kind],body,'POST');closeDetail();
      if(kind==='teacher'){await loadTeachers();notify('أُضيف الأستاذ بنجاح.');}else{await refresh();notify('أُضيف السجل بنجاح.');}
    }
  }catch(e){notify(e.message,true);}finally{clearTimeout(pendingTimer);busy=false;if(submit)submit.disabled=false;for(const notice of [$('#notice'),$('#dialog-notice')])if(notice.textContent===pendingText)notice.hidden=true;}
});
(async()=>{
  const tg=window.Telegram?.WebApp;
  tg?.ready();tg?.expand();
  try{tg?.disableVerticalSwipes?.();}catch{}
  try{tg?.setHeaderColor?.('#244643');}catch{}
  try{tg?.setBackgroundColor?.('#faf7f2');}catch{}
  try{tg?.requestFullscreen?.();}catch{}
  if(!tg?.initData){setContent(empty('افتح اللوحة من البوت','سجّل دخولك إلى تليجرام، ثم اضغط «لوحة الإدارة» في حساب الأدمن. فتح الرابط وحده لا يمنح صلاحية الاطلاع على بيانات الطلبة.'));return;}
  try{
    const session=await api('/auth',{initData:tg.initData},'POST');token=session.token;$('#identity').textContent=session.user.name;
    seasons=await api('/seasons');
    if(seasons.length>1){const sel=$('#season-select');sel.hidden=false;sel.innerHTML=seasons.map(se=>`<option value="${se.is_current?'':se.id}">${esc(se.name)}${se.is_current?' — الموسم الحالي':''}</option>`).join('');}
    await home();
  }
  catch(e){setContent(empty('تعذر فتح لوحة الإدارة',e.message));}
})();
