'use strict';
const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=value=>value?new Date(value).toLocaleDateString('ar-IQ',{timeZone:'Asia/Baghdad'}):'—';
const stamp=value=>value?new Date(value).toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad'}):'—';
const labels={pending:'بانتظار القرار',approved:'معتمدة',rejected:'مرفوضة',ended:'منتهية',cancelled:'ملغاة',sent:'أُرسلت',sending:'قيد الإرسال',failed:'تعذّر إرسالها',expired:'انتهت المهلة',draft:'مسودة',published:'منشور'};
const actionLabels={update_student:'تعديل طالب',move_stage:'نقل مرحلة',move_group:'نقل مجموعة',leave_decision:'قرار إجازة',grade_report:'تقييم تقرير',end_session:'إنهاء مباحثة',create_stage:'إضافة مرحلة',create_subject:'إضافة مادة',create_group:'إضافة مجموعة',update_group:'تعديل مجموعة',assign_teacher:'إسناد أستاذ',unassign_teacher:'إلغاء إسناد أستاذ',create_slot:'إضافة موعد',remove_slot:'إيقاف موعد',create_exam:'إنشاء امتحان',exam_question:'إضافة سؤال',exam_publish:'نشر امتحان',exam_postpone:'تغيير موعد امتحان',remove_question:'حذف سؤال',create_teacher:'إضافة أستاذ',update_teacher:'تعديل أستاذ',toggle_teacher:'تفعيل/إيقاف أستاذ',regenerate_code:'توليد كود ربط'};
const entityLabels={student:'طالب',stage:'مرحلة',subject:'مادة',group:'مجموعة',leave:'إجازة',report:'تقرير',session:'مباحثة',slot:'موعد',exam:'امتحان',question:'سؤال',teacher:'أستاذ',assignment:'إسناد'};
const DAY_NAMES=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
let token='',stages=[],teachers=[],currentStage=null,currentStudent=null,currentExam=null,currentTeacher=null,matrixStageId=null,matrixDay=new Date().getDay(),matrixEligible=[],tab='students',page=0,view='home',sequence=0,dialogSequence=0,busy=false;
let filters={q:'',status:'active',groupId:''};
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
function groupOptions(groups,selected='',all='جميع المجموعات'){return `<option value="">${all}</option>`+groups.map(g=>`<option value="${g.id}" ${String(g.id)===String(selected)?'selected':''}>${esc(g.subject_name||'')} · ${esc(g.title)}</option>`).join('');}
function stageHeader(){const s=currentStage;return head(s.name,`الموسم: ${s.season_name||'لا يوجد موسم نشط'}`,button('كل المراحل','home'))+
  `<div class="summary"><div><b>${s.student_count}</b>طالب</div><div><b>${s.subject_count}</b>مادة</div><div><b>${s.group_count}</b>مجموعة</div></div>`+
  `<div class="tabs" role="navigation" aria-label="أقسام المرحلة">${Object.entries({students:'الطلبة',subjects:'المواد والمجموعات',leaves:'الإجازات',...(s.stage_type!=='lessons_only'?{reports:'التقارير',schedule:'المباحثات',exams:'الامتحانات'}:{}),exports:'التصدير'}).map(([key,name])=>button(name,'tab',`data-tab="${key}"`,tab===key?'active':'')).join('')}</div>`;}
async function home(){view='home';currentStage=null;page=0;setNav('home');const id=++sequence;stages=await api('/stages');if(id!==sequence)return;
  $('#breadcrumb').textContent='المعهد / المراحل والطلبة';
  setContent(head('المراحل الدراسية','اختر المرحلة للاطلاع على طلبتها وموادها ومجموعاتها.',button('إضافة مرحلة','new-stage','','primary'))+
    (stages.length?`<div class="cards">${stages.map(s=>`<button class="stage-card" data-action="stage" data-id="${s.id}"><div><h2>${esc(s.name)}</h2><small>${esc(s.season_name||'لا يوجد موسم نشط')}</small></div><div class="stats"><div><span class="metric">${s.student_count}</span><small>طالب</small></div><div><span class="metric">${s.subject_count}</span><small>مادة</small></div><div><span class="metric">${s.group_count}</span><small>مجموعة</small></div></div><div class="card-footer"><span>${s.is_active?'مرحلة نشطة':'مرحلة مؤرشفة'}</span><span>عرض التفاصيل ←</span></div></button>`).join('')}</div>`:empty('لم تُضف مراحل بعد','ابدأ بإضافة المرحلة الأولى.')));
}
async function openStage(id){view='stage';tab='students';page=0;filters={q:'',status:'active',groupId:''};const n=++sequence;const s=await api('/stages/'+id);if(n!==sequence)return;currentStage=s;await renderStage();}
async function renderStage(){
  if(!currentStage)return;view='stage';const n=++sequence,s=currentStage;$('#breadcrumb').textContent='المعهد / '+s.name;
  let body='';const query=new URLSearchParams({stageId:s.id,page,...filters});if(!filters.groupId)query.delete('groupId');
  if(tab==='students'){
    const data=await api('/students?'+query);
    body=`<form id="search" class="toolbar"><label>اسم الطالب<input name="q" value="${esc(filters.q)}" placeholder="بحث داخل المرحلة" maxlength="150"></label><label class="compact">الحالة<select name="status">${Object.entries({active:'نشطون',archived:'مؤرشفون',all:'الجميع'}).map(([v,t])=>`<option value="${v}" ${filters.status===v?'selected':''}>${t}</option>`).join('')}</select></label><label class="compact">المجموعة<select name="groupId">${groupOptions(s.groups,filters.groupId)}</select></label><button class="primary" type="submit">عرض</button></form>`+
    table(['الطالب','المجموعات حسب المادة','الحالة','ملف الطالب'],data.rows.map(st=>[esc(st.full_name),st.groups.map(g=>`<div>${esc(g.subject)}: ${esc(g.group)}</div>`).join('')||'<span class="subtle">لم يُوزّع بعد</span>',`<span class="tag ${st.is_active?'ok':''}">${st.is_active?'نشط':'مؤرشف'}</span>`,button('عرض وتعديل','student',`data-id="${st.id}"`)]))+pager(data.total);
  }else if(tab==='subjects'){
    body=`<div class="toolbar">${button('إضافة مادة','new-subject','','primary')}${s.stage_type!=='lessons_only'?button('إضافة مجموعة','new-group')+button('إسناد أستاذ لمادة','new-assignment'):''}</div>`+
      s.subjects.map(sub=>`<section class="detail-section"><h2>${esc(sub.name)}</h2><p class="subtle">الأستاذ: ${esc(sub.teacher_name||'لم يُسنَد')} · الهاشتاغ: #${esc(sub.hashtag)}</p>`+table(['المجموعة','الطلبة / السعة','رابط المجموعة','الحالة','الإجراء'],s.groups.filter(g=>g.subject_id===sub.id).map(g=>[esc(g.title),`${g.member_count} / ${g.capacity}`,g.invite_link&&/^https:\/\/t\.me\//.test(g.invite_link)?`<a href="${esc(g.invite_link)}" target="_blank" rel="noopener noreferrer">فتح المجموعة</a>`:'لم يُضف',g.is_active?'<span class="tag ok">نشطة</span>':'<span class="tag danger">معطّلة</span>',button('تعديل','edit-group',`data-id="${g.id}"`)]))+'</section>').join('');
    if(!s.subjects.length)body+=empty('لا توجد مواد في المرحلة');
  }else if(tab==='leaves')body=await leavesContent(s.id);
  else if(tab==='reports'){
    const data=await api('/reports?'+new URLSearchParams({seasonId:s.stage_season_id,page,...(filters.groupId?{groupId:filters.groupId}:{})}));
    body=`<form id="report-filter" class="toolbar"><label>المجموعة<select name="groupId">${groupOptions(s.groups,filters.groupId)}</select></label><button>عرض</button></form>`+
      table(['الطالب والمادة','المجموعة وقت الإرسال','التاريخ','الدرجة / 15','المراجعة'],data.rows.map(r=>[`${esc(r.full_name)}<div class="subtle">${esc(r.subject_name)}</div>`,esc(r.group_title_snapshot||'قديم: بلا مجموعة موثقة'),stamp(r.submitted_at),r.score==null?'لم يُقيّم':esc(r.score),button('عرض وتقييم','report',`data-id="${r.id}"`)]))+pager(data.total);
    if(n===sequence)window.currentReports=data.rows;
  }else if(tab==='schedule'){
    const [slots,sessions]=await Promise.all([api('/schedule?seasonId='+s.stage_season_id),api('/sessions?seasonId='+s.stage_season_id)]);
    body=`<div class="toolbar">${button('إضافة موعد مباحثة','new-slot','','primary')}</div><h2>الجدول الأسبوعي</h2>`+table(['المادة','المجموعة والأستاذ','اليوم','الموعد','الإجراء'],slots.map(sl=>[esc(sl.subject_name),`${esc(sl.group_title)}<div class="subtle">${esc(sl.teacher_name)}</div>`,['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'][sl.day_of_week],`${sl.hour}:${String(sl.minute).padStart(2,'0')} · ساعة`,button('إيقاف الموعد','remove-slot',`data-id="${sl.id}"`)]))+
      '<section class="detail-section"><h2>آخر 100 مباحثة</h2><p class="subtle">الحضور المكتمل يعني تسجيل البداية والنهاية معًا. تُصدّر جميع سجلات الحضور من قسم التصدير.</p>'+table(['المادة والمجموعة','الانتهاء','حضور مكتمل','الحالة / الإجراء'],sessions.map(session=>[`${esc(session.subject_name)}<div class="subtle">${esc(session.group_title)}</div>`,stamp(session.closes_at),String(session.complete_count),!session.is_closed&&new Date(session.closes_at)>new Date()?button('إنهاء وفتح الحضور الثاني','end-session',`data-id="${session.id}"`):session.end_closes_at&&new Date(session.end_closes_at)>new Date()?'<span class="tag ok">حضور النهاية مفتوح</span>':'انتهت']))+'</section>';
  }else if(tab==='exams'){
    const exams=await api('/exams?seasonId='+s.stage_season_id);
    body=`<div class="toolbar">${button('إنشاء امتحان','new-exam','','primary')}</div>`+table(['المادة','الامتحان','الفتح','الإغلاق','الحالة','الأسئلة والنشر'],exams.map(ex=>[esc(ex.subject_name),esc(ex.title||'الشهري '+ex.exam_number),stamp(ex.opens_at),stamp(ex.closes_at),esc(labels[ex.status]),button('فتح الامتحان','exam',`data-id="${ex.id}"`)]));
  }else if(tab==='exports'){
    body=`<section class="empty"><h2>سجلات الحضور بصيغة MD</h2><p>صف مستقل لكل تسجيل حضور، مع عمود للتاريخ وآخر للوقت بتوقيت بغداد ووقت UTC. حضور البداية والنهاية سجلان منفصلان.</p><div class="toolbar"><label>الموسم<select id="export-season">${s.seasons.map(se=>`<option value="${se.id}">${esc(se.name||se.season_name||'الموسم')} ${se.is_active?'— الحالي':'— أرشيف'}</option>`).join('')}</select></label>${button('تنزيل حضور الدروس','export',`data-kind="lessons"`,'primary')}${s.stage_type!=='lessons_only'?button('تنزيل حضور المباحثات','export','data-kind="discussions"'):''}</div></section>`;
  }
  if(n===sequence)setContent(stageHeader()+body);
}
async function leavesContent(stageId){
  const data=await api('/leaves?'+new URLSearchParams({page,status:filters.leaveStatus||'pending',...(stageId?{stageId}:{})}));
  return `<form id="leave-filter" class="toolbar"><label>حالة الطلب<select name="leaveStatus">${['pending','approved','ended','rejected','cancelled','all'].map(v=>`<option value="${v}" ${v===(filters.leaveStatus||'pending')?'selected':''}>${labels[v]||'الجميع'}</option>`).join('')}</select></label><button>عرض</button></form>`+
    table(['الطالب / المرحلة','الفترة','الأيام','الحالة','القرار'],data.rows.map(l=>[`${esc(l.full_name)}<div class="subtle">${esc(l.stage_name)}</div>`,`${date(l.start_date)} — ${date(l.end_date)}`,esc(l.days),esc(labels[l.status]),l.status==='pending'?button('موافقة','leave',`data-id="${l.id}" data-approve="true"`)+button('رفض','leave',`data-id="${l.id}" data-approve="false"`):'—']))+pager(data.total);
}
async function allLeaves(){view='leaves';currentStage=null;setNav('all-leaves');$('#breadcrumb').textContent='المعهد / طلبات الإجازة';const n=++sequence;const html=await leavesContent(null);if(n===sequence)setContent(head('طلبات الإجازة','جميع المراحل · الحد الأقصى عشرة أيام لكل طالب في الموسم')+html);}
async function loadTeachers(){view='teachers';currentStage=null;setNav('teachers');$('#breadcrumb').textContent='المعهد / الأساتذة';const n=++sequence;teachers=await api('/teachers');if(n!==sequence)return;
  setContent(head('الأساتذة','إدارة حسابات الأساتذة وربطها بتليجرام وإسنادها للمواد.',button('إضافة أستاذ','add-teacher','','primary'))+
    table(['الاسم','الهاتف','الربط بتليجرام','المواد النشطة','الحالة','الإجراءات'],teachers.map(t=>[esc(t.full_name),esc(t.phone||'—'),
      t.linked?'<span class="tag ok">مرتبط</span>':t.link_code?`<span class="tag warn">بانتظار الربط</span><div class="subtle">كود: <b>${esc(t.link_code)}</b></div>`:'<span class="tag warn">بانتظار الربط</span>',
      esc(t.active_subject_count),t.is_active?'<span class="tag ok">نشط</span>':'<span class="tag danger">موقوف</span>',
      button('تعديل الاسم','edit-teacher',`data-id="${t.id}"`)+button(t.is_active?'إيقاف':'تفعيل','toggle-teacher',`data-id="${t.id}" data-active="${!t.is_active}"`,t.is_active?'danger':'')+button('كود جديد','regenerate-code',`data-id="${t.id}"`)+button('المواد','teacher-subjects',`data-id="${t.id}"`)
    ]))+(teachers.length?'':empty('لا يوجد أساتذة بعد','ابدأ بإضافة الأستاذ الأول.')));
}
async function loadScheduleMatrix(){view='schedule-matrix';currentStage=null;setNav('schedule-matrix');$('#breadcrumb').textContent='المعهد / جداول المباحثات';const n=++sequence;
  if(!stages.length)stages=await api('/stages');if(n!==sequence)return;
  matrixEligible=stages.filter(s=>s.stage_type!=='lessons_only'&&s.stage_season_id);
  if(!matrixEligible.length){setContent(head('جداول المباحثات','مصفوفة المجموعات والساعات المعتمدة لكل يوم.')+empty('لا توجد مراحل مباحثات نشطة','أضف مرحلة موسمها نشط وليست من نوع الدروس فقط.'));return;}
  if(!matrixStageId||!matrixEligible.some(s=>String(s.id)===String(matrixStageId)))matrixStageId=matrixEligible[0].id;
  await renderScheduleMatrix();
}
async function renderScheduleMatrix(){
  const n=++sequence;const s=await api('/stages/'+matrixStageId);const slots=await api('/schedule?seasonId='+s.stage_season_id);if(n!==sequence)return;
  const dayTabs=DAY_NAMES.map((d,i)=>button(d,'matrix-day',`data-day="${i}"`,String(i)===String(matrixDay)?'active':'')).join('');
  const daySlots=slots.filter(sl=>Number(sl.day_of_week)===Number(matrixDay));
  const hours=[...new Set(daySlots.map(sl=>Number(sl.hour)))].sort((a,b)=>a-b);
  let body=`<form id="matrix-stage" class="toolbar"><label>المرحلة<select name="stageId">${matrixEligible.map(e=>`<option value="${e.id}" ${String(e.id)===String(matrixStageId)?'selected':''}>${esc(e.name)}</option>`).join('')}</select></label></form>`+
    `<div class="tabs" role="navigation" aria-label="أيام الأسبوع">${dayTabs}</div>`;
  if(!s.groups.length)body+=empty('لا توجد مجموعات في هذه المرحلة');
  else if(!hours.length)body+=empty('لا توجد مباحثات مجدولة في هذا اليوم','اختر يومًا آخر أو أضف موعدًا من صفحة المرحلة.');
  else body+=`<div class="matrix-wrap"><table class="matrix"><thead><tr><th scope="col">المجموعة</th>${hours.map(h=>`<th scope="col">${String(h).padStart(2,'0')}:00</th>`).join('')}</tr></thead><tbody>${
    s.groups.map(g=>`<tr><td>${esc(g.subject_name)} · ${esc(g.title)}</td>${hours.map(h=>{
      const match=daySlots.find(sl=>Number(sl.group_id)===Number(g.id)&&Number(sl.hour)===h);
      return `<td>${match?`<span class="matrix-check" title="${esc(match.teacher_name||'')}">✓</span>`:'<span class="matrix-empty">—</span>'}</td>`;
    }).join('')}</tr>`).join('')
  }</tbody></table></div>`;
  if(n===sequence)setContent(head('جداول المباحثات','العمود الأول أسماء المجموعات، والصف الأول ساعات المباحثات المعتمدة لليوم المختار.')+body);
}
function dialog(title,html){clearNotice();$('#dialog-title').textContent=title;$('#dialog-body').innerHTML=html;if(!$('#detail').open)$('#detail').showModal();}
async function showStudent(id){
  const n=++dialogSequence;const st=await api('/students/'+id);if(n!==dialogSequence)return;currentStudent=st;
  const budget=st.activity?.approvedLeaveDays||0;const pending=st.leaves.filter(l=>l.status==='pending'&&l.stage_season_id===st.activity?.stageSeasonId).reduce((sum,l)=>sum+Number(l.days),0);
  dialog(st.full_name,`<p class="subtle">${esc(st.stage_name)} · ${st.is_active?'نشط':'مؤرشف'} · ${st.official_confirmed_at?'أكّد التسجيل الرسمي':'لم يؤكد التسجيل الرسمي'}</p><form id="edit-student"><label>الاسم الرباعي<input name="fullName" value="${esc(st.full_name)}" maxlength="200" required></label><div class="form-actions"><button class="primary">حفظ الاسم</button>${button(st.is_active?'أرشفة الطالب':'إعادة تفعيل الطالب','archive',`data-id="${st.id}" data-active="${!st.is_active}"`,st.is_active?'danger':'')}</div></form>`+
    `<section class="detail-section"><h3>المرحلة الدراسية</h3><form id="move-stage" class="toolbar"><label>النقل إلى مرحلة<select name="stageId" required>${stages.filter(s=>s.is_active&&s.stage_season_id).map(s=>`<option value="${s.id}" ${s.id===st.stage_id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label><button>نقل الطالب</button></form></section>`+
    `<section class="detail-section"><h3>المجموعات حسب المادة</h3>${st.groups.map(g=>`<p>${esc(g.subject_name)}: ${esc(g.group_title)}</p>`).join('')||'<p>لم يُوزّع بعد.</p>'}${currentStage?.groups.length?`<form id="move-group" class="toolbar"><label>نقل / إسناد الطالب لمجموعة<select name="groupId" required>${groupOptions(currentStage.groups,'','اختر المجموعة')}</select></label><button>حفظ المجموعة</button></form>`:''}<p class="subtle">النقل لا يغير مجموعة التقارير السابقة. تبدأ أهلية مباحثات المجموعة الجديدة من تاريخ النقل.</p></section>`+
    `<section class="detail-section"><h3>المتغيرات في الموسم الحالي</h3><div class="summary"><div><b>${budget}/10</b>إجازات معتمدة</div><div><b>${pending}</b>أيام محجوزة لطلبات معلقة</div><div><b>${Math.max(0,10-budget-pending)}</b>أيام متبقية</div></div>${st.activity?.warnings?.length?`<p>التنبيهات المستلمة: ${st.activity.warnings.length}</p>`:''}</section>`+
    `<section class="detail-section"><h3>حضور الدروس في الموسم الحالي</h3>${table(['المادة','الحضور','عدد الدروس'],st.attendance.map(r=>[esc(r.subject_name),esc(r.attended_lessons),esc(r.total_lessons)]))}</section>`+
    `<section class="detail-section"><h3>آخر 100 طلب إجازة، بما فيها المواسم السابقة</h3>${table(['البداية','النهاية','الأيام','الحالة'],st.leaves.map(l=>[date(l.start_date),date(l.end_date),esc(l.days),esc(labels[l.status])]))}</section>`);
}
async function newForm(kind){
  const id=++dialogSequence;
  const subjectOptions=currentStage?.subjects.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');
  let fields=kind==='stage'?'<label>اسم المرحلة<input name="name" required maxlength="100"></label>':kind==='subject'?'<label>اسم المادة<input name="name" required maxlength="100"></label><label>الهاشتاغ<input name="hashtag" required maxlength="100"></label>':`<label>المادة<select name="subjectId" required>${subjectOptions||''}</select></label><label>عنوان المجموعة<input name="title" required maxlength="100" placeholder="المجموعة الأولى"></label><label>السعة<input name="capacity" type="number" min="1" max="10000" value="50" required></label><label>رابط المجموعة (اختياري)<input name="inviteLink" type="url" placeholder="https://t.me/..."></label>`;
  if(['assignment','slot','exam'].includes(kind)){
    const teachers=(await api('/teachers')).filter(t=>t.is_active);if(id!==dialogSequence)return;
    const teacherField=`<label>الأستاذ<select name="teacherId" required>${teachers.map(t=>`<option value="${t.id}">${esc(t.full_name)}</option>`).join('')}</select></label>`;
    const subjectField=`<label>المادة<select name="subjectId" required>${subjectOptions}</select></label>`;
    fields=kind==='assignment'?subjectField+teacherField:kind==='slot'?`<label>المجموعة<select name="groupId" required>${groupOptions(currentStage.groups,'','اختر المجموعة')}</select></label>${teacherField}<label>اليوم<select name="dayOfWeek">${['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'].map((d,i)=>`<option value="${i}">${d}</option>`).join('')}</select></label><label>الساعة (0–23)<input name="hour" type="number" min="0" max="23" required></label><label>الدقيقة<input name="minute" type="number" min="0" max="59" value="0" required></label><p class="subtle">المدة ساعة. اختر أستاذًا مسندًا لهذه المادة؛ يمنع النظام تداخل مواعيده.</p>`:
      subjectField+teacherField+'<label>رقم الامتحان<input name="examNumber" type="number" min="1" max="3" required></label><label>العنوان<input name="title" maxlength="150" required></label><label>التاريخ<input name="dateIso" type="date" required></label><label>ساعات الإتاحة<input name="hours" type="number" min="1" max="720" value="24" required></label><p class="subtle">يبدأ الامتحان في الساعة المحددة بإعدادات المعهد (الافتراضي 22:00 بتوقيت بغداد). يُحفظ مسودة حتى تضيف الأسئلة وتنشره.</p>';
  }
  dialog({stage:'إضافة مرحلة',subject:'إضافة مادة',group:'إضافة مجموعة',assignment:'إسناد أستاذ لمادة',slot:'إضافة موعد',exam:'إنشاء امتحان'}[kind],`<form id="create-${kind}"><div class="form-grid">${fields}</div><div class="form-actions"><button class="primary">حفظ</button></div></form>`);
}
async function showExam(id){
  const n=++dialogSequence;const exam=await api('/exams/'+id);if(n!==dialogSequence)return;currentExam=exam;
  dialog(exam.title||'الامتحان الشهري '+exam.exam_number,`<p>${esc(exam.subject_name)} · ${esc(labels[exam.status])}</p><p>يفتح: ${stamp(exam.opens_at)} · يغلق: ${stamp(exam.closes_at)}</p>`+
    table(['السؤال','الخيارات','الصحيح','الإجراء'],exam.questions.map(q=>[esc(q.prompt),esc((q.options||['صح','خطأ']).join(' / ')),esc(q.correct_answer),exam.status==='draft'?button('حذف السؤال','remove-question',`data-id="${q.id}"`):'محمي بعد النشر']))+
    (exam.status==='draft'?`<form id="exam-question" class="detail-section"><h3>إضافة سؤال</h3><label>النوع<select name="type"><option value="tf">صح أو خطأ</option><option value="mcq">اختيار من متعدد</option></select></label><label>نص السؤال<textarea name="prompt" maxlength="3000" required></textarea></label><label>الخيارات: كل خيار في سطر (للاختيار المتعدد فقط)<textarea name="options"></textarea></label><label>الإجابة الصحيحة بالنص المطابق للخيار<input name="correct" maxlength="300" required placeholder="صح أو خطأ أو نص أحد الخيارات"></label><div class="form-actions"><button class="primary">إضافة السؤال</button></div></form><div class="form-actions">${button('نشر الامتحان وإشعار الطلبة','publish-exam','','primary')}</div>`:'')+
    `<form id="postpone-exam" class="detail-section"><h3>تغيير الموعد</h3><p class="subtle">متاح فقط قبل بدء أي طالب محاولة. تُحفظ الإجابات السابقة.</p><label>التاريخ الجديد<input name="dateIso" type="date" required></label><div class="form-actions"><button>حفظ الموعد</button></div></form>`);
}
async function refresh(){if(view==='stage'){currentStage=await api('/stages/'+currentStage.id);return renderStage();}if(view==='leaves')return allLeaves();return home();}
document.addEventListener('click',async event=>{
  const target=event.target.closest('[data-action]');if(!target||busy)return;const a=target.dataset.action;
  if(target.closest('form')&&target.type==='submit')event.preventDefault();
  clearNotice();
  try{
    if(a==='home')await home();
    else if(a==='stage')await openStage(target.dataset.id);
    else if(a==='tab'){tab=target.dataset.tab;page=0;await renderStage();}
    else if(a==='prev'||a==='next'){page+=a==='next'?1:-1;await refresh();}
    else if(a==='all-leaves'){page=0;await allLeaves();}
    else if(a==='student')await showStudent(target.dataset.id);
    else if(a==='close-dialog'){dialogSequence++;$('#detail').close();}
    else if(a.startsWith('new-'))await newForm(a.slice(4));
    else if(a==='exam')await showExam(target.dataset.id);
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
      dialog('مراجعة التقرير',`<h3>${esc(r.full_name)} — ${esc(r.subject_name)}</h3><p>${esc(r.group_title_snapshot||'سجل قديم بلا مجموعة موثقة')} · ${stamp(r.submitted_at)}</p><div class="report-note">${esc(r.note||'التقرير مرفق كملف.')}</div>${button('إرسال المرفق إلى حسابي في البوت','report-send',`data-id="${r.id}"`)}<form id="grade-report" data-id="${r.id}" class="detail-section"><label>درجة التقرير من 15<input name="score" type="number" min="0" max="15" step="0.01" value="${esc(r.score??'')}" required></label><div class="form-actions"><button class="primary">حفظ التقييم</button></div></form>`);
    }else if(a==='report-send'){busy=true;await api('/reports/'+target.dataset.id+'/send',{},'POST');notify('أُدرج التقرير للإرسال إلى حسابك في البوت.');}
    else if(a==='export'){
      busy=true;const season=$('#export-season').value;const response=await fetch(`/api/admin/attendance.md?seasonId=${season}&kind=${target.dataset.kind}`,{headers:{Authorization:'Bearer '+token}});
      if(!response.ok)throw Error('تعذر تنزيل الملف. أعد فتح اللوحة إذا انتهت جلسة الدخول.');
      const url=URL.createObjectURL(await response.blob());const link=document.createElement('a');link.href=url;link.download=`attendance-${season}-${target.dataset.kind}.md`;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);notify('تم تجهيز ملف MD.');
    }else if(a==='audit'){
      view='audit';setNav('audit');$('#breadcrumb').textContent='المعهد / سجل التعديلات';const id=++sequence;const rows=await api('/audit');if(id===sequence)setContent(head('سجل التعديلات','آخر 25 عملية مسجلة')+table(['التاريخ','المسؤول','العملية','السجل'],rows.map(r=>[stamp(r.created_at),esc(r.actor_id),esc(actionLabels[r.action]||r.action),`${esc(entityLabels[r.entity_type]||r.entity_type)} #${r.entity_id}`])));
    }else if(a==='notifications'){
      view='notifications';setNav('notifications');$('#breadcrumb').textContent='المعهد / حالة الإشعارات';const id=++sequence;const rows=await api('/notifications');if(id===sequence)setContent(head('حالة الإشعارات','الإشعارات المجدولة المحفوظة؛ المحاولات المؤقتة يعاد إرسالها تلقائيًا.')+table(['الحالة','العدد'],rows.map(r=>[esc(labels[r.status]||r.status),esc(r.count)])));
    }else if(a==='teachers')await loadTeachers();
    else if(a==='schedule-matrix')await loadScheduleMatrix();
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
  if(event.target.name==='stageId'&&event.target.closest('#matrix-stage')){if(busy)return;busy=true;clearNotice();
    try{matrixStageId=event.target.value;await renderScheduleMatrix();}catch(e){notify(e.message,true);}finally{busy=false;}
  }
});
document.addEventListener('submit',async event=>{
  const form=event.target;event.preventDefault();if(busy)return;clearNotice();const body=Object.fromEntries(new FormData(form));
  busy=true;const submit=form.querySelector('button[type="submit"],button:not([data-action])');if(submit)submit.disabled=true;
  try{
    if(form.id==='search'){filters={...filters,...body};page=0;await renderStage();}
    else if(form.id==='leave-filter'){filters.leaveStatus=body.leaveStatus;page=0;await refresh();}
    else if(form.id==='report-filter'){filters.groupId=body.groupId;page=0;await renderStage();}
    else if(form.id==='edit-student'){await api('/students/'+currentStudent.id,{...body,expectedName:currentStudent.full_name},'PATCH');$('#detail').close();await refresh();notify('حُفظ اسم الطالب.');}
    else if(form.id==='move-group'){if(!confirm('حفظ المجموعة المختارة لهذه المادة؟ لن تتغير مجموعة التقارير السابقة.'))return;await api('/students/'+currentStudent.id+'/group',body,'POST');$('#detail').close();await refresh();notify('حُفظت المجموعة.');}
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
  try{const session=await api('/auth',{initData:tg.initData},'POST');token=session.token;$('#identity').textContent=session.user.name;await home();}
  catch(e){setContent(empty('تعذر فتح لوحة الإدارة',e.message));}
})();
