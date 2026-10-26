'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {findExamDayConflict,assertExamDayFree,examDayConflictMessage}=require('../examDayPolicy');

test('a different subject in the same stage season blocks the chosen day',async()=>{
  const calls=[];
  const db={async query(sql,params){calls.push({sql,params});
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[]};
    return {rows:[{id:19,exam_number:2,subject_id:202,subject_name:'الفقه'}]};
  }};
  await assert.rejects(
    ()=>assertExamDayFree(db,101,3,'2030-04-11'),
    err=>err.code==='EXAM_STAGE_SAME_DAY'&&/الفقه/.test(err.message)&&/2030-04-11/.test(err.message)
  );
  assert.deepEqual(calls[0].params,[207117,3]); // lock is per stage-season, not per subject
  assert.match(calls[1].sql,/e\.stage_season_id=\$1/);
  assert.doesNotMatch(calls[1].sql,/e\.subject_id=\$1/);
  assert.deepEqual(calls[1].params,[3,'2030-04-11',null]);
});

test('editing an exam excludes only itself, while cancellations do not hold dates',async()=>{
  const seen=[];
  const db={async query(sql,params){seen.push({sql,params});return {rows:[]};}};
  assert.equal(await findExamDayConflict(db,3,'2030-04-11',19),null);
  assert.deepEqual(seen[0].params,[3,'2030-04-11',19]);
  assert.match(seen[0].sql,/e.status<>\'cancelled\'/);
  assert.match(seen[0].sql,/e.id<>\$3/);
});

test('dates are validated, and no collision permits another stage',async()=>{
  const db={async query(){return {rows:[]};}};
  await assertExamDayFree(db,501,99,'2030-04-11');
  await assert.rejects(()=>findExamDayConflict(db,99,'2030-02-30'),/تاريخ الامتحان غير صالح/);
  assert.match(examDayConflictMessage({subject_name:'العقائد',exam_number:1},'2030-04-11'),/العقائد/);
});
