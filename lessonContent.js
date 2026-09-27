'use strict';
const {extractFirstUrl}=require('./utils');
const normalize=value=>String(value||'').normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g,'').replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').toLowerCase();
const compact=value=>normalize(value).replace(/[^\p{L}\p{N}]/gu,'');
function namedSubjects(subjects,text){
  const content=compact(text);
  return subjects.filter(s=>{
    const curriculum=['مسائل','منطق','عقائد','تفسير','اخلاق','نحو','قطر','بلاغة','اصول'];
    const aliases=curriculum.filter(word=>compact(s.name).includes(word));
    return [s.name,s.hashtag,normalize(s.hashtag).replace(/^ال/,''),...aliases].some(label=>compact(label).length>=3&&content.includes(compact(label)));
  });
}
function classify(message,subjects=[]){
  const text=message.caption||message.text||'',plain=normalize(text),url=extractFirstUrl(message);
  if(message.sticker)return {kind:'ignore',reason:'ملصق'};
  if(/رابط البوت|الدليل الارشادي|فيديو توضيحي.*(?:تسجيل الحضور|نظام تسجيل|البوت)|المناهج الدراسيه غير متوفره|المناهج الدراسية غير متوفرة/s.test(plain)
    ||(/🗓/.test(text)&&/(?:\d{4}[\/.-]\d|هـ)/.test(text)))return {kind:'ignore',reason:'إعلان أو تعليمات، وليس درسًا'};
  const matches=namedSubjects(subjects,text);
  const media=!!(message.audio||message.voice||message.video||message.video_note||message.document);
  if(media)return {kind:'media',matches};
  let institute=false;
  try{const u=new URL(url);institute=u.hostname==='edu.turathalanbiaa.com'&&/^\/lesson\/\d+\/?$/.test(u.pathname);}catch{}
  if(url&&(matches.length===1||institute))return {kind:'title',matches};
  return {kind:'review',matches};
}
module.exports={classify,namedSubjects,compact};
