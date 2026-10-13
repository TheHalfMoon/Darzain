// Resource policy v2: procd reports each worker's peak Job Object memory, a
// worker over its memory limit fails instead of growing, and the frozen
// qualification thresholds stay inside the limits enforced at run time.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { ProcessOwner, type WorkerReport } from "../core/process/owner.ts";
import { mediaTools } from "../core/process/workers.ts";
import { RESOURCE_POLICY } from "../core/command/policy.ts";

const MiB = 1024 * 1024;
const windows = process.platform === "win32";
// A 1080p H.264 encode of a moving pattern: well over 64 MiB of memory.
const encode = [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=1920x1080:rate=30:duration=2",
  "-c:v",
  "libx264",
  "-f",
  "null",
  "-",
];

test(
  "procd reports a worker's peak Job Object memory to the run and to observers",
  { skip: !windows && "Windows Job Objects" },
  async () => {
    const { ffmpeg } = mediaTools();
    const owner = new ProcessOwner([ffmpeg]);
    const reports: WorkerReport[] = [];
    const stop = owner.observe((r) => reports.push(r));
    try {
      const limit = RESOURCE_POLICY.enforced.renderMemoryBytes;
      const result = await owner.run({
        executable: ffmpeg,
        args: encode,
        cwd: tmpdir(),
        memoryBytes: limit,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.ok(
        result.peakMemoryBytes! > 64 * MiB,
        `${result.peakMemoryBytes}`,
      );
      assert.ok(result.peakMemoryBytes! <= limit);
      assert.equal(reports.length, 1);
      assert.equal(reports[0].peakMemoryBytes, result.peakMemoryBytes);
      assert.equal(reports[0].memoryLimitBytes, limit);
      assert.match(reports[0].executable, /^ffmpeg/i);
      assert.ok(reports[0].wallMs > 0);
      // Unsubscribed observers hear nothing more.
      stop();
      await owner.run({
        executable: ffmpeg,
        args: ["-version"],
        cwd: tmpdir(),
      });
      assert.equal(reports.length, 1);
    } finally {
      owner.close();
    }
  },
);

test(
  "a worker over its Job Object memory limit fails rather than grows",
  { skip: !windows && "Windows Job Objects" },
  async () => {
    const { ffmpeg } = mediaTools();
    const owner = new ProcessOwner([ffmpeg]);
    try {
      const limit = 64 * MiB;
      const result = await owner.run({
        executable: ffmpeg,
        args: encode,
        cwd: tmpdir(),
        memoryBytes: limit,
      });
      assert.notEqual(result.code, 0, "the encode cannot succeed in 64 MiB");
      // The kernel fails the worker's allocations at the limit...
      assert.match(result.stderr, /malloc|alloc/i);
      // ...and its commit stops there, within the few MiB the job may
      // overshoot (up to 7.5 MiB seen at limits of 32-192 MiB).
      assert.ok(result.peakMemoryBytes! > 0);
      assert.ok(
        result.peakMemoryBytes! <= limit + 16 * MiB,
        `${result.peakMemoryBytes}`,
      );
    } finally {
      owner.close();
    }
  },
);

test("the frozen qualification rule sits inside the enforced limits", () => {
  const { enforced, qualification } = RESOURCE_POLICY;
  assert.equal(RESOURCE_POLICY.policy, "yamakan.resource-policy/v2");
  assert.ok(Object.isFrozen(qualification));
  assert.ok(
    qualification.workerPeakShareOfLimit > 0 &&
      qualification.workerPeakShareOfLimit < 1,
  );
  assert.ok(
    qualification.importServicePeakMiB * MiB < enforced.workerMemoryBytes,
  );
  // The worst case at once (service, job worker, preview renderer, the
  // concurrent probes and one engine check) fits in half of the
  // qualification profile's 16 GiB.
  const worstMiB =
    qualification.budget.serviceMiB +
    (2 * enforced.renderMemoryBytes +
      (enforced.concurrentImports + 1) * enforced.workerMemoryBytes) /
      MiB;
  assert.ok(worstMiB <= 16 * 1024 * qualification.budget.maxShareOfRam);
});
