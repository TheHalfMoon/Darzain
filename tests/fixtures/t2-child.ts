// Child process for multi-process storage tests. Modes:
//   writer <root> <projectId> <name> <requestId> [pauseAt] [releaseFile]
//     saves a rename at revision 0; optionally blocks inside the transaction at
//     a fault point until releaseFile exists (or the parent kills it).
//   lock <root>
//     acquires the service lock and holds it until killed.
import { existsSync, writeFileSync } from "node:fs";
import { ProjectStore } from "../../core/store.ts";
import type { FaultPoint } from "../../core/store.ts";
import { acquireServiceLock } from "../../core/service-lock.ts";
import { toCommandError } from "../../core/command/errors.ts";

const [mode, root, projectId, name, requestId, pauseAt, releaseFile] =
  process.argv.slice(2);
const report = (value: unknown) => process.send?.(value);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

if (mode === "lock") {
  await acquireServiceLock(root);
  report({ locked: true });
  setInterval(() => {}, 1000);
} else if (mode === "writer") {
  const store = new ProjectStore(root, {
    fault: (point: FaultPoint) => {
      if (point !== pauseAt) return;
      // Signal through the filesystem: IPC cannot be serviced while blocked.
      writeFileSync(`${releaseFile}.paused`, point);
      while (!existsSync(releaseFile)) Atomics.wait(sleeper, 0, 0, 10);
    },
  });
  await store.initialize();
  report({ ready: true });
  process.once("message", async () => {
    try {
      const current = await store.load(projectId);
      const saved = await store.save({ ...current, name }, 0, {
        principalId: "local-client",
        requestId,
        digest: name,
      });
      report({ ok: true, revision: saved.revision });
    } catch (e) {
      report({ ok: false, code: toCommandError(e).code });
    }
    store.close();
  });
}
