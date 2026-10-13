// A stand-in service for crash tests: opens the workspace, starts the job
// supervisor and submits one constant-rate conversion of a staged
// variable-frame-rate asset, then waits to be killed.
import { ProjectStore } from "../../core/store.ts";
import { JobSupervisor } from "../../core/jobs.ts";

const [root, projectId, stagedJson] = process.argv.slice(2);
const store = new ProjectStore(root);
await store.initialize();
const supervisor = new JobSupervisor(store);
await supervisor.start();
const job = await supervisor.submitDerivative(
  projectId,
  JSON.parse(stagedJson),
);
process.send?.({ jobId: job.id });
setInterval(() => {}, 1000);
