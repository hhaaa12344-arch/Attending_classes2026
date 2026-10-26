'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {summarizeLessonScheduleAudit}=require('../lessonScheduleAudit');

test('11 planned appointments and 19 activated lessons are reconciled without suppressing student attendance',()=>{
  const summaries=[{subject_id:3,subject_name:'العقائد',planned_count:11,activated_count:19}];
  const lessons=[];
  for(let day=1;day<=11;day++)lessons.push({id:day,subject_id:3,lesson_date:`2026-10-${String(day).padStart(2,'0')}`,in_schedule:true,day_order:1,attendance_count:12});
  for(let day=12;day<=17;day++)lessons.push({id:day,subject_id:3,lesson_date:`2026-10-${day}`,in_schedule:false,day_order:1,attendance_count:8});
  lessons.push({id:18,subject_id:3,lesson_date:'2026-10-01',in_schedule:true,day_order:2,attendance_count:7});
  lessons.push({id:19,subject_id:3,lesson_date:'2026-10-02',in_schedule:true,day_order:2,attendance_count:4});
  const audit=summarizeLessonScheduleAudit(33,summaries,lessons);
  const item=audit.subjects[0];
  assert.equal(item.planned_count,11);assert.equal(item.activated_count,19);
  assert.equal(item.matched_count,11);assert.equal(item.outside_count,6);
  assert.equal(item.repeated_count,2);assert.equal(item.missing_count,0);
  assert.equal(item.exceptions.length,8);
  assert.equal(item.exceptions.find(x=>x.id===18).attendance_count,7);
});

test('missing calendar appointments and extra lessons are different conditions',()=>{
  const r=summarizeLessonScheduleAudit(10,[{subject_id:1,subject_name:'الفقه',planned_count:3,activated_count:2}],
    [{id:2,subject_id:1,in_schedule:false,day_order:1,attendance_count:0},
     {id:3,subject_id:1,in_schedule:true,day_order:1,attendance_count:2}]);
  assert.equal(r.subjects[0].missing_count,2);
  assert.equal(r.subjects[0].outside_count,1);
  assert.equal(r.subjects[0].matched_count,1);
});

test('classification ignores irrelevant season subjects and never mutates inputs',()=>{
  const subjects=[{subject_id:1,subject_name:'الفقه',planned_count:1,activated_count:1}];
  const lessons=[{id:1,subject_id:1,in_schedule:true,day_order:1,attendance_count:4},{id:9,subject_id:2,in_schedule:false,day_order:1,attendance_count:0}];
  const r=summarizeLessonScheduleAudit(10,subjects,lessons);
  assert.equal(r.subjects.length,1);
  assert.equal(r.subjects[0].outside_count,0);
  assert.equal(lessons[0].issue,undefined);
});
