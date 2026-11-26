'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
const {createOutboxWorker}=require('../outbox');
let db;
test.before(async()=>{({db}=await testDatabase());});
test.after(async()=>{await db.pool.end();});

const add=(key,status,ageDays,{msg=null,deleted=false,available='now()'}={})=>db.pool.query(
  `INSERT INTO notification_outbox(dedupe_key,chat_id,payload,status,created_at,sent_at,expires_at,telegram_message_id,deleted_at,available_at)
   VALUES($1,1,'["x",{}]'::jsonb,$2,now()-$3::int*interval '1 day',now()-$3::int*interval '1 day',now()-$3::int*interval '1 day',$4,${deleted?`now()-$3::int*interval '1 day'`:'NULL'},${available})`,
  [key,status,ageDays,msg]);

test('finished notifications are pruned by kind; pending, undeleted-telegram and broadcast rows are protected',async()=>{
  await add('daily:1:2026-01-01:1','sent',10,{msg:5,deleted:true});   // قديم ومحذوف من تلغرام: يُحذف
  await add('daily:1:2026-01-01:2','sent',10,{msg:6});                 // رسالة تلغرام لم تُحذف بعد: يبقى
  await add('daily:1:2026-01-01:3','sent',1,{msg:7,deleted:true});     // حديث: يبقى
  await add('absence:student:1','sent',10);                             // أخرى: 30 يومًا، يبقى
  await add('absence:student:2','sent',40);                             // يُحذف
  await add('broadcast:1:1','sent',40);                                 // بث: يبقى 90 يومًا
  await add('broadcast:2:1','sent',100);                                // يُحذف
  await add('session:9:teacher','expired',5);                           // قصيرة: يُحذف
  await add('lesson-reminder:1:1','pending',10,{available:"now()+interval '1 day'"}); // منتظر: يبقى
  const worker=createOutboxWorker(db.pool,{sendMessage:async()=>({message_id:1})});
  await worker.tick({force:true});
  const keys=(await db.pool.query('SELECT dedupe_key FROM notification_outbox ORDER BY dedupe_key')).rows.map(r=>r.dedupe_key);
  assert.deepEqual(keys.sort(),['absence:student:1','broadcast:1:1','daily:1:2026-01-01:2','daily:1:2026-01-01:3','lesson-reminder:1:1'].sort());
});
