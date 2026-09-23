'use strict';
const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=value=>value?new Date(value).toLocaleDateString('ar-IQ',{timeZone:'Asia/Baghdad'}):'—';
const stamp=value=>value?new Date(value).toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad'}):'—';
const labels={pending:'بانتظار القرار',approved:'معتمدة',rejected:'مرفوضة',ended:'منتهية',cancelled:'ملغاة',sent:'أُرسلت',sending:'قيد الإرسال',failed:'تعذّر إرسالها',expired:'انتهت المهلة',draft:'مسودة',published:'منشور'};
const actionLabels={participation_settings:'إعدادات المباحثات والتقارير',update_student:'تعديل طالب',move_stage:'نقل مرحلة',move_group:'نقل مجموعة',leave_decision:'قرار إجازة',grade_report:'تقييم تقرير',end_session:'إنهاء مباحثة',create_stage:'إضافة مرحلة',create_subject:'إضافة مادة',create_group:'إضافة مجموعة',update_group:'تعديل مجموعة',assign_teacher:'إسناد أستاذ',unassign_teacher:'إلغاء إسناد أستاذ',create_slot:'إضافة موعد',remove_slot:'إيقاف موعد',create_exam:'إنشاء امتحان',set_lesson_schedule:'إضافة موعد نشر في جدول الدروس',remove_lesson_schedule:'إزالة موعد نشر من جدول الدروس',exam_question:'إضافة سؤال',exam_publish:'نشر امتحان',exam_postpone:'تغيير موعد امتحان',remove_question:'حذف سؤال',create_teacher:'إضافة أستاذ',update_teacher:'تعديل أستاذ',toggle_teacher:'تفعيل/إيقاف أستاذ',regenerate_code:'توليد كود ربط',reopen_lesson:'إعادة فتح درس',mark_all_present:'تحضير جميع الطلبة',cancel_lesson:'إلغاء تفعيل درس',unlink_channel:'فكّ ربط قناة',reopen_session:'إعادة فتح مباحثة','mark-all_session':'تحضير طلبة مباحثة',cancel_session:'حذف مباحثة'};
const entityLabels={student:'طالب',stage:'مرحلة',subject:'مادة',group:'مجموعة',leave:'إجازة',report:'تقرير',session:'مباحثة',slot:'موعد',exam:'امتحان',question:'سؤال',teacher:'أستاذ',assignment:'إسناد',lesson_schedule:'جدول الدروس',lesson:'درس',channel:'قناة'};
const DAY_NAMES=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
let token='',stages=[],teachers=[],seasons=[],currentSeasonId='',currentStage=null,currentStudent=null,currentExam=null,currentTeacher=null,matrixStageId=null,matrixDay=new Date().getDay(),matrixEligible=[],tab='students',page=0,view='home',sequence=0,dialogSequence=0,busy=false;
let lessonScheduleStageId=null,lessonScheduleData=null;
let adminSelection=null;
Object.assign(actionLabels,{correct_lesson_subject:'تصحيح مادة الدرس',late_lesson_attendance:'حضور إداري متأخر',reopen_student_exam:'فتح امتحان لطالب واحد'});
Object.assign(actionLabels,{contact_student_admin:'رسالة إدارية لطالب',contact_student_teacher:'رسالة أستاذ لطالب'});
let contactQuery='',contactPage=0,contactStudent=null;
const contactRequestKey=prefix=>prefix+':'+(globalThis.crypto?.randomUUID?.()||`${Date.now()}:${Math.random().toString(36).slice(2)}`);
const contactStatuses={pending:'بانتظار الإرسال',sending:'قيد الإرسال',sent:'أُرسلت',failed:'تعذّر الإرسال',expired:'انتهت المهلة',archived:'سجل إرسال مؤرشف'};
const lessonSource=value=>value==='channel_schedule'?'تم تحديد المادة اعتمادًا على الجدول (دون هاشتاغ)':value==='channel_hashtag'?'تم تحديد المادة من رسالة هاشتاغ':value==='channel'?'تفعيل من القناة':value==='manual'?'تفعيل يدوي':'مصدر التحديد غير موثق';
let filters={q:'',status:'active',groupId:'',mode:''};
function notify(text,error=false){const n=$('#detail').open?$('#dialog-notice'):$('#notice');n.hidden=false;n.className=error?'error':'';n.textContent=text;}
function clearNotice(){$('#notice').hidden=true;$('#dialog-notice').hidden=true;}
function setNav(action){document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.action===action));}
async function api(route,body,method='GET'){
  const response=await fetch('/api/admin'+route,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  if(!response.ok){let data;try{data=await response.json();}catch{}throw Error(data?.error||'تعذر الاتصال. حاول مرة أخرى.');}
  return response.json();
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
    head('المراحل الدراسية','اختر المرحلة للاطلاع على طلبتها وموادها ومجموعاتها.',historical?'':button('إضافة مرحلة','new-stage','','primary'))+
    (stages.length?`<div class="cards">${stages.map(s=>`<button class="stage-card" data-action="stage" data-id="${s.id}"><div><h2>${esc(s.name)}</h2><small>${esc(s.season_name||'لا يوجد موسم نشط')}</small></div><div class="stats"><div><span class="metric">${s.student_count}</span><small>طالب</small></div><div><span class="metric">${s.subject_count}</span><small>مادة</small></div><div><span class="metric">${s.discussion_grouping===false?'—':s.group_count}</span><small>${s.discussion_grouping===false?'دون تقسيم':'مجموعة مباحثة'}</small></div></div><div class="card-footer"><span>${s.is_active?'مرحلة نشطة':'مرحلة مؤرشفة'}</span><span>عرض التفاصيل ←</span></div></button>`).join('')}</div>`:empty('لا توجد بيانات لهذا الموسم','اختر موسمًا آخر أو أضف المرحلة الأولى.')));
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
  return `<form id="participation-settings" class="detail-section"><h2>تنظيم المباحثات والتقارير</h2><p class="subtle">هذه الإعدادات تخص الموسم المعروض فقط. جميع مواد المرحلة تبقى في حضور الدروس.</p><label>تنظيم المباحثات<select name="grouped"><option value="true" ${s.discussion_grouping!==false?'selected':''}>تقسيم الطلبة إلى مجموعات مرقمة</option><option value="false" ${s.discussion_grouping===false?'selected':''}>المرحلة كاملة — دون تقسيم</option></select></label><fieldset><legend>المواد المشمولة بالمباحثات والتقارير</legend>${s.subjects.map(sub=>`<label class="study-choice">${esc(sub.name)}<select name="study-${sub.id}" data-study-id="${sub.id}"><option value="true" ${sub.participation_enabled!==false?'selected':''}>تشمل مباحثات وتقارير</option><option value="false" ${sub.participation_enabled===false?'selected':''}>بدون مباحثات وتقارير</option></select></label>`).join('')}</fieldset><p class="subtle">اختيار «بدون مباحثات وتقارير» يخفي المادة من قائمة المباحثات والتقارير ويوقف المشاركة الجديدة فيها، مع حفظ سجلاتها السابقة. عند اختيار المرحلة كاملة تُدمج المجموعات وينتقل أعضاؤها تلقائيًا، مع حفظ الحضور والتقارير السابقة. تتوقف مواعيد المادة ذات المجموعات المتعددة حتى تحدد موعدًا موحّدًا؛ رابطها الموحد يكون رابط أول مجموعة نشطة ويمكن تعديله.</p><button class="primary" type="submit">حفظ إعدادات الموسم</button></form>`;
}
async function openStage(id){view='stage';tab='students';page=0;sessionSubjectId='';sessionPage=0;filters={q:'',status:'active',groupId:'',mode:''};const n=++sequence;const s=await api('/stages/'+id+(currentSeasonId?'?seasonId='+currentSeasonId:''));if(n!==sequence)return;currentStage=s;await renderStage();}
async function renderStage(){
  if(!currentStage)return;view='stage';const n=++sequence,s=currentStage,ro=Boolean(s.is_historical);$('#breadcrumb').textContent='المعهد / '+s.name;
  let body='';const query=new URLSearchParams({stageId:s.id,page,...filters});if(!filters.groupId)query.delete('groupId');if(!filters.mode)query.delete('mode');if(s.is_historical){query.set('seasonId',s.stage_season_id);query.set('status','all');}
  if(tab==='students'){
    const data=await api('/students?'+query);
    body=`<form id="search" class="toolbar"><label>اسم الطالب<input name="q" value="${esc(filters.q)}" placeholder="بحث داخل المرحلة" maxlength="150"></label><label class="compact">الحالة<select name="status">${Object.entries({active:'نشطون',archived:'مؤرشفون',all:'الجميع'}).map(([v,t])=>`<option value="${v}" ${filters.status===v?'selected':''}>${t}</option>`).join('')}</select></label><label class="compact">${s.discussion_grouping===false?'مباحثة المادة':'مجموعة المباحثة'}<select name="groupId">${groupOptions(s.groups,filters.groupId)}</select></label><label class="compact">وضع المشاركة<select name="mode">${[['','الكل'],['mubahatha','مباحثة'],['report','تقارير']].map(([v,t])=>`<option value="${v}" ${filters.mode===v?'selected':''}>${t}</option>`).join('')}</select></label><button class="primary" type="submit">عرض</button></form>`+
    table(['الطالب','تنظيم المباحثات','المواد ووضع المشاركة','الحالة','ملف الطالب'],data.rows.map(st=>[esc(st.full_name),s.discussion_grouping===false?'المرحلة كاملة':esc(cohortLabel(st.groups)),st.groups.map(g=>`<div>${esc(g.subject)}: ${esc(g.group)}${g.group_number?' · رقم '+esc(g.group_number):''} ${modeTag(g.mode)}</div>`).join('')||'<span class="subtle">لم يُوزّع بعد</span>',`<span class="tag ${st.is_active?'ok':''}">${st.is_active?'نشط':'مؤرشف'}</span>`,button(ro?'عرض':'عرض وتعديل','student',`data-id="${st.id}"`)]))+pager(data.total);
  }else if(tab==='attendance'){body=await attendanceContent(s.id);
  }else if(tab==='subjects'){
    body=(ro?'':`<div class="toolbar">${button('إضافة مادة','new-subject','','primary')}${s.stage_type!=='lessons_only'?(s.discussion_grouping!==false?button('إضافة مجموعة','new-group'):'')+button('إسناد أستاذ لمادة','new-assignment'):''}</div>`)+
      (!ro&&s.stage_type!=='lessons_only'?participationForm(s):'')+s.subjects.map(sub=>`<section class="detail-section"><h2>${esc(sub.name)}</h2><p class="subtle">الأستاذ: ${esc(sub.teacher_name||'لم يُسنَد')} · الهاشتاغ: #${esc(sub.hashtag)}</p><p>${sub.participation_enabled===false?'غير مشمولة بالمباحثات والتقارير · سجلاتها السابقة محفوظة<br>':''}${modeTag('mubahatha')} ${sub.mubahatha_count} طالب · ${modeTag('report')} ${sub.report_count} طالب · ${modeTag(null)} ${sub.undecided_count} طالب</p>`+table([s.discussion_grouping===false?'مباحثة المادة':'المجموعة',s.discussion_grouping===false?'عدد الطلبة':'الطلبة / السعة','رابط المجموعة','الحالة',...(ro?[]:['الإجراء'])],s.groups.filter(g=>g.subject_id===sub.id).map(g=>[esc(g.title),s.discussion_grouping===false?esc(g.member_count):`${g.member_count} / ${g.capacity}`,g.invite_link&&/^https:\/\/t\.me\//.test(g.invite_link)?`<a href="${esc(g.invite_link)}" target="_blank" rel="noopener noreferrer">فتح المجموعة</a>`:'لم يُضف',g.is_active?'<span class="tag ok">نشطة</span>':'<span class="tag danger">معطّلة</span>',...(ro?[]:[button('تعديل','edit-group',`data-id="${g.id}"`)])]))+'</section>').join('');
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
async function leavesContent(stageId,ro=false){
  const data=await api('/leaves?'+new URLSearchParams({page,status:filters.leaveStatus||'pending',...(stageId?{stageId}:{})}));
  return `<form id="leave-filter" class="toolbar"><label>حالة الطلب<select name="leaveStatus">${['pending','approved','ended','rejected','cancelled','all'].map(v=>`<option value="${v}" ${v===(filters.leaveStatus||'pending')?'selected':''}>${labels[v]||'الجميع'}</option>`).join('')}</select></label><button>عرض</button></form>`+
    table(['الطالب / المرحلة','الفترة','الأيام','الحالة','القرار'],data.rows.map(l=>[`${esc(l.full_name)}<div class="subtle">${esc(l.stage_name)}</div>`,`${date(l.start_date)} — ${date(l.end_date)}`,esc(l.days),esc(labels[l.status]),(!ro&&l.status==='pending'?button('موافقة','leave',`data-id="${l.id}" data-approve="true"`)+button('رفض','leave',`data-id="${l.id}" data-approve="false"`):'')+button('رد برسالة','contact-student',`data-id="${l.student_id}" data-name="${esc(l.full_name)}" data-telegram="${esc(l.telegram_id||'')}" data-context-kind="leave" data-context-id="${l.id}"`)]))+pager(data.total);
}
async function allLeaves(){view='leaves';currentStage=null;setNav('all-leaves');$('#breadcrumb').textContent='المعهد / طلبات الإجازة';const n=++sequence;const html=await leavesContent(null);if(n===sequence)setContent(head('طلبات الإجازة','جميع المراحل · الحد الأقصى عشرة أيام لكل طالب في الموسم')+html);}
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
  const table1=table(['المرحلة','الإجمالي','مستمر','متلكئ','تارك'],rows.map(r=>[esc(r.stage_name),esc(r.total),esc(r.continuing),esc(r.lagging),esc(r.dropped)]));
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
    table(['المادة','المجموعة','التاريخ','هل عُقدت'],perf.sessions.map(s=>[esc(s.subject_name),esc(s.group_title),date(s.scheduled_date),s.held==null?'<span class="subtle">بلا قرار</span>':s.held?'<span class="tag ok">عُقدت</span>':'<span class="tag warn">أُجِّلت</span>']))+'</section>');
}
async function loadScheduleMatrix(){view='schedule-matrix';currentStage=null;setNav('schedule-matrix');$('#breadcrumb').textContent='المعهد / جداول المباحثات';const n=++sequence;
  if(!stages.length)stages=await api('/stages');if(n!==sequence)return;
  matrixEligible=stages.filter(s=>s.stage_type!=='lessons_only'&&s.stage_season_id);
  if(!matrixEligible.length){setContent(head('جداول المباحثات','مصفوفة المجموعات والساعات المعتمدة لكل يوم.')+empty('لا توجد مراحل مباحثات نشطة','أضف مرحلة موسمها نشط وليست من نوع الدروس فقط.'));return;}
  if(!matrixStageId||!matrixEligible.some(s=>String(s.id)===String(matrixStageId)))matrixStageId=matrixEligible[0].id;
  await renderScheduleMatrix();
}
let matrixDetail=null;
async function renderScheduleMatrix(){
  const n=++sequence;const s=await api('/stages/'+matrixStageId);const slots=await api('/schedule?seasonId='+s.stage_season_id);if(n!==sequence)return;
  const dayTabs=DAY_NAMES.map((d,i)=>button(d,'matrix-day',`data-day="${i}"`,String(i)===String(matrixDay)?'active':'')).join('');
  const daySlots=slots.filter(sl=>Number(sl.day_of_week)===Number(matrixDay));
  const hours=Array.from({length:8},(_,i)=>i+16);matrixDetail=s;
  let body=`<form id="matrix-stage" class="toolbar"><label>المرحلة<select name="stageId">${matrixEligible.map(e=>`<option value="${e.id}" ${String(e.id)===String(matrixStageId)?'selected':''}>${esc(e.name)}</option>`).join('')}</select></label></form>`+
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
function dialog(title,html){clearNotice();$('#dialog-title').textContent=title;$('#dialog-body').innerHTML=html;if(!$('#detail').open)$('#detail').showModal();}
async function showStudent(id){
  const n=++dialogSequence;const st=await api('/students/'+id);if(n!==dialogSequence)return;currentStudent=st;const ro=Boolean(currentStage?.is_historical);
  const budget=st.activity?.approvedLeaveDays||0;const pending=st.leaves.filter(l=>l.status==='pending'&&l.stage_season_id===st.activity?.stageSeasonId).reduce((sum,l)=>sum+Number(l.days),0);
  dialog(st.full_name,`<p class="subtle">${esc(st.stage_name)} · ${st.is_active?'نشط':'مؤرشف'} · ${st.official_confirmed_at?'أكّد التسجيل الرسمي':'لم يؤكد التسجيل الرسمي'}${ro?' · عرض بيانات موسم أرشيفي':''}</p>`+
    button('💬 التواصل مع هذا الطالب','contact-student',`data-id="${st.id}" data-name="${esc(st.full_name)}" data-telegram="${esc(st.telegram_id||'')}"`)+
    (ro?'':`<form id="edit-student"><label>الاسم الرباعي<input name="fullName" value="${esc(st.full_name)}" maxlength="200" required></label><div class="form-actions"><button class="primary">حفظ الاسم</button>${button(st.is_active?'أرشفة الطالب':'إعادة تفعيل الطالب','archive',`data-id="${st.id}" data-active="${!st.is_active}"`,st.is_active?'danger':'')}</div></form>`+
    `<section class="detail-section"><h3>المرحلة الدراسية</h3><form id="move-stage" class="toolbar"><label>النقل إلى مرحلة<select name="stageId" required>${stages.filter(s=>s.is_active&&s.stage_season_id).map(s=>`<option value="${s.id}" ${s.id===st.stage_id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label><button>نقل الطالب</button></form></section>`)+
    `<section class="detail-section"><h3>تنظيم المباحثات حسب المادة</h3>${st.groups.map(g=>`<p>${esc(g.subject_name)}: ${esc(g.group_title)}${g.group_number?' · رقم '+esc(g.group_number):''} ${modeTag(g.mode)}</p>`).join('')||'<p>لم يُوزّع بعد.</p>'}${!ro&&currentStage?.discussion_grouping!==false&&currentStage?.groups.length?`<form id="move-group" class="toolbar"><label>توحيد رقم المجموعة في جميع المواد<select name="groupId" required>${groupOptions(currentStage.groups.filter(g=>currentStage.subjects.find(sub=>sub.id===g.subject_id)?.participation_enabled!==false),'','اختر مباحثة المادة')}</select></label><button>حفظ المجموعة</button></form>`:''}<p class="subtle">في المراحل المقسمة، اختيار المجموعة يوحّد رقم مباحثات الطالب في مواده لهذا الموسم. لا يؤثر ذلك في حضور الدروس. لا تتغير التقارير السابقة؛ تبدأ أهلية الحضور من وقت النقل في المجموعات التي تغيّرت فقط.</p></section>`+
    `<section class="detail-section"><h3>المتغيرات في الموسم الحالي</h3><div class="summary"><div><b>${budget}/10</b>إجازات معتمدة</div><div><b>${pending}</b>أيام محجوزة لطلبات معلقة</div><div><b>${Math.max(0,10-budget-pending)}</b>أيام متبقية</div></div>${st.activity?.warnings?.length?`<p>التنبيهات المستلمة: ${st.activity.warnings.length}</p>`:''}</section>`+
    `<section class="detail-section"><h3>حضور الدروس في الموسم الحالي</h3>${table(['المادة','الحضور','عدد الدروس'],st.attendance.map(r=>[esc(r.subject_name),esc(r.attended_lessons),esc(r.total_lessons)]))}</section>`+
    `<section class="detail-section"><h3>آخر 100 طلب إجازة، بما فيها المواسم السابقة</h3>${table(['البداية','النهاية','الأيام','الحالة'],st.leaves.map(l=>[date(l.start_date),date(l.end_date),esc(l.days),esc(labels[l.status])]))}</section>`);
}
async function newForm(kind){
  const id=++dialogSequence;
  const subjectOptions=currentStage?.subjects.filter(s=>!['group','slot'].includes(kind)||s.participation_enabled!==false).map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');
  let fields=kind==='stage'?'<label>اسم المرحلة<input name="name" required maxlength="100"></label>':kind==='subject'?'<label>اسم المادة<input name="name" required maxlength="100"></label><label>الهاشتاغ<input name="hashtag" required maxlength="100"></label>':`<label>المادة<select name="subjectId" required>${subjectOptions||''}</select></label><label>عنوان المجموعة<input name="title" required maxlength="100" placeholder="المجموعة الأولى"></label><label>السعة<input name="capacity" type="number" min="1" max="10000" value="50" required></label><label>رابط المجموعة (اختياري)<input name="inviteLink" type="url" placeholder="https://t.me/..."></label>`;
  if(['assignment','slot','exam'].includes(kind)){
    const teachers=(await api('/teachers')).filter(t=>t.is_active);if(id!==dialogSequence)return;
    const teacherField=`<label>الأستاذ<select name="teacherId" required>${teachers.map(t=>`<option value="${t.id}">${esc(t.full_name)}</option>`).join('')}</select></label>`;
    const subjectField=`<label>المادة<select name="subjectId" required>${subjectOptions}</select></label>`;
    fields=kind==='assignment'?subjectField+teacherField:kind==='slot'?`<label>المجموعة<select name="groupId" required>${groupOptions(currentStage.groups.filter(g=>currentStage.subjects.find(sub=>sub.id===g.subject_id)?.participation_enabled!==false),'','اختر مباحثة المادة')}</select></label>${teacherField}<label>اليوم<select name="dayOfWeek">${['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'].map((d,i)=>`<option value="${i}">${d}</option>`).join('')}</select></label><label>الساعة (16–23، أي 4 عصرًا حتى 11 ليلًا)<input name="hour" type="number" min="16" max="23" required></label><label>الدقيقة<input name="minute" type="number" min="0" max="59" value="0" required></label><p class="subtle">المدة ساعة. اختر أستاذًا مسندًا لهذه المادة؛ يمنع النظام تداخل مواعيده.</p>`:
      subjectField+teacherField+'<label>رقم الامتحان<input name="examNumber" type="number" min="1" max="3" required></label><label>العنوان<input name="title" maxlength="150" required></label><label>التاريخ<input name="dateIso" type="date" required></label><label>ساعات الإتاحة<input name="hours" type="number" min="1" max="720" value="24" required></label><p class="subtle">يبدأ الامتحان في الساعة المحددة بإعدادات المعهد (الافتراضي 22:00 بتوقيت بغداد). يُحفظ مسودة حتى تضيف الأسئلة وتنشره.</p>';
  }
  dialog({stage:'إضافة مرحلة',subject:'إضافة مادة',group:'إضافة مجموعة',assignment:'إسناد أستاذ لمادة',slot:'إضافة موعد',exam:'إنشاء امتحان'}[kind],`<form id="create-${kind}"><div class="form-grid">${fields}</div><div class="form-actions"><button class="primary">حفظ</button></div></form>`);
}
async function showExam(id){
  const n=++dialogSequence;const exam=await api('/exams/'+id);if(n!==dialogSequence)return;currentExam=exam;
  dialog(exam.title||'الامتحان الشهري '+exam.exam_number,`<p>${esc(exam.subject_name)} · ${esc(labels[exam.status])}</p><p>يفتح: ${stamp(exam.opens_at)} · يغلق: ${stamp(exam.closes_at)}</p>`+
    (exam.status==='published'&&!currentStage?.is_historical&&new Date(exam.closes_at)<=new Date()?`<div class="form-actions">${button('إعادة فتح لطالب محدد','exam-student-window',`data-id="${exam.id}"`,'primary')}</div>`:'')+
    ((exam.studentWindows||[]).length?'<h3>نوافذ الفتح الخاصة بالطلبة — بتوقيت بغداد</h3>'+table(['الطالب','بداية الفتح','نهاية الفتح','الملاحظة','المسؤول'],exam.studentWindows.map(w=>[esc(w.full_name),stamp(w.opens_at),stamp(w.closes_at),esc(w.note||'—'),esc(w.created_by)])):'')+
    table(['السؤال','الخيارات','الصحيح','الإجراء'],exam.questions.map(q=>[esc(q.prompt),esc((q.options||['صح','خطأ']).join(' / ')),esc(q.correct_answer),exam.status==='draft'?button('حذف السؤال','remove-question',`data-id="${q.id}"`):'محمي بعد النشر']))+
    (exam.status==='draft'?`<form id="exam-question" class="detail-section"><h3>إضافة سؤال</h3><label>النوع<select name="type"><option value="tf">صح أو خطأ</option><option value="mcq">اختيار من متعدد</option></select></label><label>نص السؤال<textarea name="prompt" maxlength="3000" required></textarea></label><label>الخيارات: كل خيار في سطر (للاختيار المتعدد فقط)<textarea name="options"></textarea></label><label>الإجابة الصحيحة بالنص المطابق للخيار<input name="correct" maxlength="300" required placeholder="صح أو خطأ أو نص أحد الخيارات"></label><div class="form-actions"><button class="primary">إضافة السؤال</button></div></form><div class="form-actions">${button('نشر الامتحان وإشعار الطلبة','publish-exam','','primary')}</div>`:'')+
    `<form id="postpone-exam" class="detail-section"><h3>تغيير الموعد</h3><p class="subtle">متاح فقط قبل بدء أي طالب محاولة. تُحفظ الإجابات السابقة.</p><label>التاريخ الجديد<input name="dateIso" type="date" required></label><div class="form-actions"><button>حفظ الموعد</button></div></form>`);
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
async function renderLessonSchedule(eligible){
  const stage=eligible.find(x=>String(x.id)===String(lessonScheduleStageId));if(!stage)return;
  const data=await api('/lesson-schedule?stageSeasonId='+stage.stage_season_id);lessonScheduleData=data;
  const checked=new Set(data.entries.map(e=>`${e.subject_id}:${e.lesson_date}`));let lastMonth='';
  const rows=(data.dates||[]).map(iso=>{
    const month=monthLabel(iso),monthCell=month!==lastMonth?month:'';lastMonth=month;
    const cells=data.subjects.map(sub=>{const key=`${sub.id}:${iso}`,on=checked.has(key);
      return `<td><button type="button" class="schedule-check ${on?'checked':''}" data-action="lesson-schedule-toggle" data-subject-id="${sub.id}" data-date="${iso}" data-checked="${on?'true':'false'}" aria-label="${esc(sub.name)} ${esc(isoDateLabel(iso))}">${on?'✓':'·'}</button></td>`;}).join('');
    return `<tr><td class="month-cell">${esc(monthCell)}</td><td class="date-cell">${esc(isoDateLabel(iso))}</td>${cells}</tr>`;
  }).join('');
  setContent(head('جدول الدروس','ضع علامة ✓ في تاريخ نشر كل مادة. هذا الجدول التخطيطي لا يفعّل الدرس ولا يرسل الإشعارات.')+
    `<div class="toolbar"><label>المرحلة الدراسية<select id="lesson-schedule-stage">${eligible.map(e=>`<option value="${e.id}" ${String(e.id)===String(lessonScheduleStageId)?'selected':''}>${esc(e.name)}</option>`).join('')}</select></label>
    <div class="subtle">من ${esc(isoDateLabel(data.start_date))} إلى ما قبل ${esc(isoDateLabel(data.end_date_exclusive))} · الخميس والجمعة مستبعدان تلقائيًا.</div></div>`+
    `<div class="summary"><div><b>${data.dates.length}</b> يومًا دراسيًا</div><div><b>${data.subjects.length}</b> مادة</div><div><b class="lesson-schedule-summary-count">${data.entries.length}</b> موعد نشر مخطط</div></div>`+
    `<div class="table-wrap lesson-schedule-wrap"><table class="lesson-schedule"><thead><tr><th>الشهر الميلادي</th><th>التاريخ</th>${data.subjects.map(s=>`<th>${esc(s.name)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`);
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
  if(n===sequence)setContent(head('الدروس المفعّلة','جميع الدروس حسب المرحلة والمادة والموسم. إعادة الفتح تنتهي بعد 24 ساعة من النشر الأصلي وتحفظ الحضور السابق.')+selector+body);
}
async function lessonManagementContent(stageId){
  const data=await api('/lesson-management?'+new URLSearchParams({stageId,page:mgtPage,...(mgtSubjectId?{subjectId:mgtSubjectId}:{}),...(currentSeasonId?{seasonId:currentSeasonId}:{})}));
  if(data.total&&mgtPage>0&&!data.rows.length){mgtPage--;return lessonManagementContent(stageId);}
  const ro=!data.season.is_active;
  return managementSummary(data,'درسًا')+subjectSelector(data,'lesson-mgt',mgtSubjectId)+
    table(['رقم الدرس في المادة','المادة','النشر الأصلي','نهاية التسجيل','الحضور',...(ro?[]:['الإجراءات'])],data.rows.map(l=>[`${l.item_number}<div class="subtle">المعرف #${l.id}</div>`,`${esc(l.subject_name)}<div class="subtle">${esc(lessonSource(l.source_type))}</div>`,stamp(l.activated_at),`${stamp(l.active_until)}<div>${l.is_active?'مفتوح':'انتهت المهلة'}</div>`,`${l.attended_count} / ${l.enrolled_count}`,
      ...(ro?[]:[(l.can_reopen?button('إعادة فتح للوقت المتبقي','lesson-reopen',`data-id="${l.id}" data-subject="${esc(l.subject_name)}"`):'<span class="subtle">مضت مهلة إعادة الفتح</span>')+
      button('تصحيح المادة','lesson-correct',`data-id="${l.id}"`)+
      (!l.is_active?button('حضور إداري متأخر لطلبة محددين','lesson-late',`data-id="${l.id}"`):'')+
      button('تحضير الجميع','lesson-markall',`data-id="${l.id}" data-subject="${esc(l.subject_name)}"`)+button('حذف الدرس','lesson-cancel',`data-id="${l.id}" data-subject="${esc(l.subject_name)}"`,'danger')])]))+managementPager(data,'lessons');
}
async function correctLessonDialog(id){
  const n=++dialogSequence,data=await api('/lessons/'+id+'/admin-options');if(n!==dialogSequence)return;
  const l=data.item;
  dialog('تصحيح مادة الدرس',`<p>الدرس #${l.id} · ${esc(l.subject_name)} · النشر الأصلي: ${stamp(l.activated_at)}</p><p>${esc(lessonSource(l.source_type))}</p>
    <p>يبقى الدرس وكل سجلات حضوره محفوظة. تتغير المادة في التقارير ويُحسب رقم الدرس ضمن المادة الصحيحة.</p>
    <form id="correct-lesson" data-id="${l.id}"><input type="hidden" name="expectedSubjectId" value="${l.subject_id}">
    <label>المادة الصحيحة<select name="subjectId" required>${data.subjects.map(s=>`<option value="${s.id}" ${s.id===l.subject_id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label>
    <div class="form-actions"><button class="primary">حفظ تصحيح المادة</button></div></form>`);
}
async function studentOverrideDialog(kind,id){
  const n=++dialogSequence,data=await api(`/${kind==='lesson'?'lessons':'exams'}/${id}/admin-options`);if(n!==dialogSequence)return;
  adminSelection={kind,id:Number(id),item:data.item,selected:new Map(),page:0,query:'',request:0};
  const l=data.item,late=kind==='lesson';
  dialog(late?'حضور إداري متأخر':'فتح الامتحان لطالب واحد',`<p>${esc(l.subject_name)} · ${late?'الدرس':'الامتحان'} #${l.id}</p>
    <p>${late?'النشر الأصلي: '+stamp(l.activated_at):'الامتحان الشهري '+l.exam_number+' · '+esc(l.title||'')} · نهاية الوقت الأصلي: ${stamp(late?l.active_until:l.closes_at)}</p>
    <p>${late?'اختر طالبًا أو عدة طلاب (حتى 500). يُحفظ التسجيل كحضور إداري متأخر بوقت التأشير الحقيقي.':'اختر طالبًا واحدًا. يحتفظ بإجاباته ويكمل المحاولة غير المكتملة؛ لا تُنشأ محاولة ثانية لمن أكمل الامتحان.'}</p>
    <form id="override-search" class="toolbar"><label>البحث باسم الطالب<input name="q" maxlength="150"></label><button>بحث</button></form>
    <div id="override-students"></div><p id="override-selected" role="status"></p>
    <form id="save-override"><div class="form-grid">${late?'':`<label>بداية الفتح الجديدة — بتوقيت بغداد<input name="opensAt" type="datetime-local" required></label><label>نهاية الفتح الجديدة — بتوقيت بغداد<input name="closesAt" type="datetime-local" required></label>`}
    <label>السبب أو الملاحظة (اختياري)<textarea name="note" maxlength="500"></textarea></label></div>
    <div class="form-actions"><button class="primary">${late?'تسجيل الحضور للطلبة المحددين':'حفظ نافذة الطالب الخاصة'}</button></div></form>`);
  renderOverrideStudents(data);
}
function updateOverrideSelected(){
  if(!adminSelection||!$('#override-selected'))return;
  const names=[...adminSelection.selected.values()];
  $('#override-selected').textContent=`المحددون: ${names.length}${names.length?' — '+names.slice(0,10).join('، '):''}${names.length>10?' …':''}`;
}
function renderOverrideStudents(data){
  const state=adminSelection,late=state.kind==='lesson';
  state.page=data.page;
  $('#override-students').innerHTML=table(['اختيار','الطالب','الحالة الحالية'],data.rows.map(st=>[
    `<input type="${late?'checkbox':'radio'}" name="override-student" value="${st.id}" data-name="${esc(st.full_name)}" aria-label="اختيار ${esc(st.full_name)}" ${state.selected.has(st.id)?'checked':''} ${late&&st.attendance?'disabled':''}>`,
    `${esc(st.full_name)} <span class="subtle">#${st.id}</span>`,late?(st.attendance?`${st.attendance.marking_kind==='admin_late'?'حضور إداري متأخر':'حضور مسجل'} · ${stamp(st.attendance.listened_at)}${st.attendance.marked_by?' · المسؤول '+esc(st.attendance.marked_by):''}${st.attendance.admin_note?' · '+esc(st.attendance.admin_note):''}`:'لم يسجل الحضور'):
      `${st.student_window?'نافذة خاصة: '+stamp(st.student_window.opens_at)+' ← '+stamp(st.student_window.closes_at):'لا توجد نافذة خاصة'}${st.submitted_at?' · سبق تسليم المحاولة':''}`]))+
    `<div class="pagination"><span>${data.total} طالبًا · الصفحة ${data.page+1}</span><div>${data.page?button('السابق','override-prev'):''}${(data.page+1)*data.size<data.total?button('التالي','override-next'):''}</div></div>`;
  updateOverrideSelected();
}
async function loadOverrideStudents(page){
  const state=adminSelection,n=++state.request;
  const data=await api(`/${state.kind==='lesson'?'lessons':'exams'}/${state.id}/admin-options?`+new URLSearchParams({page,q:state.query}));
  if(adminSelection===state&&n===state.request&&$('#override-students'))renderOverrideStudents(data);
}
async function sessionManagementContent(stage,ro){
  const data=await api('/session-management?'+new URLSearchParams({stageId:stage.id,page:sessionPage,...(sessionSubjectId?{subjectId:sessionSubjectId}:{}),...(currentSeasonId?{seasonId:currentSeasonId}:{})}));
  if(data.total&&sessionPage>0&&!data.rows.length){sessionPage--;return sessionManagementContent(stage,ro);}
  const startDelay=Number(data.startAttendanceDelayMinutes||10),autoLead=Number(data.endAttendanceMinutes||10);
  const addMinutes=(value,mins)=>value?new Date(new Date(value).getTime()+mins*60000):null;
  return '<section class="detail-section"><h2>المباحثات المفعّلة</h2><p>إعادة الفتح تتيح تسجيل البداية والنهاية حتى مرور 24 ساعة من النشر الأصلي، وتحفظ الحضور السابق. التحضير الإداري يكمل البداية والنهاية لطلبة المجموعة المؤهلين.</p>'+
    managementSummary(data,'مباحثة')+subjectSelector(data,'session-mgt',sessionSubjectId)+
    table(['رقم المباحثة في المادة','المادة والمجموعة','موعد المباحثة','نوافذ تسجيل الحضور','الحضور المكتمل',...(ro?[]:['الإجراءات'])],data.rows.map(x=>{
      const firstOpen=addMinutes(x.opened_at,startDelay),autoEnd=addMinutes(x.closes_at,-autoLead),lastMinute=addMinutes(x.closes_at,-1);
      const canEnd=!x.is_closed&&!x.end_opened_at&&x.start_notifications_queued&&new Date(x.closes_at)>new Date()&&firstOpen&&firstOpen<=new Date();
      return [
      `${x.item_number}<div class="subtle">المعرف #${x.id}</div>`,`${esc(x.subject_name)}<div>${esc(x.group_title)}</div><div>${esc(x.title)}</div>`,stamp(x.opened_at),
      `الحضور الأول: يبدأ ${stamp(firstOpen)}<div>ويبقى حتى ${stamp(lastMinute)}</div>`+
        `<div style="margin-top:.35rem">الحضور الثاني: ${x.end_opened_at?'بدأ '+stamp(x.end_opened_at):'يفتح عند إنهاء الأستاذ أو تلقائيًا '+stamp(autoEnd)}</div><div>ويبقى حتى ${stamp(lastMinute)}</div>`,esc(x.complete_count),
      ...(ro?[]:[(canEnd?button('إنهاء وفتح الحضور الثاني','end-session',`data-id="${x.id}"`):'')+
        (x.can_reopen?button('إعادة فتح للوقت المتبقي','session-reopen',`data-id="${x.id}"`):'<span class="subtle">مضت مهلة إعادة الفتح</span>')+
        button('تحضير طلبة المجموعة','session-markall',`data-id="${x.id}"`)+button('حذف المباحثة','session-cancel',`data-id="${x.id}"`,'danger')])];
    }))+
    managementPager(data,'sessions')+'</section>';
}
async function loadChannels(){
  view='channels';currentStage=null;setNav('channels');$('#breadcrumb').textContent='المعهد / القنوات';const n=++sequence;
  const data=await api('/channel-diagnostics');if(n!==sequence)return;
  const outcomeLabels={received:'وصل — قيد المعالجة',activated:'تم تفعيل الدرس',duplicate_post:'وصل — سبق تفعيله',ignored_non_lesson:'وصل — ليس درسًا',hashtag_no_match:'وصل — الهاشتاغ لا يطابق مواد المرحلة',schedule_no_match:'وصل — لا توجد مادة مجدولة متبقية',no_subject:'وصل — تعذر تحديد المادة',unlinked:'وصل — Chat ID غير مرتبط',season_inactive:'وصل — الموسم المرتبط غير نشط',processing_error:'وصل — خطأ أثناء المعالجة',activated_notification_error:'فُعّل الدرس لكن حدث خطأ لاحق في الإشعارات'};
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
async function refresh(){if(view==='student-contact')return loadStudentContact();if(view==='lesson-attendance')return attendanceHome();if(view==='stage'){currentStage=await api('/stages/'+currentStage.id+(currentSeasonId?'?seasonId='+currentSeasonId:''));return renderStage();}if(view==='leaves')return allLeaves();if(view==='teachers')return loadTeachers();if(view==='schedule-matrix')return loadScheduleMatrix();if(view==='lesson-schedule')return loadLessonSchedule();if(view==='lesson-management')return loadLessonManagement();if(view==='channels')return loadChannels();return home();}
document.addEventListener('click',async event=>{
  const target=event.target.closest('[data-action]');if(!target||busy)return;const a=target.dataset.action;
  if(target.closest('form')&&target.type==='submit')event.preventDefault();
  clearNotice();
  try{
    if(a==='home')await home();
    else if(a==='lesson-attendance'){page=0;await attendanceHome();}
    else if(a==='stage')await openStage(target.dataset.id);
    else if(a==='tab'){tab=target.dataset.tab;page=0;await renderStage();}
    else if(a==='prev'||a==='next'){page+=a==='next'?1:-1;await refresh();}
    else if(a==='all-leaves'){page=0;await allLeaves();}
    else if(a==='student-contact'){contactPage=0;await loadStudentContact();}
    else if(a==='contact-prev'||a==='contact-next'){contactPage+=a==='contact-next'?1:-1;await loadStudentContact();}
    else if(a==='contact-student')await openStudentContact(target.dataset.id,target.dataset.contextKind||null,target.dataset.contextId||null);
    else if(a==='student')await showStudent(target.dataset.id);
    else if(a==='close-dialog'){dialogSequence++;$('#detail').close();}
    else if(a.startsWith('new-'))await newForm(a.slice(4));
    else if(a==='exam')await showExam(target.dataset.id);
    else if(a==='lesson-correct')await correctLessonDialog(target.dataset.id);
    else if(a==='lesson-late')await studentOverrideDialog('lesson',target.dataset.id);
    else if(a==='exam-student-window')await studentOverrideDialog('exam',target.dataset.id);
    else if(a==='override-prev'||a==='override-next')await loadOverrideStudents(adminSelection.page+(a==='override-next'?1:-1));
    else if(a==='remove-slot'){if(!confirm('إيقاف هذا الموعد الأسبوعي؟ تبقى سجلاته السابقة محفوظة.'))return;busy=true;await api('/schedule/'+target.dataset.id+'/remove',{},'POST');await refresh();}
    else if(a==='remove-question'){if(!confirm('حذف السؤال من المسودة؟'))return;busy=true;await api('/questions/'+target.dataset.id+'/remove',{},'POST');await showExam(currentExam.id);}
    else if(a==='publish-exam'){if(!confirm('نشر الامتحان وإرسال إشعارات للطلبة؟ تصبح أسئلته محمية من التعديل.'))return;busy=true;await api('/exams/'+currentExam.id+'/publish',{},'POST');await showExam(currentExam.id);notify('نُشر الامتحان وحُفظت إشعارات الطلبة للإرسال.');}
    else if(a==='leave'){
      if(!confirm(target.dataset.approve==='true'?'الموافقة على طلب الإجازة؟':'رفض طلب الإجازة؟'))return;
      busy=true;await api('/leaves/'+target.dataset.id+'/decision',{approve:target.dataset.approve==='true'},'POST');notify('حُفظ القرار.');await refresh();
    }else if(a==='archive'){
      if(!confirm(target.dataset.active==='true'?'إعادة تفعيل الطالب؟':'أرشفة الطالب مع الاحتفاظ بسجله؟'))return;
      busy=true;await api('/students/'+target.dataset.id,{active:target.dataset.active==='true'},'PATCH');$('#detail').close();await refresh();notify('حُفظت حالة الطالب.');
    }else if(a==='end-session'){
      if(!confirm('إنهاء هذه المباحثة وفتح الحضور الثاني؟'))return;busy=true;await api('/sessions/'+target.dataset.id+'/end',{},'POST');await refresh();notify('فُتح الحضور الثاني وحُفظت إشعارات الطلبة للإرسال.');
    }else if(a==='report'){
      const r=window.currentReports.find(x=>String(x.id)===target.dataset.id);if(!r)return;
      dialog('مراجعة التقرير',`<h3>${esc(r.full_name)} — ${esc(r.subject_name)}</h3><p>${esc(r.group_title_snapshot||'سجل قديم بلا مجموعة موثقة')} · ${stamp(r.submitted_at)}</p><div class="report-note">${esc(r.note||'التقرير مرفق كملف.')}</div>${button('إرسال المرفق إلى حسابي في البوت','report-send',`data-id="${r.id}"`)}${button('التواصل مع الطالب','contact-student',`data-id="${r.student_id}"`)}<form id="grade-report" data-id="${r.id}" class="detail-section"><label>درجة التقرير من 15<input name="score" type="number" min="0" max="15" step="0.01" value="${esc(r.score??'')}" required></label><div class="form-actions"><button class="primary">حفظ التقييم</button></div></form>`);
    }else if(a==='report-send'){busy=true;await api('/reports/'+target.dataset.id+'/send',{},'POST');notify('أُدرج التقرير للإرسال إلى حسابك في البوت.');}
    else if(a==='attendance-export'){
      busy=true;const query=new URLSearchParams({stageId:target.dataset.stage,...attendanceFilters,...(currentSeasonId?{seasonId:currentSeasonId}:{})});
      const response=await fetch('/api/admin/lesson-attendance.md?'+query,{headers:{Authorization:'Bearer '+token}});
      if(!response.ok)throw Error('تعذر تنزيل البيانات.');
      const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download='lesson-attendance-'+target.dataset.stage+'.md';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);notify('تم تنزيل جميع النتائج المطابقة بصيغة MD.');
    }
    else if(a==='export'){
      busy=true;const season=$('#export-season').value;const response=await fetch(`/api/admin/attendance.md?seasonId=${season}&kind=${target.dataset.kind}`,{headers:{Authorization:'Bearer '+token}});
      if(!response.ok)throw Error('تعذر تنزيل الملف. أعد فتح اللوحة إذا انتهت جلسة الدخول.');
      const url=URL.createObjectURL(await response.blob());const link=document.createElement('a');link.href=url;link.download=`attendance-${season}-${target.dataset.kind}.md`;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);notify('تم تجهيز ملف MD.');
    }else if(a==='audit'){
      view='audit';setNav('audit');$('#breadcrumb').textContent='المعهد / سجل التعديلات';const id=++sequence;const rows=await api('/audit');if(id===sequence)setContent(head('سجل التعديلات','آخر 25 عملية مسجلة')+table(['التاريخ','المسؤول','العملية','السجل','التفاصيل'],rows.map(r=>[stamp(r.created_at),esc(r.actor_id),esc(actionLabels[r.action]||r.action),`${esc(entityLabels[r.entity_type]||r.entity_type)} #${r.entity_id}`,r.action==='correct_lesson_subject'?`${esc(r.before_data?.subject_name)} ← ${esc(r.after_data?.subject_name)}`:r.action==='late_lesson_attendance'?`${esc(r.after_data?.subject_name)} · الطلبة: ${esc(r.after_data?.student_ids?.join('، '))} · ${esc(r.after_data?.note||'')}`:r.action==='reopen_student_exam'?`الطالب #${esc(r.after_data?.student_id)} · ${stamp(r.after_data?.opens_at)} ← ${stamp(r.after_data?.closes_at)} · ${esc(r.after_data?.note||'')}`:'—'])));
    }else if(a==='notifications'){
      view='notifications';setNav('notifications');$('#breadcrumb').textContent='المعهد / حالة الإشعارات';const id=++sequence;const rows=await api('/notifications');if(id===sequence)setContent(head('حالة الإشعارات','الإشعارات المجدولة المحفوظة؛ المحاولات المؤقتة يعاد إرسالها تلقائيًا.')+table(['الحالة','العدد'],rows.map(r=>[esc(labels[r.status]||r.status),esc(r.count)])));
     }else if(a==='matrix-add'){
      const g=matrixDetail?.groups.find(x=>String(x.id)===target.dataset.group);if(!g||g.is_active===false)return;
      const assigned=matrixDetail.subjects.find(x=>x.id===g.subject_id)?.teachers||[];
      if(!assigned.length)throw Error('أسند أستاذًا نشطًا لهذه المادة أولًا.');
      dialog('إضافة موعد — '+g.title,`<form id="matrix-slot"><input type="hidden" name="groupId" value="${g.id}"><input type="hidden" name="dayOfWeek" value="${matrixDay}"><input type="hidden" name="hour" value="${Number(target.dataset.hour)}"><p>${esc(DAY_NAMES[matrixDay])} — الساعة ${Number(target.dataset.hour)} بتوقيت بغداد</p><label>الأستاذ<select name="teacherId" required>${assigned.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label><label>الدقيقة<input name="minute" type="number" min="0" max="59" value="0" required></label><p class="subtle">مدة المباحثة ساعة. يمنع النظام تعارض مواعيد الأستاذ والمجموعة.</p><button class="primary" type="submit">حفظ الموعد ✓</button></form>`);
    }else if(a==='matrix-remove'){
      if(!confirm('إيقاف هذا الموعد الأسبوعي؟ تبقى سجلات الحضور السابقة محفوظة.'))return;
      busy=true;await api('/schedule/'+target.dataset.id+'/remove',{},'POST');await renderScheduleMatrix();
    }else if(a==='teachers')await loadTeachers();
    else if(a==='schedule-matrix')await loadScheduleMatrix();
    else if(a==='lesson-schedule')await loadLessonSchedule();
    else if(a==='lesson-management')await loadLessonManagement();
    else if(a==='management-page'){
      if(target.dataset.kind==='lessons'){mgtPage=Number(target.dataset.page);await loadLessonManagement();}
      else{sessionPage=Number(target.dataset.page);await renderStage();}
    }
    else if(['session-reopen','session-markall','session-cancel'].includes(a)){
      const action=a==='session-markall'?'mark-all':a.slice('session-'.length);
      const messages={reopen:'إعادة فتح تسجيل البداية والنهاية للوقت المتبقي من 24 ساعة منذ النشر الأصلي؟ يبقى الحضور السابق محفوظًا.',
        'mark-all':'تسجيل البداية والنهاية لطلبة المجموعة النشطين المؤهلين لهذه المباحثة؟',cancel:'حذف المباحثة نهائيًا مع حضورها؟ لن يعيد الجدول إنشاءها تلقائيًا لهذا الموعد. لا يمكن التراجع.'};
      if(!confirm(messages[action]))return;
      busy=true;const r=await api('/sessions/'+target.dataset.id+'/'+action,{},'POST');await renderStage();
      notify(action==='mark-all'?`اكتمل حضور ${r.added} طالبًا؛ أضيف ${r.records} تسجيلًا جديدًا.`:action==='cancel'?'حُذفت المباحثة وحضورها.':'أُعيد فتح الحضور للوقت المتبقي من المهلة الأصلية.');
    }
    else if(a==='lesson-reopen'){
      if(!confirm(`إعادة فتح درس «${target.dataset.subject}» للوقت المتبقي من 24 ساعة منذ النشر الأصلي، مع حفظ الحضور السابق؟`))return;
      busy=true;await api('/lessons/'+target.dataset.id+'/reopen',{},'POST');notify('أُعيد فتح الدرس حتى نهاية 24 ساعة من النشر الأصلي.');await loadLessonManagement();
    }else if(a==='lesson-markall'){
      if(!confirm(`تسجيل جميع طلبة المرحلة النشطين حاضرين لدرس «${target.dataset.subject}»، بمن فيهم من لم يستمع فعليًا؟`))return;
      busy=true;const r=await api('/lessons/'+target.dataset.id+'/mark-all',{},'POST');notify(`سُجِّل ${r.added} طالبًا حاضرًا لم يكونوا مؤشَّرين سابقًا.`);await loadLessonManagement();
    }else if(a==='lesson-cancel'){
      if(!confirm(`حذف درس «${target.dataset.subject}» نهائيًا مع كل حضور مسجَّل عليه؟ لا يمكن التراجع.`))return;
      busy=true;await api('/lessons/'+target.dataset.id+'/cancel',{},'POST');notify('أُلغي تفعيل الدرس وحُذف أي حضور مسجَّل عليه.');await loadLessonManagement();
    }else if(a==='channels'||a==='channels-refresh')await loadChannels();
    else if(a==='channel-unlink'){
      if(!confirm(`فكّ ربط قناة «${target.dataset.title}» عن مرحلتها؟ تبقى الدروس والحضور السابقة محفوظة، ولن تُفعّل دروسًا جديدة.`))return;
      busy=true;await api('/channels/'+target.dataset.id+'/unlink',{},'POST');notify('فُكّ ربط القناة.');await loadChannels();
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
        notify(next?'تمت إضافة تاريخ النشر إلى الجدول.':'أزيل تاريخ النشر من الجدول.');
      }catch(e){notify(e.message,true);}finally{busy=false;}
    }
    else if(a==='stats')await loadStats();
    else if(a==='watchlist')await loadWatchlist();
    else if(a==='teacher-performance')await showTeacherPerformance(target.dataset.id);
    else if(a==='matrix-day'){matrixDay=Number(target.dataset.day);await renderScheduleMatrix();}
    else if(a==='add-teacher'){dialog('إضافة أستاذ','<form id="create-teacher"><div class="form-grid"><label>الاسم الرباعي<input name="fullName" maxlength="200" required></label><label>الهاتف (اختياري)<input name="phone" maxlength="30"></label></div><div class="form-actions"><button class="primary">حفظ</button></div></form>');}
    else if(a==='edit-teacher'){const t=teachers.find(x=>String(x.id)===target.dataset.id);if(!t)return;dialog('تعديل اسم الأستاذ',`<form id="edit-teacher" data-id="${t.id}"><label>الاسم الرباعي<input name="fullName" value="${esc(t.full_name)}" maxlength="200" required></label><div class="form-actions"><button class="primary">حفظ</button></div></form>`);}
    else if(a==='toggle-teacher'){
      const active=target.dataset.active==='true';if(!confirm(active?'إعادة تفعيل حساب الأستاذ؟':'إيقاف حساب الأستاذ؟ لن يستطيع الدخول لواجهته حتى إعادة التفعيل.'))return;
      busy=true;await api('/teachers/'+target.dataset.id+'/toggle',{active},'POST');notify('حُفظت حالة الأستاذ.');await loadTeachers();
    }else if(a==='regenerate-code'){
      if(!confirm('توليد كود ربط جديد؟ سيُفصل الحساب المرتبط حاليًا إن وجد، ويحتاج الأستاذ لإرسال الكود الجديد للبوت.'))return;
      busy=true;const r=await api('/teachers/'+target.dataset.id+'/regenerate-code',{},'POST');await loadTeachers();
      dialog('كود الربط الجديد',`<p>أرسل هذا الكود إلى الأستاذ ليُدخله في البوت لربط حسابه:</p><div class="link-code">${esc(r.link_code)}</div>`);
    }else if(a==='teacher-subjects'){
      const t=teachers.find(x=>String(x.id)===target.dataset.id);if(!t)return;currentTeacher=t;
      const subjects=await api('/teachers/'+t.id+'/subjects');
      dialog('مواد '+t.full_name,subjects.length?table(['المادة','المرحلة','الموسم','الطلبة النشطون','إلغاء الإسناد'],subjects.map(sj=>[esc(sj.subject_name),esc(sj.stage_name),esc(sj.season_name),esc(sj.student_count),button('إلغاء','unassign-teacher',`data-id="${sj.assignment_id}"`,'danger')])):empty('لا توجد مواد مسندة لهذا الأستاذ حاليًا','أسند مادة له من تبويب «المواد والمجموعات» داخل المرحلة.'));
    }else if(a==='unassign-teacher'){
      if(!confirm('إلغاء إسناد هذه المادة عن الأستاذ؟'))return;busy=true;await api('/assignments/'+target.dataset.id+'/remove',{},'POST');
      if(currentTeacher){const subjects=await api('/teachers/'+currentTeacher.id+'/subjects');dialog('مواد '+currentTeacher.full_name,subjects.length?table(['المادة','المرحلة','الموسم','الطلبة النشطون','إلغاء الإسناد'],subjects.map(sj=>[esc(sj.subject_name),esc(sj.stage_name),esc(sj.season_name),esc(sj.student_count),button('إلغاء','unassign-teacher',`data-id="${sj.assignment_id}"`,'danger')])):empty('لا توجد مواد مسندة لهذا الأستاذ حاليًا'));}
      notify('أُلغي إسناد المادة.');
    }else if(a==='edit-group'){
      const g=currentStage?.groups.find(x=>String(x.id)===target.dataset.id);if(!g)return;
      dialog('تعديل '+g.title,`<form id="edit-group" data-id="${g.id}"><div class="form-grid"><label>السعة<input name="capacity" type="number" min="1" max="10000" value="${g.capacity}" required></label><label>رابط المجموعة<input name="inviteLink" type="url" value="${esc(g.invite_link||'')}" placeholder="https://t.me/..."></label></div><div class="form-actions"><button class="primary">حفظ</button>${button(g.is_active?'تعطيل المجموعة':'تفعيل المجموعة','toggle-group',`data-id="${g.id}" data-active="${!g.is_active}"`,g.is_active?'danger':'')}</div></form>`);
    }else if(a==='toggle-group'){
      const active=target.dataset.active==='true';if(!confirm(active?'إعادة تفعيل المجموعة؟':'تعطيل المجموعة؟ يبقى سجلها محفوظًا.'))return;
      busy=true;await api('/groups/'+target.dataset.id,{active},'PATCH');$('#detail').close();await refresh();notify('حُفظت حالة المجموعة.');
    }else if(a==='logout'){if(token)await api('/logout',{},'POST');token='';sequence++;$('#detail').close();setContent(empty('انتهت جلسة الإدارة','أغلق النافذة وافتحها مجددًا من البوت للدخول.'));}
  }catch(e){notify(e.message,true);}finally{busy=false;}
});
document.addEventListener('change',async event=>{
  if(event.target.name==='override-student'&&adminSelection){
    const id=Number(event.target.value);
    if(adminSelection.kind==='exam')adminSelection.selected.clear();
    if(event.target.checked)adminSelection.selected.set(id,event.target.dataset.name);
    else adminSelection.selected.delete(id);
    updateOverrideSelected();return;
  }
  if(event.target.name==='stageId'&&event.target.closest('#attendance-stage')){if(busy)return;busy=true;clearNotice();try{attendanceStageId=event.target.value;page=0;await attendanceHome();}catch(e){notify(e.message,true);}finally{busy=false;}
  }else if(event.target.name==='stageId'&&event.target.closest('#matrix-stage')){if(busy)return;busy=true;clearNotice();
    try{matrixStageId=event.target.value;await renderScheduleMatrix();}catch(e){notify(e.message,true);}finally{busy=false;}
  }else if(event.target.id==='lesson-schedule-stage'){if(busy)return;busy=true;clearNotice();
    try{lessonScheduleStageId=event.target.value;await renderLessonSchedule(stages.filter(s=>s.stage_season_id));}catch(e){notify(e.message,true);}finally{busy=false;}
  }else if(event.target.name==='stageId'&&event.target.closest('#lesson-mgt-stage')){if(busy)return;busy=true;clearNotice();
    try{mgtStageId=event.target.value;mgtSubjectId='';mgtPage=0;await loadLessonManagement();}catch(e){notify(e.message,true);}finally{busy=false;}
  }else if(['lesson-mgt-subject','session-mgt-subject'].includes(event.target.id)){if(busy)return;busy=true;clearNotice();
    try{if(event.target.id==='lesson-mgt-subject'){mgtSubjectId=event.target.value;mgtPage=0;await loadLessonManagement();}else{sessionSubjectId=event.target.value;sessionPage=0;await renderStage();}}catch(e){notify(e.message,true);}finally{busy=false;}
  }else if(event.target.id==='season-select'){if(busy)return;busy=true;clearNotice();
    try{currentSeasonId=event.target.value;mgtSubjectId='';mgtPage=0;sessionSubjectId='';sessionPage=0;if(view==='lesson-management')await loadLessonManagement();else if(view==='stage'&&currentStage)await openStage(currentStage.id);else if(view==='lesson-attendance'){page=0;await attendanceHome();}else await home();}catch(e){notify(e.message,true);}finally{busy=false;}
  }
});
document.addEventListener('submit',async event=>{
  const form=event.target;event.preventDefault();if(busy)return;clearNotice();const body=Object.fromEntries(new FormData(form));
  busy=true;const submit=form.querySelector('button[type="submit"],button:not([data-action])');if(submit)submit.disabled=true;
  try{
    if(form.id==='contact-search'){contactQuery=String(body.q||'').trim();contactPage=0;await loadStudentContact();}
    else if(form.id==='contact-send'){
      if(!contactStudent)throw Error('اختر الطالب أولًا.');
      const saved=await api('/student-contact',{studentId:contactStudent.id,message:body.message,contextKind:contactStudent.contextKind,contextId:contactStudent.contextId,requestKey:form.dataset.requestKey||(form.dataset.requestKey=contactRequestKey('admin-web'))},'POST');
      await openStudentContact(contactStudent.id,contactStudent.contextKind,contactStudent.contextId);
      notify(`حُفظت الرسالة #${saved.id} للإرسال عبر البوت.`);
    }
    else if(form.id==='correct-lesson'){
      if(!confirm('حفظ المادة الصحيحة مع الاحتفاظ بكل حضور الدرس؟'))return;
      await api('/lessons/'+form.dataset.id+'/subject',body,'PATCH');$('#detail').close();await loadLessonManagement();notify('حُفظت المادة وبقيت كل سجلات الحضور.');
    }else if(form.id==='override-search'){adminSelection.query=body.q;await loadOverrideStudents(0);}
    else if(form.id==='save-override'){
      const state=adminSelection,ids=[...state.selected.keys()];
      if(!ids.length)throw Error('حدد طالبًا واحدًا على الأقل.');
      if(state.kind==='lesson'){
        if(ids.length>500)throw Error('الحد الأقصى 500 طالب في العملية.');
        if(!confirm(`تسجيل حضور إداري متأخر لـ ${ids.length} طالبًا في ${state.item.subject_name}، الدرس #${state.id} المنشور ${stamp(state.item.activated_at)}؟`))return;
        const result=await api('/lessons/'+state.id+'/late-attendance',{subjectId:state.item.subject_id,studentIds:ids,note:body.note},'POST');
        $('#detail').close();await loadLessonManagement();notify(`أضيف حضور ${result.added} طالبًا. كان ${result.existing} مسجلًا مسبقًا.`);
      }else{
        if(ids.length!==1)throw Error('حدد طالبًا واحدًا فقط.');
        if(!body.opensAt||!body.closesAt)throw Error('أدخل وقت البداية والنهاية الجديدين.');
        const opensAt=body.opensAt+':00+03:00',closesAt=body.closesAt+':00+03:00';
        if(!(new Date(closesAt)>new Date(opensAt)))throw Error('نهاية النافذة يجب أن تكون بعد بدايتها.');
        if(!confirm(`فتح ${state.item.subject_name} للطالب ${state.selected.get(ids[0])} فقط من ${stamp(opensAt)} إلى ${stamp(closesAt)}؟`))return;
        await api('/exams/'+state.id+'/student-window',{subjectId:state.item.subject_id,studentId:ids[0],opensAt,closesAt,note:body.note},'POST');
        await showExam(state.id);notify('حُفظت نافذة الفتح الخاصة بالطالب. يدخل إليها من الامتحانات الشهرية في البوت.');
      }
    }
    else if(form.id==='attendance-filter'){attendanceFilters={q:body.q,status:body.status};page=0;await refresh();}
    else if(form.id==='participation-settings'){if(body.grouped==='false'&&currentStage.discussion_grouping!==false&&!confirm('تحويل مباحثات المرحلة إلى تنظيم موحّد؟ ينتقل أعضاء المجموعات تلقائيًا مع حفظ سجلاتهم. عند وجود مجموعات متعددة للمادة تتوقف مواعيدها لتحديد موعد موحد.'))return;const saved=await api('/stage-seasons/'+currentStage.stage_season_id+'/participation-settings',{grouped:body.grouped==='true',enabledSubjectIds:[...form.querySelectorAll('[data-study-id]')].filter(el=>el.value==='true').map(el=>Number(el.dataset.studyId))},'PATCH');await refresh();notify(saved.pausedSlots?'حُفظت الإعدادات ونُقل الطلبة. حُفظت المواعيد السابقة وتوقفت؛ حدّد موعدًا موحدًا لكل مادة مدمجة من جداول المباحثات.':'حُفظت إعدادات المباحثات والتقارير لهذا الموسم.');}
    else if(form.id==='search'){filters={...filters,...body};page=0;await renderStage();}
    else if(form.id==='leave-filter'){filters.leaveStatus=body.leaveStatus;page=0;await refresh();}
    else if(form.id==='report-filter'){filters.groupId=body.groupId;page=0;await renderStage();}
    else if(form.id==='matrix-slot'){await api('/schedule',body,'POST');$('#detail').close();await renderScheduleMatrix();notify('حُفظ موعد المباحثة.');}
    else if(form.id==='edit-student'){await api('/students/'+currentStudent.id,{...body,expectedName:currentStudent.full_name},'PATCH');$('#detail').close();await refresh();notify('حُفظ اسم الطالب.');}
    else if(form.id==='move-group'){if(!confirm('توحيد رقم المجموعة المختارة في جميع مواد الطالب لهذا الموسم؟ سيُرفض النقل كله إذا غابت مجموعة مطابقة أو امتلأت. تبقى التقارير السابقة محفوظة.'))return;await api('/students/'+currentStudent.id+'/group',body,'POST');$('#detail').close();await refresh();notify('وُحّد رقم المجموعة في مواد الطالب.');}
    else if(form.id==='move-stage'){if(!confirm('نقل الطالب إلى المرحلة المختارة؟ يُحفظ حضوره السابق وتبدأ أهلية الدروس الجديدة من وقت النقل.'))return;await api('/students/'+currentStudent.id+'/stage',body,'POST');$('#detail').close();await refresh();notify('حُفظت المرحلة.');}
    else if(form.id==='exam-question'){body.options=body.type==='mcq'?body.options.split(/\r?\n/).map(s=>s.trim()).filter(Boolean):undefined;await api('/exams/'+currentExam.id+'/question',body,'POST');await showExam(currentExam.id);notify('أُضيف السؤال.');}
    else if(form.id==='postpone-exam'){if(!confirm('تغيير موعد الامتحان؟'))return;await api('/exams/'+currentExam.id+'/postpone',body,'POST');await showExam(currentExam.id);notify('حُفظ الموعد.');}
    else if(form.id==='grade-report'){await api('/reports/'+form.dataset.id+'/score',body,'POST');$('#detail').close();await refresh();notify('حُفظ تقييم التقرير.');}
    else if(form.id==='edit-teacher'){await api('/teachers/'+form.dataset.id,body,'PATCH');$('#detail').close();await loadTeachers();notify('حُفظ اسم الأستاذ.');}
    else if(form.id==='edit-group'){await api('/groups/'+form.dataset.id,{capacity:body.capacity,inviteLink:body.inviteLink||null},'PATCH');$('#detail').close();await refresh();notify('حُفظت بيانات المجموعة.');}
    else if(form.id.startsWith('create-')){
      const kind=form.id.slice(7);const routes={stage:'/stages',subject:'/subjects',group:'/groups',assignment:'/assignments',slot:'/schedule',exam:'/exams',teacher:'/teachers'};
      if(kind==='subject')body.stageId=currentStage.id;if(['group','exam'].includes(kind))body.seasonId=currentStage.stage_season_id;
      await api(routes[kind],body,'POST');$('#detail').close();
      if(kind==='teacher'){await loadTeachers();notify('أُضيف الأستاذ بنجاح.');}else{await refresh();notify('أُضيف السجل بنجاح.');}
    }
  }catch(e){notify(e.message,true);}finally{busy=false;if(submit)submit.disabled=false;}
});
(async()=>{
  const tg=window.Telegram?.WebApp;
  tg?.ready();tg?.expand();
  try{tg?.disableVerticalSwipes?.();}catch{}
  try{tg?.setHeaderColor?.('#101b2b');}catch{}
  try{tg?.setBackgroundColor?.('#f4f6f9');}catch{}
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
