'use strict';
// One transaction owns selection and insertion. A caption/link, an edited old
// post, or an old backlog must never silently consume today's first subject.
const baghdadDay=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const {classify,namedSubjects,messageText}=require('./lessonContent');
// عند وجود اسم صريح للمادة يُعتمد الاسم فقط. وإن لم يوجد اسم:
//  - مع {byOrder:true} تُؤخذ أول مادة مجدولة لم تُفعّل بعد (بترتيب أعمدة الجدول)،
//    وهو المسار المعتاد لنشر ملف صوتي بلا وصف.
//  - وبدونه لا يُختار إلا إذا بقيت مادة واحدة فقط.
function chooseSubject(subjects,text,allSubjects=subjects,{byOrder=false}={}){
  const matches=namedSubjects(allSubjects,text);
  if(matches.length)return matches.length===1?subjects.find(s=>s.id===matches[0].id):null;
  if(byOrder)return subjects[0]||null;
  return subjects.length===1?subjects[0]:null;
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
      const ownMatches=namedSubjects(allSubjects,text);
      const previous=classification.kind==='media'?(await c.query(`SELECT * FROM pending_channel_lesson_posts WHERE telegram_chat_id=$1 AND stage_season_id=$2
        AND source_message_id=$3 AND content_kind='lesson_title' AND lesson_date=$4 AND received_at<=$5 AND received_at>=$5::timestamp-interval '24 hours'`,
        [message.chat.id,channel.stage_season_id,message.message_id-1,day,published||now])).rows[0]:null;
      const inherited=previous&&(!ownMatches.length||namedSubjects(allSubjects,previous.content_text).every(s=>ownMatches.some(x=>x.id===s.id)))?previous:null;
      const contentText=inherited&&!ownMatches.length?`${inherited.content_text||''} ${text}`:text;
      const known=namedSubjects(allSubjects,contentText).length===1||explicitSubjectId;
      const autoMatch=!!published&&!edited&&published<=now&&day===baghdadDay(now)&&
        (classification.kind==='title'||(classification.kind==='media'&&(['voice','audio','audio_document','document'].includes(contentKind)||known||inherited)));
      const p=await db.queuePendingChannelLessonPost({chatId:message.chat.id,messageId:message.message_id,stageId:channel.stage_id,stageSeasonId:channel.stage_season_id,
        lessonDate:day,sourceUrl,contentKind:classification.kind==='title'?'lesson_title':contentKind,receivedAt:published,autoMatch:!!autoMatch,contentText,titleMessageId:inherited?.source_message_id||null},c);
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
      // طابور الملفات التي بلا اسم مادة: الأقدم فيه يأخذ أول مادة مجدولة متبقية.
      // الملفات المسمّاة (حتى لو كانت مادتها غير مجدولة بعد) لا تدخل الطابور كي لا تعطّل ما بعدها.
      const queue=(await c.query(`SELECT id,content_text FROM pending_channel_lesson_posts p WHERE stage_season_id=$1 AND lesson_date=$2 AND status='pending' AND auto_match=true
        AND NOT EXISTS(SELECT 1 FROM effective_lessons l WHERE l.source_chat_id=p.telegram_chat_id AND l.source_message_id=p.source_message_id)
        ORDER BY received_at,source_message_id,id`,[channel.stage_season_id,day])).rows;
      const first=queue.find(r=>!namedSubjects(allSubjects,r.content_text).length)||null;
      const subjects=await db.getPendingScheduledSubjectsForDate(channel.stage_season_id,day,c);
      const subject=explicitSubjectId?allSubjects.find(s=>s.id===explicitSubjectId):chooseSubject(subjects,contentText,allSubjects,{byOrder:true});
      if((!known&&(!first||Number(first.id)!==Number(p.id)))||!subject){await c.query('COMMIT');return {created:false,pending:p};}
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
