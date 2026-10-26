'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chooseSubject}=require('../scheduledPublication');
const {PAIRS,KEY}=require('../aqeedah20261026Repair');
const subjects=[
  {id:18,name:'عقائد الباب الحادي عشر - مستوى1',hashtag:'العقائد'},
  {id:19,name:'مسائل معاملات مستوى 1',hashtag:'الفقه'},
  {id:20,name:'المنطق ج2 - مستوى 1',hashtag:'المنطق'},
];
test('anonymous MP3 22 does not automatically become عقائد if three subjects are scheduled',()=>{
  assert.equal(chooseSubject(subjects,'المرحلة الثانية مقدمات - المستوى الأول /lesson/1533 22.mp3',subjects,{singleScheduledSubject:false}),null);
});
test('even the last unoccupied slot on a multi-subject day must not be inferred from an anonymous file',()=>{
  assert.equal(chooseSubject([subjects[0]],'22.mp3',subjects,{singleScheduledSubject:false}),null);
});
test('named aqeedah lesson 11 is identified regardless of timetable ordering',()=>{
  assert.equal(chooseSubject(subjects,'عقائد الباب الحادي عشر - الدرس 11.mp3',subjects)?.id,18);
});
test('a named lesson never steals a different subject slot',()=>{
  assert.equal(chooseSubject([subjects[2]],'عقائد الباب الحادي عشر - الدرس 11.mp3',subjects),null);
});
test('even one scheduled subject cannot identify an anonymous recording',()=>{
  assert.equal(chooseSubject([subjects[0]],'تسجيل صوتي.mp3',subjects,{singleScheduledSubject:true}),null);
});
test('ambiguously named file with multiple subjects remains unassigned',()=>{
  assert.equal(chooseSubject(subjects,'العقائد والمنطق',subjects),null);
});
test('repair is limited to the nine reviewed unidentified posts in one stage season',()=>{
  assert.equal(PAIRS.length,9);assert.equal(new Set(PAIRS.map(x=>x.day)).size,9);
  assert.deepEqual(PAIRS.map(x=>x.wrong),[169,205,299,377,431,504,597,667,748]);
  assert.equal(PAIRS.at(-1).namedMessage,286);
  assert.match(KEY,/stage4-season5/);
});
