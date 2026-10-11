import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
const ledger = JSON.parse(readFileSync("docs/provenance/imports.json", "utf8"));
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
])
  if (!existsSync(file)) throw new Error(`Missing notice: ${file}`);
console.log(
  `Verified ${ledger.length} pinned source records and required notices.`,
);
