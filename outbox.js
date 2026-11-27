'use strict';

async function enqueueNotification(client, { key, chatId, text, extra = {}, method = 'sendMessage', priority = 5, expiresAt = null, mark = null }) {
  if (!['sendMessage', 'sendDocument', 'sendPhoto', 'sendVideo'].includes(method)) throw new Error('Unsupported notification');
  return client.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,method,payload,priority,expires_at,delivery_mark)
    VALUES($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
  [key, chatId, method, JSON.stringify([text, extra]), priority, expiresAt,JSON.stringify(mark)]);
}

// محادثة محظورة تُجرَّب مرة واحدة كل 14 يومًا فقط (تشفي الحالات الخاطئة)، وتُرفع الحماية فور تفاعلها مع البوت.
const BLOCKED_PROBE_MS = 14 * 24 * 3600 * 1000;

function createOutboxWorker(pool, queue, deleteMessage = null, { prepareNotification = null } = {}) {
  // chat_id -> وقت الحظر. null حتى أول تحميل.
  let blocked = null;
  async function loadBlocked() {
    try {
      blocked = new Map((await pool.query('SELECT chat_id,blocked_at FROM blocked_chats')).rows
        .map((r) => [Number(r.chat_id), new Date(r.blocked_at).getTime()]));
    } catch (err) { blocked = new Map(); console.warn('Blocked chats load failed:', err.code || err.message); }
  }
  function block(chatId, reason = '403') {
    chatId = Number(chatId);
    (blocked ||= new Map()).set(chatId, Date.now());
    return pool.query(`INSERT INTO blocked_chats(chat_id,reason) VALUES($1,$2)
      ON CONFLICT(chat_id) DO UPDATE SET reason=EXCLUDED.reason,blocked_at=now()`, [chatId, String(reason).slice(0, 100)])
      .catch((err) => console.warn('Block chat failed:', err.code || err.message));
  }
  function unblock(chatId) {
    chatId = Number(chatId);
    if (blocked && !blocked.has(chatId)) return Promise.resolve();
    blocked?.delete(chatId);
    return pool.query('DELETE FROM blocked_chats WHERE chat_id=$1', [chatId])
      .catch((err) => console.warn('Unblock chat failed:', err.code || err.message));
  }
  let running = false;
  let stopped = false;
  let nextPoll = 0;
  let lastPrune = 0;
  async function tick({force=false}={}) {
    if (running || stopped || (!force && Date.now()<nextPoll)) return;
    if (!blocked) await loadBlocked();
    running = true;
    try {
      if(Date.now()-lastPrune>86400000){
        // تنظيف الإشعارات المنتهية لتبقى قاعدة البيانات صغيرة (تكلفة الذاكرة والقرص).
        // لا يُمَس أي إشعار منتظر أو قيد الإرسال، ولا رسالة تلغرام ما زال البوت سيحذفها عند انتهاء صلاحيتها.
        //   قصيرة (OUTBOX_RETENTION_DAYS، الافتراضي 3 أيام): إشعارات الدروس اليومية والتذكيرات والجلسات والمواعيد.
        //   أخرى (OUTBOX_RETENTION_OTHER_DAYS، الافتراضي 30 يومًا).
        //   محفوظة أطول (OUTBOX_RETENTION_KEEP_DAYS، الافتراضي 90 يومًا): البث والامتحانات لأن تعديل البث وتأجيل الامتحان يعتمدان عليها،
        //   والإشعارات الفاشلة (للتشخيص): تُحذف فقط إن كانت من النوع القصير وبعد المدة نفسها، وغير ذلك تبقى.
        //   الفاشلة بخطأ 403 (الطالب حظر البوت أو لم يبدأ محادثته) لا قيمة تشخيصية لها: تُحذف بعد 7 أيام.
        const SHORT_KINDS='^(daily|lesson-reminder|lesson-recovered|lesson-republished|session|slot|missed-slot|schedule-fallback|exam-start|exam-reminder|exam-cancel):';
        const days=(name,def,min,max)=>{const v=Number(process.env[name]??def);return Number.isInteger(v)&&v>=min&&v<=max?v:def;};
        const shortDays=days('OUTBOX_RETENTION_DAYS',3,2,90),otherDays=days('OUTBOX_RETENTION_OTHER_DAYS',30,2,365),keepDays=days('OUTBOX_RETENTION_KEEP_DAYS',90,2,365);
        await pool.query(`DELETE FROM notification_outbox n
          WHERE n.status IN ('sent','expired','failed')
            AND (n.telegram_message_id IS NULL OR n.deleted_at IS NOT NULL
                 OR NOT (n.dedupe_key LIKE 'daily:%' OR n.dedupe_key LIKE 'lesson-reminder:%'))
            AND GREATEST(COALESCE(n.sent_at,n.created_at),COALESCE(n.expires_at,n.created_at))
                < now() - (CASE WHEN n.status='failed' AND n.last_error LIKE '403%' THEN 7
                                WHEN n.status='failed' THEN (CASE WHEN n.dedupe_key ~ $4::text THEN $3::int ELSE 36500 END)
                                WHEN n.dedupe_key ~ $4::text THEN $1::int
                                WHEN n.dedupe_key ~ '^(broadcast|exam|exam-postpone):' THEN $3::int
                                ELSE $2::int END) * interval '1 day'`,[shortDays,otherDays,keepDays,SHORT_KINDS]);
        await pool.query(`DELETE FROM student_daily_lesson_notifications d
          WHERE d.notification_date<CURRENT_DATE-$1::int AND NOT EXISTS(
            SELECT 1 FROM notification_outbox n WHERE n.dedupe_key='daily:'||d.stage_id||':'||d.notification_date||':'||d.student_id
              AND (n.status IN ('pending','sending') OR n.expires_at>now()))`,[shortDays]);
        lastPrune=Date.now();
      }
      await pool.query(`UPDATE notification_outbox SET status='expired'
        WHERE status IN ('pending','sending') AND expires_at <= now()`);
      if(deleteMessage){
        const expired=(await pool.query(`SELECT id,chat_id,telegram_message_id FROM notification_outbox
          WHERE status='sent' AND telegram_message_id IS NOT NULL AND deleted_at IS NULL
            AND expires_at<=now() AND (dedupe_key LIKE 'daily:%' OR dedupe_key LIKE 'lesson-reminder:%')
          ORDER BY expires_at,id LIMIT 20`)).rows;
        for(const notice of expired){
          try{await deleteMessage(Number(notice.chat_id),Number(notice.telegram_message_id));}
          catch(err){if(![400,404].includes(err.response?.error_code))continue;}
          await pool.query('UPDATE notification_outbox SET deleted_at=now() WHERE id=$1',[notice.id]);
        }
      }
      // Lease one item at a time: never reserve a large batch while waiting for Telegram.
      for (let i = 0; i < 250 && !stopped; i++) {
        const { rows } = await pool.query(`UPDATE notification_outbox SET status='sending',
          lease_until=now()+interval '5 minutes', attempts=attempts+1
          WHERE id=(SELECT id FROM notification_outbox
            WHERE ((status='pending' AND available_at <= now()) OR (status='sending' AND lease_until < now()))
              AND (expires_at IS NULL OR expires_at > now())
            ORDER BY priority,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
        const job = rows[0];
        if (!job) {nextPoll=Date.now()+10000;break;} // استطلاع خامل كل 10 ث بدل 5 لتقليل استعلامات قاعدة البيانات؛ الإرسال الفوري يوقظه force
        // محادثة محظورة: لا نستهلك طلبًا من تلغرام ولا محاولات؛ يُسجَّل الفشل كما لو أعاد تلغرام 403.
        const blockedAt = blocked.get(Number(job.chat_id));
        if (blockedAt !== undefined && Date.now() - blockedAt < BLOCKED_PROBE_MS) {
          await pool.query("UPDATE notification_outbox SET status='failed',lease_until=NULL,last_error='403' WHERE id=$1", [job.id]);
          continue;
        }
        try {
          const beforeSend = prepareNotification && job.dedupe_key.startsWith('weekly-report:') ? async () => {
            const payload = await prepareNotification(job);
            if (payload === null) return null;
            job.payload = payload;
            await pool.query('UPDATE notification_outbox SET payload=$2::jsonb WHERE id=$1', [job.id, JSON.stringify(payload)]);
            return [Number(job.chat_id), ...payload];
          } : null;
          const sent=await queue[job.method](Number(job.chat_id), ...job.payload, { priority: job.priority, beforeSend });
          if (sent?.notificationSkipped) {
            await pool.query("UPDATE notification_outbox SET status='expired',lease_until=NULL,last_error=NULL WHERE id=$1", [job.id]);
            continue;
          }
          if (blocked.has(Number(job.chat_id))) await unblock(job.chat_id); // نجحت التجربة: المحادثة عادت
          const c=await pool.connect();
          try{
            await c.query('BEGIN');
            await c.query(`UPDATE notification_outbox SET status='sent',sent_at=now(),lease_until=NULL,last_error=NULL,
              telegram_message_id=$2 WHERE id=$1`,[job.id,sent?.message_id||null]);
            const mark=job.delivery_mark;
            if(mark?.kind==='student_absence')await c.query('UPDATE student_attendance_days SET student_alert_sent_at=COALESCE(student_alert_sent_at,now()) WHERE id=$1',[mark.id]);
            if(mark?.kind==='admin_absence')await c.query('UPDATE student_attendance_days SET admin_alert_sent_at=COALESCE(admin_alert_sent_at,now()) WHERE id=ANY($1::bigint[])',[mark.ids]);
            await c.query('COMMIT');
          }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
        } catch (err) {
          const code = err.response?.error_code;
          if (code === 403) await block(job.chat_id, '403');
          const permanent = code === 400 || code === 403 || job.attempts >= 8;
          const delay = Math.max(Number(err.response?.parameters?.retry_after || 0), Math.min(300, 2 ** job.attempts));
          await pool.query(`UPDATE notification_outbox SET status=$2,lease_until=NULL,
            available_at=now()+make_interval(secs=>$3),last_error=$4 WHERE id=$1`,
          [job.id, permanent ? 'failed' : 'pending', delay, String(code || err.code || 'DELIVERY_ERROR').slice(0, 100)]);
        }
      }
    } finally { running = false; }
  }
  return { tick, stop: () => { stopped = true; }, isRunning: () => running, block, unblock, blockedCount: () => blocked?.size || 0 };
}
module.exports = { enqueueNotification, createOutboxWorker };
