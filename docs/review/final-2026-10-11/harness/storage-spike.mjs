import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const root=path.resolve('work/storage-spike');fs.mkdirSync(root,{recursive:true});
const dbPath=path.join(root,'workspace.sqlite');
const open=()=>{const d=new DatabaseSync(dbPath);d.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');return d;};
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
if(process.argv[2]==='child'){
 const d=open();d.exec('BEGIN IMMEDIATE');d.prepare('INSERT INTO snapshots VALUES (?,?)').run('interrupted',Buffer.from('{"draft":true}'));
 process.send('prepared');setInterval(()=>{},1000);
} else {
 const d=open();d.exec('CREATE TABLE IF NOT EXISTS snapshots(hash TEXT PRIMARY KEY,bytes BLOB NOT NULL); CREATE TABLE IF NOT EXISTS heads(project TEXT PRIMARY KEY,revision INTEGER NOT NULL,hash TEXT REFERENCES snapshots(hash)); CREATE TABLE IF NOT EXISTS requests(principal TEXT,project TEXT,id TEXT,payload TEXT,revision INTEGER,result TEXT,PRIMARY KEY(principal,project,id));');
 const put=(expected,id,bytes)=>{const payload=digest(bytes);d.exec('BEGIN IMMEDIATE');try{
 const replay=d.prepare('SELECT * FROM requests WHERE principal=? AND project=? AND id=?').get('user','p',id);
 if(replay){if(replay.payload!==payload)throw Error('IDEMPOTENCY_MISMATCH');d.exec('COMMIT');return {revision:replay.revision,replay:true};}
 const head=d.prepare('SELECT revision FROM heads WHERE project=?').get('p');if((head?.revision??0)!==expected)throw Error('REVISION_CONFLICT');
 d.prepare('INSERT OR IGNORE INTO snapshots VALUES (?,?)').run(payload,Buffer.from(bytes));
 d.prepare('INSERT INTO heads VALUES (?,?,?) ON CONFLICT(project) DO UPDATE SET revision=excluded.revision,hash=excluded.hash').run('p',expected+1,payload);
 d.prepare('INSERT INTO requests VALUES (?,?,?,?,?,?)').run('user','p',id,payload,expected+1,'committed');d.exec('COMMIT');return {revision:expected+1,replay:false};
 }catch(e){d.exec('ROLLBACK');throw e;}};
 assert.deepEqual(put(0,'a','{"edit":1}'),{revision:1,replay:false});
 assert.deepEqual(put(0,'a','{"edit":1}'),{revision:1,replay:true});
 assert.throws(()=>put(0,'a','{"edit":2}'),/IDEMPOTENCY_MISMATCH/);
 assert.throws(()=>put(0,'b','{"edit":2}'),/REVISION_CONFLICT/);
 const child=spawn(process.execPath,[import.meta.filename,'child'],{stdio:['ignore','ignore','pipe','ipc']});
 await new Promise((resolve,reject)=>{child.once('message',()=>child.kill('SIGKILL'));child.once('exit',resolve);child.once('error',reject);});
 assert.equal(d.prepare('SELECT count(*) AS n FROM snapshots WHERE hash=?').get('interrupted').n,0);
 assert.equal(d.prepare('SELECT revision FROM heads WHERE project=?').get('p').revision,1);
 assert.equal(d.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 const committed=d.prepare('SELECT bytes FROM snapshots JOIN heads USING(hash) WHERE project=?').get('p').bytes;assert.equal(Buffer.from(committed).toString(),'{{"edit":1}}'.replace('{{','{').replace('}}','}'));
 d.close();
 const F=705600000n,N=60000n,D=1001n;let mismatch=null;for(let seconds=213n;seconds<20000n;seconds++){const t=seconds*F+F/3n;const exact=t*N/(F*D);const naive=Math.floor(Number(t)*Number(N)/(Number(F)*Number(D)));if(BigInt(naive)!==exact){mismatch={ticks:String(t),exact:String(exact),naive};break;}}
 const receipt={node:process.version,sqlite:new DatabaseSync(':memory:').prepare('SELECT sqlite_version() AS version').get().version,checks:['snapshot/head/request committed in one DB transaction','same-payload retry returns original revision before stale-revision check','different-payload retry rejected','stale new request rejected','process killed after snapshot INSERT rolls back snapshot and head together','integrity_check ok','committed canonical bytes available without external snapshot file'],time:{flicksPerSecond:String(F),sample48000Ticks:Number(F/48000n),legacy120000TicksPer48000Sample:2.5,unsafeIntermediateAt213Seconds:!Number.isSafeInteger(213*Number(F)*60000),counterexample:mismatch},limits:['One bounded process-kill trial; not power-loss, physical disk-full, hostile filesystems, or production integration','No hardware flush guarantee','No application-code change']};
 fs.writeFileSync('work/storage-spike-result.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}
