'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db;
test.before(async()=>{({db}=await testDatabase());});
test.after(async()=>{await db.pool.end();});

async function seed(key,method,payload,chats){
  const b=(await db.pool.query(`INSERT INTO message_broadcasts(request_key,actor_id,actor_role,scope_kind,message_text,recipient_count)
    VALUES($1,777,'admin','all','x',$2) RETURNING id`,[key,chats.length])).rows[0];
  for(const [i,chat] of chats.entries())
    await db.pool.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,method,payload,priority,expires_at,status,sent_at,telegram_message_id)
      VALUES($1,$2,$3,$4::jsonb,9,now()+interval '7 days','sent',now(),$5)`,[`broadcast:${b.id}:${i}`,chat,method,JSON.stringify(payload),1000+i]);
  return b.id;
}
const fake=()=>{const calls=[];const rec=(n)=>async(...a)=>{calls.push([n,...a]);if(a[0]===2)throw Object.assign(new Error('blocked'),{description:'Forbidden: bot was blocked'});return {};};
  return {calls,editMessageMedia:rec('media'),editMessageCaption:rec('caption'),editMessageText:rec('text')};};
const HEADER='📣 رسالة من إدارة المعهد\nإلى: جميع الطلبة';

test('replacing a photo edits every recipient message and keeps the header',async()=>{
  const id=await seed('t-photo-1','sendPhoto',['OLDFILEID',{caption:`${HEADER}\n\nالتعليق القديم`}],[1,2,3]);
  const tg=fake();const svc=require('../broadcastEdit').createBroadcastEdit(db.pool,tg,{delayMs:0});
  const actor={id:777,role:'admin'};
  const info=await svc.load(actor,id);assert.equal(info.kind,'photo');assert.equal(info.count,3);assert.equal(info.body,'التعليق القديم');
  const r=await svc.apply(actor,id,{media:{kind:'photo',fileId:'NEWFILEID'}});
  assert.deepEqual([r.edited,r.failed],[2,1],'chat 2 فشل (حظر البوت)');
  const m=tg.calls.find(c=>c[0]==='media'&&c[1]===1);
  assert.equal(m[2],1000);assert.equal(m[4].media,'NEWFILEID');assert.equal(m[4].caption,`${HEADER}\n\nالتعليق القديم`,'يبقى التعليق عند عدم تغييره');
  const p=(await db.pool.query("SELECT payload FROM notification_outbox WHERE dedupe_key=$1",[`broadcast:${id}:0`])).rows[0].payload;
  assert.equal(p[0],'NEWFILEID');
});

test('caption-only edit, text edit, and invalid cases',async()=>{
  const id=await seed('t-photo-2','sendPhoto',['F',{caption:`${HEADER}\n\nقديم`}],[11]);
  const tg=fake();const svc=require('../broadcastEdit').createBroadcastEdit(db.pool,tg,{delayMs:0});
  const actor={id:777,role:'admin'};
  await svc.apply(actor,id,{text:'جديد'});
  assert.equal(tg.calls[0][0],'caption');assert.equal(tg.calls[0][4],`${HEADER}\n\nجديد`);
  const tid=await seed('t-text-1','sendMessage',[`${HEADER}\n\nنص قديم`,{}],[21]);
  await svc.apply(actor,tid,{text:'نص جديد'});
  assert.equal(tg.calls.at(-1)[0],'text');assert.equal(tg.calls.at(-1)[4],`${HEADER}\n\nنص جديد`);
  await assert.rejects(()=>svc.apply(actor,tid,{media:{kind:'photo',fileId:'X'}}),/نصي/);
  await assert.rejects(()=>svc.apply({id:999,role:'teacher'},id,{text:'x'}),/غير موجود|ليس لك/);
  await assert.rejects(()=>svc.apply(actor,id,{text:'ن'.repeat(1100)}),/طويل/);
  assert.ok((await svc.listRecent(actor)).some(b=>b.id===id));
});
