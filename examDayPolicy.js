'use strict';

// جميع مواد موسم المرحلة تتشارك تقويم امتحانات واحدًا (بتوقيت بغداد).
// التحقق الأولي للواجهات لا يغني عن القفل داخل عملية الحفظ.
const {appError}=require('./integrity');

function validateExamDate(dateIso){
  if(typeof dateIso!=='string'||!/^(\d{4})-(\d{2})-(\d{2})$/.test(dateIso)||
     Number.isNaN(Date.parse(`${dateIso}T00:00:00Z`))||
     new Date(`${dateIso}T00:00:00Z`).toISOString().slice(0,10)!==dateIso)
    throw appError('تاريخ الامتحان غير صالح.');
}

async function findExamDayConflict(queryable,stageSeasonId,dateIso,exceptId=null){
  validateExamDate(dateIso);
  const row=(await queryable.query(`SELECT e.id, e.exam_number, e.subject_id, sub.name AS subject_name
    FROM exams e JOIN subjects sub ON sub.id=e.subject_id
    WHERE e.stage_season_id=$1 AND e.status<>'cancelled'
      AND (e.opens_at + interval '3 hours')::date=$2::date
      AND ($3::int IS NULL OR e.id<>$3)
    ORDER BY e.id LIMIT 1`,[stageSeasonId,dateIso,exceptId])).rows[0];
  return row||null;
}

function examDayConflictMessage(conflict,dateIso){
  return `لا يمكن اختيار ${dateIso}؛ يوجد امتحان لمادة «${conflict.subject_name}» (الامتحان رقم ${conflict.exam_number}) في اليوم نفسه ضمن هذه المرحلة. اختر تاريخًا آخر.`;
}

async function assertExamDayFree(client,subjectId,stageSeasonId,dateIso,exceptId=null){
  validateExamDate(dateIso);
  // القفل بحسب *موسم المرحلة* لا بحسب المادة، حتى لا تستطيع مادتان حجز اليوم بالتزامن.
  await client.query('SELECT pg_advisory_xact_lock($1::int,$2::int)',[207117,Number(stageSeasonId)]);
  const conflict=await findExamDayConflict(client,stageSeasonId,dateIso,exceptId);
  if(conflict)throw appError(examDayConflictMessage(conflict,dateIso),'EXAM_STAGE_SAME_DAY',409);
}

module.exports={validateExamDate,findExamDayConflict,examDayConflictMessage,assertExamDayFree};
