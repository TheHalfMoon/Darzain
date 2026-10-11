// Migrates a legacy Darzain workspace into a new Yamakan workspace without
// modifying the original. Usage:
//   npm run migrate -- <legacy workspace> <new empty folder> [--accept-latest-verified]
import { migrateLegacyWorkspace } from "../core/migrate.ts";
import { toCommandError } from "../core/command/errors.ts";

const args = process.argv.slice(2);
const accept = args.includes("--accept-latest-verified");
const [source, destination] = args.filter((a) => !a.startsWith("--"));
if (!source || !destination)
  throw new Error(
    "Usage: npm run migrate -- <legacy workspace> <new empty folder> [--accept-latest-verified]",
  );
try {
  const report = await migrateLegacyWorkspace(source, destination, {
    acceptLatestVerified: accept,
  });
  for (const p of report.projects)
    console.log(
      `${p.status.padEnd(8)} ${p.projectId}${p.status === "migrated" ? ` revisions ${p.migratedRevisions.join(",")}` : ` — ${p.reason}`}`,
    );
  console.log(
    `Source unchanged: ${report.sourceUnchanged} (${report.sourceFiles} files, manifest ${report.sourceManifestSha256}). Report: migration/report.json in the new workspace.`,
  );
  if (report.projects.some((p) => p.status === "skipped")) process.exitCode = 2;
} catch (e) {
  const error = toCommandError(e);
  console.error(JSON.stringify({ code: error.code, message: error.message }));
  process.exitCode = 1;
}
