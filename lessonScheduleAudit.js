'use strict';

// Pure comparison: reporting never changes existing lessons or attendance records.
function summarizeLessonScheduleAudit(stageSeasonId, summaries, lessons) {
  const byId = new Map(summaries.map(sub => [Number(sub.subject_id), {
    ...sub,
    planned_count: Number(sub.planned_count),
    activated_count: Number(sub.activated_count),
    matched_count: 0,
    outside_count: 0,
    repeated_count: 0,
    missing_count: 0,
    exceptions: []
  }]));
  for (const lesson of lessons) {
    const sub=byId.get(Number(lesson.subject_id));
    if(!sub)continue;
    const row={...lesson,id:Number(lesson.id),day_order:Number(lesson.day_order),attendance_count:Number(lesson.attendance_count)};
    if(row.day_order>1) {
      row.issue='repeated_day';sub.repeated_count++;sub.exceptions.push(row);
    } else if(!row.in_schedule) {
      row.issue='outside_schedule';sub.outside_count++;sub.exceptions.push(row);
    } else {
      sub.matched_count++;
    }
  }
  for(const sub of byId.values())sub.missing_count=Math.max(0,sub.planned_count-sub.matched_count);
  return {stage_season_id:stageSeasonId,subjects:[...byId.values()]};
}

module.exports={summarizeLessonScheduleAudit};
