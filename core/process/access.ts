// Owner-only access to a workspace (plan T9: "token ACL"; "second Windows
// account denied"). On Windows a workspace folder gets a protected DACL that
// grants full access only to the current user, SYSTEM and Administrators;
// everything below it inherits that, including the client token and the
// launch link. Other accounts of the machine (Users, Authenticated Users,
// Everyone) are denied. The DACL is set by the dependency-free
// yamakan-acl helper built with yamakan-procd. Elsewhere, POSIX modes:
// 0700 for folders, 0600 for files.
import { execFile } from "node:child_process";
import { chmod, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CommandError } from "../command/errors.ts";

function helper() {
  const configured = process.env.YAMAKAN_ACL;
  const file =
    configured ||
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../native/procd/target/release/yamakan-acl.exe",
    );
  if (!existsSync(file))
    throw new CommandError(
      "CAPABILITY_UNAVAILABLE",
      "yamakan-acl is not built; run npm run build:native.",
    );
  return file;
}

function run(args: string[]) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      helper(),
      args,
      { windowsHide: true, timeout: 600_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const out = String(stdout).trim();
        if (!error && /^(OK|ALLOWED|DENIED|\{)/.test(out)) return resolve(out);
        // "ERROR <code> <message>" from the helper.
        const message =
          /^ERROR \d+ (.*)$/.exec(out)?.[1] ??
          (out || (error as Error).message);
        reject(
          new CommandError(
            "CAPABILITY_UNAVAILABLE",
            `Could not make ${args[args.length - 1]} private to this account: ${message}`,
          ),
        );
      },
    ),
  );
}

// Restricts a folder (and everything below it) or a file to the current
// user. A link or junction, or a path owned by another account, is refused:
// its owner could change the access again whatever is set now.
export async function restrictToOwner(target: string, kind: "dir" | "file") {
  if (process.platform !== "win32") {
    const info = await lstat(target);
    if (info.isSymbolicLink())
      throw new CommandError("VALIDATION", `${target} is a link.`);
    if (process.getuid && info.uid !== process.getuid())
      throw new CommandError(
        "VALIDATION",
        `${target} belongs to another account.`,
      );
    await chmod(target, kind === "dir" ? 0o700 : 0o600);
    return;
  }
  await run(["secure", kind, path.resolve(target)]);
}

// Windows evidence: the DACL as the system reports it.
export async function describeAccess(target: string): Promise<{
  owner: string;
  protected: boolean;
  null: boolean;
  aces: { type: number; flags: number; mask: number; sid: string }[];
}> {
  return JSON.parse(await run(["describe", path.resolve(target)]));
}

// Windows evidence: whether a principal holding at least what another
// standard account of this machine holds (this token with the current user
// and Administrators deny-only and no privileges; it keeps this logon's
// other groups, so a denial is conservative) can open the path for reading.
export async function readableByOtherAccounts(target: string) {
  return (await run(["probe-other", path.resolve(target)])) === "ALLOWED";
}
