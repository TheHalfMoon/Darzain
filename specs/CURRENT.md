# Yamakan current frontier

Updated: 2026-10-11. Canonical repository: `TheHalfMoon/Yamakan` (default branch `main`).

**Phase:** P01 authority (T1–T3), implementation authorized by the [founder decision record](../docs/FOUNDER_DECISION_RECORD.md) against plan `edbaba6c4f5f2f42e968b4ab2273c8e11620d9af`. [IMPLEMENTATION_PLAN](../docs/IMPLEMENTATION_PLAN.md) is the sole task authority; [operational contracts](../docs/OPERATIONAL_CONTRACTS.md) define protocols. Release verdict: **NO-GO** until every T10 gate passes.

**Verified main:** `559ac7f7` (planning PRs #3 `4e2f4b2b`, #4 `237518ef`, #5 `559ac7f7` merged with normal merge commits; tree identical to `edbaba6c`).

| Task | Status | Evidence |
|---|---|---|
| T1 command boundary and import guard | In review on `feat/t1-command-boundary` | See the T1 PR body |
| T2 SQLite snapshot authority | Next; depends on T1 | — |
| T3–T10 | Not started | — |

## T1 delivered surface

- `core/command/`: envelope v1 (`apiVersion, operation, requestId, parameters`), stable error codes with retry policy and HTTP mapping, versioned resource policy with content hash, and a scope-declaring command registry. `darzain.*` names and the `{name, arguments}` body remain compatibility aliases.
- Distinct authentication paths: an in-memory browser session cookie (`browser-ui` principal; cookie state changes must be same-origin) and the workspace bearer token for local clients (`local-client`).
- `sdk/client.ts` typed TypeScript client; the CLI and UI use it. `mcp/main.ts` registry-derived MCP stdio server (`npm run mcp`).
- `scripts/import-guard.mjs` + `docs/provenance/import-policy.json`, run by `npm run provenance:check`: excluded donor paths, deny-by-default donor roots, process-spawn allowlist, and no shell/exec/eval in production roots.

## Deferred inside T1 scope (explicit)

- `expectedRevision`/`projectId` at envelope level and idempotency receipts land with T2's transactional commit; T1 keeps them in command parameters.
- MCP asset import (raw bytes) waits for T4 streaming import with explicit grants.
- Both MVP principals hold all MVP scopes (trusted local account). Narrower grants are enforced by the registry and tested, but not yet issued.

## Tooling status (actual, 2026-10-11)

| Tool | Status |
|---|---|
| Jev 2026.919.0 | Installed; **blocked**: no TypeSafe API key on this machine (`JEV_API_KEY` unset, no stored login). No Jev result is claimed. |
| Alibaba OCR 1.12.13 | Installed; no LLM provider configured. Only **delegate mode** (file/rule selection; host agent performs the review) runs. Not a model-backed OCR review. |
| Graft 0.21.1 | Keyless structural build works (`graft build`, no `--deep`). |
| PStack | Markdown playbook at `~/.tooling/pstack`; applied as review discipline by the agent, not as an executed automated check. |
| REA | Not reachable from the Claude Code session on this machine (no `rea` binary on PATH; MCP registration is Codex-only). |
| E2E | Real Windows runs: `npm test` and `npm run test:e2e` (Microsoft Edge, headless). |

## Blockers

- **Disk:** C: has ~3 GiB free (99% used); D: has ~20 GiB free. Clone and npm cache live on D:. T4's ≥2 GiB import and T10 media tests need a disk-capacity preflight and may need space freed by the founder.
- Jev key and an OCR LLM backend are founder-provided resources; without them those reviews stay recorded as unavailable.

**Next executable task:** T2 SQLite transactional snapshot authority, after T1 merges.
