// Offline recovery commands. They work on folders directly, without the
// service:
//   diagnose <workspace> [--verify-objects]  read-only report
//   restore <backup folder> <new empty folder>
//   backup <workspace> [recovery folder]      only while no service runs
// A running service backs up and restores through its own commands
// (yamakan.workspace.backup / .restore), which choose the folders.
import path from "node:path";
import { ProjectStore } from "../core/store.ts";
import { acquireServiceLock } from "../core/service-lock.ts";
import {
  backupWorkspace,
  defaultRecoveryHome,
  diagnoseWorkspace,
  restoreWorkspace,
} from "../core/recovery.ts";
import { CommandError } from "../core/command/errors.ts";

const [command, ...args] = process.argv.slice(2);
const usage =
  "Usage: npm run recovery -- diagnose <workspace> [--verify-objects] | restore <backup> <new folder> | backup <workspace> [recovery folder]";
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
try {
  if (command === "diagnose" && args[0]) {
    const report = await diagnoseWorkspace(path.resolve(args[0]), {
      verifyObjects: args.includes("--verify-objects"),
    });
    print(report);
    const healthy =
      !report.database.error &&
      report.database.integrity?.[0] === "ok" &&
      report.objects.missing.length === 0 &&
      report.objects.mismatched.length === 0;
    if (!healthy) process.exitCode = 2;
  } else if (command === "restore" && args[0] && args[1]) {
    print(await restoreWorkspace(path.resolve(args[0]), path.resolve(args[1])));
  } else if (command === "backup" && args[0]) {
    const root = path.resolve(args[0]);
    // The service lock proves no service is writing this workspace.
    const lock = await acquireServiceLock(root);
    const store = new ProjectStore(root);
    try {
      await store.initialize();
      print(
        await backupWorkspace(
          store,
          path.resolve(args[1] ?? defaultRecoveryHome(root)),
        ),
      );
    } finally {
      store.close();
      lock.release();
    }
  } else {
    console.error(usage);
    process.exitCode = 64;
  }
} catch (e) {
  const error =
    e instanceof CommandError
      ? { code: e.code, message: e.message }
      : { code: "INTERNAL", message: (e as Error).message };
  console.error(JSON.stringify(error));
  process.exitCode = 1;
}
