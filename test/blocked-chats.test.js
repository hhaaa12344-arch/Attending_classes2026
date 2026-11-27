'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
const {createOutboxWorker,enqueueNotification}=require('../outbox');
let db;
test.before(async()=>{({db}=await testDatabase());});
test.after(async()=>{await db.pool.end();});
const status=async key=>(await db.pool.query('SELECT status,last_error FROM notification_outbox WHERE dedupe_key=$1',[key])).rows[0];
const isBlocked=async id=>(await db.pool.query('SELECT 1 FROM blocked_chats WHERE chat_id=$1',[id])).rowCount===1;

test('a 403 blocks the chat; later notices skip Telegram; interaction or a successful probe lifts the block',async()=>{
  let calls=0,mode='block';
  const queue={sendMessage:async()=>{calls++;if(mode==='block'){const e=new Error('Forbidden');e.response={error_code:403};throw e;}return {message_id:9};}};
  const worker=createOutboxWorker(db.pool,queue);
  const chat=880001;

  await enqueueNotification(db.pool,{key:'t:1',chatId:chat,text:'a'});
  await worker.tick({force:true});
  assert.equal((await status('t:1')).status,'failed');
  assert.equal(calls,1);assert.equal(await isBlocked(chat),true);

  await enqueueNotification(db.pool,{key:'t:2',chatId:chat,text:'b'});
  await worker.tick({force:true});
  assert.equal(calls,1,'لم يُستهلك طلب تلغرام');
  const s2=await status('t:2');assert.equal(s2.status,'failed');assert.equal(s2.last_error,'403');

  mode='ok';
  await worker.unblock(chat);
  assert.equal(await isBlocked(chat),false);
  await enqueueNotification(db.pool,{key:'t:3',chatId:chat,text:'c'});
  await worker.tick({force:true});
  assert.equal((await status('t:3')).status,'sent');assert.equal(calls,2);

  // تجربة دورية: محظورة منذ 20 يومًا تُجرَّب مرة، فإن نجحت رُفع الحظر
  const chat2=880002;
  await db.pool.query("INSERT INTO blocked_chats(chat_id,reason,blocked_at) VALUES($1,'403',now()-interval '20 days')",[chat2]);
  const worker2=createOutboxWorker(db.pool,queue);
  await enqueueNotification(db.pool,{key:'t:4',chatId:chat2,text:'d'});
  await worker2.tick({force:true});
  assert.equal((await status('t:4')).status,'sent');assert.equal(await isBlocked(chat2),false);

  // محظورة حديثًا: لا تجربة
  const chat3=880003;
  await db.pool.query("INSERT INTO blocked_chats(chat_id,reason) VALUES($1,'my_chat_member')",[chat3]);
  const worker3=createOutboxWorker(db.pool,queue);
  const before=calls;
  await enqueueNotification(db.pool,{key:'t:5',chatId:chat3,text:'e'});
  await worker3.tick({force:true});
  assert.equal(calls,before);assert.equal((await status('t:5')).status,'failed');
});
