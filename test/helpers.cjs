'use strict';
const { PGlite } = require('@electric-sql/pglite');
async function testDatabase() {
  if(process.env.TEST_DATABASE_URL){
    const url=new URL(process.env.TEST_DATABASE_URL);
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/^\/attendance_test/.test(url.pathname))throw Error('Native tests require a local attendance_test database');
    const db=require('../db');const {Pool}=require('pg');
    const schema='test_'+process.pid+'_'+Math.random().toString(16).slice(2,10);
    const setup=new Pool({connectionString:url.toString(),options:'-c timezone=UTC'});
    await setup.query(`CREATE SCHEMA ${schema}`);await setup.end();
    const native=new Pool({connectionString:url.toString(),max:5,options:`-c timezone=UTC -c search_path=${schema},public`,connectionTimeoutMillis:10000});
    await db.pool.end();db.pool.query=native.query.bind(native);db.pool.connect=native.connect.bind(native);
    db.pool.end=async()=>{await native.query(`DROP SCHEMA ${schema} CASCADE`);await native.end();};
    const studies=require('../studies');await db.initSchema();await studies.initStudiesSchema();await require('../integrity').initIntegritySchema(db.pool);
    return {db,studies,engine:null};
  }
  const engine = new PGlite({
    parsers:{1114:v=>new Date(v.replace(' ','T')+'Z'),1082:v=>new Date(v+'T00:00:00Z')},
    serializers:{1114:v=>v instanceof Date?v.toISOString().slice(0,-1):v,1082:v=>v instanceof Date?v.toISOString().slice(0,10):v}
  });
  await engine.waitReady;
  await engine.exec("SET TIME ZONE 'UTC'");
  let tail = Promise.resolve();
  async function acquire() {
    const prev=tail; let release;
    tail=new Promise(r=>{release=r;});
    await prev; return release;
  }
  async function query(sql,args) {
    const result = !args && sql.split(';').filter(s=>s.trim()).length>1
      ? (await engine.exec(sql)).at(-1) : await engine.query(sql,args);
    return {...result,rowCount:result.rows.length||(result.affectedRows??0)};
  }
  const db=require('../db');
  db.pool.query=async(sql,args)=>{const release=await acquire();try{return await query(sql,args);}finally{release();}};
  db.pool.connect=async()=>{const release=await acquire();return {query,release};};
  db.pool.end=()=>engine.close();
  const studies=require('../studies');
  await db.initSchema();
  await studies.initStudiesSchema();
  await require('../integrity').initIntegritySchema(db.pool);
  return {db,studies,engine};
}
module.exports={testDatabase};
