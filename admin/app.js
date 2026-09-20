'use strict';
const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=value=>value?new Date(value).toLocaleDateString('ar-IQ',{timeZone:'Asia/Baghdad'}):'—';
const stamp=value=>value?new Date(value).toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad'}):'—';
const labels={pending:'بانتظار القرار',approved:'معتمدة',rejected:'مرفوضة',ended:'منتهية',cancelled:'ملغاة',sent:'أُرسلت',sending:'قيد الإرسال',failed:'فشل الإرسال'};
const actionLabels={participation_settings:'إعدادات المباحثات والتقارير',update_student:'تعديل طالب',move_stage:'نقل مرحلة',move_group:'نقل مجموعة',set_lesson_schedule:'تحديد جدول الدروس',remove_lesson_schedule:'إزالة جدول درس',create_slot:'إضافة موعد',remove_slot:'إزالة موعد',create_stage:'إضافة مرحلة',create_subject:'إضافة مادة',create_group:'إضافة مجموعة',assign_teacher:'إسناد أستاذ',unassign_teacher:'إلغاء إسناد أستاذ',create_exam:'إنشاء امتحان',exam_question:'إضافة سؤال امتحان',exam_publish:'نشر امتحان',exam_postpone:'تأجيل امتحان',remove_question:'حذف سؤال',grade_report:'تقييم تقرير',toggle_teacher:'تفعيل/إيقاف أستاذ',regenerate_code:'توليد كود ربط',toggle_group:'تفعيل/إيقاف مجموعة'};
const entityLabels={student:'طالب',stage:'مرحلة',subject:'مادة',group:'مجموعة',leave:'إجازة',report:'تقرير',session:'مباحثة',slot:'موعد',exam:'امتحان',question:'سؤال',teacher:'أستاذ',lesson_schedule:'جدول درس'};
const DAY_NAMES=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
let token='',stages=[],teachers=[],seasons=[],currentSeasonId='',currentStage=null,currentStudent=null,currentExam=null,currentTeacher=null,matrixStageId=null,matrixDay=new Date().getDay(),matrixEligible=[];
let lessonScheduleStageId=null,lessonScheduleData=null;
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
const table=(headers,rows)=>rows.length?`<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:empty('لا توجد بيانات');
const pager=(total,size=25)=>`<div class="pagination"><span>${esc(total)} سجلًا · الصفحة ${page+1}</span><div>${page>0?button('السابق','prev'):''} ${((page+1)*size<total)?button('التالي','next'):''}</div></div>`;
function head(title,subtitle='',actions=''){return `<div class="page-head"><div><h1>${esc(title)}</h1><p class="subtle">${esc(subtitle)}</p></div><div>${actions}</div></div>`;}
function setContent(html){$('#content').innerHTML=html;$('#content').setAttribute('aria-busy','false');}
function cohortLabel(groups){const numbers=[...new Set(groups.map(g=>Number(g.group_number)).filter(Boolean))];return numbers.length===1?'المجموعة '+numbers[0]:numbers.length>1?'يحتاج أرقام متعددة': 'غير مخصص';}
function modeTag(mode){return mode==='mubahatha'?'<span class="tag info">مباحثة</span>':mode==='report'?'<span class="tag warn">تقارير</span>':'<span class="tag">بلا اختيار</span>';} 
function groupOptions(groups,selected='',all='جميع المجموعات'){return `<option value="">${all}</option>`+groups.map(g=>`<option value="${g.id}" ${String(g.id)===String(selected)?'selected':''}>${esc(g.title||g.subject_name||'مجموعة')}</option>`).join('');}
function stageHeader(){const s=currentStage;return head(s.name,`الموسم: ${s.season_name||'لا يوجد موسم نشط'}${s.is_historical?' — أرشيف':''}`,button('كل المراحل','home','','secondary'))+`<div class="tabs" role="navigation" aria-label="أقسام المرحلة">${Object.entries({students:'الطلبة',attendance:'حضور الدروس',subjects:'المواد والمجموعات',schedule:'جدول المباحثات',reports:'التقارير',exams:'الامتحانات'}).map(([tabKey,tabLabel])=>button(tabLabel,'tab',`data-tab="${tabKey}"`,tab===tabKey?'active':'' )).join('')}</div>`;}
async function home(){view='home';currentStage=null;page=0;setNav('home');const id=++sequence;stages=await api('/stages'+(currentSeasonId?'?seasonId='+currentSeasonId:''));if(id!==sequence)return;
  $('#breadcrumb').textContent='المعهد / المراحل والطلبة';
  const historical=Boolean(currentSeasonId);
  setContent((historical?`<div class="empty" style="border-color:#e2b8b8;background:var(--danger-soft);color:var(--danger);text-align:right;padding:1rem 1.3rem;margin-bottom:1.2rem"><p style="margin:0">يعرض هذا العرض موسمًا أرشيفيًا فقط.</p></div>`:'')+
    head('المراحل الدراسية','اختر المرحلة للاطلاع على طلبتها وموادها ومجموعاتها.',historical?'':button('إضافة مرحلة','new-stage','','primary'))+
    (stages.length?`<div class="cards">${stages.map(s=>`<button class="stage-card" data-action="stage" data-id="${s.id}"><div><h2>${esc(s.name)}</h2><small>${esc(s.season_name||'لا يوجد موسم نشط')}</small></div><div class="meta"><span>${s.student_count} طالب</span><span>${s.subject_count} مادة</span></div></button>`).join('')}</div>`:empty('لا توجد مراحل بعد')));
}
let attendanceStageId='',attendanceFilters={q:'',status:'all'};
async function attendanceHome(){view='lesson-attendance';setNav('lesson-attendance');const n=++sequence;const available=await api('/stages'+(currentSeasonId?'?seasonId='+currentSeasonId:''));if(n!==sequence)return;if(!available.some(s=>String(s.id)===String(attendanceStageId)))attendanceStageId='';$('#breadcrumb').textContent='المعهد / حضور الدروس';const selector=`<form id="attendance-stage" class="toolbar"><label>المرحلة الدراسية<select name="stageId"><option value="">اختر المرحلة</option>${available.map(s=>`<option value="${s.id}" ${String(s.id)===String(attendanceStageId)?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label></form>`;const body=attendanceStageId?await attendanceContent(attendanceStageId):empty('اختر مرحلة لعرض حضور الدروس','جميع طلبة المرحلة في جدول واحد، مع عدد الحضور لكل مادة.');if(n===sequence)setContent(head('حضور الدروس','إحصاء الدروس التي انتهت مهلة حضورها في الموسم المختار.')+selector+body);
}
async function attendanceContent(stageId){const data=await api('/lesson-attendance?'+new URLSearchParams({stageId,page,...attendanceFilters,...(currentSeasonId?{seasonId:currentSeasonId}:{})}));return `<p class="subtle">${esc(data.season.season_name)} · الإحصاء حتى ${stamp(data.season.as_of)}</p><div class="toolbar"><label>الاسم الرباعي<input name="q" maxlength="150" value="${esc(attendanceFilters.q)}" placeholder="بحث بالاسم"></label><label>الحالة<select name="status"><option value="all" ${attendanceFilters.status==='all'?'selected':''}>الكل</option><option value="active" ${attendanceFilters.status==='active'?'selected':''}>نشط</option><option value="archived" ${attendanceFilters.status==='archived'?'selected':''}>مؤرشف</option></select></label><button type="submit">عرض</button></div>${table(['تسلسل','الاسم الرباعي للطالب',...data.subjects.map(sub=>sub.name)],data.rows.map(st=>[esc(st.sequence),esc(st.full_name),...st.attendance.map(item=>`<span class="attendance-ratio">${Number(item.attended)}/${Number(item.total)}</span>`)]))}${pager(data.total,50)}`;}

async function renderLessonSchedule(eligible){
  const stage=eligible.find(x=>String(x.id)===String(lessonScheduleStageId));
  if(!stage){return;}
  const data=await api('/lesson-schedule?stageSeasonId='+stage.stage_season_id);
  if(!data || !Array.isArray(data.subjects) || !Array.isArray(data.dates)){
    setContent(head('جدول الدروس','ضع علامة ✓ في تاريخ نشر كل مادة. هذا الجدول التخطيطي لا يفعّل الدرس ولا يرسل الإشعار.',button('العودة','home','','secondary'))+
      `<div class="empty"><h2>لا توجد بيانات جدول دروس لهذا الموسم</h2><p>تاريخ بداية الموسم غير مضبوط أو لم يتم إنشاء الموسم بعد.</p></div>`);
    return;
  }
  lessonScheduleData=data;
  const checked=new Set((data.entries||[]).map(e=>`${e.subject_id}:${e.lesson_date}`));
  let lastMonth='';
  const rows=(data.dates||[]).map(iso=>{
    const month=iso?new Date(`${iso}T00:00:00Z`).toLocaleDateString('ar-IQ',{timeZone:'UTC',month:'long',year:'numeric'}):'';
    const monthCell=month!==lastMonth?month:'';lastMonth=month;
    const cells=(data.subjects||[]).map(sub=>{const key=`${sub.id}:${iso}`,on=checked.has(key);return `<td><button type="button" class="schedule-check ${on?'checked':''}" data-action="lesson-schedule-toggle" data-subject-id="${sub.id}" data-date="${iso}" data-checked="${on?'true':'false'}" aria-label="${esc(sub.name)} في ${esc(iso)}">${on?'✓':''}</button></td>`;});
    return `<tr><td class="month-cell">${esc(monthCell)}</td><td class="date-cell">${esc(iso?new Date(`${iso}T00:00:00Z`).toLocaleDateString('ar-IQ',{timeZone:'UTC',day:'numeric',month:'numeric',year:'numeric'}):'—')}</td>${cells.join('')}</tr>`;
  }).join('');
  setContent(head('جدول الدروس','ضع علامة ✓ في تاريخ نشر كل مادة. هذا الجدول التخطيطي لا يفعّل الدرس ولا يرسل الإشعار.',button('العودة','home','','secondary'))+
    `<div class="toolbar"><label>المرحلة الدراسية<select id="lesson-schedule-stage">${eligible.map(e=>`<option value="${e.id}" ${String(e.id)===String(lessonScheduleStageId)?'selected':''}>${esc(e.name)}</option>`).join('')}</select></label></div>`+
    `<div class="subtle">${data.start_date?`من ${esc(new Date(`${data.start_date}T00:00:00Z`).toLocaleDateString('ar-IQ',{timeZone:'UTC',day:'numeric',month:'numeric',year:'numeric'}) )} إلى ما قبل ${esc(new Date(`${data.end_date_exclusive}T00:00:00Z`).toLocaleDateString('ar-IQ',{timeZone:'UTC',day:'numeric',month:'numeric',year:'numeric'}))}`:'لا توجد أيام دراسية لأن تاريخ بداية الموسم غير مضبوط.'} · الخميس والجمعة مستبعدان تلقائيًا.</div>`+
    `<div class="summary"><div><b>${(data.dates||[]).length}</b> يومًا دراسيًا</div><div><b>${(data.subjects||[]).length}</b> مادة</div><div><b>${(data.entries||[]).length}</b> موعد نشر مخزّن</div></div>`+
    `<div class="table-wrap lesson-schedule-wrap"><table class="lesson-schedule"><thead><tr><th>الشهر الميلادي</th><th>التاريخ</th>${(data.subjects||[]).map(s=>`<th>${esc(s.name)}</th>`).join('')}</tr></thead><tbody>${rows||'<tr><td colspan="'+((data.subjects||[]).length+2)+'">لا توجد أيام دراسية في هذا النطاق.</td></tr>'}</tbody></table></div>`);
}
async function refresh(){if(view==='lesson-attendance')return attendanceHome();if(view==='stage'){currentStage=await api('/stages/'+currentStage.id+(currentSeasonId?'?seasonId='+currentSeasonId:''));await renderStage();}else if(view==='lesson-schedule'){const eligible=(stages||[]).filter(s=>s.stage_season_id);await renderLessonSchedule(eligible);}else if(view==='home'){await home();}else if(view==='teachers'){await loadTeachers();}}

document.addEventListener('click',async event=>{
  const target=event.target.closest('[data-action]');if(!target||busy)return;const a=target.dataset.action;
  if(target.closest('form')&&target.type==='submit')event.preventDefault();
  clearNotice();
  try{
    if(a==='home')await home();
    else if(a==='lesson-schedule')await loadLessonSchedule();
    else if(a==='lesson-schedule-toggle'){
      busy=true;const next=target.dataset.checked!=='true';
      try{await api('/lesson-schedule',{stageSeasonId:lessonScheduleData.stage_season_id,subjectId:Number(target.dataset.subjectId),lessonDate:target.dataset.date,checked:next},'POST');await renderLessonSchedule(stages.filter(s=>s.stage_season_id));}catch(e){notify(e.message,true);}finally{busy=false;}
    }
  }catch(e){notify(e.message,true);}finally{busy=false;}
});

document.addEventListener('change',async event=>{
  if(event.target.id==='lesson-schedule-stage'){if(busy)return;busy=true;clearNotice();
    try{lessonScheduleStageId=event.target.value;await renderLessonSchedule(stages.filter(s=>s.stage_season_id));}catch(e){notify(e.message,true);}finally{busy=false;}
  }
});

let view='home',page=0,busy=false,sequence=0,tab='students';
async function loadLessonSchedule(){view='lesson-schedule';currentStage=null;setNav('lesson-schedule');$('#breadcrumb').textContent='المعهد / جدول الدروس';const n=++sequence;
  if(!stages.length)stages=await api('/stages');if(n!==sequence)return;
  const eligible=stages.filter(s=>s.stage_season_id);
  if(!eligible.length){setContent(head('جدول الدروس','خطة نشر مكملة للهاشتاك؛ عند غياب الهاشتاك يمكن للجدول تحديد المادة تلقائيًا.',button('العودة','home','','secondary'))+empty('لا توجد مراحل بموسم نشط.','أنشئ موسمًا أو أضف مرحلة أولًا.'));return;}
  if(!lessonScheduleStageId||!eligible.some(s=>String(s.id)===String(lessonScheduleStageId)))lessonScheduleStageId=eligible[0].id;
  await renderLessonSchedule(eligible);
}
(async()=>{
  const tg=window.Telegram?.WebApp;
  tg?.ready();tg?.expand();
  if(!tg?.initData){setContent(empty('افتح اللوحة من البوت','سجّل دخولك إلى تليجرام، ثم اضغط «لوحة الإدارة» في حساب الأدمن.'));return;}
  try{
    const session=await api('/auth',{initData:tg.initData},'POST');token=session.token;$('#identity').textContent=session.user.name;
    seasons=await api('/seasons');
    if(seasons.length>1){const sel=$('#season-select');sel.hidden=false;sel.innerHTML=seasons.map(se=>`<option value="${se.is_current?'':se.id}">${esc(se.name)}${se.is_current?' — الموسم الحالي':''}</option>`).join('');}
    await home();
  }
  catch(e){setContent(empty('تعذر فتح لوحة الإدارة',e.message));}
})();
