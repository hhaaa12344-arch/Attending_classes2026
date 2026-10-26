'use strict';
// Verified subject reclassification: no student attendance is copied/created.
// Usage: node scripts/repair-aqeedah-2026-10-26.cjs --preview
// Apply ONLY after reviewing all generic Telegram posts and confirming them:
// REPAIR_ACTOR_ID=<administrator telegram ID> node scripts/repair-aqeedah-2026-10-26.cjs --apply --token=<preview token> --confirm=VERIFIED_POSTS
require('dotenv').config();
const db=require('../db');
const repair=require('../aqeedah20261026Repair').createAqeedah20261026Repair(db);
(async()=>{
  if(!process.env.DATABASE_URL)throw Error('DATABASE_URL is required');
  const [mode,...args]=process.argv.slice(2);
  if(mode==='--preview')console.log(JSON.stringify(await repair.preview(),null,2));
  else if(mode==='--apply'||mode==='--rollback'){
    const token=args.find(v=>v.startsWith('--token='))?.slice(8);
    const confirmed=args.includes('--confirm=VERIFIED_POSTS');
    if(!token||!confirmed)throw Error('Preview token and manual VERIFIED_POSTS confirmation are required');
    const url=new URL(process.env.DATABASE_URL);
    const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&/^\/attendance_test/.test(url.pathname);
    if(!local&&!args.includes('--approve-production-write'))throw Error('Remote writes require separate explicit production approval (--approve-production-write)');
    if(!process.env.REPAIR_ACTOR_ID)throw Error('REPAIR_ACTOR_ID is required');
    console.log(JSON.stringify(await repair[mode==='--apply'?'apply':'rollback']({token,confirmed,actorId:process.env.REPAIR_ACTOR_ID}),null,2));
  }else throw Error('Run with --preview or --apply --token=<preview_token> --confirm=VERIFIED_POSTS');
})().catch(err=>{console.error('Repair stopped without completing:',err.message);process.exitCode=1;}).finally(async()=>{await db.pool.end();});
