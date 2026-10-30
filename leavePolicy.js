'use strict';
const iso=d=>d.toISOString().slice(0,10);
function parse(value){const s=value instanceof Date?iso(value):String(value).slice(0,10);const d=new Date(s+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||Number.isNaN(+d)||iso(d)!==s)throw new Error('تاريخ الإجازة غير صالح.');return d;}
function working(d){return d.getUTCDay()!==4&&d.getUTCDay()!==5;}
function leavePeriod(start,calendarDays){const d=parse(start);const dates=[];for(let i=0;i<calendarDays;i++){if(working(d))dates.push(iso(d));d.setUTCDate(d.getUTCDate()+1);}return {start:dates[0],end:dates.at(-1),days:dates.length,holidays:calendarDays-dates.length};}
function endAfterWorkingDays(start,days){const d=parse(start);let n=0;while(n<days){if(working(d))n++;if(n<days)d.setUTCDate(d.getUTCDate()+1);}return iso(d);}
function countWorkingDays(start,end){const a=parse(start),b=parse(end);let n=0;while(a<=b){if(working(a))n++;a.setUTCDate(a.getUTCDate()+1);}return n;}
module.exports={leavePeriod,endAfterWorkingDays,countWorkingDays};
