// T2b: deterministic interleaving. B passes its expectedRevision check, then A fully commits,
// then B allocates nextRevision. A real second process (second server, CLI with direct store,
// worker) can hit this with slow disk/AV scanning.
import { ProjectStore } from "../darzain/core/store.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const root = await mkdtemp(path.join(tmpdir(), "yk-t2b-"));
const a = new ProjectStore(root), b = new ProjectStore(root);
await a.initialize();
const p = await a.create("base");
const origLoad = b.load.bind(b);
let aDone!: () => void; const aCommitted = new Promise<void>((r) => (aDone = r));
(b as any).load = async (id: string) => { const r = await origLoad(id); await aCommitted; return r; };
const bSave = b.save({ ...p, name: "B-edit (based on rev 0)" }, p.revision);
const aRes = await a.save({ ...p, name: "A-edit (based on rev 0)" }, p.revision);
aDone();
const bRes = await bSave.then((x) => x, (e) => e);
const final = await a.load(p.id);
console.log("A acked rev", aRes.revision, "| B result:", bRes instanceof Error ? "ERROR " + bRes.message : "acked rev " + bRes.revision);
console.log("final head:", final.revision, JSON.stringify(final.name));
console.log(bRes instanceof Error ? "SAFE: conflict detected" : "LOST UPDATE: A's acknowledged edit is silently superseded by a write based on stale revision 0");
