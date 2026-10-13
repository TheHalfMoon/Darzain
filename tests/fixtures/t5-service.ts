// A stand-in service for crash tests: opens the workspace, starts the job
// supervisor and submits one export, reports the job and the procd process
// once it exists, then waits to be killed.
import { ProjectStore } from "../../core/store.ts";
import { JobSupervisor } from "../../core/jobs.ts";
import { workers } from "../../core/process/workers.ts";

const [root, projectId] = process.argv.slice(2);
const store = new ProjectStore(root);
await store.initialize();
const supervisor = new JobSupervisor(store);
await supervisor.start();
const job = await supervisor.submit(projectId, "crash-test");
process.send?.({ jobId: job.id });
const report = setInterval(() => {
  const ownerPid = workers().ownerPid;
  if (ownerPid) {
    process.send?.({ ownerPid });
    clearInterval(report);
  }
}, 20);
setInterval(() => {}, 1000);
