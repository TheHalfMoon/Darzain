// Deny-by-default source import guard. Pure: callers supply the file list and
// a text reader so tests can exercise negative fixtures without touching disk.
// This is a tripwire over source text, not a sandbox: the enforcement boundary
// is the command registry, whose strict schemas accept no executable input.
const REQUIRED = [
  "source",
  "sha",
  "original",
  "imported",
  "sha256",
  "importedSha256",
];
// Any route to process creation, module loading by computed name or code
// evaluation. Allowlisted spawn modules may only use the named imports below.
const PROCESS_ACCESS =
  /child_process|spawn_sync|getBuiltinModule|process\.binding|createRequire|["'](?:node:)?(?:vm|worker_threads|cluster)["']/;
// Named spawn/execFile imports, or type-only imports (erased at runtime).
const ALLOWED_PROCESS_IMPORT =
  /^import\s*(?:\{\s*((?:spawn|execFile)(?:\s*,\s*(?:spawn|execFile))*)\s*,?\s*\}|type\s*\{\s*\w+(?:\s*,\s*\w+)*\s*,?\s*\})\s*from\s*["']node:child_process["'];?$/;
const FORBIDDEN = [
  [
    /\bexecSync\b|\bspawnSync\b|\bexecFileSync\b/,
    "synchronous process execution",
  ],
  [/(?<![\w$.])exec\s*\(/, "shell-interpreting exec"],
  [/["']?\bshell["']?\s*:\s*(?!false\b)/, "shell option"],
  [/\beval\b\s*[(),]|(?<![\w$])Function\s*\(/, "dynamic code evaluation"],
  // Module specifiers must be one complete string literal.
  [/\bimport\s*\(\s*(?!(["'])[^"'`]*\1\s*\))/, "computed dynamic import"],
  [/\brequire\s*\(\s*(?!(["'])[^"'`]*\1\s*\))/, "computed require"],
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
    const allowed = policy.processSpawnAllowlist.includes(file);
    // Formatters wrap long named imports; judge each import as one statement.
    const statements = text.replace(
      /import\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?/g,
      (m) => m.replace(/\s+/g, " "),
    );
    if (allowed && /\bshell\b/.test(text))
      violations.push(`Shell reference in a process module: ${file}`);
    for (const line of statements.split("\n")) {
      if (!PROCESS_ACCESS.test(line)) continue;
      if (!allowed || !ALLOWED_PROCESS_IMPORT.test(line.trim())) {
        violations.push(
          allowed
            ? `Process access other than a named spawn/execFile import: ${file}`
            : `Process execution outside the allowlist: ${file}`,
        );
        break;
      }
    }
    for (const [pattern, label] of FORBIDDEN)
      if (pattern.test(text)) violations.push(`Forbidden ${label}: ${file}`);
  }
  for (const file of ledgered)
    if (!files.includes(file))
      violations.push(`Ledger references a missing file: ${file}`);
  return violations;
}
