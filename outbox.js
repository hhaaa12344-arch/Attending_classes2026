'use strict';

async function enqueueNotification(client, { key, chatId, text, extra = {}, method = 'sendMessage', priority = 5, expiresAt = null, mark = null }) {
  if (!['sendMessage', 'sendDocument', 'sendPhoto', 'sendVideo'].includes(method)) throw new Error('Unsupported notification');
  return client.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,method,payload,priority,expires_at,delivery_mark)
    VALUES($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
  [key, chatId, method, JSON.stringify([text, extra]), priority, expiresAt,JSON.stringify(mark)]);
}

function createOutboxWorker(pool, queue, deleteMessage = null) {
  let running = false;
  let stopped = false;
  let nextPoll = 0;
  let lastPrune = 0;
  async function tick({force=false}={}) {
    if (running || stopped || (!force && Date.now()<nextPoll)) return;
    running = true;
    try {
      if(Date.now()-lastPrune>86400000){
        // Daily lesson notices alone: keep other outbox records for diagnostics,
        // delivery history, retries, and administrative workflows.
        await pool.query(`DELETE FROM notification_outbox WHERE dedupe_key LIKE 'daily:%' AND (
          (status='sent' AND sent_at<now()-interval '30 days'
            AND (expires_at IS NULL OR expires_at<now()-interval '30 days')
            AND (telegram_message_id IS NULL OR deleted_at IS NOT NULL))
          OR (status='expired' AND expires_at<now()-interval '30 days')
          OR (status='failed' AND expires_at<now()-interval '90 days'))`);
        await pool.query(`DELETE FROM student_daily_lesson_notifications d
          WHERE d.notification_date<CURRENT_DATE-30 AND NOT EXISTS(
            SELECT 1 FROM notification_outbox n WHERE n.dedupe_key='daily:'||d.stage_id||':'||d.notification_date||':'||d.student_id
              AND (n.status IN ('pending','sending') OR n.expires_at>now()))`);
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
        if (!job) {nextPoll=Date.now()+5000;break;}
        try {
          const sent=await queue[job.method](Number(job.chat_id), ...job.payload, { priority: job.priority });
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
          const permanent = code === 400 || code === 403 || job.attempts >= 8;
          const delay = Math.max(Number(err.response?.parameters?.retry_after || 0), Math.min(300, 2 ** job.attempts));
          await pool.query(`UPDATE notification_outbox SET status=$2,lease_until=NULL,
            available_at=now()+make_interval(secs=>$3),last_error=$4 WHERE id=$1`,
          [job.id, permanent ? 'failed' : 'pending', delay, String(code || err.code || 'DELIVERY_ERROR').slice(0, 100)]);
        }
      }
    } finally { running = false; }
  }
  return { tick, stop: () => { stopped = true; }, isRunning: () => running };
}
module.exports = { enqueueNotification, createOutboxWorker };
