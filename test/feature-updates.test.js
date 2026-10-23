'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createBroadcasts}=require('../broadcasts');
const {createExamNotifications}=require('../examNotifications');
const {windowDates}=require('../adminOverrides');

test('media broadcasts use the same transactional queued delivery and distinct Telegram method',async()=>{
  for(const media of [null,{kind:'photo',fileId:'photo-file-id-1'},{kind:'video',fileId:'video-file-id-2'}]){
    const inserted=[];
    const client={async query(sql,params){
      if(sql.includes('SELECT DISTINCT st.id'))return {rows:[{id:11,telegram_id:111111},{id:12,telegram_id:222222}]};
      if(sql.includes('INSERT INTO message_broadcasts'))return {rows:[{id:90,recipient_count:2}]};
      if(sql.includes('INSERT INTO notification_outbox')){inserted.push({sql,params});return {rowCount:2};}
      return {rows:[],rowCount:0};
    },release(){}};
    const pool={connect:async()=>client};
    const result=await createBroadcasts(pool).send({id:42,role:'admin'},{kind:'all'},'تجربة','key-for-test-'+(media?.kind||'text'),media);
    assert.equal(result.recipientCount,2);
    assert.equal(inserted.length,1);
    assert.match(inserted[0].sql,/r\.chat_id,\$5,\$2::jsonb/);
    const method=inserted[0].params[4];
    assert.equal(method,media?'send'+media.kind[0].toUpperCase()+media.kind.slice(1):'sendMessage');
    const payload=JSON.parse(inserted[0].params[1]);
    if(media){assert.equal(payload[0],media.fileId);assert.match(payload[1].caption,/تجربة/);}
    else assert.match(payload[0],/تجربة/);
  }
});

test('exam start and reminder outbox include a direct answer button with dedupe and one-hour bound',async()=>{
  const attempts=[];
  const pool={query:async(sql,params)=>{
    if(sql.startsWith('SELECT e.id'))return {rows:[{id:7,exam_number:1,title:'شهري',subject_name:'الفقه',stage_season_id:5,
      opens_at:new Date(Date.now()-1000*3600),closes_at:new Date(Date.now()+1000*1200)}]};
    if(sql.includes('INSERT INTO notification_outbox')){attempts.push({sql,params});return {rowCount:2};}
    if(sql.includes('FROM exam_student_windows w\n'))return {rows:[]};
    throw Error('Unexpected query: '+sql);
  }};
  assert.equal(await createExamNotifications(pool).tick(),4);
  assert.equal(attempts.length,2);
  assert.equal(attempts[0].params[6],true);
  assert.equal(attempts[1].params[5],true);
  for(const notice of attempts){
    const payload=JSON.parse(notice.params[1]);
    assert.equal(payload[1].reply_markup.inline_keyboard[0][0].callback_data,'stex_start:7');
    assert.match(notice.sql,/ON CONFLICT\(dedupe_key\) DO NOTHING/);
  }
});

test('Baghdad admin-selected dates are converted to their real UTC instants',()=>{
  const {start,end}=windowDates({opensAt:'2026-10-24T08:30:00+03:00',closesAt:'2026-10-24T10:00:00+03:00'});
  assert.equal(start.toISOString(),'2026-10-24T05:30:00.000Z');
  assert.equal(end.toISOString(),'2026-10-24T07:00:00.000Z');
  assert.throws(()=>windowDates({opensAt:'2026-10-24T10:00+03:00',closesAt:'2026-10-24T08:00+03:00'}));
});
