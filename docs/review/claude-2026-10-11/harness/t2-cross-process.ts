// T2: Two independent ProjectStore instances (= two processes; exclusive() is per-instance)
// both save from the same expectedRevision. Correct behavior: exactly one succeeds, the other conflicts.
import { ProjectStore } from "../darzain/core/store.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const root = await mkdtemp(path.join(tmpdir(), "yk-t2-"));
const a = new ProjectStore(root), b = new ProjectStore(root);
await a.initialize();
const tally: Record<string, number> = {};
for (let i = 0; i < 40; i++) {
  const p = await a.create("t2-" + i);
  const r = await Promise.allSettled([
    a.save({ ...p, name: "writer-A" }, p.revision),
    b.save({ ...p, name: "writer-B" }, p.revision),
  ]);
  const final = await a.load(p.id);
  const ok = r.filter((x) => x.status === "fulfilled").length;
  const key = ok === 2 ? `BOTH-ACKED(final=${final.name},rev=${final.revision})` : ok === 1 ? "one-acked" : "none-acked";
  tally[key.replace(/rev=\d+/, "rev=?")] = (tally[key.replace(/rev=\d+/, "rev=?")] || 0) + 1;
}
console.log(tally);
