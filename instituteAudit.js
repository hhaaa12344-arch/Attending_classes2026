'use strict';
const {namedSubjects}=require('./lessonContent');
const {readArchive}=require('./backupArchive');
const instant=value=>value instanceof Date?value:new Date(String(value).replace(' ','T')+(/[T ].*(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(String(value))?'':'Z'));
const baghdadDay=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit',day:'2-digit'}).format(instant(value));
const key=(...parts)=>parts.map(String).join(':');
const byId=rows=>new Map(rows.map(r=>[String(r.id),r]));
// IDs are local database identifiers; no student names, Telegram IDs, answers or
// notification payloads enter the report. Differences are candidates, not verdicts.
function auditSnapshot(tables,{asOf=new Date()}={}){
  const get=t=>tables[t]||[],now=new Date(asOf),today=baghdadDay(now.toISOString());
  const subjects=byId(get('subjects')),seasons=byId(get('stage_seasons')),stages=byId(get('stages'));
  const retired=new Set(get('lesson_corrections').map(r=>String(r.lesson_id)));
  const lessons=get('lessons').filter(l=>!retired.has(String(l.id))),lm=byId(get('lessons'));
  const posts=new Map(get('pending_channel_lesson_posts').map(p=>[key(p.telegram_chat_id,p.source_message_id),p]));
  const attendance=new Map();for(const a of get('attendance')){const k=String(a.lesson_id);if(!attendance.has(k))attendance.set(k,[]);attendance.get(k).push(a);}
  const result=[],mismatches=[],sameDay=[],unidentified=[],pending=[],integrity=[];
  for(const ss of get('stage_seasons')){
    const stage=stages.get(String(ss.stage_id));
    const stageSubjects=get('subjects').filter(s=>String(s.stage_id)===String(ss.stage_id));
    for(const sub of stageSubjects){
      const ls=lessons.filter(l=>String(l.stage_season_id)===String(ss.id)&&String(l.subject_id)===String(sub.id));
      const plan=get('lesson_schedule_entries').filter(e=>String(e.stage_season_id)===String(ss.id)&&String(e.subject_id)===String(sub.id));
      const scheduled=new Set(plan.map(e=>String(e.lesson_date).slice(0,10))),due=new Set([...scheduled].filter(d=>d<=today)),used=new Set(),groups=new Map();
      for(const l of ls){
        const date=l.schedule_date?String(l.schedule_date).slice(0,10):baghdadDay(l.activated_at);used.add(date);
        if(!groups.has(date))groups.set(date,[]);groups.get(date).push(l);
        if(l.source_message_id){
          const p=posts.get(key(l.source_chat_id,l.source_message_id)),matches=namedSubjects(stageSubjects,p?.content_text||'');
          const evidence={stageId:Number(ss.stage_id),stageSeasonId:Number(ss.id),lessonId:Number(l.id),subjectId:Number(sub.id),messageId:Number(l.source_message_id),attendance:(attendance.get(String(l.id))||[]).length};
          if(matches.length===1&&String(matches[0].id)!==String(sub.id))mismatches.push({...evidence,identifiedSubjectId:Number(matches[0].id)});
          else if(matches.length!==1)unidentified.push({...evidence,reason:p?'ambiguous_or_unnamed':'no_saved_content'});
        }
      }
      for(const [date,list] of groups)if(list.length>1)sameDay.push({stageId:Number(ss.stage_id),stageSeasonId:Number(ss.id),subjectId:Number(sub.id),date,
        lessons:list.map(l=>({id:Number(l.id),sourceType:l.source_type,messageId:l.source_message_id?Number(l.source_message_id):null,
          sourceLabel:(posts.get(key(l.source_chat_id,l.source_message_id))?.content_text||'').slice(0,512),
          attendance:(attendance.get(String(l.id))||[]).length}))});
      result.push({stageId:Number(ss.stage_id),stage:stage?.name||'',stageSeasonId:Number(ss.id),seasonId:Number(ss.season_id),subjectId:Number(sub.id),subject:sub.name,
        planned:plan.length,plannedDue:due.size,activated:ls.length,activatedToday:ls.filter(l=>baghdadDay(l.activated_at)===today).length,
        attendanceOpen:ls.filter(l=>instant(l.activated_at)<=now&&instant(l.active_until)>now).length,
        republished:ls.filter(l=>l.republished_at).length,recovered:ls.filter(l=>l.source_type==='channel_schedule_recovered').length,
        fallbacks:ls.filter(l=>l.source_type==='schedule_fallback').length,
        sameDayExtraCandidates:[...groups.values()].reduce((n,g)=>n+Math.max(0,g.length-1),0),
        outsideScheduleCandidates:ls.filter(l=>!scheduled.has(l.schedule_date?String(l.schedule_date).slice(0,10):baghdadDay(l.activated_at))).length,
        dueDatesWithoutLesson:[...due].filter(d=>!used.has(d)),attendanceRows:ls.reduce((n,l)=>n+(attendance.get(String(l.id))||[]).length,0)});
    }
  }
  for(const p of get('pending_channel_lesson_posts').filter(p=>p.status==='pending')){
    const matches=namedSubjects(get('subjects').filter(s=>String(s.stage_id)===String(p.stage_id)),p.content_text);
    pending.push({id:Number(p.id),stageId:Number(p.stage_id),stageSeasonId:Number(p.stage_season_id),messageId:Number(p.source_message_id),date:String(p.lesson_date).slice(0,10),kind:p.content_kind,identifiedSubjects:matches.map(s=>Number(s.id))});
  }
  for(const l of get('lessons'))if(subjects.get(String(l.subject_id))?.stage_id!==seasons.get(String(l.stage_season_id))?.stage_id)integrity.push({kind:'lesson_stage_mismatch',lessonId:Number(l.id)});
  const students=byId(get('students')),attempts=byId(get('exam_attempts')),exams=byId(get('exams')),questions=byId(get('exam_questions'));
  for(const a of get('attendance'))if(!students.has(String(a.student_id))||!lm.has(String(a.lesson_id)))integrity.push({kind:'orphan_attendance',id:Number(a.id)});
  for(const a of get('exam_answers'))if(!attempts.has(String(a.attempt_id))||!questions.has(String(a.question_id))||attempts.get(String(a.attempt_id))?.exam_id!==questions.get(String(a.question_id))?.exam_id)integrity.push({kind:'cross_exam_answer',id:Number(a.id)});
  for(const t of ['exams','student_reports','final_grades','mubahatha_groups','schedule_slots'])for(const r of get(t)){
    if(subjects.get(String(r.subject_id))?.stage_id!==seasons.get(String(r.stage_season_id))?.stage_id)integrity.push({kind:t+'_stage_mismatch',id:Number(r.id)});
  }
  const occupied=new Map(),examConflicts=[];
  for(const e of get('exams').filter(e=>e.status!=='cancelled')){
    const k=key(e.stage_season_id,baghdadDay(e.opens_at));if(occupied.has(k))examConflicts.push({stageSeasonId:Number(e.stage_season_id),date:baghdadDay(e.opens_at),exams:[Number(occupied.get(k)),Number(e.id)]});else occupied.set(k,e.id);
  }
  const summaries={stages:get('stages').length,stageSeasons:get('stage_seasons').length,seasons:get('seasons').length,subjects:get('subjects').length,
    rawLessons:get('lessons').length,effectiveLessons:lessons.length,attendance:get('attendance').length,discussionAttendance:get('mubahatha_attendance').length,
    reports:get('student_reports').length,exams:exams.size,attempts:attempts.size,answers:get('exam_answers').length,finalGrades:get('final_grades').length,
    sourceSubjectMismatchCandidates:mismatches.length,unidentifiedSourceLessons:unidentified.length,sameDayGroups:sameDay.length,pendingPosts:pending.length,integrityIssues:integrity.length,examConflicts:examConflicts.length};
  return {asOf:now.toISOString(),policy:'READ_ONLY_CANDIDATES_REQUIRE_LECTURE_EVIDENCE',summary:summaries,subjects:result,sourceSubjectMismatchCandidates:mismatches,
    unidentifiedSourceLessons:unidentified,sameDayCandidates:sameDay,pendingReview:pending,integrityIssues:integrity,examConflicts};
}
async function auditArchive(file){
  const wanted=new Set(['stages','stage_seasons','seasons','subjects','lessons','lesson_corrections','lesson_schedule_entries','pending_channel_lesson_posts','attendance','students','mubahatha_attendance','student_reports','exams','exam_attempts','exam_questions','exam_answers','final_grades','mubahatha_groups','schedule_slots']);
  const tables={};const checked=await readArchive(file,{onRow(r,t){
    if(!wanted.has(r.table))return;
    const row=Object.fromEntries(t.columns.map((c,i)=>[c.name,r.values[i]]));
    if(!tables[r.table])tables[r.table]=[];tables[r.table].push(row);
  }});
  return {...auditSnapshot(tables,{asOf:checked.metadata.createdAt}),archive:{createdAt:checked.metadata.createdAt,checksum:checked.summary.sha256,counts:checked.summary.counts}};
}
module.exports={auditSnapshot,auditArchive};
