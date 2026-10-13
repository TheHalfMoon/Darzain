// A stand-in service process: starts a ProcessOwner, launches one long-running
// worker, reports the worker and owner PIDs, then waits to be killed.
// Mode "hang": onCreated never completes, so the worker stays suspended.
import { fileURLToPath } from "node:url";
const workerProbe = fileURLToPath(
  new URL(
    "../../native/procd/target/release/worker-probe.exe",
    import.meta.url,
  ),
);
import { ProcessOwner } from "../../core/process/owner.ts";

const [marker, mode] = process.argv.slice(2);
const owner = new ProcessOwner([workerProbe]);
void owner
  .run({
    executable: workerProbe,
    args: ["sleep", marker],
    cwd: process.cwd(),
    onCreated: (pid) => {
      process.send?.({ worker: pid, owner: owner.ownerPid });
      if (mode === "hang") return new Promise<void>(() => {});
    },
  })
  .catch(() => {});
setInterval(() => {}, 1000);
