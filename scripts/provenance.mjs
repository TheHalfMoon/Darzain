import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { checkImports } from "./import-guard.mjs";
const ledger = JSON.parse(readFileSync("docs/provenance/imports.json", "utf8"));
const policy = JSON.parse(
  readFileSync("docs/provenance/import-policy.json", "utf8"),
);
for (const entry of ledger) {
  if (!/^[a-f0-9]{40}$/.test(entry.sha))
    throw new Error(`Unpinned source: ${entry.imported}`);
  const hash = createHash("sha256")
    .update(readFileSync(entry.imported))
    .digest("hex");
  if (hash !== entry.importedSha256)
    throw new Error(`Unrecorded source change: ${entry.imported}`);
  if (!entry.modifications.length && hash !== entry.sha256)
    throw new Error(`Unreported modification: ${entry.imported}`);
}
for (const file of [
  "LICENSE",
  "NOTICE",
  "notices/ai-video-production-editor-LICENSE",
  "notices/Ninerr-LICENSE",
  "notices/OpenCut-LICENSE",
])
  if (!existsSync(file)) throw new Error(`Missing notice: ${file}`);
// Pinned fonts: unmodified files whose bytes match the ledger, each with its
// license notice. Rendering verifies the same hashes before use.
const fonts = JSON.parse(readFileSync("docs/provenance/fonts.json", "utf8"));
let fontFiles = 0;
for (const family of fonts) {
  if (!existsSync(family.licenseFile))
    throw new Error(`Missing font license: ${family.licenseFile}`);
  for (const file of family.files) {
    const hash = createHash("sha256")
      .update(readFileSync(file.imported))
      .digest("hex");
    if (hash !== file.sha256) throw new Error(`Font changed: ${file.imported}`);
    fontFiles++;
  }
}
const skip = new Set([
  ".git",
  "node_modules",
  "dist",
  "work",
  ".yamakan",
  ".darzain",
  "graft",
]);
const files = readdirSync(".", { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile())
  .map((d) =>
    `${d.parentPath}/${d.name}`.replaceAll("\\", "/").replace(/^\.\//, ""),
  )
  .filter((f) => !skip.has(f.split("/")[0]))
  // Native build outputs are not source.
  .filter((f) => !f.startsWith("native/procd/target/"));
const violations = checkImports({
  files,
  read: (f) => readFileSync(f, "utf8"),
  ledger,
  policy,
});
if (violations.length)
  throw new Error(`Import guard failed:\n${violations.join("\n")}`);
console.log(
  `Verified ${ledger.length} pinned source records, ${fontFiles} pinned font files, required notices and import guard over ${files.length} files.`,
);
