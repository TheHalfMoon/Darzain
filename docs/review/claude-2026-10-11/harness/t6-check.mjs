import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2]);
const ic = db.prepare("PRAGMA integrity_check").get();
const head = db.prepare("SELECT revision FROM head WHERE project='p'").get().revision;
const revs = db.prepare("SELECT count(*) c, max(revision) m FROM revisions").get();
const idem = db.prepare("SELECT count(*) c FROM idempotency").get().c;
console.log(JSON.stringify({ integrity: Object.values(ic)[0], head, revisionRows: revs.c, maxRevision: revs.m, idempotencyRows: idem,
  invariant_head_eq_rows_eq_idem: head === revs.c && revs.c === idem && revs.m === head }));
