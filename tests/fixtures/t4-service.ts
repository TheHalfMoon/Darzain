// A stand-in service process: starts a ProcessOwner, launches one long-running
// worker, reports the worker and owner PIDs, then waits to be killed.
// Mode "hang": onCreated never completes, so the worker stays suspended.
import { ProcessOwner } from "../../core/process/owner.ts";

const [marker, mode] = process.argv.slice(2);
const owner = new ProcessOwner([process.execPath]);
void owner
  .run({
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)", marker],
    cwd: process.cwd(),
    onCreated: (pid) => {
      process.send?.({ worker: pid, owner: owner.ownerPid });
      if (mode === "hang") return new Promise<void>(() => {});
    },
  })
  .catch(() => {});
setInterval(() => {}, 1000);
