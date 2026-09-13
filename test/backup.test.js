'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const zlib=require('node:zlib');
const {testDatabase}=require('./helpers.cjs');
const {exportArchive,readArchive,restoreArchive,schemaInfo}=require('../backupArchive');
const {initBackupSchema,createBackups,baghdadDate}=require('../backups');
let db,studies,archive,dir;
test.before(async()=>{
  ({db,studies}=await testDatabase());
  await require('../instituteLinks').createInstituteLinks(db.pool).initSchema();
  await initBackupSchema(db.pool);
  dir=await fs.mkdtemp(path.join(os.tmpdir(),'backup-tests-'));
});
test.after(async()=>{if(archive)await archive.cleanup();await fs.rm(dir,{recursive:true,force:true});await db.pool.end();});
test('archive: complete valid JSON, gzip, all tables, exact bigint/decimal/JSON/Unicode/microseconds',async()=>{
  const stage=await db.addStage('مرحلة النسخ');
  const subject=await db.addSubject(stage.id,'الفقه','فقه');
  const student=await db.createStudent(99001,'طالب النسخة الاحتياطية',stage.id);
  const lesson=await db.activateLesson(subject.id,24);
  await db.pool.query('INSERT INTO attendance(student_id,lesson_id) VALUES($1,$2)',[student.id,lesson.id]);
  await db.pool.query(`CREATE TABLE backup_precision_test(id BIGSERIAL PRIMARY KEY,amount NUMERIC(30,9),text_value TEXT,
    precise_time TIMESTAMP,json_value JSONB,bytes BYTEA,items TEXT[],nullable TEXT);
    INSERT INTO backup_precision_test(id,amount,text_value,precise_time,json_value,bytes,items) VALUES
    (9007199254740993,123456789012345678901.123456789,'عربي 👋\nسطر ثان','2026-09-13 12:34:56.123456','{"n":9007199254740993}',decode('00ff01','hex'),ARRAY['أ','ب']);`);
  const c=await db.pool.connect();try{archive=await exportArchive(c);}finally{c.release();}
  const parsed=JSON.parse(zlib.gunzipSync(await fs.readFile(archive.file)));
  const r=parsed.rows.find(r=>r.table==='backup_precision_test');
  assert.equal(r.values[0],'9007199254740993');assert.equal(r.values[1],'123456789012345678901.123456789');
  assert.equal(r.values[3],'2026-09-13 12:34:56.123456');assert.ok(r.values[4].includes('9007199254740993'));
  assert.ok(parsed.rows.some(r=>r.table==='attendance'));
  assert.equal(parsed.metadata.tables.length,(await schemaInfo(db.pool)).tables.length);
  assert.ok(parsed.metadata.tables.some(t=>t.name==='backup_control'));
});
test('archive: truncated gzip, altered rows and oversized uploads are rejected',async()=>{
  const data=await fs.readFile(archive.file),bad=path.join(dir,'bad.gz');
  await fs.writeFile(bad,data.subarray(0,data.length-10));await assert.rejects(()=>readArchive(bad));
  const raw=zlib.gunzipSync(data).toString().replace('عربي','معدل');
  await fs.writeFile(bad,zlib.gzipSync(raw));await assert.rejects(()=>readArchive(bad),/checksum/);
  const c=await db.pool.connect();try{await assert.rejects(()=>exportArchive(c,{maxUpload:1}),/حد رفع/);}finally{c.release();}
});
test('restore: refuses populated database; exact round-trip, foreign keys and sequence recovery',async()=>{
  const c=await db.pool.connect();
  try {
    await assert.rejects(()=>restoreArchive(c,archive.file),/فارغة/);
    const before=(await c.query('SELECT row_to_json(t)::text AS data FROM backup_precision_test t')).rows[0].data;
    // This is an isolated test database; explicitly allow deletion of our fixture rows.
    await restoreArchive(c,archive.file,{allowSeedRows:true});
    assert.equal((await c.query('SELECT row_to_json(t)::text AS data FROM backup_precision_test t')).rows[0].data,before);
    assert.equal((await c.query('SELECT COUNT(*)::int AS n FROM attendance')).rows[0].n,1);
    const next=(await c.query("INSERT INTO backup_precision_test(text_value) VALUES('new') RETURNING id::text")).rows[0].id;
    assert.equal(next,'9007199254740994');
    assert.equal((await c.query('SELECT enabled FROM backup_control')).rows[0].enabled,false);
    await assert.rejects(()=>c.query('INSERT INTO attendance(student_id,lesson_id) VALUES(-1,-1)'),/foreign key/);
  }finally{c.release();}
});
test('Baghdad midnight rolls over at 21:00 UTC',()=>{
  assert.equal(baghdadDate(new Date('2026-09-13T20:59:59Z')),'2026-09-13');
  assert.equal(baghdadDate(new Date('2026-09-13T21:00:00Z')),'2026-09-14');
});
function fakeService(){
  const calls=[];let message=400,number=0,failEdit=null,hold=null;
  const telegram={
    sendMessage:async(chat,text)=>{calls.push(['text',chat,text]);return {message_id:++message};},
    editMessageMedia:async(chat,id,unused,media)=>{calls.push(['edit',chat,id,media]);if(failEdit)throw failEdit;return {message_id:id,document:{file_id:'file-'+(++number)}};},
    pinChatMessage:async(...args)=>{calls.push(['pin',...args]);}
  };
  let now=new Date('2026-09-13T20:59:00Z');
  const exporter=async()=>{calls.push(['export']);if(hold)await hold;return {file:'/mock.gz',filename:'backup.json.gz',size:100,metadata:{tables:[{}]},summary:{counts:{students:1000},sha256:'abc'},cleanup:async()=>calls.push(['cleanup'])};};
  const options={pool:db.pool,telegram,adminIds:[42,43],clock:()=>now,exporter,logger:{error(){}}};
  return {calls,options,service:createBackups(options),setNow:v=>{now=new Date(v);},fail:e=>{failEdit=e;},hold:p=>{hold=p;}};
}
test('service: explicit admin activation, initial backup, same-message daily update, restart dedupe',async()=>{
  const f=fakeService();assert.deepEqual(await f.service.run(),{disabled:true});
  await assert.rejects(()=>f.service.configure(99001,true),/مصرح/);
  await f.service.configure(42,true);assert.equal((await f.service.run()).success,true);
  const first=await f.service.status();assert.ok(first.file_id);assert.ok(first.message_id);
  assert.equal((await f.service.run()).current,true);
  const restarted=createBackups(f.options);assert.equal((await restarted.run()).current,true);
  f.setNow('2026-09-13T21:00:00Z');assert.equal((await restarted.run()).success,true);
  assert.equal((await restarted.status()).message_id,first.message_id);
  assert.equal(f.calls.filter(c=>c[0]==='edit').length,2);
  assert.equal(f.calls.filter(c=>c[0]==='text').length,1,'one permanent message only');
});
test('service: failures retain last file, persist retry, recover after outage, recreate only deleted message',async()=>{
  const f=fakeService();f.setNow('2026-09-14T21:00:00Z');
  const before=await f.service.status();
  f.fail(Object.assign(new Error('timeout'),{code:'ETIMEDOUT'}));
  assert.equal((await f.service.run()).failed,true);
  const after=await f.service.status();assert.equal(after.file_id,before.file_id);assert.equal(after.message_id,before.message_id);
  assert.equal((await f.service.run()).deferred,true);
  f.setNow('2026-09-14T21:06:00Z');f.fail(null);assert.equal((await f.service.run()).success,true);
  f.setNow('2026-09-15T21:00:00Z');
  // Fail only the first edit to simulate a user deleting the permanent message.
  const orig=f.options.telegram.editMessageMedia;let once=true;
  f.options.telegram.editMessageMedia=async(...args)=>{if(once){once=false;throw {response:{error_code:400,description:'Bad Request: message to edit not found'}};}return orig(...args);};
  assert.equal((await f.service.run()).success,true);
  assert.notEqual((await f.service.status()).message_id,before.message_id);
});
test('service: overlapping requests do not create concurrent exports; removed admin cannot receive data',async()=>{
  const f=fakeService();f.setNow('2026-09-16T21:00:00Z');let release;f.hold(new Promise(r=>{release=r;}));
  const first=f.service.run(true);assert.equal((await f.service.run(true)).busy,true);release();await first;
  const removed=createBackups({...f.options,adminIds:[43]});
  f.setNow('2026-09-17T21:00:00Z');assert.equal((await removed.run()).unauthorizedRecipient,true);
  const previous=await removed.status();await removed.configure(43,true);const moved=await removed.status();
  assert.equal(Number(moved.chat_id),43);assert.equal(moved.message_id,null);assert.ok(previous.message_id);
  assert.equal((await removed.run()).success,true);
  await removed.configure(43,false);assert.equal((await removed.run()).disabled,true);
});

if(process.env.TEST_DATABASE_URL)test('native PostgreSQL: 1000 students, 50 concurrent attendance writes, consistent snapshot and cross-worker lock',async()=>{
  const stage=(await db.pool.query('SELECT id FROM stages LIMIT 1')).rows[0];
  const lesson=(await db.pool.query('SELECT id FROM lessons LIMIT 1')).rows[0];
  const added=(await db.pool.query(`INSERT INTO students(telegram_id,full_name,stage_id)
    SELECT 80000000+n,'طالب اختبار '||n,$1 FROM generate_series(1,1000)n RETURNING id`,[stage.id])).rows;
  const before=Number((await db.pool.query('SELECT COUNT(*) AS n FROM attendance')).rows[0].n);
  const c=await db.pool.connect();let snapshot,interleaved=false;
  try{
    const wrapped={query:async(sql,args)=>{
      const result=await c.query(sql,args);
      if(sql==='FETCH FORWARD 100 FROM backup_rows'&&!interleaved){
        interleaved=true;
        await Promise.all(added.slice(0,50).map(st=>db.pool.query('INSERT INTO attendance(student_id,lesson_id) VALUES($1,$2)',[st.id,lesson.id])));
      }
      return result;
    }};
    snapshot=await exportArchive(wrapped);
    assert.equal(snapshot.summary.counts.attendance,before,'snapshot excludes all later concurrent commits');
    assert.ok(snapshot.summary.counts.students>=1000);
  }finally{c.release();if(snapshot)await snapshot.cleanup();}
  assert.equal(Number((await db.pool.query('SELECT COUNT(*) AS n FROM attendance')).rows[0].n),before+50);
  const f=fakeService();await f.service.configure(42,true);f.setNow('2026-10-01T21:00:00Z');
  let release,entered;const ready=new Promise(r=>{entered=r;});const hold=new Promise(r=>{release=r;});
  const exporter=async(...args)=>{entered();await hold;return f.options.exporter(...args);};
  const first=createBackups({...f.options,exporter}),second=createBackups(f.options);
  const pending=first.run(true);await ready;
  assert.equal((await second.run(true)).busy,true,'PostgreSQL advisory lock protects independent workers');
  release();assert.equal((await pending).success,true);
});

test('restore: a well-formed archive with broken relationships rolls back all data changes',async()=>{
  const parsed=JSON.parse(zlib.gunzipSync(await fs.readFile(archive.file)));
  const t=parsed.metadata.tables.find(t=>t.name==='attendance');
  parsed.rows.find(r=>r.table==='attendance').values[t.columns.findIndex(c=>c.name==='student_id')]='-999';
  const digest=require('node:crypto').createHash('sha256').update(JSON.stringify(parsed.metadata)+'\n');
  for(const row of parsed.rows)digest.update(JSON.stringify(row)+'\n');
  parsed.summary.sha256=digest.digest('hex');
  const raw='{\n"metadata":'+JSON.stringify(parsed.metadata)+',\n"rows":[\n'+parsed.rows.map((r,i)=>(i?',':'')+JSON.stringify(r)).join('\n')+'\n],\n"summary":'+JSON.stringify(parsed.summary)+'\n}\n';
  const file=path.join(dir,'bad-relationships.json.gz');await fs.writeFile(file,zlib.gzipSync(raw));
  const before=(await db.pool.query('SELECT COUNT(*)::int AS n FROM backup_precision_test')).rows[0].n;
  const c=await db.pool.connect();try{
    await assert.rejects(()=>restoreArchive(c,file,{allowSeedRows:true}),/foreign key/);
    assert.equal((await c.query('SELECT COUNT(*)::int AS n FROM backup_precision_test')).rows[0].n,before);
  }finally{c.release();}
});

test('1000 students and 50 queued attendance writes: snapshot stays consistent and all writes complete',async()=>{
  const stage=(await db.pool.query('SELECT id FROM stages LIMIT 1')).rows[0];
  const lesson=(await db.pool.query('SELECT id FROM lessons LIMIT 1')).rows[0];
  const added=(await db.pool.query(`INSERT INTO students(telegram_id,full_name,stage_id)
    SELECT 81000000+n,'طالب ضغط النسخ '||n,$1 FROM generate_series(1,1000)n RETURNING id`,[stage.id])).rows;
  const before=Number((await db.pool.query('SELECT COUNT(*) AS n FROM attendance')).rows[0].n);
  const c=await db.pool.connect();let snapshot,interleaved=false,writes;
  try{
    const wrapped={query:async(sql,args)=>{
      const result=await c.query(sql,args);
      if(sql==='FETCH FORWARD 100 FROM backup_rows'&&!interleaved){
        interleaved=true;
        writes=Promise.all(added.slice(0,50).map(st=>db.pool.query('INSERT INTO attendance(student_id,lesson_id) VALUES($1,$2)',[st.id,lesson.id])));
        writes.catch(()=>{});
        if(process.env.TEST_DATABASE_URL)await writes;
      }
      return result;
    }};
    snapshot=await exportArchive(wrapped);
    assert.equal(snapshot.summary.counts.attendance,before);
    assert.ok(snapshot.summary.counts.students>=1000);
  }finally{c.release();if(snapshot)await snapshot.cleanup();}
  await writes;
  assert.equal(Number((await db.pool.query('SELECT COUNT(*) AS n FROM attendance')).rows[0].n),before+50);
});

test('Telegram requests can be aborted on shutdown without an unbounded wait',async()=>{
  let signal;
  const telegram={callApi:async(method,payload,options)=>new Promise((resolve,reject)=>{
    signal=options.signal;signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});
  })};
  require('../backups').boundedTelegram(telegram);
  const request=telegram.callApi('editMessageMedia',{});
  telegram.abortPending();await assert.rejects(()=>request,/aborted/);assert.equal(signal.aborted,true);
});
