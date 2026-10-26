'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
(async()=>{
  const [archive,out]=process.argv.slice(2);if(!archive||!out)throw Error('Usage: node scripts/audit-archive.cjs <backup.json.gz> <private-output-folder>');
  const report=await require('../instituteAudit').auditArchive(archive);
  await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'institute-audit.json'),JSON.stringify(report,null,2));
  const cols=Object.keys(report.subjects[0]||{}),csv=v=>{let s=String(Array.isArray(v)?v.join(';'):v??'');if(/^[=+@\-\t\r\n]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
  await fs.writeFile(path.join(out,'all-subjects-audit.csv'),'\ufeff'+[cols.map(csv).join(','),...report.subjects.map(r=>cols.map(c=>csv(r[c])).join(','))].join('\r\n'));
  console.log(JSON.stringify(report.summary,null,2));
})().catch(e=>{console.error('Audit failed:',e.message);process.exitCode=1;});
