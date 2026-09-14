'use strict';
const { enqueueNotification } = require('./outbox');

function createScheduler({ pool, studies }) {
  let running = false;
  const buttons = (text, data) => ({ reply_markup: { inline_keyboard: [[{ text, callback_data: data }]] } });
  async function queueSession(sessionId, phase) {
    const client = await pool.connect();
    const field = phase === 'start' ? 'start_notifications_queued' : 'end_notifications_queued';
    try {
      await client.query('BEGIN');
      const r = await client.query(`SELECT s.*,g.subject_id,g.stage_season_id,discussion_group_label(g.id) AS group_title,sub.name AS subject_name
        FROM mubahatha_sessions s JOIN mubahatha_groups g ON g.id=s.group_id
        JOIN subjects sub ON sub.id=g.subject_id JOIN stage_seasons ss ON ss.id=g.stage_season_id AND ss.is_active=true
        WHERE s.id=$1 AND participation_enabled(g.subject_id,g.stage_season_id) AND s.${field}=false FOR UPDATE OF s`, [sessionId]);
      const s = r.rows[0];
      if (!s) { await client.query('COMMIT'); return 0; }
      const expires = phase === 'start' ? s.closes_at : s.end_closes_at;
      if (!expires || new Date(expires) <= new Date()) { await client.query('COMMIT'); return 0; }
      const students = await client.query(`SELECT st.telegram_id FROM group_memberships m
        JOIN students st ON st.id=m.student_id AND st.is_active=true
        JOIN enrollments e ON e.student_id=st.id AND e.stage_season_id=m.stage_season_id AND e.status='active'
        JOIN participation_modes pm ON pm.student_id=st.id AND pm.subject_id=m.subject_id AND pm.stage_season_id=m.stage_season_id AND pm.mode='mubahatha'
        WHERE m.group_id=$1 AND m.assigned_at <= $2 AND pm.joined_mubahatha_at <= $2`, [s.group_id, s.opened_at]);
      const text = phase === 'start'
        ? `🟢 بدأت مباحثة «${s.subject_name}» — ${s.group_title}.\nسجّل حضور البداية بعد حضورك الفعلي. ويلزم تسجيل النهاية أيضًا.`
        : `🔔 فُتح حضور نهاية مباحثة «${s.subject_name}» — ${s.group_title}.\nينتهي التسجيل عند ${new Date(expires).toLocaleTimeString('ar-IQ', {timeZone: studies.SCHEDULE_TZ, hour:'2-digit', minute:'2-digit'})}. يلزم حضور البداية والنهاية للاكتمال.`;
      const extra = buttons(phase === 'start' ? '✅ حضرتُ بداية المباحثة' : '✅ حضرتُ نهاية المباحثة', `${phase === 'start' ? 'mub_attend' : 'mub_end_attend'}:${s.id}`);
      // One bounded SQL insert, no thousands of promises held in RAM.
      await client.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,expires_at)
        SELECT $1||':'||x::text,x,$2::jsonb,$3 FROM unnest($4::bigint[]) x
        ON CONFLICT(dedupe_key) DO NOTHING`,
      [`session:${s.id}:${phase}`, JSON.stringify([text,extra]), expires, students.rows.map(x => x.telegram_id)]);
      if (phase === 'start') {
        const teacher = (await client.query('SELECT telegram_id FROM teachers WHERE id=$1 AND is_active=true', [s.teacher_id])).rows[0];
        if (teacher?.telegram_id) await enqueueNotification(client, {
          key: `session:${s.id}:teacher`, chatId: teacher.telegram_id, expiresAt: s.closes_at,
          text: `بدأت مباحثة «${s.subject_name}» — ${s.group_title}. يمكنك إنهاؤها وفتح الحضور الثاني، وإلا يفتح تلقائيًا عند نهاية الوقت.`,
          extra: buttons('🔚 إنهاء المباحثة وفتح حضور النهاية', `mub_finish:${s.id}`)
        });
      }
      await client.query(`UPDATE mubahatha_sessions SET ${field}=true WHERE id=$1`, [s.id]);
      await client.query('COMMIT');
      return students.rowCount;
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  }
  async function openEnd(sessionId, automatic = false) {
    const opened = await studies.openEndAttendance(sessionId, automatic);
    if (!opened) return null;
    return { notified: await queueSession(sessionId, 'end') };
  }
  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const slot of await studies.getSlotsNeedingPrompt(5)) {
        if (!slot.teacher_telegram_id) continue;
        const date = typeof slot.scheduled_date === 'string' ? slot.scheduled_date.slice(0,10) : slot.scheduled_date.toISOString().slice(0,10);
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await enqueueNotification(c, { key:`slot:${slot.id}:${date}:prompt`,chatId:slot.teacher_telegram_id,
            text:`⏰ يقترب موعد «${slot.subject_name}» — ${slot.group_title}. ${process.env.SCHEDULE_REQUIRE_CONFIRMATION==='true'?'يلزم تأكيدك لفتحه في الموعد.':'يبدأ تلقائيًا في وقته ما لم تؤجله.'}`,
            extra:{ reply_markup:{inline_keyboard:[[{text:'✅ تأكيد',callback_data:`slot_yes:${slot.id}:${date}`},{text:'🕓 تأجيل اليوم',callback_data:`slot_no:${slot.id}:${date}`}]]}},
            expiresAt: new Date(Date.now()+5*60000) });
          await c.query(`INSERT INTO slot_decisions(slot_id,scheduled_date) VALUES($1,$2) ON CONFLICT DO NOTHING`,[slot.id,date]);
          await c.query('COMMIT');
        } catch(e) {await c.query('ROLLBACK');throw e;} finally {c.release();}
      }
      for (const slot of await studies.getSlotsReadyToStart()) await studies.startSessionFromSlot(slot);
      const pending = await pool.query(`SELECT id FROM mubahatha_sessions
        WHERE (start_notifications_queued=false AND is_closed=false AND closes_at > now())
           OR (end_notifications_queued=false AND end_closes_at > now()) ORDER BY id LIMIT 100`);
      for (const s of pending.rows) { await queueSession(s.id,'start'); await queueSession(s.id,'end'); }
      for (const s of await studies.getSessionsNeedingEndPrompt(studies.END_ATTENDANCE_MINUTES)) {
        if (!s.teacher_telegram_id) continue;
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await enqueueNotification(c, { key:`session:${s.id}:endprompt`,chatId:s.teacher_telegram_id,
            expiresAt:s.closes_at, text:`⏰ تبقّت نحو عشر دقائق على نهاية «${s.subject_name}» — ${s.group_title}. يمكنك إنهاؤها الآن، وإلا يُفتح الحضور الثاني تلقائيًا عند نهاية الموعد.`,
            extra: buttons('🔚 إنهاء المباحثة وفتح حضور النهاية',`mub_finish:${s.id}`) });
          await c.query('UPDATE mubahatha_sessions SET end_prompt_sent=true WHERE id=$1',[s.id]);
          await c.query('COMMIT');
        } catch(e) {await c.query('ROLLBACK');throw e;} finally {c.release();}
      }
      for (const s of await studies.getSessionsNeedingAutoEnd()) await openEnd(s.id,true);
    } finally { running=false; }
  }
  return { tick, openEnd, queueSession };
}
module.exports = { createScheduler };
