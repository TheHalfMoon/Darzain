// A stand-in service for crash tests: opens the workspace, starts the job
// supervisor and submits one export, then waits to be killed.
import { ProjectStore } from "../../core/store.ts";
import { JobSupervisor } from "../../core/jobs.ts";

const [root, projectId] = process.argv.slice(2);
const store = new ProjectStore(root);
await store.initialize();
const supervisor = new JobSupervisor(store);
await supervisor.start();
const job = await supervisor.submit(projectId, "crash-test");
process.send?.({ jobId: job.id });
setInterval(() => {}, 1000);
