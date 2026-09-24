'use strict';
const { enqueueNotification } = require('./outbox');

function createScheduler({ pool, studies }) {
  let running = false;
  const promptLeadMinutes = Number(process.env.SLOT_PROMPT_LEAD_MINUTES || 5);
  if (!Number.isInteger(promptLeadMinutes) || promptLeadMinutes < 1 || promptLeadMinutes > 30) {
    throw new Error('SLOT_PROMPT_LEAD_MINUTES must be an integer from 1 to 30');
  }
  const buttons = (text, data) => ({ reply_markup: { inline_keyboard: [[{ text, callback_data: data }]] } });
  const lastAvailableMinute = (value) => new Date(new Date(value).getTime() - 60000)
    .toLocaleTimeString('ar-IQ', {timeZone: studies.SCHEDULE_TZ, hour:'2-digit', minute:'2-digit'});
  async function queueSession(sessionId, phase) {
    const client = await pool.connect();
    const field = phase === 'start' ? 'start_notifications_queued' : 'end_notifications_queued';
    try {
      await client.query('BEGIN');
      const r = await client.query(`SELECT s.*,g.subject_id,g.stage_season_id,discussion_group_label(g.id) AS group_title,sub.name AS subject_name
        FROM mubahatha_sessions s JOIN mubahatha_groups g ON g.id=s.group_id
        JOIN subjects sub ON sub.id=g.subject_id JOIN stage_seasons ss ON ss.id=g.stage_season_id AND ss.is_active=true
        WHERE s.id=$1 AND participation_enabled(g.subject_id,g.stage_season_id) AND s.${field}=false
          ${phase === 'start' ? `AND s.opened_at + make_interval(mins => ${Number(studies.START_ATTENDANCE_DELAY_MINUTES)}) <= now()` : 'AND s.end_opened_at IS NOT NULL AND s.end_opened_at <= now()'}
        FOR UPDATE OF s`, [sessionId]);
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
        ? `🟢 فُتح تسجيل الحضور الأول لمباحثة «${s.subject_name}» — ${s.group_title}.\nسجّل حضور البداية الآن. ويلزم تسجيل حضور النهاية أيضًا لاكتمال الحضور.`
        : `🔔 فُتح تسجيل الحضور الثاني لمباحثة «${s.subject_name}» — ${s.group_title}.\nيبقى متاحًا لغاية ${lastAvailableMinute(expires)}. يلزم تسجيل البداية والنهاية للاكتمال.`;
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
          text: `فُتح الحضور الأول لمباحثة «${s.subject_name}» — ${s.group_title}.\nعند انتهاء المباحثة اضغط الزر لفتح الحضور الثاني للطلبة. إذا لم تنهها، سيفتح الحضور الثاني تلقائيًا قبل نهاية الساعة بعشر دقائق.`,
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
  async function queueSlotDecisionNotice(slotId, scheduledDate, decision, reason = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const q = await client.query(`SELECT sl.*,d.decision,d.reason,sub.name AS subject_name,
          discussion_group_label(g.id) AS group_title,sg.name AS stage_name,
          ((d.scheduled_date+make_time(sl.hour,sl.minute,0)+make_interval(hours=>sl.duration_hours)) AT TIME ZONE $3) AS expires_at
        FROM slot_decisions d JOIN schedule_slots sl ON sl.id=d.slot_id
        JOIN mubahatha_groups g ON g.id=sl.group_id
        JOIN subjects sub ON sub.id=sl.subject_id
        JOIN stage_seasons ss ON ss.id=sl.stage_season_id AND ss.is_active=true
        JOIN stages sg ON sg.id=ss.stage_id
        WHERE d.slot_id=$1 AND d.scheduled_date=$2::date AND d.decision=$4
          AND sl.is_active=true AND participation_enabled(sl.subject_id,sl.stage_season_id)
        FOR UPDATE OF d`,[slotId,scheduledDate,studies.SCHEDULE_TZ,decision]);
      const slot=q.rows[0];
      if(!slot){await client.query('ROLLBACK');return null;}
      const at=`${String(slot.hour).padStart(2,'0')}:${String(slot.minute).padStart(2,'0')}`;
      const effectiveReason=(reason||slot.reason||'').trim();
      const text=decision==='confirmed'
        ? `✅ أكد الأستاذ إقامة مباحثة مادة «${slot.subject_name}» للمرحلة «${slot.stage_name}» — ${slot.group_title}.\nالموعد الساعة ${at} بتوقيت بغداد.`
        : `🕓 تم تأجيل مباحثة مادة «${slot.subject_name}» للمرحلة «${slot.stage_name}» — ${slot.group_title}.`+
          (effectiveReason?`\nالسبب: ${effectiveReason}`:'');
      const payload=JSON.stringify([text,{}]);
      const inserted=await client.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,expires_at)
        SELECT $1||':'||st.telegram_id::text,st.telegram_id,$2::jsonb,$3
        FROM group_memberships m
        JOIN students st ON st.id=m.student_id AND st.is_active=true
        JOIN enrollments e ON e.student_id=st.id AND e.stage_season_id=m.stage_season_id AND e.status='active'
        JOIN participation_modes pm ON pm.student_id=st.id AND pm.subject_id=m.subject_id
          AND pm.stage_season_id=m.stage_season_id AND pm.mode='mubahatha'
        WHERE m.group_id=$4
        ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
        [`slot:${slot.id}:${scheduledDate}:${decision}`,payload,slot.expires_at,slot.group_id]);
      await client.query('COMMIT');
      return {notified:inserted.rowCount,subjectName:slot.subject_name,stageName:slot.stage_name,groupTitle:slot.group_title};
    } catch(err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  }
  async function queueMissedSlotAlerts(adminIds=[]) {
    if(!adminIds.length)return 0;
    const {rows}=await pool.query(`WITH loc AS (SELECT now() AT TIME ZONE $1::text AS local_now),
      dates AS (SELECT local_now::date AS day FROM loc UNION ALL SELECT local_now::date-1 FROM loc)
      SELECT sl.id,dates.day::text AS scheduled_date,sl.hour,sl.minute,
        sub.name AS subject_name,sg.name AS stage_name,discussion_group_label(g.id) AS group_title,
        COALESCE(t.full_name,'أستاذ غير محدد') AS teacher_name,d.decision
      FROM schedule_slots sl JOIN mubahatha_groups g ON g.id=sl.group_id AND g.is_active=true
      JOIN subjects sub ON sub.id=sl.subject_id
      JOIN stage_seasons ss ON ss.id=sl.stage_season_id AND ss.is_active=true
      JOIN stages sg ON sg.id=ss.stage_id
      LEFT JOIN teachers t ON t.id=sl.teacher_id
      CROSS JOIN dates CROSS JOIN loc
      LEFT JOIN slot_decisions d ON d.slot_id=sl.id AND d.scheduled_date=dates.day
      WHERE sl.is_active=true AND participation_enabled(sl.subject_id,sl.stage_season_id)
        AND EXTRACT(DOW FROM dates.day)::int=sl.day_of_week
        AND loc.local_now>=dates.day+make_time(sl.hour,sl.minute,0)+make_interval(hours=>sl.duration_hours)
        AND sl.created_at<=((dates.day+make_time(sl.hour,sl.minute,0)) AT TIME ZONE $1::text) AT TIME ZONE 'UTC'
        AND d.session_id IS NULL AND d.decision IS DISTINCT FROM 'postponed'
        AND NOT EXISTS(SELECT 1 FROM mubahatha_sessions ms WHERE ms.group_id=sl.group_id
          AND ms.held_on=dates.day AND ms.opened_at>=((dates.day+make_time(sl.hour,sl.minute,0)) AT TIME ZONE $1::text) AT TIME ZONE 'UTC'
          AND ms.opened_at<((dates.day+make_time(sl.hour,sl.minute,0)+make_interval(hours=>sl.duration_hours)) AT TIME ZONE $1::text) AT TIME ZONE 'UTC')
      ORDER BY dates.day,sl.id`,[studies.SCHEDULE_TZ]);
    let queued=0;
    for(const slot of rows){
      const at=`${String(slot.hour).padStart(2,'0')}:${String(slot.minute).padStart(2,'0')}`;
      const text=`⚠️ لم تُسجَّل مباحثة الموعد المطلوب.\nالأستاذ: ${slot.teacher_name}\nالمرحلة: ${slot.stage_name}\nالمادة: ${slot.subject_name}\nالمجموعة: ${slot.group_title}\nالموعد: ${slot.scheduled_date} الساعة ${at} بتوقيت بغداد.\n${slot.decision==='confirmed'?'أكّد الأستاذ الموعد، لكن لم تُفتح جلسة.':'لم يؤكد الأستاذ الموعد ولم تُفتح جلسة.'}`;
      for(const adminId of adminIds){
        const result=await enqueueNotification(pool,{key:`missed-slot:${slot.id}:${slot.scheduled_date}:${adminId}`,chatId:adminId,text});
        queued+=result.rowCount;
      }
    }
    return queued;
  }
  async function tick(adminIds=[]) {
    if (running) return;
    running = true;
    try {
      for (const slot of await studies.getSlotsNeedingPrompt(promptLeadMinutes)) {
        if (!slot.teacher_telegram_id) continue;
        const date = typeof slot.scheduled_date === 'string' ? slot.scheduled_date.slice(0,10) : slot.scheduled_date.toISOString().slice(0,10);
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await enqueueNotification(c, { key:`slot:${slot.id}:${date}:prompt`,chatId:slot.teacher_telegram_id,
            text:`⏰ بعد ${promptLeadMinutes} دقائق موعد مباحثة المرحلة «${slot.stage_name}» في مادة «${slot.subject_name}» — ${slot.group_title}.\nهل أنت مستعد للمباحثة؟ لن تبدأ جلسة اليوم ما لم تؤكدها.`,
            extra:{ reply_markup:{inline_keyboard:[[{text:'✅ نعم، ستكون هناك مباحثة',callback_data:`slot_yes:${slot.id}:${date}`},{text:'🕓 تأجيل',callback_data:`slot_no:${slot.id}:${date}`}]]}},
            expiresAt: new Date(Date.now()+promptLeadMinutes*60000) });
          await c.query(`INSERT INTO slot_decisions(slot_id,scheduled_date) VALUES($1,$2) ON CONFLICT DO NOTHING`,[slot.id,date]);
          await c.query('COMMIT');
        } catch(e) {await c.query('ROLLBACK');throw e;} finally {c.release();}
      }
      for (const slot of await studies.getSlotsReadyToStart()) await studies.startSessionFromSlot(slot);
      // الامتحانات لا تحتاج زر نشر: تتحول تلقائيًا إلى منشورة عند حلول موعدها.
      for (const exam of await studies.getExamsReadyToAutoPublish(50)) {
        try { await studies.publishExam(exam.id); }
        catch (err) {
          // قد تتسابق دورة أخرى مع هذه الدورة؛ هذا ليس خطأ تشغيليًا.
          if (err?.code !== 'CONFLICT') console.error(`Auto exam publish ${exam.id} failed:`, err.message);
        }
      }
      const pending = await pool.query(`SELECT id FROM mubahatha_sessions
        WHERE (start_notifications_queued=false AND closes_at > now()
               AND opened_at + make_interval(mins => $1::int) <= now())
           OR (end_notifications_queued=false AND end_closes_at > now()) ORDER BY id LIMIT 100`,
        [studies.START_ATTENDANCE_DELAY_MINUTES]);
      for (const s of pending.rows) { await queueSession(s.id,'start'); await queueSession(s.id,'end'); }
      for (const s of await studies.getSessionsNeedingAutoEnd()) await openEnd(s.id,true);
      await studies.closeExpiredSessionsWithoutEnd();
      await queueMissedSlotAlerts(adminIds);
    } finally { running=false; }
  }
  return { tick, openEnd, queueSession, queueSlotDecisionNotice, queueMissedSlotAlerts };
}
module.exports = { createScheduler };
