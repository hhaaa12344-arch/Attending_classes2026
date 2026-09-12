'use strict';
const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..');let count=0;
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  if(entry.name==='node_modules'||entry.name.startsWith('.'))continue;
  const file=path.join(dir,entry.name);
  if(entry.isDirectory())walk(file);
  else if(/\.(?:js|cjs)$/.test(file)){const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);count++;}
}}
walk(root);console.log(`Syntax checked: ${count} JavaScript files.`);
