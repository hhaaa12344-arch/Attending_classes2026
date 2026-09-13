'use strict';
const { exportArchive } = require('./backupArchive');
const BUTTON = '💾 النسخ الاحتياطية';
const LOCK = [734225, 1];
function baghdadDate(now=new Date()) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
async function initBackupSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS backup_control (
    id INTEGER PRIMARY KEY CHECK(id=1),enabled BOOLEAN NOT NULL DEFAULT false,chat_id BIGINT,
    message_id BIGINT,file_id TEXT,last_success_at TIMESTAMPTZ,last_daily_date TEXT,
    last_attempt_at TIMESTAMPTZ,retry_at TIMESTAMPTZ,failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,alert_date TEXT,filename TEXT,file_size BIGINT,checksum TEXT,row_count BIGINT,
    updated_by BIGINT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  ); INSERT INTO backup_control(id) VALUES(1) ON CONFLICT DO NOTHING;`);
}
function boundedTelegram(telegram,timeoutMs=120000){
  const original=telegram.callApi.bind(telegram),pending=new Set();
  telegram.callApi=async(method,payload,options={})=>{
    const controller=new AbortController();pending.add(controller);
    const timeout=setTimeout(()=>controller.abort(),timeoutMs);timeout.unref?.();
    try{return await original(method,payload,{...options,signal:controller.signal});}
    finally{clearTimeout(timeout);pending.delete(controller);}
  };
  telegram.abortPending=()=>{for(const c of pending)c.abort();};
  return telegram;
}
function safeError(e) {
  const code=Number(e?.response?.error_code);
  if(code===403)return 'حُظر البوت أو تعذر الوصول إلى حساب المستلم. افتح البوت مجددًا.';
  if(code===429)return 'تليجرام طلب تأجيل الرفع؛ ستتم إعادة المحاولة تلقائيًا.';
  if(/^(النسخة المضغوطة تجاوزت|حجم البيانات أكبر|صف واحد يتجاوز)/.test(e?.message||''))return e.message;
  return 'تعذر إنشاء النسخة أو تأكيد رفعها. لم يُطلب حذف النسخة السابقة، وستتم إعادة المحاولة.';
}
function createBackups({pool,telegram,adminIds,clock=()=>new Date(),exporter=exportArchive,logger=console}) {
  const admins=new Set(adminIds.map(Number));
  let active=null,stopped=false,timer=null;
  async function status(c=pool){return (await c.query('SELECT * FROM backup_control WHERE id=1')).rows[0];}
  async function withLock(fn){
    const c=await pool.connect();let locked=false;
    try {
      locked=(await c.query('SELECT pg_try_advisory_lock($1,$2) AS locked',LOCK)).rows[0].locked;
      if(!locked)return {busy:true};
      return await fn(c);
    } finally {
      if(locked)await c.query('SELECT pg_advisory_unlock($1,$2)',LOCK).catch(()=>{});
      c.release();
    }
  }
  async function configure(chatId,enabled){
    if(!admins.has(Number(chatId))||Number(chatId)<=0)throw Error('غير مصرح.');
    return withLock(async c=>{
      const old=await status(c);
      if(!enabled&&Number(old.chat_id)!==Number(chatId)&&old.chat_id)throw Error('إيقاف النسخ يتم من حساب المستلم الحالي.');
      await c.query(`UPDATE backup_control SET enabled=$1,chat_id=$2,
        message_id=CASE WHEN chat_id=$2 THEN message_id ELSE NULL END,
        file_id=CASE WHEN chat_id=$2 THEN file_id ELSE NULL END,
        last_success_at=CASE WHEN chat_id=$2 THEN last_success_at ELSE NULL END,
        last_daily_date=CASE WHEN chat_id=$2 THEN last_daily_date ELSE NULL END,
        retry_at=NULL,last_error=NULL,failures=0,updated_by=$2,updated_at=now() WHERE id=1`,[enabled,chatId]);
      return {enabled};
    });
  }
  async function execute(force){
    return withLock(async c=>{
      const state=await status(c),now=clock(),date=baghdadDate(now);
      if(!state?.enabled)return {disabled:true};
      if(!admins.has(Number(state.chat_id)))return {unauthorizedRecipient:true};
      if(!force&&state.last_daily_date===date)return {current:true};
      if(!force&&state.retry_at&&new Date(state.retry_at)>now)return {deferred:true};
      if(force&&state.last_success_at&&now-new Date(state.last_success_at)<60000)return {current:true};
      let archive;
      try {
        await c.query('UPDATE backup_control SET last_attempt_at=$1 WHERE id=1',[now]);
        archive=await exporter(c,{now});
        if(stopped)return {stopped:true};
        const total=Object.values(archive.summary.counts).reduce((a,b)=>a+b,0);
        const caption='💾 آخر نسخة احتياطية لبيانات المعهد\n'+
          'وقت النسخ: '+new Intl.DateTimeFormat('ar-IQ',{timeZone:'Asia/Baghdad',dateStyle:'medium',timeStyle:'short'}).format(now)+' — بغداد\n'+
          `الجداول: ${archive.metadata.tables.length} | السجلات: ${total}\n`+
          'تُحدَّث هذه الرسالة يوميًا الساعة 12 ليلًا. احتفظ بالملف عند الحاجة.\n'+
          `SHA-256: ${archive.summary.sha256}`;
        const doc={source:archive.file,filename:archive.filename};
        let messageId=Number(state.message_id)||null;
        async function createAnchor(){
          // Persist the message ID BEFORE attaching any database file. If a
          // network reply is lost, at worst a harmless text placeholder remains.
          const anchor=await telegram.sendMessage(Number(state.chat_id),
            '💾 مكان النسخة الاحتياطية — يجري تجهيز الملف.',{disable_notification:true});
          if(!anchor?.message_id)throw Error('Telegram did not confirm backup anchor');
          await c.query('UPDATE backup_control SET message_id=$1 WHERE id=1',[anchor.message_id]);
          messageId=anchor.message_id;
        }
        if(!messageId)await createAnchor();
        let sent;
        try {
          sent=await telegram.editMessageMedia(Number(state.chat_id),messageId,undefined,
            {type:'document',media:doc,caption});
        }catch(e){
          // Retry ambiguous network errors against the SAME persisted message.
          if(e.response?.error_code!==400||!/message to edit not found/i.test(e.response?.description||''))throw e;
          await createAnchor();
          sent=await telegram.editMessageMedia(Number(state.chat_id),messageId,undefined,
            {type:'document',media:doc,caption});
        }
        if(!sent?.message_id||!sent?.document?.file_id)throw Error('Telegram did not confirm document upload');
        // Persist Telegram identity before reporting success; it survives app restarts.
        await c.query(`UPDATE backup_control SET message_id=$1,file_id=$2,last_success_at=$3,last_daily_date=$4,
          filename=$5,file_size=$6,checksum=$7,row_count=$8,retry_at=NULL,last_error=NULL,failures=0,alert_date=NULL WHERE id=1`,
          [sent.message_id,sent.document.file_id,now,date,archive.filename,archive.size,archive.summary.sha256,total]);
        if(Number(state.message_id)!==Number(sent.message_id)){
          try{await telegram.pinChatMessage(Number(state.chat_id),sent.message_id,{disable_notification:true});}catch(_){/* Pinning is optional. */}
        }
        return {success:true,messageId:sent.message_id};
      }catch(e){
        const reason=safeError(e),failures=Number(state.failures)+1;
        const retrySeconds=Math.max(Number(e?.response?.parameters?.retry_after)||0,Math.min(3600,300*2**Math.min(failures-1,4)));
        await c.query(`UPDATE backup_control SET last_error=$1,failures=$2,retry_at=$3 WHERE id=1`,[reason,failures,new Date(now.getTime()+retrySeconds*1000)]).catch(()=>{});
        // Error logs never include DB connection strings, tokens or record values.
        logger.error('Backup failed:',reason);
        if(state.alert_date!==date){
          try{
            await telegram.sendMessage(Number(state.chat_id),'⚠️ النسخ الاحتياطي: '+reason);
            await c.query('UPDATE backup_control SET alert_date=$1 WHERE id=1',[date]);
          }catch(_){/* Failed notices do not erase the last successful backup. */}
        }
        return {failed:true,error:reason};
      }finally{if(archive)await archive.cleanup();}
    });
  }
  function run(force=false){
    if(stopped)return Promise.resolve({stopped:true});
    if(active)return Promise.resolve({busy:true});
    active=execute(force).catch(e=>{logger.error('Backup service unavailable');return {failed:true,error:'تعذر الاتصال بخدمة النسخ الاحتياطي.'};}).finally(()=>{active=null;});
    return active;
  }
  function start(){
    if(timer)return;
    stopped=false;
    // Immediate catch-up after restart; one lightweight check per minute.
    void run(); timer=setInterval(()=>void run(),60000); timer.unref?.();
  }
  async function stop(){stopped=true;telegram.abortPending?.();if(timer)clearInterval(timer);timer=null;if(active)await active;}

  function install({bot,isAdmin,isInPreview,userState}){
    const authorized=ctx=>isAdmin(ctx)&&!isInPreview(ctx)&&ctx.chat?.type==='private'&&ctx.chat.id===ctx.from.id;
    async function deny(ctx){return ctx.callbackQuery?ctx.answerCbQuery('متاح للأدمن في المحادثة الخاصة فقط.',{show_alert:true}):ctx.reply('متاح للأدمن في المحادثة الخاصة فقط.');}
    function keyboard(s){return {reply_markup:{inline_keyboard:[
      ...(s.file_id?[[{text:'📥 تحميل آخر نسخة',callback_data:'backup:download'}]]:[]),
      ...(s.enabled?[[{text:'🔄 إنشاء نسخة الآن',callback_data:'backup:now'}]]:[]),
      [{text:s.enabled?'📍 نقل النسخ إلى حسابي':'✅ تفعيل النسخ إلى حسابي',callback_data:'backup:enable'}],
      ...(s.enabled?[[{text:'⏸ إيقاف النسخ التلقائي',callback_data:'backup:pause'}]]:[]),
      [{text:'🔄 تحديث الحالة',callback_data:'backup:status'}]
    ]}};}
    async function home(ctx){
      if(!authorized(ctx))return deny(ctx);
      userState.delete(ctx.from.id);
      const s=await status();
      const stamp=s.last_success_at?new Intl.DateTimeFormat('ar-IQ',{timeZone:'Asia/Baghdad',dateStyle:'medium',timeStyle:'short'}).format(new Date(s.last_success_at)):'لم تُنشأ نسخة بعد';
      const text='💾 النسخ الاحتياطية\n'+
        `الحالة: ${s.enabled?'مفعّل':'متوقف'}\nالموعد: يوميًا الساعة 12 ليلًا بتوقيت بغداد\n`+
        `حساب المستلم: ${s.chat_id||'لم يُحدد'}${s.chat_id&&!admins.has(Number(s.chat_id))?' — لم يعد أدمنًا؛ انقل النسخ إلى حساب أدمن حالي.':''}\n`+
        `آخر نسخة ناجحة: ${stamp}\n`+
        (s.last_error?'⚠️ '+s.last_error+'\n':'')+
        '\nتُحفظ النسخة في رسالة واحدة مثبتة داخل محادثة المستلم مع البوت. زر التحميل يرسل نسخة إضافية عند الطلب فقط.';
      if(ctx.callbackQuery){await ctx.answerCbQuery();try{return await ctx.editMessageText(text,keyboard(s));}catch(e){if(/message is not modified/i.test(e.description||e.message))return;}}
      return ctx.reply(text,keyboard(s));
    }
    bot.hears(BUTTON,home);bot.command('backup',home);
    bot.action(/^backup:(status|download|enable|enable_confirm|pause|pause_confirm|now)$/,async ctx=>{
      if(!authorized(ctx))return deny(ctx);
      const action=ctx.match[1];
      if(action==='status')return home(ctx);
      userState.delete(ctx.from.id);
      await ctx.answerCbQuery();
      if(action==='enable'||action==='pause')return ctx.reply(action==='enable'?
        'سيُحفظ ملف كامل لبيانات المعهد في محادثتك الخاصة، وتُنشأ نسخة أولى الآن ثم يُحدّث يوميًا. إذا كان المستلم أدمنًا آخر فسيتوقف تحديث رسالته القديمة.':
        'سيُوقف النسخ التلقائي، وتبقى آخر نسخة محفوظة.',{reply_markup:{inline_keyboard:[
          [{text:action==='enable'?'✅ تفعيل إلى حسابي':'⏸ تأكيد الإيقاف',callback_data:'backup:'+action+'_confirm'}],
          [{text:'↩️ رجوع',callback_data:'backup:status'}]
        ]}});
      if(action==='enable_confirm'||action==='pause_confirm'){
        let result;
        try{result=await configure(ctx.from.id,action==='enable_confirm');}catch(e){return ctx.reply('تعذر تغيير الإعداد: '+e.message);}
        if(result.busy)return ctx.reply('تُنشأ نسخة الآن. حاول بعد اكتمالها.');
        await ctx.reply(action==='enable_confirm'?'✅ تم التفعيل. يجري تجهيز النسخة؛ ستظهر هنا بعد اكتمالها.':'تم إيقاف النسخ التلقائي.');
        if(action==='enable_confirm')void run(true);
        return;
      }
      if(action==='now'){
        const s=await status();
        if(!s.enabled)return ctx.reply('فعّل النسخ أولًا.');
        if(!admins.has(Number(s.chat_id)))return ctx.reply('المستلم لم يعد أدمنًا. اختر نقل النسخ إلى حسابك.');
        await ctx.reply('يجري طلب نسخة جديدة إلى حساب المستلم. إذا أُنشئت نسخة خلال الدقيقة الأخيرة فستُستخدم نفسها.');
        void run(true); return;
      }
      const s=await status();
      if(!s.file_id)return ctx.reply('لا توجد نسخة ناجحة بعد.');
      // Download requests are explicit; the permanent automatic message is sent
      // through telegram directly and is never added to UI message cleanup.
      return ctx.replyWithDocument(s.file_id,{caption:'💾 نسخة عند الطلب — '+(s.filename||'آخر نسخة')});
    });
  }
  return {status,configure,run,start,stop,install,isRunning:()=>Boolean(active)};
}
module.exports={BUTTON,baghdadDate,initBackupSchema,createBackups,boundedTelegram};
