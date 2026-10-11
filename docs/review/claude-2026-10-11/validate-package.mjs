// Mechanical package validation for the review branch. Port of the Codex validator without
// its private local inputs (rtk, work/ sources). Not an architecture, runtime or security approval.
// Usage (repo root): node docs/review/claude-2026-10-11/validate-package.mjs [--write]
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const root = process.cwd(), main = "0d3bdacb51188294ba8d36ce2b218db72f6073a6", reviewed = "419bc356eaa6738ba546f38310687739177da6bb";
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).split("\n").filter(Boolean);
const tracked = [...new Set([...git("ls-files", "docs", "specs", "AGENTS.md", "README.md"), ...git("ls-files", "--others", "--exclude-standard", "docs", "specs")])].filter((p) => existsSync(p));
const required = ["PRODUCT_VISION","COMPETITOR_MATRIX","SOURCE_CATALOG","SOURCE_REUSE_LEDGER","REA_TARGET_MATRIX","REA_FINDINGS","ARCHITECTURE_OPTIONS","ARCHITECTURE_DECISION","PROVIDER_MATRIX","MODEL_CAPABILITIES","COST_ROUTER","PROJECT_DATA_MODEL","AGENT_MCP_ARCHITECTURE","SECURITY","LOCAL_INFERENCE","TEST_STRATEGY","E2E_ACCEPTANCE","ROADMAP","IMPLEMENTATION_PLAN","CLAUDE_REVIEW_HANDOFF","FOUNDER_DECISION_PACKET","review/CLAUDE_INDEPENDENT_REVIEW"].map((x) => "docs/" + x + ".md").concat("AGENTS.md", "specs/CURRENT.md", "docs/review/claude-2026-10-11/evidence.json");
const failures = [];
for (const p of required) if (!existsSync(p) || statSync(p).size < 100) failures.push({ missing: p });
let links = 0, json = 0;
for (const rel of tracked) {
  if (rel.endsWith(".json")) { try { JSON.parse(readFileSync(rel)); json++; } catch (e) { failures.push({ json: rel, error: e.message }); } }
  if (rel.endsWith(".md") && !rel.startsWith("docs/history/darzain/")) {
    const text = readFileSync(rel, "utf8");
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      let t = m[1].replace(/^<|>$/g, "").split("#")[0];
      if (!t || /^[a-z]+:/i.test(t)) continue;
      const actual = resolve(dirname(rel), decodeURIComponent(t));
      if (!actual.startsWith(root)) failures.push({ externalLocalLink: rel, target: t });
      else if (!existsSync(actual)) failures.push({ brokenLink: rel, target: t });
      links++;
    }
  }
  const content = readFileSync(rel, "latin1");
  if (/gh[pousr]_[A-Za-z0-9]{30,}|sk-proj-[A-Za-z0-9_-]{24,}|sk-ant-[A-Za-z0-9_-]{20,}|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/.test(content)) failures.push({ possibleSecret: rel });
}
const changed = [...new Set([...git("diff", "--name-only", main), ...git("ls-files", "--others", "--exclude-standard")])];
for (const p of changed) if (!/^(docs\/|specs\/CURRENT\.md$|AGENTS\.md$|README\.md$|manifest\.json$|validation\.json$)/.test(p)) failures.push({ nonPlanningChange: p });
const result = { version: 1, baseMain: main, reviewedHead: reviewed, scope: "Mechanical package validation only; not architecture/runtime/security approval and not founder approval", status: failures.length ? "FAIL" : "PASS", requiredFiles: required.length, files: tracked.length, jsonParsed: json, linksChecked: links, historicalLinkPolicy: "docs/history/darzain excluded from current-link validation", productionCodeChanged: changed.some((p) => !/^(docs\/|specs\/|AGENTS\.md|README\.md|manifest\.json|validation\.json)/.test(p)), failures };
console.log(JSON.stringify(result, null, 2));
if (process.argv.includes("--write") && !failures.length) {
  writeFileSync("validation.json", JSON.stringify(result, null, 2) + "\n");
  const files = [...tracked, "AGENTS.md", "README.md", "validation.json"].filter((p, i, a) => a.indexOf(p) === i && p !== "manifest.json").sort().map((p) => ({ path: p, bytes: statSync(p).size, sha256: sha(p) }));
  writeFileSync("manifest.json", JSON.stringify({ version: 1, product: "Yamakan", baseMain: main, reviewedHead: reviewed, planningBranch: "review/claude-independent-419bc356", status: "independent Claude review recorded; pending founder approval", selfExcluded: true, files }, null, 2) + "\n");
}
if (failures.length) process.exitCode = 1;
