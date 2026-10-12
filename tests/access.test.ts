import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
async function folder() {
  const base = await mkdtemp(path.join(tmpdir(), "yamakan-access-"));
  bases.push(base);
  const workspace = path.join(base, "workspace");
  await mkdir(path.join(workspace, "projects"), { recursive: true });
  // Written before the folder is restricted: existing files are covered too.
  await writeFile(path.join(workspace, "token"), "secret");
  await writeFile(path.join(base, "elsewhere.txt"), "public");
  return { base, workspace };
}

test(
  "a workspace becomes private to its owner; other accounts are denied, ordinary files stay readable",
  { skip: process.platform !== "win32" && "Windows DACLs" },
  async () => {
    const { base, workspace } = await folder();
    const token = path.join(workspace, "token");
    // Control: without the restriction both are readable to another account,
    // so a denial below is the restriction's doing.
    assert.equal(await readableByOtherAccounts(token), true);
    assert.equal(await restrictToOwner(workspace, "dir"), "changed");
    assert.equal(await restrictToOwner(workspace, "dir"), "unchanged");
    const acl = await describeAccess(workspace);
    assert.equal(acl.protected, true, "no permissions inherited from above");
    const sids = acl.aces.map((a) => a.sid);
    assert.equal(sids.length, 3);
    assert.ok(sids.includes("S-1-5-18"), "SYSTEM");
    assert.ok(sids.includes("S-1-5-32-544"), "Administrators");
    const user = sids.find((s) => s.startsWith("S-1-5-21-"));
    assert.ok(user, "the current user");
    for (const ace of acl.aces) {
      assert.equal(ace.type, 0, "allow entries only");
      assert.equal(ace.flags, 3, "inherited by files and folders below");
      assert.equal(ace.mask, 0x1f01ff, "full access");
    }
    // Everyone, Users and Authenticated Users hold nothing.
    for (const other of ["S-1-1-0", "S-1-5-32-545", "S-1-5-11"])
      assert.ok(!sids.includes(other), other);
    // Files below (including ones that existed before) inherit it.
    const inherited = await describeAccess(token);
    assert.deepEqual(inherited.aces.map((a) => a.sid).sort(), [...sids].sort());
    assert.ok(inherited.aces.every((a) => (a.flags & 0x10) !== 0));
    for (const target of [workspace, token, path.join(workspace, "projects")])
      assert.equal(await readableByOtherAccounts(target), false, target);
    assert.equal(
      await readableByOtherAccounts(path.join(base, "elsewhere.txt")),
      true,
      "the probe still reads an ordinary file",
    );
  },
);

test(
  "on POSIX a workspace folder is 0700 and a secret file 0600",
  { skip: process.platform === "win32" && "POSIX modes" },
  async () => {
    const { workspace } = await folder();
    await restrictToOwner(workspace, "dir");
    await restrictToOwner(path.join(workspace, "token"), "file");
    assert.equal((await stat(workspace)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(path.join(workspace, "token"))).mode & 0o777,
      0o600,
    );
  },
);
