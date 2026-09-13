#!/usr/bin/env node
'use strict';
// Offline recovery only. Never import index.js here: no bot, scheduler or notifications.
const path=require('node:path');
require('dotenv').config();
const {readArchive,restoreArchive}=require('../backupArchive');
async function main(){
  const [mode,file]=process.argv.slice(2);
  if(!file||!['--check','--restore-new'].includes(mode))throw Error('Usage: node scripts/restore-backup.cjs --check FILE.json.gz | --restore-new FILE.json.gz');
  const archive=path.resolve(file);
  const verified=await readArchive(archive);
  console.log('Valid backup:',verified.metadata.createdAt,'tables:',verified.metadata.tables.length,'rows:',Object.values(verified.summary.counts).reduce((a,b)=>a+b,0));
  if(mode==='--check')return;
  // A separate, explicitly named variable prevents accidental use of production DATABASE_URL.
  if(!process.env.RESTORE_DATABASE_URL)throw Error('Set RESTORE_DATABASE_URL to a NEW, EMPTY PostgreSQL database.');
  if(process.env.DATABASE_URL){
    const source=new URL(process.env.DATABASE_URL),target=new URL(process.env.RESTORE_DATABASE_URL);
    if(source.hostname===target.hostname&&source.port===target.port&&source.pathname===target.pathname)throw Error('Refusing the configured production database. Use a different empty database.');
  }
  process.env.DATABASE_URL=process.env.RESTORE_DATABASE_URL;
  const db=require('../db');
  try {
    const existing=await db.pool.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relkind IN ('r','p','v','m','S','f') LIMIT 1`);
    if(existing.rows.length)throw Error('Target is not empty. Recovery refused; no application tables were modified.');
    await db.initSchema();
    await require('../studies').initStudiesSchema();
    await require('../integrity').initIntegritySchema(db.pool);
    await require('../instituteLinks').createInstituteLinks(db.pool).initSchema();
    await require('../backups').initBackupSchema(db.pool);
    const c=await db.pool.connect();
    try {await restoreArchive(c,archive,{allowSeedRows:true});} finally {c.release();}
    console.log('Recovery completed in the NEW database. The bot was not started. Automatic backups are disabled until you choose the recipient again.');
  }finally{await db.pool.end();}
}
main().catch(e=>{console.error('Recovery stopped:',String(e.message).replace(/postgres(?:ql)?:\/\/\S+/gi,'[redacted connection]'));process.exitCode=1;});
