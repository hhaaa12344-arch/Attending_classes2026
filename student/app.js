'use strict';
(async()=>{
 const tg=window.Telegram?.WebApp,panel=document.querySelector('#panel'),examId=Number(new URLSearchParams(location.search).get('exam'));
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 tg?.ready();tg?.expand();let token;
 async function api(action,body){const r=await fetch('/api/student-exam/'+action,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error||'تعذر إتمام الطلب');return v;}
 function render(data){
  if(data.done){panel.innerHTML=`<h2>✅ تم تسليم الامتحان</h2><p>${data.expired?'انتهت المهلة وسُلّمت الإجابات المحفوظة.':''}</p><p>درجتك: <strong>${esc(data.score)} من ${esc(data.maxScore)}</strong></p><p>الإجابات الصحيحة: ${esc(data.correct)} من ${esc(data.total)}</p>`;return;}
  if(!data.question){panel.innerHTML='<h2>أكملت جميع الأسئلة</h2><p>اضغط تسليم لإظهار درجتك.</p><button class="primary" id="submit">تسليم الامتحان</button>';panel.querySelector('#submit').onclick=()=>run('submit');return;}
  const q=data.question;panel.innerHTML=`<p class="subtle">${esc(data.subject)} · ${esc(data.title)}</p><h2>السؤال ${q.number} من ${q.total}</h2><p>${esc(q.prompt)}</p><div id="options"></div><p class="subtle">تُحفظ إجابتك عند اختيارها، ويمكنك متابعة الامتحان إذا انقطع الاتصال.</p>`;
  for(const answer of q.options){const b=document.createElement('button');b.textContent=answer;b.onclick=()=>run('answer',{questionId:q.id,answer});panel.querySelector('#options').append(b);}
 }
 async function run(action,extra={}){for(const b of panel.querySelectorAll('button'))b.disabled=true;try{render(await api(action,{examId,...extra}));}catch(e){const p=document.createElement('p');p.textContent=e.message;panel.append(p);for(const b of panel.querySelectorAll('button'))b.disabled=false;}}
 try{if(!Number.isSafeInteger(examId)||examId<1)throw Error('رابط الامتحان غير صالح.');const auth=await api('auth',{initData:tg?.initData||''});token=auth.token;await run('start');}catch(e){panel.textContent=e.message;}
})();
