'use strict';
const {appError}=require('./integrity');
const defaultPlan=require('./scheduleBatchPlan.json');
const ACTION='one_time_schedule_import_2026_09_24';
const DAYS=[6,0,1,2,3];
const TIMES=DAYS.flatMap(dayOfWeek=>[19,20].map(hour=>({dayOfWeek,hour,minute:0})));

function validatePlan(plan){
  if(!Array.isArray(plan.rows)||!Array.isArray(plan.slots)||!plan.rows.length||plan.slots.length!==plan.rows.reduce((n,r)=>n+2*r.groupCount,0))
    throw Error('Invalid schedule plan');
  const rowMap=new Map(plan.rows.map(r=>[r.workbookRow,r]));
  if(rowMap.size!==plan.rows.length)throw Error('Duplicate source row');
  const groups=new Map(),teachers=new Set(),cohorts=new Set();
  for(const s of plan.slots){
    const r=rowMap.get(s.workbookRow);
    if(!r||r.subjectId!==s.subjectId||r.teacherId!==s.teacherId||r.seasonId!==s.seasonId||
      !Number.isSafeInteger(s.groupId)||s.groupNumber<1||s.groupNumber>r.groupCount||
      !TIMES.some(t=>t.dayOfWeek===s.dayOfWeek&&t.hour===s.hour&&t.minute===s.minute))throw Error('Invalid schedule slot');
    const groupKey=`${s.groupId}`;
    const group=groups.get(groupKey)||[];group.push(s);groups.set(groupKey,group);
    const time=`${s.dayOfWeek}:${s.hour}`;
    const teacherKey=`${s.teacherId}:${time}`,cohortKey=`${s.seasonId}:${s.groupNumber}:${time}`;
    if(teachers.has(teacherKey)||cohorts.has(cohortKey))throw Error('Schedule plan contains a conflict');
    teachers.add(teacherKey);cohorts.add(cohortKey);
  }
  if([...groups.values()].some(slots=>slots.length!==2||slots[0].dayOfWeek===slots[1].dayOfWeek))
    throw Error('Each group needs two different days');
}

function createScheduleBatchImport(pool,{plan=defaultPlan,action=ACTION}={}){
  validatePlan(plan);
  const seasonIds=[...new Set(plan.rows.map(r=>r.seasonId))];
  const teacherIds=[...new Set(plan.rows.map(r=>r.teacherId))];
  const groupIds=[...new Set(plan.slots.map(s=>s.groupId))];
  const rowByGroup=new Map(plan.slots.map(s=>[s.groupId,plan.rows.find(r=>r.workbookRow===s.workbookRow)]));

  async function completed(c){
    return Boolean((await c.query(`SELECT 1 FROM admin_audit_log WHERE action=$1 LIMIT 1`,[action])).rows[0]);
  }
  async function inspect(c){
    const errors=[];
    const seasons=(await c.query(`SELECT ss.id,ss.stage_id,ss.is_active,ss.discussion_grouping,st.name AS stage_name
      FROM stage_seasons ss JOIN stages st ON st.id=ss.stage_id WHERE ss.id=ANY($1::int[])`,[seasonIds])).rows;
    const subjects=(await c.query('SELECT id,stage_id,name FROM subjects WHERE id=ANY($1::int[])',[plan.rows.map(r=>r.subjectId)])).rows;
    const teachers=(await c.query('SELECT id,full_name,is_active FROM teachers WHERE id=ANY($1::int[])',[teacherIds])).rows;
    const groups=(await c.query(`SELECT g.id,g.subject_id,g.stage_season_id,g.group_number,g.is_active,g.merged_into_id,
      participation_enabled(g.subject_id,g.stage_season_id) AS enabled
      FROM mubahatha_groups g WHERE g.id=ANY($1::int[])`,[groupIds])).rows;
    for(const r of plan.rows){
      const ss=seasons.find(x=>Number(x.id)===r.seasonId);
      const sub=subjects.find(x=>Number(x.id)===r.subjectId);
      const teacher=teachers.find(x=>Number(x.id)===r.teacherId);
      if(!ss||!ss.is_active||ss.stage_name!==r.stageName||!sub||Number(sub.stage_id)!==Number(ss.stage_id)||sub.name!==r.subjectName)
        errors.push(`تغيّرت المرحلة أو المادة المرتبطة بالسطر ${r.workbookRow} من الإكسل.`);
      if(!teacher||!teacher.is_active||teacher.full_name!==r.teacherName)
        errors.push(`الأستاذ المرتبط بالسطر ${r.workbookRow} غير متاح أو تغيّر اسمه.`);
      if(ss&&r.groupCount===1&&ss.discussion_grouping!==false)errors.push(`تنظيم المرحلة في السطر ${r.workbookRow} لم يعد «مرحلة كاملة».`);
      if(ss&&r.groupCount>1&&ss.discussion_grouping!==true)errors.push(`تنظيم المرحلة في السطر ${r.workbookRow} لم يعد مقسمًا.`);
    }
    for(const id of groupIds){
      const g=groups.find(x=>Number(x.id)===id),row=rowByGroup.get(id);
      const planned=plan.slots.find(s=>s.groupId===id);
      if(!g||!g.is_active||g.merged_into_id!=null||!g.enabled||Number(g.subject_id)!==row.subjectId||
        Number(g.stage_season_id)!==row.seasonId||Number(g.group_number)!==planned.groupNumber)
        errors.push(`المجموعة المرتبطة بالسطر ${row.workbookRow} تغيّرت أو توقفت.`);
    }
    const existing=(await c.query(`SELECT sl.id FROM schedule_slots sl JOIN stage_seasons ss ON ss.id=sl.stage_season_id AND ss.is_active=true
      WHERE sl.is_active=true AND (sl.stage_season_id=ANY($1::int[]) OR sl.teacher_id=ANY($2::int[])) LIMIT 1`,[seasonIds,teacherIds])).rows[0];
    if(existing)errors.push('وُجد موعد مباحثة نشط أُضيف بعد النسخة المرفقة. يلزم إعادة تخطيط الدفعة قبل إدخالها.');
    const assignments=(await c.query(`SELECT subject_id,stage_season_id,teacher_id FROM teaching_assignments
      WHERE stage_season_id=ANY($1::int[])`,[seasonIds])).rows;
    const toAdd=plan.rows.filter(r=>!assignments.some(a=>Number(a.subject_id)===r.subjectId&&Number(a.stage_season_id)===r.seasonId&&Number(a.teacher_id)===r.teacherId));
    const otherAssignments=plan.rows.flatMap(r=>assignments.filter(a=>Number(a.subject_id)===r.subjectId&&Number(a.stage_season_id)===r.seasonId&&Number(a.teacher_id)!==r.teacherId)
      .map(a=>({workbookRow:r.workbookRow,subject:r.subjectName,teacherId:Number(a.teacher_id),
        teacherName:teachers.find(t=>Number(t.id)===Number(a.teacher_id))?.full_name||`الأستاذ رقم ${a.teacher_id}`})));
    return {errors,toAdd,otherAssignments};
  }
  async function availability(c,planned=false){
    const slots=planned?plan.slots:(await c.query(`SELECT teacher_id,day_of_week AS "dayOfWeek",hour,minute FROM schedule_slots sl
      JOIN stage_seasons ss ON ss.id=sl.stage_season_id AND ss.is_active=true
      WHERE sl.is_active=true AND sl.teacher_id=ANY($1::int[])`,[teacherIds])).rows;
    return plan.rows.filter((r,i,all)=>all.findIndex(x=>x.teacherId===r.teacherId)===i).map(r=>({teacherId:r.teacherId,teacherName:r.teacherName,
      used:slots.filter(s=>Number(s.teacherId??s.teacher_id)===r.teacherId).length,
      free:TIMES.filter(t=>!slots.some(s=>Number(s.teacherId??s.teacher_id)===r.teacherId&&Number(s.dayOfWeek)===t.dayOfWeek&&Number(s.hour)===t.hour&&Number(s.minute)===t.minute))}));
  }
  async function status(){
    const done=await completed(pool);
    if(done)return {completed:true,available:false,appointments:plan.slots.length,teacherAvailability:await availability(pool)};
    const review=await inspect(pool);
    return {completed:false,available:review.errors.length===0,errors:review.errors,
      sourceRows:plan.rows.length,groups:groupIds.length,appointments:plan.slots.length,
      assignmentsToAdd:review.toAdd.length,otherAssignments:review.otherAssignments,
      mapping:plan.rows.map(r=>({workbookRow:r.workbookRow,workbookSubject:r.workbookSubject,
        stageName:r.stageName,subjectName:r.subjectName,teacherName:r.teacherName})),
      plannedAvailability:await availability(pool,true)};
  }
  async function execute(actorId){
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      await c.query('SELECT id FROM stage_seasons WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE',[seasonIds]);
      await c.query('SELECT pg_advisory_xact_lock(734222,1)');
      if(await completed(c))throw appError('استُخدم زر إدخال الجداول سابقًا.','CONFLICT',409);
      const review=await inspect(c);
      if(review.errors.length)throw appError(review.errors.join(' '),'SCHEDULE_CONFLICT',409);
      let addedAssignments=0;
      for(const r of review.toAdd){
        const inserted=await c.query(`INSERT INTO teaching_assignments(teacher_id,subject_id,stage_season_id)
          VALUES($1,$2,$3) ON CONFLICT(subject_id,stage_season_id,teacher_id) DO NOTHING RETURNING id`,[r.teacherId,r.subjectId,r.seasonId]);
        addedAssignments+=inserted.rowCount;
      }
      for(const s of plan.slots)await c.query(`INSERT INTO schedule_slots
        (group_id,subject_id,stage_season_id,teacher_id,day_of_week,hour,minute,duration_hours,is_active)
        VALUES($1,$2,$3,$4,$5,$6,$7,1,true)`,[s.groupId,s.subjectId,s.seasonId,s.teacherId,s.dayOfWeek,s.hour,s.minute]);
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,$2,'schedule',$3,$4::jsonb,$5::jsonb)`,[actorId,action,Number(plan.rows[0].seasonId),
        JSON.stringify({workbook_sha256:plan.sourceWorkbookSha256,backup_created_at:plan.sourceBackupCreatedAt}),
        JSON.stringify({source_rows:plan.rows.length,groups:groupIds.length,appointments:plan.slots.length,added_assignments:addedAssignments})]);
      await c.query('COMMIT');
      return {appointments:plan.slots.length,groups:groupIds.length,addedAssignments};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  return {status,execute};
}
module.exports={createScheduleBatchImport,validatePlan,TIMES};
