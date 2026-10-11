// Deny-by-default source import guard. Pure: callers supply the file list and
// a text reader so tests can exercise negative fixtures without touching disk.
const REQUIRED = [
  "source",
  "sha",
  "original",
  "imported",
  "sha256",
  "importedSha256",
];
const CHILD_PROCESS =
  /from\s+["'](?:node:)?child_process["']|require\(\s*["'](?:node:)?child_process["']\s*\)|import\(\s*["'](?:node:)?child_process["']\s*\)/;
const FORBIDDEN = [
  [/(?<![.\w])exec(?:Sync)?\s*\(/, "shell-interpreting exec"],
  [/\bspawnSync\s*\(|\bexecFileSync\s*\(/, "synchronous process execution"],
  [/\bshell\s*:\s*(?!false\b)/, "shell option"],
  [/(?<![.\w])eval\s*\(|\bnew\s+Function\s*\(/, "dynamic code evaluation"],
];
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

export function checkImports({ files, read, ledger, policy }) {
  const violations = [];
  const excluded = policy.excludedPaths.map((e) => ({
    ...e,
    regex: new RegExp(e.pattern, "i"),
  }));
  const ledgered = new Set();
  for (const entry of ledger) {
    for (const key of REQUIRED)
      if (typeof entry[key] !== "string" || !entry[key])
        violations.push(`Ledger entry is missing ${key}: ${entry.imported}`);
    if (!Array.isArray(entry.modifications))
      violations.push(`Ledger entry lacks modifications: ${entry.imported}`);
    for (const e of excluded)
      if (
        e.regex.test(entry.original ?? "") ||
        e.regex.test(entry.imported ?? "")
      )
        violations.push(
          `Excluded donor path in ledger: ${entry.original} (${e.reason})`,
        );
    ledgered.add(entry.imported);
  }
  const local = new Set(policy.localFilesInDonorRoots.map((f) => f.path));
  for (const file of files) {
    for (const e of excluded)
      if (e.regex.test(file))
        violations.push(`Excluded donor path present: ${file} (${e.reason})`);
    if (
      policy.donorRoots.some((r) => file.startsWith(`${r}/`)) &&
      !ledgered.has(file) &&
      !local.has(file)
    )
      violations.push(`Unrecorded file in donor root: ${file}`);
    const production =
      policy.productionRoots.some((r) => file.startsWith(`${r}/`)) &&
      SOURCE.test(file) &&
      !/\.test\.[cm]?[jt]sx?$/.test(file);
    if (!production) continue;
    const text = read(file);
    if (
      CHILD_PROCESS.test(text) &&
      !policy.processSpawnAllowlist.includes(file)
    )
      violations.push(`Process execution outside the allowlist: ${file}`);
    for (const [pattern, label] of FORBIDDEN)
      if (pattern.test(text)) violations.push(`Forbidden ${label}: ${file}`);
  }
  for (const file of ledgered)
    if (!files.includes(file))
      violations.push(`Ledger references a missing file: ${file}`);
  return violations;
}
