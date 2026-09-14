'use strict';
const {PAGES,STUDENT_BUTTON,ADMIN_BUTTON,defaultText}=require('./studentGuideContent');
const byKey=new Map(PAGES.map(p=>[p.key,p]));
async function initStudentGuideSchema(pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS student_guide_pages (
    page_key TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,photo_file_id TEXT,
    updated_by BIGINT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  ); CREATE TABLE IF NOT EXISTS student_guide_views (
    telegram_id BIGINT PRIMARY KEY,chat_id BIGINT NOT NULL,message_id BIGINT NOT NULL,
    message_kind TEXT NOT NULL CHECK(message_kind IN ('photo','text')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),CHECK(chat_id=telegram_id)
  );`);
  for(const p of PAGES){
    const body=defaultText(p);
    await pool.query(`INSERT INTO student_guide_pages(page_key,title,body)
      VALUES($1,$2,$3) ON CONFLICT(page_key) DO NOTHING`,[p.key,p.title,body]);
    const oldBody=body.replaceAll('تقرير الحضور','تقريري').replaceAll('«المباحثات والتقارير»','«مشاركتي»')
      .replace('قد تكون المباحثة للمرحلة كاملة أو لمجموعتك؛ يحدد المعهد تنظيمها. حضور الدروس مستقل عن تقسيم المباحثات.','مجموعتك مستقلة عن المجموعات الأخرى، ورقمها موحّد بين مواد مرحلتك في الموسم.');
    await pool.query('UPDATE student_guide_pages SET body=$2 WHERE page_key=$1 AND body=$3',[p.key,body,oldBody]);
  }
}
function createStudentGuide({pool,telegram}){
  let deps;
  const privateChat=ctx=>ctx.chat?.type==='private'&&ctx.from?.id===ctx.chat.id;
  const admin=ctx=>privateChat(ctx)&&deps.isAdmin(ctx)&&!deps.isInPreview(ctx);
  const view=async id=>(await pool.query('SELECT * FROM student_guide_views WHERE telegram_id=$1',[id])).rows[0];
  async function page(key){
    const def=byKey.get(key);if(!def)return null;
    const saved=(await pool.query('SELECT * FROM student_guide_pages WHERE page_key=$1',[key])).rows[0];
    return {page_key:key,title:def.title,body:defaultText(def),...saved,audience:def.audience};
  }
  async function quietDelete(chatId,messageId){
    try{await telegram.deleteMessage(chatId,Number(messageId));}
    catch(_){try{await telegram.editMessageReplyMarkup(chatId,Number(messageId),undefined,{inline_keyboard:[]});}catch(_){} }
  }
  async function clear(ctx){
    if(!privateChat(ctx)||deps.isInPreview(ctx))return;
    const r=await pool.query('DELETE FROM student_guide_views WHERE telegram_id=$1 RETURNING *',[ctx.from.id]);
    for(const v of r.rows)await quietDelete(Number(v.chat_id),v.message_id);
  }
  async function open(ctx,key='registration', {navigate=false}={}){
    if(!privateChat(ctx))return;
    if(deps.isInPreview(ctx))return ctx.reply('اخرج من وضع المعاينة لفتح الدليل.');
    const student=await deps.effectiveStudent(ctx);
    const allowed=PAGES.filter(p=>!student||student.stage_type!=='lessons_only'||p.audience==='all');
    let index=allowed.findIndex(p=>p.key===key);
    if(index<0){if(ctx.callbackQuery)return ctx.answerCbQuery('هذا القسم لا ينطبق على مرحلتك.',{show_alert:true});index=0;}
    const prior=await view(ctx.from.id);
    if(navigate&&(!prior||Number(prior.message_id)!==ctx.callbackQuery?.message?.message_id)){
      return ctx.answerCbQuery('هذه نسخة قديمة من الدليل. افتحه من «دليل الاستخدام» أو /guide.',{show_alert:true});
    }
    if(ctx.callbackQuery)await ctx.answerCbQuery();
    if(!navigate){
      deps.userState.delete(ctx.from.id);
      if(!student&&!deps.isAdmin(ctx)&&!await deps.effectiveTeacher(ctx))deps.userState.set(ctx.from.id,{action:'awaiting_onboarding_ack'});
    }
    const p=await page(allowed[index].key);
    const text=`📘 دليل الطالب — ${index+1} / ${allowed.length}\n${p.title}\n\n${p.body}`;
    const nav=[];
    if(index>0)nav.push({text:'السابق',callback_data:'guide:page:'+allowed[index-1].key});
    if(index+1<allowed.length)nav.push({text:'التالي',callback_data:'guide:page:'+allowed[index+1].key});
    const existing=Boolean(student||deps.isAdmin(ctx)||await deps.effectiveTeacher(ctx));
    const rows=[...(nav.length?[nav]:[]),[{text:existing?'↩️ العودة إلى قائمتي':'✅ ابدأ التسجيل',callback_data:'guide:begin'}]];
    if(!existing)rows.push([{text:'🔑 لديّ كود تفعيل / نقل حساب',callback_data:'guide:code'}]);
    const extra={reply_markup:{inline_keyboard:rows}};
    let sent,kind=p.photo_file_id?'photo':'text';
    if(p.photo_file_id){
      try{
        sent=prior?await telegram.editMessageMedia(ctx.chat.id,Number(prior.message_id),undefined,
          {type:'photo',media:p.photo_file_id,caption:text},extra):await telegram.sendPhoto(ctx.chat.id,p.photo_file_id,{caption:text,...extra});
      }catch(e){
        if(/message is not modified/i.test(e.description||e.message))return;
        // Invalid file IDs, removed messages and unavailable media cannot block registration.
        kind='text';
      }
    }
    if(!sent){
      if(prior?.message_kind==='text'){
        try{sent=await telegram.editMessageText(ctx.chat.id,Number(prior.message_id),undefined,text,extra);}
        catch(e){if(/message is not modified/i.test(e.description||e.message))return;}
      }
      if(!sent)sent=await telegram.sendMessage(ctx.chat.id,text,extra);
      kind='text';
    }
    if(!sent?.message_id)throw Error('لم يؤكد تليجرام إرسال الدليل.');
    await pool.query(`INSERT INTO student_guide_views(telegram_id,chat_id,message_id,message_kind)
      VALUES($1,$1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET message_id=EXCLUDED.message_id,
      message_kind=EXCLUDED.message_kind,updated_at=now()`,[ctx.from.id,sent.message_id,kind]);
    if(prior&&Number(prior.message_id)!==sent.message_id)await quietDelete(ctx.chat.id,prior.message_id);
    return sent;
  }
  async function adminHome(ctx){
    if(!admin(ctx))return deny(ctx);
    deps.userState.delete(ctx.from.id);
    if(ctx.callbackQuery)await ctx.answerCbQuery();
    const saved=(await pool.query('SELECT page_key,photo_file_id FROM student_guide_pages')).rows;
    const photos=new Set(saved.filter(p=>p.photo_file_id).map(p=>p.page_key));
    return ctx.reply(`🖼️ إدارة دليل الطالب\nالصور المرفوعة: ${photos.size} من ${PAGES.length}\n\nارفع الصور هنا كصور تليجرام؛ يحفظ البوت معرّفاتها دون ملفات على الاستضافة. تبقى الصفحات نصية إلى أن ترفع صورها.`,{reply_markup:{inline_keyboard:[
      [{text:'📤 رفع الصور الست بالتتابع',callback_data:'guide:upload_all'}],
      ...PAGES.map((p,i)=>[{text:`${photos.has(p.key)?'✅':'▫️'} ${i+1}. ${p.title}`,callback_data:'guide:manage:'+p.key}]),
      [{text:'👁 عرض الدليل',callback_data:'guide:preview'}]
    ]}});
  }
  async function manage(ctx,key){
    const p=await page(key);if(!p)return;
    return ctx.reply(`الصورة ${PAGES.findIndex(p=>p.key===key)+1}: ${p.title}\nالحالة: ${p.photo_file_id?'صورة مرفوعة':'شرح نصي فقط'}\nتغيير النص أسفل الصورة لا يغيّر الكتابة المطبوعة داخلها؛ حدّث الصورة أيضًا إذا تغيّرت التعليمات.`,{reply_markup:{inline_keyboard:[
      [{text:'📤 رفع / استبدال الصورة',callback_data:'guide:upload:'+key}],
      [{text:'✏️ تعديل الشرح النصي',callback_data:'guide:text:'+key}],
      [{text:'↺ استعادة الشرح الأصلي',callback_data:'guide:reset:'+key}],
      [{text:'🗑 إزالة الصورة',callback_data:'guide:remove:'+key}],
      [{text:'↩️ قائمة الصور',callback_data:'guide:admin'}]
    ]}});
  }
  async function promptUpload(ctx,key,batch=false){
    deps.userState.set(ctx.from.id,{action:'admin_guide_upload',key,batch});
    return ctx.reply(`أرسل الصورة ${PAGES.findIndex(p=>p.key===key)+1} الآن كصورة مستقلة:\n«${byKey.get(key).title}»\nلا ترسلها كمستند أو ضمن ألبوم.`,{reply_markup:{inline_keyboard:[[{text:'إلغاء الرفع',callback_data:'guide:admin'}]]}});
  }
  async function deny(ctx){return ctx.callbackQuery?ctx.answerCbQuery('متاح للأدمن في المحادثة الخاصة فقط.',{show_alert:true}):ctx.reply('متاح للأدمن في المحادثة الخاصة فقط.');}
  function install(options){
    deps=options;const {bot,userState}=deps;
    bot.hears(STUDENT_BUTTON,ctx=>open(ctx));bot.command('guide',ctx=>open(ctx));
    bot.hears(ADMIN_BUTTON,adminHome);bot.command('guideadmin',adminHome);
    bot.action(/^guide:page:([a-z]+)$/,ctx=>open(ctx,ctx.match[1],{navigate:true}));
    bot.action(/^guide:(begin|code)$/,async ctx=>{
      if(!privateChat(ctx)||deps.isInPreview(ctx))return deny(ctx);
      await ctx.answerCbQuery();await clear(ctx);return deps.onContinue(ctx,ctx.match[1]==='code');
    });
    bot.action(/^guide:(admin|preview|upload_all|manage|upload|text|reset|remove)(?::([a-z]+))?$/,async ctx=>{
      if(!admin(ctx))return deny(ctx);
      const [,action,key]=ctx.match;
      if(action==='admin')return adminHome(ctx);
      if(action==='preview')return open(ctx);
      await ctx.answerCbQuery();
      if(action==='upload_all')return promptUpload(ctx,PAGES[0].key,true);
      if(!byKey.has(key))return ctx.reply('الصفحة غير موجودة.');
      userState.delete(ctx.from.id);
      if(action==='manage')return manage(ctx,key);
      if(action==='upload')return promptUpload(ctx,key);
      if(action==='text'){
        userState.set(ctx.from.id,{action:'admin_guide_text',key});
        return ctx.reply('أرسل الشرح الجديد أسفل الصورة، بحد أقصى 850 حرفًا. أرسل «❌ إلغاء العملية» للإلغاء.');
      }
      if(action==='reset')await pool.query('UPDATE student_guide_pages SET body=$1,updated_by=$2,updated_at=now() WHERE page_key=$3',[defaultText(byKey.get(key)),ctx.from.id,key]);
      if(action==='remove')await pool.query('UPDATE student_guide_pages SET photo_file_id=NULL,updated_by=$1,updated_at=now() WHERE page_key=$2',[ctx.from.id,key]);
      return manage(ctx,key);
    });
    // Installed before channel-forward and report upload handlers to prevent cross-flow interpretation.
    bot.on('message',async(ctx,next)=>{
      const state=ctx.from&&userState.get(ctx.from.id);
      if(!state?.action?.startsWith('admin_guide_'))return next();
      if(!admin(ctx)){userState.delete(ctx.from.id);return deny(ctx);}
      const text=ctx.message?.text?.trim();
      if(text&&(text.startsWith('/')||['↩️ رجوع','❌ إلغاء العملية'].includes(text)||deps.menus.some(s=>s.has(text)))){
        userState.delete(ctx.from.id);return next();
      }
      if(state.action==='admin_guide_text'){
        if(!text||text.length>850)return ctx.reply('أرسل نصًا من 1 إلى 850 حرفًا.');
        await pool.query('UPDATE student_guide_pages SET body=$1,updated_by=$2,updated_at=now() WHERE page_key=$3',[text,ctx.from.id,state.key]);
        userState.delete(ctx.from.id);return manage(ctx,state.key);
      }
      if(ctx.message.media_group_id){
        if(state.rejectedAlbum!==ctx.message.media_group_id){
          userState.set(ctx.from.id,{...state,rejectedAlbum:ctx.message.media_group_id});
          return ctx.reply('أرسل كل صورة وحدها كي لا تختلط صفحات الدليل. ننتظر الصورة '+(PAGES.findIndex(p=>p.key===state.key)+1)+'.');
        }
        return;
      }
      const photo=ctx.message.photo?.at(-1);
      if(!photo?.file_id)return ctx.reply('أرسلها كصورة تليجرام، وليس كملف؛ أو اضغط إلغاء.');
      await pool.query('UPDATE student_guide_pages SET photo_file_id=$1,updated_by=$2,updated_at=now() WHERE page_key=$3',[photo.file_id,ctx.from.id,state.key]);
      const i=PAGES.findIndex(p=>p.key===state.key);
      await ctx.reply(`✅ حُفظت الصورة ${i+1}: ${byKey.get(state.key).title}`);
      if(state.batch&&i+1<PAGES.length)return promptUpload(ctx,PAGES[i+1].key,true);
      userState.delete(ctx.from.id);return adminHome(ctx);
    });
  }
  return {open,clear,install,page};
}
module.exports={initStudentGuideSchema,createStudentGuide};
