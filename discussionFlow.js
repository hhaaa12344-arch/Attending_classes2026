'use strict';
// Telegram can reject an old or already-edited message after the database action succeeded.
async function editDiscussionMessage(ctx,text,extra={}) {
  try{return await ctx.editMessageText(text,extra);}
  catch(e){
    const description=e.description||e.response?.description||'';
    if(/message is not modified/i.test(description))return;
    if(/message to edit not found|message can't be edited/i.test(description))return ctx.reply(text,extra);
    throw e;
  }
}
async function answerDiscussionCallback(ctx,text) {
  try{return await ctx.answerCbQuery(text);}
  catch(e){if(!/query is too old|query ID is invalid/i.test(e.description||e.response?.description||''))throw e;}
}
function endAttendanceMessage(result) {
  const until=result.closesAt?new Date(result.closesAt).toLocaleString('ar-IQ',{timeZone:'Asia/Baghdad'}):'';
  if(result.status==='opened')return `✅ أُنهيت المباحثة وفُتح حضور النهاية حتى ${until}. حُفظت إشعارات ${result.notified} طالبًا للإرسال.`;
  if(result.status==='already_open')return `✅ حضور النهاية مفتوح بالفعل حتى ${until}. يمكن للطلبة تسجيله الآن؛ لم تتغير المهلة.`;
  return result.message;
}
module.exports={editDiscussionMessage,answerDiscussionCallback,endAttendanceMessage};
