'use strict';
// Finished replies must not pile up in student and teacher chats.
// Every ordinary reply sent while handling an update is remembered; the next
// interaction from that chat removes the earlier ones, so only the message the
// user is currently working with (and the pinned reply-keyboard menu) stays.
// Notifications sent through bot.telegram directly are never recorded here.
const isMenuMessage = (extra) => Boolean(extra && extra.reply_markup && Array.isArray(extra.reply_markup.keyboard));

function createTransientCleaner({ db, isAdmin, isInPreview, deleteMessage, onError = () => {} }) {
  return async function transientCleaner(ctx, next) {
    const chat = ctx.chat;
    if (!chat || chat.type !== 'private' || !ctx.from || isAdmin(ctx) || isInPreview(ctx)) return next();

    // 1) remove what earlier interactions left behind, keeping the message being pressed
    try {
      const keep = ctx.callbackQuery?.message?.message_id ?? null;
      const stale = await db.takeTransientMessages(chat.id, keep);
      for (const id of stale) await deleteMessage(chat.id, id);
    } catch (err) { onError(err); }

    // 2) remember what this interaction sends
    const reply = ctx.reply.bind(ctx);
    ctx.reply = async (text, extra) => {
      const message = await reply(text, extra);
      if (message && Number.isSafeInteger(Number(message.message_id)) && !isMenuMessage(extra)) {
        try { await db.recordTransientMessage(chat.id, Number(message.message_id)); } catch (err) { onError(err); }
      }
      return message;
    };
    return next();
  };
}
module.exports = { createTransientCleaner, isMenuMessage };
