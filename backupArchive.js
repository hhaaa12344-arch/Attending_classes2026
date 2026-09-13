'use strict';
// Application data backup: valid streamed JSON, gzip, exact PostgreSQL text values.
// Restoration uses the trusted project's schema; no SQL from the archive is executed.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createGzip, createGunzip } = require('node:zlib');
const { createHash } = require('node:crypto');
const readline = require('node:readline');
const FORMAT = 'institute-postgres-json';
const MAX_RAW = 512 * 1024 * 1024;
const MAX_UPLOAD = 49 * 1024 * 1024;
const quote = s => '"' + String(s).replace(/"/g, '""') + '"';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw new Error(message); };

async function schemaInfo(c) {
  const schema = (await c.query('SELECT current_schema() AS name')).rows[0].name;
  const rows = (await c.query(`SELECT t.relname AS name, a.attname AS column, format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull AS required, a.attidentity AS identity, a.attgenerated AS generated
    FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname=$1 AND t.relkind IN ('r','p') AND NOT t.relispartition
    ORDER BY t.relname,a.attnum`, [schema])).rows;
  const tables = [];
  for (const r of rows) {
    let t = tables.at(-1);
    if (!t || t.name !== r.name) tables.push(t = { name:r.name, columns:[] });
    t.columns.push({ name:r.column, type:r.type, required:r.required, identity:r.identity, generated:r.generated });
  }
  return { schema, tables, schemaHash:hash(tables) };
}

async function exportArchive(c, { now = new Date(), maxUpload = MAX_UPLOAD } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'institute-backup-'));
  const filename = 'institute-backup-' + now.toISOString().replace(/[:.]/g,'-') + '.json.gz';
  const file = path.join(dir, filename);
  let transaction = false;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    await c.query("SET LOCAL DateStyle='ISO, YMD'");
    await c.query("SET LOCAL IntervalStyle='postgres'");
    await c.query("SET LOCAL bytea_output='hex'");
    const info = await schemaInfo(c);
    if (!info.tables.length) fail('لا توجد جداول لنسخها.');
    // Keep schema stable throughout the consistent snapshot; normal writes remain allowed.
    await c.query('LOCK TABLE ' + info.tables.map(t=>quote(info.schema)+'.'+quote(t.name)).join(',') + ' IN ACCESS SHARE MODE');
    const sequences = [];
    for (const t of info.tables) for (const col of t.columns) {
      const seq = (await c.query('SELECT pg_get_serial_sequence($1,$2) AS name', [quote(info.schema)+'.'+quote(t.name),col.name])).rows[0].name;
      if (!seq) continue;
      // The relation name comes from PostgreSQL, not the archive or a Telegram message.
      const value = (await c.query(`SELECT last_value::text AS value,is_called FROM ${seq}`)).rows[0];
      sequences.push({table:t.name,column:col.name,...value});
    }
    const metadata = { format:FORMAT, version:1, appVersion:require('./package.json').version,
      createdAt:now.toISOString(), timezone:'Asia/Baghdad', tables:info.tables, schemaHash:info.schemaHash, sequences };
    const digest = createHash('sha256'); digest.update(JSON.stringify(metadata)+'\n');
    const counts = Object.fromEntries(info.tables.map(t=>[t.name,0]));
    async function* json() {
      yield '{\n"metadata":'+JSON.stringify(metadata)+',\n"rows":[\n';
      let first = true;
      for (const t of info.tables) {
        // Text casts preserve bigint, decimal, timestamp microseconds, JSON, bytea and arrays.
        const values = t.columns.map(col=>'r.'+quote(col.name)+'::text').join(',');
        await c.query(`DECLARE backup_rows NO SCROLL CURSOR FOR SELECT json_build_array(${values})::text AS values FROM ${quote(info.schema)}.${quote(t.name)} r`);
        try {
          while (true) {
            const batch = (await c.query('FETCH FORWARD 100 FROM backup_rows')).rows;
            if (!batch.length) break;
            for (const r of batch) {
              const record = JSON.stringify({table:t.name,values:JSON.parse(r.values)});
              if (Buffer.byteLength(record)>8*1024*1024) fail('صف واحد يتجاوز الحد الآمن لحجم النسخة.');
              digest.update(record+'\n'); counts[t.name]++;
              yield (first?'':',')+record+'\n'; first=false;
            }
          }
        } finally { await c.query('CLOSE backup_rows'); }
      }
      yield '],\n"summary":'+JSON.stringify({counts,sha256:digest.digest('hex')})+'\n}\n';
    }
    let raw = 0;
    await pipeline(Readable.from(json()), new Transform({transform(chunk,enc,cb){raw+=chunk.length;cb(raw>MAX_RAW?new Error('حجم البيانات أكبر من حد النسخ الحالي (512 MiB).'):null,chunk);}}),
      createGzip({level:6}), fs.createWriteStream(file,{flags:'wx',mode:0o600}));
    await c.query('COMMIT'); transaction = false;
    const size = (await fsp.stat(file)).size;
    if (size>maxUpload) fail('النسخة المضغوطة تجاوزت حد رفع تليجرام؛ بقيت النسخة السابقة محفوظة.');
    const verified = await readArchive(file);
    return {file,filename,size,...verified,cleanup:()=>fsp.rm(dir,{recursive:true,force:true})};
  } catch (e) {
    if (transaction) await c.query('ROLLBACK').catch(()=>{});
    await fsp.rm(dir,{recursive:true,force:true}); throw e;
  }
}

async function readArchive(file, { onMetadata, onRow } = {}) {
  let raw = 0, lineBytes = 0;
  const limited = new Transform({transform(chunk,enc,cb){
    raw+=chunk.length;
    for (const byte of chunk) { lineBytes=byte===10?0:lineBytes+1; if(lineBytes>8*1024*1024)return cb(new Error('Backup line too large')); }
    cb(raw>MAX_RAW?new Error('Backup exceeds decompression limit'):null,chunk);
  }});
  const pump = pipeline(fs.createReadStream(file),createGunzip(),limited);
  // Attach rejection immediately: malformed gzip must not become an unhandled rejection.
  pump.catch(()=>{});
  const lines = readline.createInterface({input:limited,crlfDelay:Infinity});
  let phase=0,metadata,summary,tables,counts,first=true;
  const digest=createHash('sha256');
  try {
    for await (const line of lines) {
      if (phase===0) { if(line!=='{')fail('Invalid backup header'); phase=1; continue; }
      if (phase===1) {
        if(!line.startsWith('"metadata":')||!line.endsWith(','))fail('Missing metadata');
        metadata=JSON.parse(line.slice(11,-1));
        if(metadata.format!==FORMAT||metadata.version!==1||!Array.isArray(metadata.tables)||!metadata.tables.length||
          metadata.schemaHash!==hash(metadata.tables)||!Array.isArray(metadata.sequences))fail('Unsupported backup format/schema');
        tables=new Map(); counts={};
        for(const t of metadata.tables){
          if(typeof t.name!=='string'||tables.has(t.name)||!Array.isArray(t.columns)||!t.columns.length)fail('Invalid table metadata');
          tables.set(t.name,t); Object.defineProperty(counts,t.name,{value:0,writable:true,enumerable:true});
        }
        digest.update(JSON.stringify(metadata)+'\n');
        if(onMetadata)await onMetadata(metadata); phase=2; continue;
      }
      if(phase===2){if(line!=='"rows":[')fail('Missing rows');phase=3;continue;}
      if(phase===3){
        if(line==='],'){phase=4;continue;}
        if(!first&&!line.startsWith(','))fail('Missing row separator');
        const record=JSON.parse(first?line:line.slice(1)); first=false;
        const table=tables.get(record.table);
        if(!table||!Array.isArray(record.values)||record.values.length!==table.columns.length||record.values.some(v=>v!==null&&typeof v!=='string'))fail('Invalid backup row');
        digest.update(JSON.stringify(record)+'\n'); counts[record.table]++;
        if(onRow)await onRow(record,table); continue;
      }
      if(phase===4){
        if(!line.startsWith('"summary":'))fail('Missing summary'); summary=JSON.parse(line.slice(10));
        if(hash(summary.counts)!==hash(counts)||summary.sha256!==digest.digest('hex'))fail('Backup checksum/count mismatch');
        phase=5;continue;
      }
      if(phase===5&&line==='}'){phase=6;continue;}
      fail('Unexpected backup content');
    }
    await pump;
    if(phase!==6)fail('Incomplete backup');
    return {metadata,summary};
  } finally { lines.close(); limited.destroy(); await pump.catch(()=>{}); }
}

// Target schema must be initialized by this exact project version and contain no
// application data. This function is also used by isolated restoration tests.
async function restoreArchive(c, file, { allowSeedRows = false } = {}) {
  const checked=await readArchive(file);
  const target=await schemaInfo(c);
  if(target.schemaHash!==checked.metadata.schemaHash)fail('بنية القاعدة لا تطابق النسخة. استخدم نسخة المشروع التي أُخذ بها الباك أب.');
  const qualified=t=>quote(target.schema)+'.'+quote(t);
  await c.query('BEGIN');
  try {
    await c.query('LOCK TABLE '+target.tables.map(t=>qualified(t.name)).join(',')+' IN ACCESS EXCLUSIVE MODE');
    // Seed deletion is permitted only by the CLI after proving the target was blank before initialization.
    if(!allowSeedRows)for(const t of target.tables){
      if((await c.query(`SELECT 1 FROM ${qualified(t.name)} LIMIT 1`)).rows.length)fail('الاستعادة مسموحة إلى قاعدة جديدة وفارغة فقط.');
    }
    if(allowSeedRows)await c.query('TRUNCATE '+target.tables.map(t=>qualified(t.name)).join(','));
    const fks=(await c.query(`SELECT t.relname AS table_name, k.conname AS name,k.condeferrable,k.condeferred
      FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=$1 AND k.contype='f' ORDER BY t.relname,k.conname`,[target.schema])).rows;
    for(const k of fks)await c.query(`ALTER TABLE ${qualified(k.table_name)} ALTER CONSTRAINT ${quote(k.name)} DEFERRABLE INITIALLY DEFERRED`);
    await c.query('SET CONSTRAINTS ALL DEFERRED');
    const batches=new Map();
    async function flush(t){
      const batch=batches.get(t.name)||[];if(!batch.length)return;
      const writable=t.columns.map((col,i)=>({col,i})).filter(x=>!x.col.generated);
      const args=[];
      const tuples=batch.map(row=>'('+writable.map(x=>{args.push(row.values[x.i]);return '$'+args.length+'::text::'+x.col.type;}).join(',')+')');
      await c.query(`INSERT INTO ${qualified(t.name)} (${writable.map(x=>quote(x.col.name)).join(',')}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(',')}`,args);
      batches.set(t.name,[]);
    }
    await readArchive(file,{onMetadata:async m=>{if(m.schemaHash!==target.schemaHash)fail('Backup schema changed during recovery');},onRow:async(row,t)=>{
      let batch=batches.get(t.name);if(!batch)batches.set(t.name,batch=[]);
      batch.push(row);if(batch.length>=100)await flush(t);
    }});
    for(const t of target.tables)await flush(t);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    for(const k of fks)await c.query(`ALTER TABLE ${qualified(k.table_name)} ALTER CONSTRAINT ${quote(k.name)} ${k.condeferrable?'DEFERRABLE':'NOT DEFERRABLE'} INITIALLY ${k.condeferred?'DEFERRED':'IMMEDIATE'}`);
    for(const s of checked.metadata.sequences){
      const t=target.tables.find(t=>t.name===s.table);
      if(!t?.columns.some(col=>col.name===s.column)||!/^\d+$/.test(s.value)||typeof s.is_called!=='boolean')fail('Invalid sequence');
      const name=(await c.query('SELECT pg_get_serial_sequence($1,$2) AS name',[qualified(s.table),s.column])).rows[0].name;
      if(!name)fail('Sequence missing in target');
      const max=(await c.query(`SELECT MAX(${quote(s.column)})::text AS value FROM ${qualified(s.table)}`)).rows[0].value;
      const value=max!==null&&BigInt(max)>BigInt(s.value)?max:s.value;
      // ALTER SEQUENCE is transactional, unlike setval: failed restores leave no half-restored counters.
      await c.query(`ALTER SEQUENCE ${name} RESTART WITH ${(BigInt(value)+(s.is_called||max!==null?1n:0n)).toString()}`);
    }
    if(target.tables.some(t=>t.name==='backup_control'))await c.query(`UPDATE ${qualified('backup_control')} SET enabled=false,chat_id=NULL,message_id=NULL,file_id=NULL,last_success_at=NULL,last_daily_date=NULL,last_error=NULL,retry_at=NULL,failures=0`);
    await c.query('COMMIT');
    return checked;
  } catch(e) {await c.query('ROLLBACK');throw e;}
}
module.exports={exportArchive,readArchive,restoreArchive,schemaInfo,quote,MAX_UPLOAD};
