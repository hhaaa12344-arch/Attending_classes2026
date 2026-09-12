'use strict';
// Serialize multi-step conversations per account, without serializing all students.
function createUpdateGate(maxPending = 4096) {
  const tails = new Map();
  let count = 0;
  return async (ctx, next) => {
    const key = ctx.from?.id || ctx.chat?.id;
    if (key == null) return next();
    if (count >= maxPending) {
      if (ctx.callbackQuery) return ctx.answerCbQuery('النظام مشغول لحظيًا، أعد المحاولة.');
      if(ctx.chat?.type==='private')return ctx.reply('النظام مشغول لحظيًا، أعد المحاولة بعد قليل.').catch(()=>{});
      return;
    }
    count++;
    const previous = tails.get(key) || Promise.resolve();
    let release;
    const mine = new Promise(resolve => { release = resolve; });
    tails.set(key, mine);
    try { await previous; return await next(); }
    finally { release(); count--; if (tails.get(key) === mine) tails.delete(key); }
  };
}
module.exports = { createUpdateGate };
