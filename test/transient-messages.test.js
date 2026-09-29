'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
process.env.BOT_TOKEN='12345:OFFLINE_TEST_ONLY';process.env.DATABASE_URL='postgresql://localhost/attendance_test_unused';process.env.ADMIN_IDS='42';
const {createTransientCleaner}=require('../transientMessages');
const {testDatabase}=require('./helpers.cjs');
let db;
test.before(async()=>{({db}=await testDatabase());});
test.after(async()=>{if(db)await db.pool.end();});
function harness(overrides={}){
  const deleted=[];let next=1000;
  const clean=createTransientCleaner({db,isAdmin:c=>c.from.id===42,isInPreview:()=>false,deleteMessage:async(chat,id)=>{deleted.push(id);},...overrides});
  async function update(ctx,handler){
    const c={chat:{id:ctx.from.id,type:'private'},...ctx};
    c.reply=async()=>({message_id:++next});
    await clean(c,async()=>{await handler?.(c);});return c;
  }
  return {deleted,update};
}
test('earlier button results are removed on the next interaction; menu replies stay',async()=>{
  const h=harness();const user={id:7001};
  await h.update({from:user},async c=>{await c.reply('نتيجة أولى');await c.reply('قائمة',{reply_markup:{keyboard:[[{text:'x'}]]}});});
  assert.deepEqual(h.deleted,[]);
  await h.update({from:user},async c=>{await c.reply('نتيجة ثانية');});
  assert.deepEqual(h.deleted,[1001],'only the ordinary reply is deleted, never the keyboard menu');
  await h.update({from:user});
  assert.deepEqual(h.deleted,[1001,1003]);
});
test('the message that was pressed is kept and other chats are untouched',async()=>{
  const h=harness();
  await h.update({from:{id:7002}},async c=>{await c.reply('a');await c.reply('b');});   // 1001,1002
  await h.update({from:{id:7003}},async c=>{await c.reply('other');});                  // 1003
  await h.update({from:{id:7002},callbackQuery:{message:{message_id:1002}}});
  assert.deepEqual(h.deleted,[1001]);
  await h.update({from:{id:7002}});
  assert.deepEqual(h.deleted,[1001,1002]);
});
test('administrators, previews and non-private chats are never cleaned or tracked',async()=>{
  const h=harness({isInPreview:c=>c.from.id===43});
  await h.update({from:{id:42}},async c=>{await c.reply('admin');});
  await h.update({from:{id:42}});
  await h.update({from:{id:43}},async c=>{await c.reply('preview');});
  await h.update({from:{id:43}});
  await h.update({from:{id:7004},chat:{id:-100,type:'supergroup'}},async c=>{await c.reply('group');});
  await h.update({from:{id:7004},chat:{id:-100,type:'supergroup'}});
  assert.deepEqual(h.deleted,[]);
  assert.equal(Number((await db.pool.query('SELECT COUNT(*) AS n FROM transient_ui_messages WHERE chat_id IN (42,43,-100)')).rows[0].n),0);
});
test('a failing delete or database error never blocks the user action',async()=>{
  const errors=[];const h=harness({deleteMessage:async()=>{throw Error('gone');},onError:e=>errors.push(e.message)});
  await h.update({from:{id:7005}},async c=>{await c.reply('a');});
  let ran=false;await h.update({from:{id:7005}},async()=>{ran=true;});
  assert.equal(ran,true);assert.deepEqual(errors,['gone']);
});
