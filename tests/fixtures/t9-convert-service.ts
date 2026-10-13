// A stand-in service for crash tests: holds the service lock, opens the
// workspace, starts the job supervisor and submits one constant-rate
// conversion of a staged variable-frame-rate asset, reports the job and the
// procd process once it exists, then waits to be killed.
import { ProjectStore } from "../../core/store.ts";
import { JobSupervisor } from "../../core/jobs.ts";
import { acquireServiceLock } from "../../core/service-lock.ts";
import { workers } from "../../core/process/workers.ts";

const [root, projectId, stagedJson] = process.argv.slice(2);
await acquireServiceLock(root);
const store = new ProjectStore(root);
await store.initialize();
const supervisor = new JobSupervisor(store);
await supervisor.start();
const job = await supervisor.submitDerivative(
  projectId,
  JSON.parse(stagedJson),
);
process.send?.({ jobId: job.id });
const report = setInterval(() => {
  const ownerPid = workers().ownerPid;
  if (ownerPid) {
    process.send?.({ ownerPid });
    clearInterval(report);
  }
}, 20);
setInterval(() => {}, 1000);
