// Owner-only access to a workspace (plan T9: "token ACL"; "second Windows
// account denied"). On Windows a workspace folder gets a protected DACL that
// grants full access only to the current user, SYSTEM and Administrators;
// everything below it inherits that, including the client token and the
// launch link. Other accounts of the machine (Users, Authenticated Users,
// Everyone) are denied. The DACL is set by the dependency-free
// yamakan-acl helper built with yamakan-procd. Elsewhere, POSIX modes:
// 0700 for folders, 0600 for files.
import { execFile } from "node:child_process";
import { chmod } from "node:fs/promises";
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
      { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const out = String(stdout).trim();
        if (error || !/^(OK|ALLOWED|DENIED|\{)/.test(out))
          reject(
            new CommandError(
              "CAPABILITY_UNAVAILABLE",
              `Could not set owner-only access: ${out || (error as Error).message}`,
            ),
          );
        else resolve(out);
      },
    ),
  );
}

// Restricts a folder (and everything below it) or a file to its owner.
// Returns whether anything changed.
export async function restrictToOwner(
  target: string,
  kind: "dir" | "file",
): Promise<"changed" | "unchanged"> {
  if (process.platform !== "win32") {
    await chmod(target, kind === "dir" ? 0o700 : 0o600);
    return "changed";
  }
  const out = await run(["secure", kind, path.resolve(target)]);
  return out === "OK unchanged" ? "unchanged" : "changed";
}

// Windows evidence: the DACL as the system reports it.
export async function describeAccess(target: string): Promise<{
  protected: boolean;
  null: boolean;
  aces: { type: number; flags: number; mask: number; sid: string }[];
}> {
  return JSON.parse(await run(["describe", path.resolve(target)]));
}

// Windows evidence: whether a principal holding what another standard
// account of this machine holds (this token with the current user and
// Administrators deny-only and no privileges) can open the path for reading.
export async function readableByOtherAccounts(target: string) {
  return (await run(["probe-other", path.resolve(target)])) === "ALLOWED";
}
