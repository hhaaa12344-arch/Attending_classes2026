'use strict';
// تعديل رسالة جماعية أُرسلت سابقًا (نص أو صورة أو فيديو) عند جميع مستلميها.
// يعتمد على telegram_message_id المحفوظ لكل مستلم في notification_outbox، فيعدّل الرسالة نفسها في محادثة كل طالب.
// ملاحظة تليجرام: تظهر علامة «معدّلة» على الرسالة، ولا يصل الطالب إشعار جديد.
const {appError,positiveInt}=require('./integrity');
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
const running=new Set();

function splitHeader(full) {
  const text=String(full||'');const i=text.indexOf('\n\n');
  return i===-1?{header:text,body:''}:{header:text.slice(0,i),body:text.slice(i+2)};
}

function createBroadcastEdit(pool,telegram,{delayMs=60}={}) {
  async function listRecent(actor) {
    const own=actor.role!=='admin';
    return (await pool.query(`SELECT b.id,b.message_text,b.recipient_count,b.created_at,
        (SELECT n.method FROM notification_outbox n WHERE n.dedupe_key LIKE 'broadcast:'||b.id||':%' LIMIT 1) AS method,
        (SELECT COUNT(*)::int FROM notification_outbox n WHERE n.dedupe_key LIKE 'broadcast:'||b.id||':%'
           AND n.status='sent' AND n.telegram_message_id IS NOT NULL AND n.deleted_at IS NULL) AS editable
      FROM message_broadcasts b WHERE b.created_at>now()-interval '30 days' AND ($1::boolean=false OR b.actor_id=$2)
      ORDER BY b.created_at DESC,b.id DESC LIMIT 8`,[own,actor.id])).rows;
  }

  async function rowsOf(id) {
    return (await pool.query(`SELECT id,chat_id,method,payload,telegram_message_id FROM notification_outbox
      WHERE dedupe_key LIKE 'broadcast:'||$1::text||':%' AND status='sent' AND telegram_message_id IS NOT NULL AND deleted_at IS NULL
      ORDER BY id`,[id])).rows;
  }

  async function load(actor,id) {
    id=positiveInt(id);
    const b=(await pool.query(`SELECT b.id,b.actor_id,b.created_at FROM message_broadcasts b WHERE b.id=$1 ${actor.role==='admin'?'':'AND b.actor_id=$2'}`,
      actor.role==='admin'?[id]:[id,actor.id])).rows[0];
    if(!b)throw appError('الإرسال غير موجود أو ليس لك.','NOT_FOUND',404);
    const rows=await rowsOf(id);
    if(!rows.length)throw appError('لا توجد رسائل مرسلة قابلة للتعديل لهذا الإرسال (لم تُسلَّم بعد أو حُذفت).','CONFLICT',409);
    const first=rows[0];
    const kind=first.method==='sendPhoto'?'photo':first.method==='sendVideo'?'video':'text';
    const full=kind==='text'?first.payload[0]:first.payload[1]?.caption||'';
    return {id,kind,count:rows.length,...splitHeader(full)};
  }

  async function apply(actor,id,{media=null,text=undefined}) {
    const info=await load(actor,id);
    if(running.has(info.id))throw appError('هذا الإرسال قيد التعديل الآن. انتظر انتهاءه.','CONFLICT',409);
    if(info.kind==='text'&&media)throw appError('هذا الإرسال نصي؛ لا يمكن تحويله إلى صورة. أرسل نصًا جديدًا.');
    if(media&&!['photo','video'].includes(media.kind))throw appError('نوع المرفق غير مدعوم.');
    const body=text===undefined?info.body:String(text).trim();
    if(info.kind==='text'&&!body)throw appError('اكتب نصًا جديدًا.');
    const full=info.header+(body?`\n\n${body}`:'');
    if(info.kind==='text'?full.length>4096:full.length>1024)throw appError('النص طويل؛ اختصره ثم أعد المحاولة.');
    running.add(info.id);
    let edited=0,failed=0;
    try{
      for(const row of await rowsOf(info.id)){
        const chat=Number(row.chat_id),mid=Number(row.telegram_message_id);
        try{
          if(info.kind==='text')await telegram.editMessageText(chat,mid,undefined,full);
          else if(media)await telegram.editMessageMedia(chat,mid,undefined,{type:media.kind,media:media.fileId,caption:full});
          else await telegram.editMessageCaption(chat,mid,undefined,full);
        }catch(err){
          if(!/message is not modified/i.test(err.description||err.message||'')){failed++;await sleep(delayMs);continue;}
        }
        const newKind=media?media.kind:info.kind;
        const payload=info.kind==='text'?[full,{}]:[media?media.fileId:row.payload[0],{caption:full}];
        await pool.query('UPDATE notification_outbox SET payload=$2::jsonb,method=$3 WHERE id=$1',
          [row.id,JSON.stringify(payload),newKind==='photo'?'sendPhoto':newKind==='video'?'sendVideo':'sendMessage']);
        edited++;await sleep(delayMs);
      }
      await pool.query('UPDATE message_broadcasts SET message_text=$2 WHERE id=$1',[info.id,body||`مرفق ${(media?media.kind:info.kind)==='photo'?'صورة':'فيديو'}`]);
      await pool.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,'edit_broadcast','broadcast',$2,$3::jsonb,$4::jsonb)`,
        [actor.id,info.id,JSON.stringify({text:info.body}),JSON.stringify({text:body,replaced_media:Boolean(media),edited,failed})]);
    }finally{running.delete(info.id);}
    return {id:info.id,edited,failed,total:edited+failed};
  }

  return {listRecent,load,apply};
}
module.exports={createBroadcastEdit,splitHeader};
