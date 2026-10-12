// Offline recovery commands. They work on folders directly, without the
// service:
//   diagnose <workspace> [--verify-objects] [--scratch <folder>]
//                                            read-only report
//   restore <backup folder> <new empty folder>
//   backup <workspace> [recovery folder]      only while no service runs
// A running service backs up and restores through its own commands
// (yamakan.workspace.backup / .restore), which choose the folders.
import { lstat } from "node:fs/promises";
import path from "node:path";
import { acquireServiceLock } from "../core/service-lock.ts";
import {
  backupWorkspace,
  defaultRecoveryHome,
  diagnoseWorkspace,
  healthy,
  offlineSource,
  restoreWorkspace,
} from "../core/recovery.ts";
import { CommandError } from "../core/command/errors.ts";

const [command, ...args] = process.argv.slice(2);
const usage =
  "Usage: npm run recovery -- diagnose <workspace> [--verify-objects] [--scratch <folder>] | restore <backup> <new folder> | backup <workspace> [recovery folder]";
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
try {
  if (command === "diagnose" && args[0]) {
    const scratch = args.indexOf("--scratch");
    if (scratch > 0 && !args[scratch + 1]) {
      console.error(usage);
      process.exit(64);
    }
    const report = await diagnoseWorkspace(path.resolve(args[0]), {
      verifyObjects: args.includes("--verify-objects"),
      scratch: scratch > 0 ? path.resolve(args[scratch + 1]) : undefined,
    });
    print(report);
    if (!healthy(report)) process.exitCode = 2;
  } else if (command === "restore" && args[0] && args[1]) {
    print(await restoreWorkspace(path.resolve(args[0]), path.resolve(args[1])));
  } else if (command === "backup" && args[0]) {
    const root = path.resolve(args[0]);
    // A mistyped folder gets no lock file.
    if (!(await lstat(path.join(root, "workspace.sqlite")).catch(() => null)))
      throw new CommandError(
        "NOT_FOUND",
        "No workspace database in this folder.",
      );
    // The service lock proves no service is writing this workspace. The
    // database is read as it is: never created, upgraded or repaired.
    const lock = await acquireServiceLock(root);
    try {
      const source = await offlineSource(root);
      try {
        print(
          await backupWorkspace(
            source,
            path.resolve(args[1] ?? defaultRecoveryHome(root)),
          ),
        );
      } finally {
        await source.close();
      }
    } finally {
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
