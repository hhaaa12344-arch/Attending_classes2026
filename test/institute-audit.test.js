'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {auditSnapshot}=require('../instituteAudit');
test('all-season audit distinguishes legitimate same-day lectures, timetable dates, open windows and republication without altering records',()=>{
  const tables={stages:[{id:'1',name:'مرحلة أ'},{id:'2',name:'مرحلة ب'}],stage_seasons:[{id:'3',stage_id:'1',season_id:'1'},{id:'4',stage_id:'2',season_id:'1'}],seasons:[{id:'1'}],
    subjects:[{id:'5',stage_id:'1',name:'العقائد',hashtag:'العقائد'},{id:'6',stage_id:'2',name:'المنطق',hashtag:'المنطق'}],
    lessons:[{id:'10',subject_id:'5',stage_season_id:'3',activated_at:'2026-10-25 06:00:00',active_until:'2026-10-26 06:00:00',source_type:'channel',source_chat_id:'-1001',source_message_id:'50',schedule_date:'2026-10-25'},
      {id:'11',subject_id:'5',stage_season_id:'3',activated_at:'2026-10-25 07:00:00',active_until:'2026-10-27 07:00:00',source_type:'channel',source_chat_id:'-1001',source_message_id:'51',schedule_date:'2026-10-25',republished_at:'2026-10-26 07:00:00'}],
    lesson_schedule_entries:[{stage_season_id:'3',subject_id:'5',lesson_date:'2026-10-25'},{stage_season_id:'3',subject_id:'5',lesson_date:'2026-10-28'}],
    pending_channel_lesson_posts:[{id:'1',stage_id:'1',stage_season_id:'3',telegram_chat_id:'-1001',source_message_id:'50',content_text:'عقائد الدرس 7',status:'activated'},
      {id:'2',stage_id:'1',stage_season_id:'3',telegram_chat_id:'-1001',source_message_id:'51',content_text:'عقائد الدرس 8',status:'activated'}],
    attendance:[{id:'1',lesson_id:'10',student_id:'90'}],students:[{id:'90',full_name:'PRIVATE STUDENT',telegram_id:'SECRET'}]};
  const before=JSON.stringify(tables),audit=auditSnapshot(tables,{asOf:'2026-10-26T09:00:00Z'}),a=audit.subjects[0];
  assert.equal(audit.summary.stages,2);assert.equal(audit.subjects.length,2);assert.equal(a.planned,2);assert.equal(a.plannedDue,1);assert.equal(a.activated,2);
  assert.equal(a.attendanceOpen,1);assert.equal(a.activatedToday,0);assert.equal(a.republished,1);assert.deepEqual(a.dueDatesWithoutLesson,[]);
  assert.equal(a.sameDayExtraCandidates,1);assert.equal(audit.sameDayCandidates[0].lessons[1].sourceLabel,'عقائد الدرس 8');
  assert.equal(audit.summary.integrityIssues,0);assert.equal(audit.summary.sourceSubjectMismatchCandidates,0);
  assert.equal(JSON.stringify(tables),before);assert.doesNotMatch(JSON.stringify(audit),/PRIVATE STUDENT|SECRET/);
});
