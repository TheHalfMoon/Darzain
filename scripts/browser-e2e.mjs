import { chromium } from "playwright-core";
import { execFileSync, fork } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
const root = mkdtempSync(join(tmpdir(), "yamakan-browser-"));
const output = resolve(
  process.env.YAMAKAN_E2E_OUTPUT ||
    process.env.DARZAIN_E2E_OUTPUT ||
    "work/browser-e2e",
);
mkdirSync(output, { recursive: true });
const png = join(root, "reference.png"),
  wav = join(root, "music.wav");
const video = join(root, "motion-with-sound.mp4");
const ffmpeg =
  process.env.YAMAKAN_FFMPEG || process.env.DARZAIN_FFMPEG || "ffmpeg";
execFileSync(
  ffmpeg,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360",
    "-frames:v",
    "1",
    "-threads",
    "1",
    png,
  ],
  { windowsHide: true },
);
execFileSync(
  ffmpeg,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=3",
    "-threads",
    "1",
    wav,
  ],
  { windowsHide: true },
);
execFileSync(
  ffmpeg,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=180x320:duration=3:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=660:duration=3",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-c:a",
    "aac",
    "-pix_fmt",
    "yuv420p",
    "-shortest",
    video,
  ],
  { windowsHide: true },
);
const port = 24319,
  url = `http://127.0.0.1:${port}`;
const child = fork(
  fileURLToPath(new URL("../server/main.ts", import.meta.url)),
  [],
  {
    env: {
      ...process.env,
      YAMAKAN_WORKSPACE: join(root, "workspace"),
      YAMAKAN_PORT: String(port),
    },
    silent: true,
    windowsHide: true,
  },
);
let browser,
  serverError = "";
child.stderr.on("data", (chunk) => (serverError += String(chunk)));
try {
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Startup timeout: ${serverError}`)),
      10000,
    );
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Yamakan is running")) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited ${code}: ${serverError}`));
    });
  });
  const agent = {
    Authorization: `Bearer ${(await readFile(join(root, "workspace", "token"), "utf8")).trim()}`,
  };
  browser = await chromium.launch({
    channel:
      process.env.YAMAKAN_BROWSER_CHANNEL ||
      process.env.DARZAIN_BROWSER_CHANNEL ||
      "msedge",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  await page.addInitScript(() => {
    const elements = [];
    Object.defineProperty(window, "__yamakanMedia", { value: elements });
    const create = document.createElement.bind(document);
    document.createElement = (...args) => {
      const element = create(...args);
      if (args[0] === "video") elements.push(element);
      return element;
    };
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(...args) {
        super(...args);
        elements.push(this);
      }
    };
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Browser verified production");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Browser verified production", exact: true })
    .waitFor();
  await page.getByLabel("Import local media").setInputFiles(png);
  await page
    .getByRole("status")
    .filter({ hasText: /Imported \W?reference\.png/ })
    .waitFor();
  await page.getByRole("button", { name: "reference.png image" }).click();
  await page.getByLabel("Import local media").setInputFiles(wav);
  await page
    .getByRole("status")
    .filter({ hasText: /Imported \W?music\.wav/ })
    .waitFor();
  await page.getByRole("button", { name: "music.wav audio" }).click();
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByLabel("Focal length (mm)").fill("85");
  await page.getByLabel("Title text").fill("Yamakan · Local production");
  await page.getByRole("button", { name: "Add title", exact: true }).click();
  // Exercise adopted editor controls and verify their canonical result, not just clicks.
  await page.getByTitle("reference.png · 00:00:00:00 → 00:00:03:00").click();
  await page.getByLabel("Playhead").fill("1");
  await page.getByTitle("Split clip at playhead (C)").click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Saved revision" })
    .waitFor();
  const listing = await (
    await page.request.post(`${url}/api/v1/call`, {
      headers: agent,
      data: { name: "yamakan.project.list", arguments: {} },
    })
  ).json();
  const projectId = listing.result[0].id;
  const getProject = async () =>
    (
      await (
        await page.request.post(`${url}/api/v1/call`, {
          headers: agent,
          data: { name: "yamakan.project.open", arguments: { projectId } },
        })
      ).json()
    ).result;
  const saved = await getProject();
  const picture = saved.clips.filter((c) =>
    saved.assets.some((a) => a.id === c.assetId && a.kind === "image"),
  );
  assert.deepEqual(
    picture.map((c) => [c.startFrame, c.durationFrames]),
    [
      [0, 30],
      [30, 60],
    ],
  );
  await page.getByTitle("reference.png · 00:00:00:00 → 00:00:01:00").click();
  await page.getByTitle("Lock track (Alt+L)").first().click();
  await page.keyboard.press("Control+d");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Saved revision" })
    .waitFor();
  assert.equal(
    (await getProject()).clips.length,
    4,
    "Locked duplication must not add a clip",
  );
  await page.getByTitle("Unlock track (Alt+L)").first().click();
  // Reference preview: the saved revision's frame, rendered by the export's
  // plan compiler, and marked stale while the unlock is unsaved.
  await page.getByText(/Stale: save to include your latest edits/).waitFor();
  await page.waitForFunction(
    () => {
      const img = document.querySelector(".reference img");
      return (
        img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0
      );
    },
    null,
    { timeout: 60000 },
  );
  const referenceSrc = await page.locator(".reference img").getAttribute("src");
  const referenceResponse = await page.request.get(
    new URL(referenceSrc, url).href,
  );
  assert.equal(referenceResponse.ok(), true);
  assert.equal(referenceResponse.headers()["content-type"], "image/png");
  const referencePlanHash = referenceResponse.headers()["x-plan-hash"];
  assert.match(referencePlanHash, /^[a-f0-9]{64}$/);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  const link = page.getByRole("link", { name: "Download MP4" });
  await link.waitFor({ timeout: 60000 });
  const response = await page.request.get(
    new URL(await link.getAttribute("href"), url).href,
  );
  assert.equal(response.ok(), true);
  const bytes = await response.body();
  writeFileSync(join(output, "yamakan-browser-workflow.mp4"), bytes);
  await page.screenshot({
    path: join(output, "yamakan-workspace.png"),
    fullPage: true,
  });
  await page.reload();
  await page
    .getByRole("button", { name: /Browser verified production Revision/ })
    .click();
  await page.getByLabel("Focal length (mm)").waitFor();
  assert.equal(await page.getByLabel("Focal length (mm)").inputValue(), "85");
  assert.equal((await getProject()).clips.length, 4);
  // Switching projects autosaves dirty creative work before replacing the editor.
  await page.getByLabel("Scene name").fill("Preserved on switch");
  await page.getByLabel("Project name", { exact: true }).fill("Second project");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Second project", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: /Browser verified production Revision/ })
    .click();
  assert.equal(
    await page.getByLabel("Scene name").inputValue(),
    "Preserved on switch",
  );
  // Operate through the same real agent API to create overlapping audio and a
  // portrait video with embedded sound, then verify real preview media instances.
  const imported = await (
    await page.request.post(`${url}/api/v1/projects/${projectId}/assets`, {
      headers: { ...agent, "X-Asset-Name": "motion-with-sound.mp4" },
      data: await readFile(video),
    })
  ).json();
  assert.ok(imported.asset, "Video import must succeed");
  const changed = imported.project,
    originalAudio = changed.clips.find((c) =>
      changed.assets.some((a) => a.id === c.assetId && a.kind === "audio"),
    );
  changed.clips.push({
    ...originalAudio,
    id: crypto.randomUUID(),
    sourceFrame: 30,
    durationFrames: 60,
  });
  changed.clips.push({
    id: crypto.randomUUID(),
    trackId: changed.tracks[0].id,
    assetId: imported.asset.id,
    startFrame: 0,
    durationFrames: 90,
    sourceFrame: 0,
    title: null,
  });
  const changedResponse = await page.request.post(`${url}/api/v1/call`, {
    headers: agent,
    data: {
      name: "yamakan.project.save",
      arguments: { project: changed, expectedRevision: changed.revision },
    },
  });
  assert.equal(changedResponse.ok(), true);
  await page.reload();
  await page
    .getByRole("button", { name: /Browser verified production Revision/ })
    .click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(
    () =>
      window.__yamakanMedia.filter(
        (e) => e instanceof HTMLAudioElement && e.getAttribute("src"),
      ).length === 2 &&
      window.__yamakanMedia.some(
        (e) =>
          e instanceof HTMLVideoElement && e.getAttribute("src") && e.muted,
      ),
  );
  await page.waitForFunction(() =>
    window.__yamakanMedia
      .filter((e) => e instanceof HTMLAudioElement && e.getAttribute("src"))
      .every((e) => e.readyState >= 2),
  );
  await page.waitForTimeout(350);
  const audioTimes = await page.evaluate(() =>
    window.__yamakanMedia
      .filter((e) => e instanceof HTMLAudioElement && e.getAttribute("src"))
      .map((e) => e.currentTime)
      .sort((a, b) => a - b),
  );
  assert.ok(
    Math.abs(audioTimes[1] - audioTimes[0] - 1) < 0.3,
    "Overlapping clips must keep independent source offsets",
  );
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const beforeRestore = await getProject();
  const historyButton = page
    .locator(".project-list > div")
    .filter({
      has: page.getByRole("button", {
        name: /Browser verified production Revision/,
      }),
    })
    .getByRole("button", { name: "History & recovery" });
  await historyButton.click();
  await page
    .getByRole("button", {
      name: `Restore revision ${saved.revision}`,
      exact: true,
    })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: /Opened \W?Browser verified production/ })
    .waitFor();
  const restored = await getProject();
  assert.equal(restored.revision, beforeRestore.revision + 1);
  assert.equal(restored.clips.length, saved.clips.length);
  assert.equal(restored.assets.length, saved.assets.length);
  await page
    .getByLabel("Scene name")
    .fill("Unsaved draft retained during recovery");
  // Corrupt the committed head pointer through an independent SQLite
  // connection while the editor holds a dirty draft, then recover through UI.
  // The pointer now names another project's snapshot; every revision of this
  // project stays intact, so the latest revision remains restorable.
  const db = new DatabaseSync(join(root, "workspace", "workspace.sqlite"));
  db.prepare(
    "UPDATE projects SET snapshot_hash = (SELECT snapshot_hash FROM projects WHERE project_id != ? LIMIT 1) WHERE project_id = ?",
  ).run(projectId, projectId);
  db.close();
  await page
    .locator(".project-list > div")
    .filter({
      has: page.getByRole("button", {
        name: /Browser verified production Revision/,
      }),
    })
    .getByRole("button", { name: "History & recovery" })
    .click();
  await page
    .getByText("The current project cannot be verified.", { exact: false })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", {
        name: `Restore revision ${restored.revision}`,
        exact: true,
      })
      .isDisabled(),
    true,
  );
  const draftEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download unsaved draft", exact: true })
    .click();
  const draft = await draftEvent;
  await draft.saveAs(join(output, "unsaved-draft.json"));
  const draftProject = JSON.parse(
    await readFile(join(output, "unsaved-draft.json"), "utf8"),
  );
  assert.equal(
    draftProject.scenes[0].name,
    "Unsaved draft retained during recovery",
  );
  await page.screenshot({
    path: join(output, "yamakan-recovery.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", {
      name: `Restore revision ${restored.revision}`,
      exact: true,
    })
    .click();
  await page
    .getByRole("heading", { name: "Browser verified production", exact: true })
    .waitFor();
  await page
    .getByRole("status")
    .filter({ hasText: `revision ${restored.revision + 1}.` })
    .waitFor();
  assert.equal((await getProject()).revision, restored.revision + 1);
  // Arabic interface: right-to-left page, Arabic labels, left-to-right
  // timeline; translated choices still store canonical values; remembered
  // across a reload; then back to English. The switch is named by its
  // visible text (the other language).
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.documentElement.dir === "rtl" &&
      document.documentElement.lang === "ar",
  );
  assert.equal(
    await page.locator("section.timeline").getAttribute("dir"),
    "ltr",
  );
  await page.getByLabel("حجم اللقطة").first().selectOption({ label: "قريبة" });
  await page.getByRole("button", { name: "حفظ", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "حُفظت المراجعة" })
    .waitFor();
  assert.equal((await getProject()).scenes[0].camera.shotScale, "close");
  await page.screenshot({ path: join(output, "arabic-interface.png") });
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dir === "rtl");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.documentElement.dir === "ltr" &&
      document.documentElement.lang === "en",
  );
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .waitFor();
  // Workspace backup, then restore into a new folder, by keyboard only.
  const backupButton = page.getByRole("button", {
    name: "Back up now",
    exact: true,
  });
  await backupButton.focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "Backup created." })
    .waitFor({ timeout: 60000 });
  const restoreButton = page
    .getByRole("button", { name: "Restore to a new folder", exact: true })
    .first();
  await restoreButton.focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "Restored into a new workspace folder" })
    .waitFor({ timeout: 60000 });
  const restoredFolders = join(root, "workspace-recovery", "restored");
  const [restoredRoot] = await readdir(restoredFolders);
  const restoreReceipt = JSON.parse(
    await readFile(join(restoredFolders, restoredRoot, "restore.json"), "utf8"),
  );
  const head = await getProject();
  assert.deepEqual(
    restoreReceipt.projects.find((p) => p.projectId === head.id)?.revision,
    head.revision,
  );
  assert.deepEqual(restoreReceipt.quarantined, []);
  assert.deepEqual(errors, []);
  const receipt = {
    runtime:
      process.env.YAMAKAN_BROWSER_CHANNEL ||
      process.env.DARZAIN_BROWSER_CHANNEL ||
      "Microsoft Edge",
    fixture: "FFmpeg test pattern and sine audio; not AI generation",
    steps: [
      "project create",
      "image import",
      "audio import",
      "timeline add",
      "scene camera edit",
      "title",
      "split at one second",
      "locked duplicate rejection",
      "save",
      "preview",
      "reference preview frame (plan-compiled) with stale notice",
      "Arabic interface (RTL page, LTR timeline, remembered across reload)",
      "workspace backup and restore into a new folder (keyboard)",
      "export",
      "download",
      "reload",
      "reopen",
      "autosave on project switch",
      "video import via agent API",
      "independent overlapping audio",
      "embedded video audio muted",
      "restore older revision through UI",
      "detect corrupt committed head pointer",
      "recover project through UI",
      "download unsaved draft before restoring corrupt open project",
    ],
    focalLengthMm: 85,
    clipsAfterSplit: 4,
    overlappingAudioOffsets: audioTimes,
    referencePlanHash,
    pageErrors: errors,
    artifactBytes: bytes.length,
  };
  writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(receipt);
} finally {
  await browser?.close();
  if (child.exitCode === null) {
    const exited = once(child, "exit");
    child.send("shutdown");
    await exited;
  }
}
