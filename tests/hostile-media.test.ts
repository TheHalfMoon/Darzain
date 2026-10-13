// Hostile-media corpus (release gate: worker read containment). A bounded,
// reproducible set of malformed and adversarial files goes through the real
// import path, so each is probed by a contained ffprobe that may read only
// that file. Every file must import cleanly or fail with a structured media
// error: no crash, no hang beyond the probe limit, nothing from a sentinel
// file outside the workspace in any result, the sentinel unchanged, and no
// capability grant left on any object. Corpus hashes are printed as test
// diagnostics. Inputs that reference other files (playlists, concat lists,
// external data references) are included: they are refused before or by
// the worker, which in any case cannot read the sentinel.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectStore } from "../core/store.ts";
import { closeWorkers, mediaTools } from "../core/process/workers.ts";
import { toCommandError } from "../core/command/errors.ts";

const windows = process.platform === "win32";
const folders: string[] = [];
after(async () => {
  closeWorkers();
  await Promise.all(
    folders.map((f) => rm(f, { recursive: true, force: true })),
  );
});
const ffmpeg = (args: string[]) =>
  execFileSync(
    mediaTools().ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    {
      windowsHide: true,
    },
  );

// A PNG header declaring 65535x65535 pixels with one tiny data chunk.
function pngBomb() {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (~c >>> 0) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(65535, 0);
  ihdr.writeUInt32BE(65535, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 1, 0, 1])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test(
  "a hostile-media corpus fails safely under containment",
  { skip: !windows && "Windows AppContainer", timeout: 300_000 },
  async (t) => {
    const base = await mkdtemp(path.join(tmpdir(), "yamakan-hostile-"));
    folders.push(base);
    const sentinelDir = path.join(base, "elsewhere");
    await mkdir(sentinelDir);
    const sentinel = path.join(sentinelDir, "sentinel.txt");
    const SECRET = "SENTINEL-7f3a9c";
    await writeFile(sentinel, SECRET);
    const media = path.join(base, "media");
    await mkdir(media);
    const valid = path.join(media, "valid.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:rate=30:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=duration=2",
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-shortest",
      valid,
    ]);
    const good = await readFile(valid);
    const wav = path.join(media, "valid.wav");
    ffmpeg(["-f", "lavfi", "-i", "sine=duration=1", wav]);
    const goodWav = await readFile(wav);
    const sentinelUrl = sentinel.replaceAll("\\", "/");
    const corpus: [string, Buffer][] = [
      ["truncated.mp4", good.subarray(0, Math.floor(good.length / 3))],
      [
        "garbage-after-ftyp.mp4",
        Buffer.concat([good.subarray(0, 32), Buffer.alloc(4096, 0xa5)]),
      ],
      [
        "polyglot-zip.mp4",
        Buffer.concat([good, Buffer.from("PK\x03\x04hostile zip tail")]),
      ],
      ["png-bomb.png", pngBomb()],
      [
        "wav-huge-size.wav",
        (() => {
          const b = Buffer.from(goodWav);
          b.writeUInt32LE(0xfffffff0, 4);
          b.writeUInt32LE(0xfffffff0, 40);
          return b;
        })(),
      ],
      [
        "mp3-noise.mp3",
        Buffer.concat([
          Buffer.from([0xff, 0xfb, 0x90, 0x64]),
          Buffer.alloc(8192, 0x5a),
        ]),
      ],
      [
        "hls-playlist.mp4",
        Buffer.from(`#EXTM3U\n#EXTINF:1,\nfile:${sentinelUrl}\n`),
      ],
      [
        "concat-list.mp4",
        Buffer.from(`ffconcat version 1.0\nfile '${sentinelUrl}'\n`),
      ],
      [
        "ftyp-then-playlist.mp4",
        Buffer.concat([
          good.subarray(0, 32),
          Buffer.from(`\n#EXTM3U\nfile:${sentinelUrl}\n`),
        ]),
      ],
      [
        "webp-lie.webp",
        Buffer.concat([
          Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "latin1"),
          Buffer.alloc(64, 0xee),
        ]),
      ],
      ["empty-ogg.ogg", Buffer.from("OggS")],
    ];
    const hashes: Record<string, string> = {};
    for (const [name, bytes] of corpus)
      hashes[name] = createHash("sha256").update(bytes).digest("hex");
    t.diagnostic(`corpus ${JSON.stringify(hashes)}`);

    const store = new ProjectStore(path.join(base, "workspace"));
    await store.initialize();
    try {
      const project = await store.create("Hostile media");
      const outcomes: Record<string, string> = {};
      for (const [name, bytes] of corpus) {
        const started = Date.now();
        try {
          const imported = await store.importAsset(project.id, name, bytes);
          outcomes[name] = `imported as ${imported.asset.kind}`;
          assert.ok(!JSON.stringify(imported).includes(SECRET), name);
        } catch (e) {
          const err = toCommandError(e);
          outcomes[name] = err.code;
          assert.ok(
            ["MEDIA_INVALID", "VALIDATION", "LIMIT_EXCEEDED"].includes(
              err.code,
            ),
            `${name}: ${err.code} ${err.message}`,
          );
          assert.ok(!err.message.includes(SECRET), name);
        }
        // Bounded by the probe's wall-clock limit (10 s), plus margin.
        assert.ok(Date.now() - started < 20_000, `${name} took too long`);
      }
      t.diagnostic(`outcomes ${JSON.stringify(outcomes)}`);
      // A picture of unreadable size (forged header, image bomb) is refused.
      for (const name of ["png-bomb.png", "webp-lie.webp"])
        assert.equal(outcomes[name], "MEDIA_INVALID", name);
      // The references to other files were never followed into an import.
      for (const name of [
        "hls-playlist.mp4",
        "concat-list.mp4",
        "ftyp-then-playlist.mp4",
      ])
        assert.ok(
          !outcomes[name].startsWith("imported"),
          `${name}: ${outcomes[name]}`,
        );
      // The sentinel is unchanged.
      assert.equal(await readFile(sentinel, "utf8"), SECRET);
      // No capability grant remains on anything the workers were given.
      const walk = async (dir: string): Promise<string[]> => {
        const out: string[] = [dir];
        for (const e of await readdir(dir, { withFileTypes: true }))
          if (e.isDirectory())
            out.push(...(await walk(path.join(dir, e.name))));
          else out.push(path.join(dir, e.name));
        return out;
      };
      for (const p of await walk(path.join(base, "workspace", "projects"))) {
        const acl = execFileSync("icacls", [p], { encoding: "utf8" });
        assert.doesNotMatch(acl, /S-1-15-3-1024-/, p);
      }
    } finally {
      store.close();
    }
  },
);
