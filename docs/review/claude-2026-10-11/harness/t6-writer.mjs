// One writer process: CAS head revision + idempotency record + snapshot hash row in ONE transaction.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
const [db_path, name, n] = process.argv.slice(2);
const db = new DatabaseSync(db_path, { timeout: 5000 });
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
db.exec(`CREATE TABLE IF NOT EXISTS head(project TEXT PRIMARY KEY, revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS revisions(project TEXT, revision INTEGER, snapshot_sha256 TEXT, writer TEXT, PRIMARY KEY(project,revision));
CREATE TABLE IF NOT EXISTS idempotency(request_id TEXT PRIMARY KEY, project TEXT, revision INTEGER, input_sha256 TEXT);
INSERT OR IGNORE INTO head VALUES('p',0);`);
const getHead = db.prepare("SELECT revision FROM head WHERE project='p'");
const cas = db.prepare("UPDATE head SET revision=? WHERE project='p' AND revision=?");
const insRev = db.prepare("INSERT INTO revisions VALUES('p',?,?,?)");
const insIdem = db.prepare("INSERT INTO idempotency VALUES(?,?,?,?)");
let ok = 0, conflict = 0;
for (let i = 0; i < Number(n); i++) {
  const expected = getHead.get().revision;              // read outside txn (like a client)
  try {
    db.exec("BEGIN IMMEDIATE");
    const r = cas.run(expected + 1, expected);
    if (r.changes !== 1) { db.exec("ROLLBACK"); conflict++; continue; }
    insRev.run(expected + 1, createHash("sha256").update(name + i).digest("hex"), name);
    insIdem.run(randomUUID(), "p", expected + 1, "x");
    db.exec("COMMIT"); ok++;
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} conflict++; }
}
console.log(JSON.stringify({ name, ok, conflict }));
