'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {testDatabase}=require('./helpers.cjs');
let db,studies;
test.before(async()=>{({db,studies}=await testDatabase());});
test.after(async()=>{if(db)await db.pool.end();});

test('one exam per Baghdad calendar day across subjects in one stage-season, not across stages',async()=>{
  const stageA=await db.addStage('مرحلة اختبار تقويم الامتحانات أ');
  const stageB=await db.addStage('مرحلة اختبار تقويم الامتحانات ب');
  const subA=await db.addSubject(stageA.id,'العقائد','عقائد');
  const subB=await db.addSubject(stageA.id,'الفقه','فقه');
  const subC=await db.addSubject(stageB.id,'المنطق','منطق');
  const seasonA=(await db.listStageSeasons(stageA.id))[0].id;
  const seasonB=(await db.listStageSeasons(stageB.id))[0].id;
  const dateIso='2031-06-12';
  const exam=await studies.createExam(subA.id,seasonA,null,{examNumber:1,title:'العقائد الأول',dateIso,hours:24});
  await assert.rejects(()=>studies.createExam(subB.id,seasonA,null,{examNumber:1,title:'الفقه الأول',dateIso,hours:24}),
    err=>err.code==='EXAM_STAGE_SAME_DAY'&&/العقائد/.test(err.message));
  const elsewhere=await studies.createExam(subC.id,seasonB,null,{examNumber:1,title:'المنطق الأول',dateIso,hours:24});
  assert.ok(elsewhere.id);
  const other=await studies.createExam(subB.id,seasonA,null,{examNumber:1,title:'الفقه الأول',dateIso:'2031-06-13',hours:24});
  await assert.rejects(()=>studies.updateExam(other.id,{title:other.title,dateIso,hours:24}),{code:'EXAM_STAGE_SAME_DAY'});
  await assert.rejects(()=>studies.postponeExam(other.id,dateIso,24),{code:'EXAM_STAGE_SAME_DAY'});
  await studies.cancelExam(exam.id,42);
  const updated=await studies.updateExam(other.id,{title:other.title,dateIso,hours:24});
  assert.equal(updated.id,other.id);
});
