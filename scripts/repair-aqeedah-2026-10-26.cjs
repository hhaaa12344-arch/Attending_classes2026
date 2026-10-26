'use strict';
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
  else if(mode==='--apply'){
    const token=args.find(v=>v.startsWith('--token='))?.slice(8);
    const confirmed=args.includes('--confirm=VERIFIED_POSTS');
    if(!token||!confirmed||!process.env.REPAIR_ACTOR_ID)throw Error('Preview token, manual VERIFIED_POSTS confirmation, and REPAIR_ACTOR_ID are required');
    console.log(JSON.stringify(await repair.apply({token,confirmed,actorId:process.env.REPAIR_ACTOR_ID}),null,2));
  }else throw Error('Run with --preview or --apply --token=<preview_token> --confirm=VERIFIED_POSTS');
})().catch(err=>{console.error('Repair stopped without completing:',err.message);process.exitCode=1;}).finally(async()=>{await db.pool.end();});
