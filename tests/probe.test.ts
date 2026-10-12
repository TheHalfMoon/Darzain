import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { probe } from "../core/media.ts";
import { mediaTools } from "../core/process/workers.ts";
import { CommandError } from "../core/command/errors.ts";

// Every test folder is removed when the file's tests finish.
const bases: string[] = [];
after(() =>
  Promise.all(bases.map((b) => rm(b, { recursive: true, force: true }))),
);

const ffmpeg = (args: string[]) =>
  execFileSync(
    mediaTools().ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    {
      windowsHide: true,
    },
  );

test("owned probes identify constant and variable frame rate and record time bases", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "yamakan-probe-"));
  bases.push(dir);
  const cfr = path.join(dir, "cfr.mp4");
  const vfr = path.join(dir, "vfr.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=30:duration=2",
    "-pix_fmt",
    "yuv420p",
    cfr,
  ]);
  // Dropping frames irregularly with variable-rate output yields a VFR file.
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=30:duration=2",
    "-vf",
    "select='not(mod(n\\,3))+eq(n\\,1)'",
    "-fps_mode",
    "vfr",
    "-pix_fmt",
    "yuv420p",
    vfr,
  ]);
  const a = await probe(cfr);
  assert.equal(a.variableFrameRate, false);
  assert.deepEqual(a.frameRate, { num: 30, den: 1 });
  assert.ok(a.timebase && a.timebase.num > 0 && a.timebase.den > 0);
  const b = await probe(vfr);
  assert.equal(b.variableFrameRate, true);
  assert.equal(b.hasVideo, true);
});

test("unreadable media fails as MEDIA_INVALID without echoing paths or stderr", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "yamakan-probe-bad-"));
  bases.push(dir);
  const bad = path.join(dir, "broken.mp4");
  await writeFile(
    bad,
    Buffer.concat([Buffer.from("....ftypisom"), Buffer.alloc(4096, 7)]),
  );
  await assert.rejects(probe(bad), (e: unknown) => {
    assert.ok(e instanceof CommandError);
    assert.equal(e.code, "MEDIA_INVALID");
    assert.ok(!e.message.includes(dir));
    return true;
  });
});
