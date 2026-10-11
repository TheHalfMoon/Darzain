// T5: durable-jobs draft (frozen patch 998f50c7...) as untrusted candidate.
// (a) one damaged journal record; (b) lifetime job cap.
// Run from the root of the feat/durable-jobs worktree (frozen patch 998f50c7...):
//   DRAFT_ROOT=$PWD node <path>/t5-draft.ts
import { pathToFileURL } from "node:url";
const draft = process.env.DRAFT_ROOT!;
const { ProjectStore } = await import(pathToFileURL(draft + "/core/store.ts").href);
const { RenderQueue } = await import(pathToFileURL(draft + "/core/render.ts").href);
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
// (a)
{
  const root = await mkdtemp(path.join(tmpdir(), "yk-t5a-"));
  const store = new ProjectStore(root); await store.initialize();
  const q = new RenderQueue(store); await q.initialize();
  const p = await store.create("t5");
  // Healthy titled project so a submit is legitimate.
  const s = await store.save({ ...p, clips: [{ id: randomUUID(), trackId: p.tracks[0].id, assetId: null, startFrame: 0, durationFrames: 30, sourceFrame: 0, title: "x" }] }, p.revision);
  // Simulate ONE damaged/foreign record (bit flip, partial sync tool, downgrade, manual edit).
  await writeFile(path.join(root, "jobs", randomUUID() + ".json"), "{\"payload\":{}}");
  const q2 = new RenderQueue(store);
  for (const attempt of [1, 2]) {
    try { await q2.submit(s.id, "key" + attempt); console.log("(a) submit", attempt, "OK"); }
    catch (e: any) { console.log("(a) submit", attempt, "FAILED:", e.message.slice(0, 90)); }
  }
  try { await q2.initialize(); console.log("(a) initialize OK"); } catch (e: any) { console.log("(a) initialize permanently rejected (cached promise):", e.message.slice(0,60)); }
}
// (b) lifetime cap: pre-populate 1000 valid terminal records, then try one more export.
{
  const root = await mkdtemp(path.join(tmpdir(), "yk-t5b-"));
  const store = new ProjectStore(root); await store.initialize();
  const q = new RenderQueue(store); await q.initialize();
  const p = await store.create("t5b");
  const rec = (id: string) => ({ schemaVersion: 1, idempotencyKey: "k" + id.slice(0, 8), job: { id, projectId: p.id, revision: 0, state: "FAILED", progress: 0, error: "x", artifact: null, createdAt: new Date().toISOString() }, integrity: null });
  for (let i = 0; i < 1000; i++) await q.journal.write(rec(randomUUID()) as any);
  const q2 = new RenderQueue(store);
  try { await q2.submit(p.id, "after-1000"); console.log("(b) 1001st job OK"); }
  catch (e: any) { console.log("(b) 1001st job:", e.message); }
  console.log("(b) journal files:", (await readdir(path.join(root, "jobs"))).length, "— no retention/GC exists in the draft");
}
