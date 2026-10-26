'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {createHmac}=require('node:crypto');
const {validateInitData,createSessions}=require('../adminAuth');
const {createTelegramQueue}=require('../telegramQueue');
const {createUpdateGate}=require('../updateGate');
const fakeToken='123456:LOCAL_TEST_ONLY';
function signed(userId=10,now=1000){
  const p=new URLSearchParams({auth_date:String(now),query_id:'local-test',user:JSON.stringify({id:userId,first_name:'إدارة'})});
  const secret=createHmac('sha256','WebAppData').update(fakeToken).digest();
  const s=[...p].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  p.set('hash',createHmac('sha256',secret).update(s).digest('hex'));return p.toString();
}
test('Telegram initData: signature, freshness, allowlist and duplicate keys',()=>{
  assert.equal(validateInitData(signed(),fakeToken,[10],{now:1001}).id,10);
  assert.throws(()=>validateInitData(signed(11),fakeToken,[10],{now:1001}),{code:'FORBIDDEN'});
  assert.throws(()=>validateInitData(signed(),fakeToken,[10],{now:2000}),{code:'EXPIRED_AUTH'});
  assert.throws(()=>validateInitData(signed(10,5000),fakeToken,[10],{now:1001}),{code:'EXPIRED_AUTH'});
  assert.throws(()=>validateInitData(signed().replace('1000','1001'),fakeToken,[10],{now:1001}),{code:'UNAUTHORIZED'});
  assert.throws(()=>validateInitData(signed()+'&user=%7B%22id%22%3A10%7D',fakeToken,[10],{now:1001}),{code:'UNAUTHORIZED'});
  assert.throws(()=>validateInitData('user={"id":10}',fakeToken,[10],{now:1001}));
});
test('admin sessions are opaque, expiring and revocable',()=>{
  const s=createSessions();const token=s.issue({id:10});assert.equal(token.length,64);assert.equal(s.get(token).id,10);s.revoke(token);assert.equal(s.get(token),null);
  const expired=createSessions({ttlMs:-1});assert.equal(expired.get(expired.issue({id:10})),null);
});
test('Telegram queue retries transient errors, stops permanent errors and caps backlog',async()=>{
  let calls=0;const api={sendMessage:async()=>{calls++;if(calls===1)throw Object.assign(Error('temporary'),{code:'ECONNRESET'});return 'sent';},sendPhoto:async()=>{},sendVideo:async()=>{},sendDocument:async()=>{throw {response:{error_code:403}};}};
  const queue=createTelegramQueue(api,{sleep:async()=>{}});assert.equal(await queue.sendMessage(1,'x'),'sent');assert.equal(calls,2);
  await assert.rejects(()=>queue.sendDocument(1,'file'));queue.stop();await assert.rejects(()=>queue.sendMessage(1,'x'),{code:'QUEUE_STOPPED'});
  let resolve;const blocked=new Promise(r=>resolve=r);const q=createTelegramQueue({...api,sendMessage:()=>blocked},{maxPending:1,sleep:async()=>{}});
  const first=q.sendMessage(1,'first');const second=q.sendMessage(2,'second');await assert.rejects(()=>q.sendMessage(3,'third'),{code:'QUEUE_FULL'});
  resolve('ok');await Promise.all([first,second]);q.stop();
});
test('long Telegram 429 waits return to durable worker instead of hanging the queue',async()=>{
  const fail=async()=>{throw {response:{error_code:429,parameters:{retry_after:120}}};};
  const q=createTelegramQueue({sendMessage:fail,sendDocument:fail,sendPhoto:fail,sendVideo:fail},{sleep:async()=>{}});
  await assert.rejects(()=>q.sendMessage(1,'x'));q.stop();
});
test('update gate serializes one user and permits independent users, including after failure',async()=>{
  const gate=createUpdateGate();let current=0,max=0;
  await Promise.all(Array.from({length:20},()=>gate({from:{id:1}},async()=>{current++;max=Math.max(max,current);await Promise.resolve();current--;})));
  assert.equal(max,1);
  let release;const waiting=new Promise(r=>release=r);const slow=gate({from:{id:1}},()=>waiting);let other=false;
  await gate({from:{id:2}},async()=>{other=true;});assert.equal(other,true);release();await slow;
  await assert.rejects(()=>gate({from:{id:1}},async()=>{throw Error('test');}));let resumed=false;await gate({from:{id:1}},async()=>{resumed=true;});assert.ok(resumed);
});
module.exports={signed,fakeToken};
