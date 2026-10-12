import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  describeAccess,
  readableByOtherAccounts,
  restrictToOwner,
} from "../core/process/access.ts";

const bases: string[] = [];
after(() =>
  Promise.all(bases.map((b) => rm(b, { recursive: true, force: true }))),
);
// Grants with icacls (Windows' own tool), to build the starting states.
const icacls = (...args: string[]) =>
  execFileSync("icacls", args, { stdio: "pipe", windowsHide: true });

async function folder() {
  const base = await mkdtemp(path.join(tmpdir(), "yamakan-access-"));
  bases.push(base);
  // A known permissive start wherever the temporary folder is (the
  // profile's own Temp is already private): Users may read everything.
  if (process.platform === "win32")
    icacls(base, "/grant", "*S-1-5-32-545:(OI)(CI)R");
  const workspace = path.join(base, "workspace");
  await mkdir(path.join(workspace, "projects", "sub"), { recursive: true });
  // Written before the folder is restricted: existing files are covered too.
  await writeFile(path.join(workspace, "token"), "secret");
  await writeFile(path.join(workspace, "explicit.txt"), "granted");
  await writeFile(
    path.join(workspace, "projects", "sub", "protected.txt"),
    "x",
  );
  await writeFile(path.join(base, "elsewhere.txt"), "public");
  return { base, workspace };
}

test(
  "a workspace becomes private to its owner; explicit and protected grants below are removed",
  { skip: process.platform !== "win32" && "Windows DACLs" },
  async () => {
    const { base, workspace } = await folder();
    const token = path.join(workspace, "token");
    const explicit = path.join(workspace, "explicit.txt");
    const guarded = path.join(workspace, "projects", "sub", "protected.txt");
    // An explicit grant to Everyone, and a protected DACL granting Everyone,
    // as another tool or account might have left them.
    icacls(explicit, "/grant", "*S-1-1-0:R");
    icacls(
      guarded,
      "/inheritance:r",
      "/grant",
      "*S-1-1-0:R",
      "/grant",
      `${process.env.USERNAME}:F`,
    );
    // Controls: before the restriction another account reads all of them,
    // so a denial below is the restriction's doing.
    for (const target of [workspace, token, explicit, guarded])
      assert.equal(await readableByOtherAccounts(target), true, target);
    await restrictToOwner(workspace, "dir");
    await restrictToOwner(workspace, "dir"); // again: still succeeds
    const acl = await describeAccess(workspace);
    assert.equal(acl.protected, true, "no permissions inherited from above");
    const sids = acl.aces.map((a) => a.sid);
    assert.equal(sids.length, 3);
    assert.ok(sids.includes("S-1-5-18"), "SYSTEM");
    assert.ok(sids.includes("S-1-5-32-544"), "Administrators");
    const user = sids.find((s) => s.startsWith("S-1-5-21-"));
    assert.ok(user, "the current user");
    assert.equal(acl.owner, user, "owned by the current user");
    for (const ace of acl.aces) {
      assert.equal(ace.type, 0, "allow entries only");
      assert.equal(ace.flags, 3, "inherited by files and folders below");
      assert.equal(ace.mask, 0x1f01ff, "full access");
    }
    // Everyone, Users and Authenticated Users hold nothing.
    for (const other of ["S-1-1-0", "S-1-5-32-545", "S-1-5-11"])
      assert.ok(!sids.includes(other), other);
    // Everything below holds exactly the inherited grants, owned by the user.
    for (const target of [token, explicit, guarded]) {
      const below = await describeAccess(target);
      assert.equal(below.protected, false, target);
      assert.equal(below.owner, user, target);
      assert.deepEqual(below.aces.map((a) => a.sid).sort(), [...sids].sort());
      assert.ok(
        below.aces.every((a) => (a.flags & 0x10) !== 0),
        target,
      );
    }
    for (const target of [workspace, token, explicit, guarded])
      assert.equal(await readableByOtherAccounts(target), false, target);
    assert.equal(
      await readableByOtherAccounts(path.join(base, "elsewhere.txt")),
      true,
      "the probe still reads an ordinary file",
    );
  },
);

test(
  "a link or junction is never made private in place of its target",
  { skip: process.platform !== "win32" && "Windows junctions" },
  async () => {
    const { base, workspace } = await folder();
    const link = path.join(base, "link");
    await symlink(workspace, link, "junction");
    await assert.rejects(restrictToOwner(link, "dir"), /link or junction/);
    assert.equal(await readableByOtherAccounts(workspace), true);
  },
);

test(
  "on POSIX a workspace folder is 0700 and a secret file 0600; links are refused",
  { skip: process.platform === "win32" && "POSIX modes" },
  async () => {
    const { base, workspace } = await folder();
    await restrictToOwner(workspace, "dir");
    await restrictToOwner(path.join(workspace, "token"), "file");
    assert.equal((await stat(workspace)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(path.join(workspace, "token"))).mode & 0o777,
      0o600,
    );
    const link = path.join(base, "link");
    await symlink(workspace, link);
    await assert.rejects(restrictToOwner(link, "dir"), /is a link/);
  },
);

test(
  "a workspace whose objects lie past 260 characters is still made private",
  { skip: process.platform !== "win32" && "Windows path limits" },
  async () => {
    const { base } = await folder();
    // A deep root, then an object path like projects/<id>/objects/sha256/...
    const root = path.join(base, "w".repeat(80), "x".repeat(80), "workspace");
    const object = path.join(
      root,
      "projects",
      "0".repeat(36),
      "objects",
      "sha256",
      "ab",
      "ab".repeat(32),
    );
    await mkdir(path.dirname(object), { recursive: true });
    await writeFile(object, "media");
    assert.ok(object.length > 300, `${object.length} characters`);
    assert.equal(await readableByOtherAccounts(object), true, "control");
    await restrictToOwner(root, "dir");
    assert.equal(await readableByOtherAccounts(object), false);
    assert.equal((await describeAccess(object)).aces.length, 3);
  },
);
