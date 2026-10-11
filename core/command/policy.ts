// Pure constants: imported by browser code (core/project.ts), so no Node APIs.
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

// Server-owned resource policy (operational contracts, "Versioned qualification
// policy"). `enforced` values are what this build applies today; `candidate`
// values are proposed qualification targets that T4/T8 must measure and freeze
// before they can be advertised. A project or client can never raise a limit.
export const RESOURCE_POLICY = Object.freeze({
  policy: "yamakan.resource-policy/v1",
  enforced: Object.freeze({
    requestBytes: 2 * MiB,
    snapshotBytes: 2 * MiB,
    // Streamed: memory use does not grow with this limit.
    assetImportBytes: 4 * GiB,
    // Free space kept after staging plus publication of an import.
    diskReserveBytes: 256 * MiB,
    assetsPerProject: 200,
    timelineFrames: 18000,
    // The render queue is a single serial tail; this documents, not configures, it.
    activeRenderWorkers: 1,
    renderJobsPerSession: 100,
    renderThreads: 2,
    mediaDimension: 4096,
    probeStreams: 10,
    probeWallSeconds: 10,
    // Job Object memory ceiling for each media worker.
    workerMemoryBytes: 1 * GiB,
  }),
  candidate: Object.freeze({
    queuedJobs: 128,
    assetImportBytes: 4 * GiB,
    durationSeconds: 7200,
    streams: 16,
    videoWidth: 3840,
    videoHeight: 2160,
    stillMegapixels: 100,
    probeWallSeconds: 30,
    workerMemoryBytes: 1 * GiB,
    diagnosticOutputBytes: 1 * MiB,
  }),
});
