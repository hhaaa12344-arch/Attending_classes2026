'use strict';
// One transaction owns selection and insertion. A caption/link, an edited old
// post, or an old backlog must never silently consume today's first subject.
const baghdadDay=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const {classify,namedSubjects,messageText}=require('./lessonContent');
// A caption/file name is authoritative only when it identifies exactly one subject.
// A subjectless file must NEVER consume the first of several scheduled subjects:
// publication order (or an anonymous MP3 number) does not establish its curriculum.
// Even a single scheduled subject does not identify an anonymous recording.
function chooseSubject(subjects,text,allSubjects=subjects){
  const matches=namedSubjects(allSubjects,text);
  if(matches.length)return matches.length===1?subjects.find(s=>Number(s.id)===Number(matches[0].id))||null:null;
  return null;
}
function createScheduledPublication(db){
  async function publish({channel,message,sourceUrl,contentKind,edited=false,explicitSubjectId=null}){
    const c=await db.pool.connect();
    try{
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(734225,$1)',[channel.stage_season_id]);
      const linked=(await c.query(`SELECT ch.id FROM channels ch JOIN stage_seasons ss ON ss.id=ch.stage_season_id
        JOIN stages st ON st.id=ch.stage_id WHERE ch.telegram_chat_id=$1 AND ch.stage_id=$2 AND ch.stage_season_id=$3
        AND ss.is_active=true AND st.is_active=true FOR SHARE OF ch,ss,st`,[message.chat.id,channel.stage_id,channel.stage_season_id])).rows[0];
      if(!linked)throw Error('تغيّر ربط القناة أو أُرشف الموسم؛ لم يُربط المنشور بمادة.');
      const retired=(await c.query('SELECT r.canonical_lesson_id FROM lessons l JOIN lesson_corrections r ON r.lesson_id=l.id WHERE l.source_chat_id=$1 AND l.source_message_id=$2',[message.chat.id,message.message_id])).rows[0];
      if(retired){const lesson=retired.canonical_lesson_id?(await c.query('SELECT * FROM effective_lessons WHERE id=$1',[retired.canonical_lesson_id])).rows[0]:null;await c.query('COMMIT');return {lesson,created:false,ignored:!lesson};}
      const existing=(await c.query(`SELECT * FROM effective_lessons WHERE source_chat_id=$1 AND source_message_id=$2 UNION ALL SELECT l.* FROM effective_lessons l JOIN pending_channel_lesson_posts p ON p.lesson_id=l.id WHERE p.telegram_chat_id=$1 AND p.source_message_id=$2 AND p.status IN ('activated','duplicate') LIMIT 1`,[message.chat.id,message.message_id])).rows[0];
      if(existing){await c.query('COMMIT');return {lesson:existing,created:false};}
      const now=(await c.query('SELECT now() AS at')).rows[0].at;
      const published=message.date?new Date(message.date*1000):null;
      const day=baghdadDay(published||now);
      const allSubjects=(await c.query('SELECT id,name,hashtag FROM subjects WHERE stage_id=$1',[channel.stage_id])).rows;
      const classification=classify(message,allSubjects);
      if(classification.kind==='ignore'){await c.query('COMMIT');return {created:false,ignored:true};}
      const text=messageText(message);
      const hashtagOnly=contentKind==='hashtag_only'&&explicitSubjectId&&
        /^(?:#[\p{L}\p{N}_\u0640]+(?:[\s،,؛;]*)?)+$/u.test(text.trim());
      const ownMatches=namedSubjects(allSubjects,text);
      const previous=classification.kind==='media'?(await c.query(`SELECT * FROM pending_channel_lesson_posts WHERE telegram_chat_id=$1 AND stage_season_id=$2
        AND source_message_id=$3 AND content_kind='lesson_title' AND lesson_date=$4 AND received_at<=$5 AND received_at>=$5::timestamp-interval '24 hours'`,
        [message.chat.id,channel.stage_season_id,message.message_id-1,day,published||now])).rows[0]:null;
      const inherited=previous&&(!ownMatches.length||namedSubjects(allSubjects,previous.content_text).every(s=>ownMatches.some(x=>x.id===s.id)))?previous:null;
      const contentText=inherited&&!ownMatches.length?`${inherited.content_text||''} ${text}`:text;
      const known=namedSubjects(allSubjects,contentText).length===1||explicitSubjectId;
      const autoMatch=!!published&&!edited&&published<=now&&day===baghdadDay(now)&&
        (hashtagOnly||classification.kind==='title'||(classification.kind==='media'&&(['voice','audio','audio_document','document'].includes(contentKind)||known||inherited)));
      const p=await db.queuePendingChannelLessonPost({chatId:message.chat.id,messageId:message.message_id,stageId:channel.stage_id,stageSeasonId:channel.stage_season_id,
        lessonDate:day,sourceUrl,contentKind:hashtagOnly||classification.kind==='title'?'lesson_title':contentKind,receivedAt:published,autoMatch:!!autoMatch,contentText,titleMessageId:inherited?.source_message_id||null,
        mediaUniqueId:(message.audio||message.voice||message.video||message.document)?.file_unique_id||null},c);
      const evidence=namedSubjects(allSubjects,contentText);
      if(p.status==='pending'&&p.media_unique_id){
        const prior=(await c.query(`SELECT DISTINCT l.* FROM effective_lessons l JOIN pending_channel_lesson_posts prev ON prev.lesson_id=l.id
          WHERE prev.stage_season_id=$1 AND prev.telegram_chat_id=$2 AND prev.media_unique_id=$3
            AND prev.id<>$4 AND prev.status IN ('activated','duplicate')`,[channel.stage_season_id,message.chat.id,p.media_unique_id,p.id])).rows;
        if(prior.length){
          const lesson=prior.length===1?prior[0]:null;
          if(lesson&&evidence.length<=1&&(!evidence.length||Number(evidence[0].id)===Number(lesson.subject_id))&&
             (!explicitSubjectId||Number(explicitSubjectId)===Number(lesson.subject_id))){
            await c.query("UPDATE pending_channel_lesson_posts SET status='duplicate',lesson_id=$2,resolved_subject_id=$3,auto_match=false,resolved_at=now() WHERE id=$1",[p.id,lesson.id,lesson.subject_id]);
            await c.query('COMMIT');return {lesson,created:false};
          }
          await c.query('UPDATE pending_channel_lesson_posts SET auto_match=false WHERE id=$1',[p.id]);
          await c.query('COMMIT');return {created:false,pending:p,reviewRequired:true};
        }
      }
      if(inherited&&p.status==='pending'){
        await c.query('UPDATE pending_channel_lesson_posts SET auto_match=false WHERE id=$1',[inherited.id]);
        if(inherited.lesson_id){
          const lesson=(await c.query('SELECT * FROM effective_lessons WHERE id=$1',[inherited.lesson_id])).rows[0];
          if(lesson){
            await c.query("UPDATE pending_channel_lesson_posts SET status='duplicate',lesson_id=$2,resolved_subject_id=$3,resolved_at=now() WHERE id=$1",[p.id,lesson.id,lesson.subject_id]);
            await c.query('COMMIT');return {lesson,created:false};
          }
        }
      }
      // A titled link gets a short pairing interval. Link-only lectures are recovered
      // after the interval; a following file belongs to that same lecture.
      if(classification.kind==='title'||!autoMatch||!p.auto_match||p.status!=='pending'){await c.query('COMMIT');return {created:false,pending:p};}
      const subjects=await db.getPendingScheduledSubjectsForDate(channel.stage_season_id,day,c);
      // Timetable availability constrains a known subject; it never identifies one.
      const identified=namedSubjects(allSubjects,contentText);
      const subject=explicitSubjectId
        ? identified.length===1&&Number(identified[0].id)===Number(explicitSubjectId)?identified[0]:null
        : chooseSubject(subjects,contentText,allSubjects);
      if(!subject){await c.query('COMMIT');return {created:false,pending:p};}
      const fallback=(await c.query(`SELECT id FROM effective_lessons WHERE subject_id=$1 AND stage_season_id=$2
        AND source_type='schedule_fallback' AND source_message_id IS NULL AND schedule_date=$3::date LIMIT 1`,[subject.id,channel.stage_season_id,day])).rows[0];
      if(fallback){
        // Preserve both the old marks and this newly identified recording. An
        // administrator must establish whether the fallback was this lecture.
        await c.query('UPDATE pending_channel_lesson_posts SET auto_match=false WHERE id=$1',[p.id]);
        await c.query('COMMIT');return {created:false,pending:p,reviewRequired:true,fallbackLessonId:Number(fallback.id)};
      }
      const lesson=await db.activateLesson(subject.id,24,explicitSubjectId?'channel_hashtag':'channel_schedule',sourceUrl,message.chat.id,message.message_id,published,{client:c,scheduleDate:day});
      if(!lesson)throw Error('لم يعد موسم المرحلة متاحًا.');
      await c.query("UPDATE pending_channel_lesson_posts SET status='activated',lesson_id=$2,resolved_subject_id=$3,resolved_at=now() WHERE id=$1",[p.id,lesson.id,subject.id]);
      if(p.title_message_id)await c.query("UPDATE pending_channel_lesson_posts SET status='duplicate',lesson_id=$3,resolved_subject_id=$4,resolved_at=now() WHERE telegram_chat_id=$1 AND source_message_id=$2",[message.chat.id,p.title_message_id,lesson.id,subject.id]);
      await c.query('COMMIT');return {lesson,subject,created:true};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  return {publish};
}
module.exports={createScheduledPublication,chooseSubject,baghdadDay};
