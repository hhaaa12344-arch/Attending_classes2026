'use strict';
const {appError,positiveInt}=require('./integrity');
const {enqueueNotification}=require('./outbox');

function createStageCorrections(db){
  const pool=db.pool;
  async function initSchema(){
    await pool.query(`CREATE TABLE IF NOT EXISTS student_stage_correction_requests (
      id BIGSERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      from_stage_id INTEGER REFERENCES stages(id) ON DELETE SET NULL,
      target_stage_id INTEGER REFERENCES stages(id) ON DELETE SET NULL,
      from_season_id INTEGER REFERENCES stage_seasons(id) ON DELETE SET NULL,
      target_season_id INTEGER REFERENCES stage_seasons(id) ON DELETE SET NULL,
      from_stage_name TEXT NOT NULL,target_stage_name TEXT NOT NULL,reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','stale')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),decided_at TIMESTAMPTZ,decided_by BIGINT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_student_stage_correction_pending
      ON student_stage_correction_requests(student_id) WHERE status='pending';`);
  }
  const pending=async studentId=>(await pool.query("SELECT * FROM student_stage_correction_requests WHERE student_id=$1 AND status='pending'",[studentId])).rows[0];
  const choices=async studentId=>(await pool.query(`SELECT st.id,st.name FROM stages st
    WHERE st.is_active=true AND st.id<>(SELECT stage_id FROM students WHERE id=$1)
      AND EXISTS(SELECT 1 FROM stage_seasons ss WHERE ss.stage_id=st.id AND ss.is_active=true)
    ORDER BY st.sort_order,st.id`,[studentId])).rows;
  async function submit(studentId,targetStageId,fromStageId,reason,adminIds){
    studentId=positiveInt(studentId);targetStageId=positiveInt(targetStageId);fromStageId=positiveInt(fromStageId);
    reason=String(reason||'').trim();
    if(!reason||reason.length>1000)throw appError('اكتب سبب التصحيح في رسالة من 1 إلى 1000 حرف.');
    const admins=[...new Set(adminIds)].filter(x=>Number.isSafeInteger(x)&&x>0);
    if(!admins.length)throw appError('لا يوجد أدمن مهيأ لاستلام الطلب. راجع إدارة المعهد.');
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      const st=(await c.query(`SELECT s.*,sg.name AS stage_name FROM students s JOIN stages sg ON sg.id=s.stage_id
        WHERE s.id=$1 AND s.is_active=true FOR UPDATE OF s`,[studentId])).rows[0];
      if(!st)throw appError('حساب الطالب غير نشط.');
      const existing=(await c.query("SELECT * FROM student_stage_correction_requests WHERE student_id=$1 AND status='pending'",[studentId])).rows[0];
      if(existing){await c.query('COMMIT');return {...existing,alreadyPending:true};}
      if(st.stage_id!==fromStageId)throw appError('تغيّرت مرحلتك؛ افتح تصحيح المرحلة من جديد.','STALE',409);
      if(targetStageId===st.stage_id)throw appError('هذه مرحلتك الحالية بالفعل.');
      const from=(await c.query(`SELECT ss.id FROM enrollments e JOIN stage_seasons ss ON ss.id=e.stage_season_id
        WHERE e.student_id=$1 AND e.status='active' AND ss.stage_id=$2 AND ss.is_active=true`,[studentId,st.stage_id])).rows[0];
      const target=(await c.query(`SELECT ss.id,sg.name FROM stage_seasons ss JOIN stages sg ON sg.id=ss.stage_id
        WHERE sg.id=$1 AND sg.is_active=true AND ss.is_active=true FOR SHARE OF ss,sg`,[targetStageId])).rows[0];
      if(!from||!target)throw appError('المرحلة أو موسمها غير متاح الآن. أعد فتح الطلب.');
      const r=(await c.query(`INSERT INTO student_stage_correction_requests
        (student_id,from_stage_id,target_stage_id,from_season_id,target_season_id,from_stage_name,target_stage_name,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[studentId,st.stage_id,targetStageId,from.id,target.id,st.stage_name,target.name,reason])).rows[0];
      for(const admin of admins)await enqueueNotification(c,{key:`stage-correction:${r.id}:admin:${admin}`,chatId:admin,priority:2,
        text:`طلب تصحيح المرحلة الدراسية #${r.id}\nالطالب: ${st.full_name}\nمعرف الطالب: ${st.id}\nالمرحلة الحالية: ${r.from_stage_name}\nالمرحلة المطلوبة: ${r.target_stage_name}\nالسبب: ${r.reason}\n\nلن تتغيّر المرحلة إلا بعد الموافقة. تبقى السجلات السابقة محفوظة.`,
        extra:{reply_markup:{inline_keyboard:[[{text:'✅ الموافقة على التصحيح',callback_data:`stage_fix_approve:${r.id}`},{text:'❌ رفض الطلب',callback_data:`stage_fix_reject:${r.id}`}]]}}});
      await c.query('COMMIT');return r;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async function decide(id,approve,actorId){
    id=positiveInt(id);const c=await pool.connect();
    try{
      await c.query('BEGIN');
      const r=(await c.query('SELECT * FROM student_stage_correction_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!r)throw appError('الطلب غير موجود.','NOT_FOUND',404);
      if(r.status!=='pending'){await c.query('COMMIT');return {...r,alreadyDecided:true};}
      const st=(await c.query('SELECT * FROM students WHERE id=$1 FOR UPDATE',[r.student_id])).rows[0];
      let status=approve?'approved':'rejected';
      if(approve){
        const source=(await c.query(`SELECT 1 FROM enrollments e JOIN stage_seasons ss ON ss.id=e.stage_season_id
          WHERE e.student_id=$1 AND e.stage_season_id=$2 AND e.status='active' AND ss.is_active=true`,[r.student_id,r.from_season_id])).rows[0];
        const target=(await c.query(`SELECT ss.id FROM stage_seasons ss JOIN stages sg ON sg.id=ss.stage_id
          WHERE ss.id=$1 AND ss.stage_id=$2 AND ss.is_active=true AND sg.is_active=true FOR UPDATE OF ss FOR SHARE OF sg`,[r.target_season_id,r.target_stage_id])).rows[0];
        if(!st?.is_active||st.stage_id!==r.from_stage_id||!source||!target)status='stale';
        else await db.updateStudentStage(st.id,r.target_stage_id,c);
      }
      const after=(await c.query(`UPDATE student_stage_correction_requests SET status=$2,decided_at=now(),decided_by=$3
        WHERE id=$1 RETURNING *`,[id,status,actorId])).rows[0];
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,$2,'student',$3,$4::jsonb,$5::jsonb)`,[actorId,'stage_correction_'+status,r.student_id,JSON.stringify(r),JSON.stringify(after)]);
      await c.query("UPDATE notification_outbox SET status='expired',expires_at=now() WHERE dedupe_key LIKE $1 AND status='pending'",[`stage-correction:${id}:admin:%`]);
      if(st)await enqueueNotification(c,{key:`stage-correction:${id}:decision`,chatId:st.telegram_id,priority:2,
        text:status==='approved'?`✅ وافقت الإدارة على تصحيح مرحلتك إلى «${r.target_stage_name}». سجلاتك السابقة محفوظة. افتح «روابط المعهد ← قناتي الدراسية» لعرض القناة الصحيحة، أو أرسل /start لتحديث قائمتك.`:
          status==='rejected'?`لم توافق الإدارة على طلب تصحيح المرحلة #${id} إلى «${r.target_stage_name}». بقيت مرحلتك كما هي.`:
          `تعذّر تنفيذ طلب تصحيح المرحلة #${id} لأن بيانات المرحلة أو الموسم تغيّرت. لم ينفّذ الطلب أي نقل؛ يمكنك تقديم طلب جديد.`});
      await c.query('COMMIT');return after;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  function install(h){
    const {bot,Markup,userState}=h;
    const back=()=>Markup.inlineKeyboard([[Markup.button.callback('↩️ قناتي الدراسية','il_view:channels:0')]]);
    const wake=()=>{if(h.wakeNotifications)Promise.resolve().then(h.wakeNotifications).catch(e=>console.warn('Stage correction notification failed:',e.code||'DELIVERY_ERROR'));};
    async function student(ctx){
      if(ctx.chat?.type!=='private'||h.isInPreview(ctx)||h.isAdmin(ctx))return null;
      const st=await h.effectiveStudent(ctx);return st?.is_active?st:null;
    }
    bot.action(/^stage_fix_start$/,async ctx=>{
      const st=await student(ctx);if(!st)return ctx.answerCbQuery('هذه الخدمة للطالب المسجّل في المحادثة الخاصة.');
      userState.delete(ctx.from.id);const open=await pending(st.id);await ctx.answerCbQuery();
      if(open)return ctx.reply(`لديك طلب تصحيح إلى «${open.target_stage_name}» بانتظار موافقة الإدارة. مرحلتك الحالية لم تتغيّر.`,back());
      const stages=await choices(st.id);
      if(!stages.length)return ctx.reply('لا توجد مرحلة أخرى متاحة للتصحيح الآن.',back());
      userState.set(ctx.from.id,{action:'stage_correction_choose',studentId:st.id,fromStageId:st.stage_id});
      return ctx.reply(`مرحلتك الحالية: ${st.stage_name}\nاختر المرحلة الصحيحة. سيُطلب منك ذكر السبب ثم يُرسل الطلب إلى الإدارة للموافقة.`,
        Markup.inlineKeyboard([...stages.map(s=>[Markup.button.callback(s.name,`stage_fix_choose:${s.id}`)]),[Markup.button.callback('إلغاء','stage_fix_cancel')]]));
    });
    bot.action(/^stage_fix_choose:(\d+)$/,async ctx=>{
      const st=await student(ctx),state=userState.get(ctx.from.id);
      if(!st||state?.action!=='stage_correction_choose'||state.studentId!==st.id||state.fromStageId!==st.stage_id)return ctx.answerCbQuery('افتح تصحيح المرحلة من جديد.');
      const target=(await choices(st.id)).find(s=>s.id===Number(ctx.match[1]));
      if(!target)return ctx.answerCbQuery('المرحلة غير متاحة.');
      userState.set(ctx.from.id,{...state,action:'stage_correction_reason',targetStageId:target.id});
      await ctx.answerCbQuery();return ctx.reply(`اخترت «${target.name}». اكتب سبب تصحيح مرحلتك في رسالة نصية واحدة (حتى 1000 حرف). لا يتم النقل قبل موافقة الإدارة.`,Markup.inlineKeyboard([[Markup.button.callback('إلغاء','stage_fix_cancel')]]));
    });
    bot.action(/^stage_fix_cancel$/,async ctx=>{
      if(!await student(ctx))return ctx.answerCbQuery('غير مصرح.');
      const state=userState.get(ctx.from.id);if(state?.action?.startsWith('stage_correction_'))userState.delete(ctx.from.id);
      await ctx.answerCbQuery();return ctx.reply('أُلغي إدخال الطلب؛ لم تتغيّر مرحلتك.',back());
    });
    bot.on('text',async(ctx,next)=>{
      const state=userState.get(ctx.from.id),text=ctx.message.text.trim();
      if(state?.action!=='stage_correction_reason'||text.startsWith('/')||['↩️ رجوع','❌ إلغاء العملية'].includes(text)||h.menuButtons.some(s=>s.has(text)))return next();
      const st=await student(ctx);if(!st||st.id!==state.studentId){userState.delete(ctx.from.id);return ctx.reply('افتح الخدمة من حساب الطالب المسجّل.');}
      try{
        const r=await submit(st.id,state.targetStageId,state.fromStageId,text,h.adminIds);userState.delete(ctx.from.id);wake();
        return ctx.reply(`طلب تصحيح المرحلة #${r.id} إلى «${r.target_stage_name}» بانتظار موافقة الإدارة. مرحلتك الحالية لم تتغيّر.`,back());
      }catch(e){if(!e.status)throw e;return ctx.reply(e.message);}
    });
    bot.action(/^stage_fix_(approve|reject):(\d+)$/,async ctx=>{
      if(ctx.chat?.type!=='private'||!h.isAdmin(ctx)||h.isInPreview(ctx))return ctx.answerCbQuery('الموافقة والرفض متاحان للأدمن فقط.',{show_alert:true});
      try{
        const r=await decide(Number(ctx.match[2]),ctx.match[1]==='approve',ctx.from.id);
        if(r.alreadyDecided)return ctx.answerCbQuery('سبق اتخاذ القرار في هذا الطلب؛ لن يتكرر النقل.',{show_alert:true});
        wake();await ctx.answerCbQuery();
        const status={approved:'تمت الموافقة ونُقل الطالب مع حفظ سجلاته السابقة.',rejected:'رُفض الطلب؛ لم تتغيّر مرحلة الطالب.',stale:'تغيّرت بيانات الطالب أو المرحلة؛ أُغلق الطلب دون نقل.'}[r.status];
        return ctx.editMessageText(`طلب تصحيح المرحلة #${r.id}\n${r.from_stage_name} ← ${r.target_stage_name}\nالسبب: ${r.reason}\n${r.alreadyDecided?'سبق اتخاذ القرار: ':''}${status}`);
      }catch(e){if(!e.status)throw e;return ctx.answerCbQuery(e.message,{show_alert:true});}
    });
  }
  return {initSchema,pending,choices,submit,decide,install};
}
module.exports={createStageCorrections};
