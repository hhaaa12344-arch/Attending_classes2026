'use strict';
// One transaction owns selection and insertion. A caption/link, an edited old
// post, or an old backlog must never silently consume today's first subject.
const baghdadDay=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const normalized=value=>String(value||'').normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g,'').replace(/[أإآ]/g,'ا').replace(/[^\p{L}\p{N}]/gu,'').toLowerCase();
function chooseSubject(subjects,text,allSubjects=subjects){
  const caption=normalized(text),matches=allSubjects.filter(s=>[s.name,s.hashtag].some(name=>normalized(name).length>=3&&caption.includes(normalized(name))));
  if(matches.length)return matches.length===1?subjects.find(s=>s.id===matches[0].id):null;
  return subjects[0];
}
function createScheduledPublication(db){
  async function publish({channel,message,sourceUrl,contentKind,edited=false}){
    const c=await db.pool.connect();
    try{
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(734225,$1)',[channel.stage_season_id]);
      const linked=(await c.query(`SELECT ch.id FROM channels ch JOIN stage_seasons ss ON ss.id=ch.stage_season_id
        JOIN stages st ON st.id=ch.stage_id WHERE ch.telegram_chat_id=$1 AND ch.stage_id=$2 AND ch.stage_season_id=$3
        AND ss.is_active=true AND st.is_active=true FOR SHARE OF ch,ss,st`,[message.chat.id,channel.stage_id,channel.stage_season_id])).rows[0];
      if(!linked)throw Error('تغيّر ربط القناة أو أُرشف الموسم؛ لم يُربط المنشور بمادة.');
      const existing=(await c.query('SELECT * FROM lessons WHERE source_chat_id=$1 AND source_message_id=$2',[message.chat.id,message.message_id])).rows[0];
      if(existing){await c.query('COMMIT');return {lesson:existing,created:false};}
      const now=(await c.query('SELECT now() AS at')).rows[0].at;
      const published=message.date?new Date(message.date*1000):null;
      const day=baghdadDay(published||now);
      const autoMatch=!!published&&!edited&&published<=now&&day===baghdadDay(now)&&['voice','audio','audio_document','video','document'].includes(contentKind);
      const p=await db.queuePendingChannelLessonPost({chatId:message.chat.id,messageId:message.message_id,stageId:channel.stage_id,stageSeasonId:channel.stage_season_id,
        lessonDate:day,sourceUrl,contentKind,receivedAt:published,autoMatch,contentText:message.caption||message.text},c);
      if(!autoMatch||!p.auto_match||p.status!=='pending'){await c.query('COMMIT');return {created:false,pending:p};}
      const first=(await c.query(`SELECT id FROM pending_channel_lesson_posts p WHERE stage_season_id=$1 AND lesson_date=$2 AND status='pending' AND auto_match=true
        AND NOT EXISTS(SELECT 1 FROM lessons l WHERE l.source_chat_id=p.telegram_chat_id AND l.source_message_id=p.source_message_id)
        ORDER BY received_at,source_message_id,id LIMIT 1`,[channel.stage_season_id,day])).rows[0];
      const subjects=await db.getPendingScheduledSubjectsForDate(channel.stage_season_id,day,c);
      const allSubjects=(await c.query('SELECT id,name,hashtag FROM subjects WHERE stage_id=$1',[channel.stage_id])).rows;
      const subject=chooseSubject(subjects,message.caption||message.text,allSubjects);
      if(!first||Number(first.id)!==Number(p.id)||!subject){await c.query('COMMIT');return {created:false,pending:p};}
      const lesson=await db.activateLesson(subject.id,24,'channel_schedule',sourceUrl,message.chat.id,message.message_id,published,{client:c,scheduleDate:day});
      if(!lesson)throw Error('لم يعد موسم المرحلة متاحًا.');
      await c.query("UPDATE pending_channel_lesson_posts SET status='activated',lesson_id=$2,resolved_subject_id=$3,resolved_at=now() WHERE id=$1",[p.id,lesson.id,subject.id]);
      await c.query('COMMIT');return {lesson,subject,created:true};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  return {publish};
}
module.exports={createScheduledPublication,chooseSubject,baghdadDay};
