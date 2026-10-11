// Mechanical planning checks only. No product, security, E2E or founder approval.
// Run at repo root: rtk proxy node docs/review/final-2026-10-11/validate-package.mjs [--write]
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
const base='73910ba9db870a68c9b08c7c369c4bdd1ff3f420',main='0d3bdacb51188294ba8d36ce2b218db72f6073a6',root=process.cwd();
const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim().split('\n').filter(Boolean);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');const failures=[];
const files=[...new Set([...git('ls-files'),...git('ls-files','--others','--exclude-standard')])].filter(p=>fs.existsSync(p)&&/^(docs\/|specs\/CURRENT\.md$|AGENTS\.md$|README\.md$|manifest\.json$|validation\.json$)/.test(p));
const required=['docs/IMPLEMENTATION_PLAN.md','docs/OPERATIONAL_CONTRACTS.md','docs/SOURCE_IMPORT_MATRIX.md','docs/FOUNDER_DECISION_PACKET.md','docs/E2E_ACCEPTANCE.md','docs/SECURITY.md','docs/COMPETITOR_MATRIX.md','docs/review/FINAL_OPTIMIZATION_REVIEW.md','docs/review/final-2026-10-11/evidence.json'];
for(const p of required)if(!fs.existsSync(p)||fs.statSync(p).size<200)failures.push({missing:p});
let json=0,links=0,preserved=0;
for(const p of files){const text=fs.readFileSync(p,'utf8');if(p.endsWith('.json')){try{JSON.parse(text);json++;}catch(e){failures.push({json:p,error:e.message});}}
 if(p.endsWith('.md')&&!p.startsWith('docs/history/darzain/'))for(const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)){const t=m[1].replace(/^<|>$/g,'').split('#')[0];if(!t||/^[a-z]+:/i.test(t))continue;const dest=path.resolve(path.dirname(p),decodeURIComponent(t));links++;if(!dest.startsWith(root+path.sep)||!fs.existsSync(dest))failures.push({link:p,target:t});}
 if(/gh[pousr]_[A-Za-z0-9]{30,}|sk-proj-[A-Za-z0-9_-]{24,}|sk-ant-[A-Za-z0-9_-]{20,}|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/.test(text))failures.push({possibleSecret:p});
}
for(const p of git('ls-tree','-r','--name-only',base,'docs/review/claude-2026-10-11','docs/review/CLAUDE_INDEPENDENT_REVIEW.md')){const original=execFileSync('git',['show',base+':'+p]);if(!fs.existsSync(p)||hash(original)!==hash(fs.readFileSync(p)))failures.push({modifiedClaudeEvidence:p});else preserved++;}
const changed=git('diff','--name-only',main);const other=git('ls-files','--others','--exclude-standard');
for(const p of [...new Set([...changed,...other])])if(!/^(docs\/|specs\/CURRENT\.md$|AGENTS\.md$|README\.md$|manifest\.json$|validation\.json$)/.test(p))failures.push({nonPlanningChange:p});
const catalog=fs.readFileSync('docs/SOURCE_CATALOG.md','utf8');const pins=[...catalog.matchAll(/\| ([a-f0-9]{40}) \|/g)].map(m=>m[1]);if(pins.length<58||new Set(pins).size!==pins.length)failures.push({catalogPins:pins.length,unique:new Set(pins).size});
let manifestVerified=0;
if(!process.argv.includes('--write')){const m=JSON.parse(fs.readFileSync('manifest.json','utf8'));const expected=files.filter(p=>p!=='manifest.json').sort();const actual=m.files.map(x=>x.path).sort();if(JSON.stringify(expected)!==JSON.stringify(actual))failures.push({manifestFileSet:'differs'});for(const x of m.files){const p=path.resolve(root,x.path);if(!p.startsWith(root+path.sep)||!fs.existsSync(p)){failures.push({manifestPath:x.path});continue;}const b=fs.readFileSync(p);if(b.length!==x.bytes||hash(b)!==x.sha256)failures.push({manifestHash:x.path});else manifestVerified++;}}
const baselineDiffSha256=hash(execFileSync('git',['diff','--cached','--binary']));
const result={version:1,status:failures.length?'FAIL':'PASS',baseMain:main,reviewBase:base,scope:'Mechanical planning integrity only; not product/runtime/security acceptance or founder approval',jsonParsed:json,linksChecked:links,sourceCatalogPins:pins.length,claudeFilesByteIdentical:preserved,manifestFilesVerified:manifestVerified,productionCodeChanged:failures.some(e=>e.nonPlanningChange),stagedDiffSha256:baselineDiffSha256,digestScope:process.argv.includes('--write')?'Index before generated validation/manifest publication; exact proposal identity is its Git commit':'Current index; manifest hashes checked against working files',failures};console.log(JSON.stringify(result,null,2));
if(process.argv.includes('--write')&&!failures.length){
 fs.writeFileSync('validation.json',JSON.stringify(result,null,2)+'\n');
 const records=files.filter(p=>p!=='manifest.json').sort().map(p=>({path:p,bytes:fs.statSync(p).size,sha256:hash(fs.readFileSync(p))}));
 fs.writeFileSync('manifest.json',JSON.stringify({version:1,product:'Yamakan',baseMain:main,reviewBase:base,planningBranch:'docs/yamakan-final-optimization',status:'final planning proposal; founder approval pending',selfExcluded:true,files:records},null,2)+'\n');
}
if(failures.length)process.exitCode=1;
