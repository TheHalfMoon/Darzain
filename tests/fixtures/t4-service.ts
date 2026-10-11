// A stand-in service process: starts a ProcessOwner, launches one long-running
// worker, reports the worker and owner PIDs, then waits to be killed.
import { ProcessOwner } from "../../core/process/owner.ts";

const [marker] = process.argv.slice(2);
const owner = new ProcessOwner([process.execPath]);
void owner
  .run({
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)", marker],
    cwd: process.cwd(),
    onCreated: (pid) => {
      process.send?.({ worker: pid, owner: owner.ownerPid });
    },
  })
  .catch(() => {});
setInterval(() => {}, 1000);
