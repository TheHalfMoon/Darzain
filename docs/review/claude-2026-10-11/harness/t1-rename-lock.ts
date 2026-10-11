// T1: Does atomic head publication survive another process holding head.json open
// without FILE_SHARE_DELETE (antivirus, indexer, backup agent, text editor)?
import { ProjectStore } from "../darzain/core/store.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const root = await mkdtemp(path.join(tmpdir(), "yk-t1-"));
const store = new ProjectStore(root); await store.initialize();
const p = await store.create("t1");
const head = await store.file(p.id, "head.json");
const ps = spawn("powershell", ["-NoProfile", "-Command",
  `$f=[System.IO.File]::Open('${head}','Open','Read','Read'); Write-Output ready; Start-Sleep 8; $f.Close()`]);
await new Promise<void>((r) => ps.stdout.on("data", (d) => String(d).includes("ready") && r()));
const t0 = Date.now();
try { await store.save({ ...p, name: "renamed" }, p.revision); console.log("SAVE OK while locked", Date.now() - t0, "ms"); }
catch (e: any) { console.log("SAVE FAILED while locked:", e.code, e.message.split("\n")[0], Date.now() - t0, "ms"); }
// What state is left behind? Orphan snapshot without head advance?
const h = await store.history(p.id);
console.log("after-failure history:", JSON.stringify(h.snapshots), "currentRevision", h.currentRevision);
await new Promise((r) => ps.on("exit", r));
try { const again = await store.save({ ...(await store.load(p.id)), name: "retry" }, (await store.load(p.id)).revision); console.log("retry after release OK revision", again.revision); } catch (e: any) { console.log("retry failed", e.message); }
