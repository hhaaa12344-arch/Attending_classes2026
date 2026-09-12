'use strict';
const {createHmac,timingSafeEqual,randomBytes}=require('node:crypto');
const {appError}=require('./integrity');

function validateInitData(raw,botToken,adminIds,{now=Math.floor(Date.now()/1000),maxAge=600}={}) {
  if(typeof raw!=='string'||raw.length>16384||!raw)throw appError('افتح لوحة الإدارة من داخل البوت.','UNAUTHORIZED',401);
  const params=new URLSearchParams(raw);
  const keys=[...params.keys()];
  if(new Set(keys).size!==keys.length)throw appError('بيانات دخول غير صالحة.','UNAUTHORIZED',401);
  const hash=params.get('hash');params.delete('hash');
  if(!/^[a-f0-9]{64}$/i.test(hash||''))throw appError('بيانات دخول غير صالحة.','UNAUTHORIZED',401);
  const secret=createHmac('sha256','WebAppData').update(botToken).digest();
  const check=[...params.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  const expected=createHmac('sha256',secret).update(check).digest();
  if(!timingSafeEqual(expected,Buffer.from(hash,'hex')))throw appError('تعذر التحقق من حساب تليجرام.','UNAUTHORIZED',401);
  const date=Number(params.get('auth_date'));
  if(!Number.isSafeInteger(date)||date>now+30||now-date>maxAge)throw appError('انتهت صلاحية الدخول. أغلق اللوحة وافتحها مجددًا من البوت.','EXPIRED_AUTH',401);
  let user;try{user=JSON.parse(params.get('user'));}catch{throw appError('حساب غير صالح.','UNAUTHORIZED',401);}
  if(!user||!Number.isSafeInteger(user.id)||!adminIds.includes(user.id))throw appError('هذه اللوحة متاحة للإدارة فقط.','FORBIDDEN',403);
  return {id:user.id,name:user.first_name||'الإدارة'};
}
function createSessions({ttlMs=30*60000,max=1000}={}) {
  const sessions=new Map();
  const clean=()=>{const now=Date.now();for(const [key,value]of sessions)if(value.expires<=now)sessions.delete(key);};
  return {
    issue(user){clean();if(sessions.size>=max)throw appError('حاول الدخول لاحقًا.','BUSY',503);const token=randomBytes(32).toString('hex');sessions.set(token,{user,expires:Date.now()+ttlMs});return token;},
    get(token){clean();return sessions.get(token)?.user||null;},
    revoke(token){sessions.delete(token);}
  };
}
module.exports={validateInitData,createSessions};
