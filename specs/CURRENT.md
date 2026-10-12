# Yamakan current frontier

Updated: 2026-10-12. Canonical repository: `TheHalfMoon/Yamakan` (default branch `main`).

**Phase:** P01 authority (T1–T3), implementation authorized by the [founder decision record](../docs/FOUNDER_DECISION_RECORD.md) against plan `edbaba6c4f5f2f42e968b4ab2273c8e11620d9af`. [IMPLEMENTATION_PLAN](../docs/IMPLEMENTATION_PLAN.md) is the sole task authority; [operational contracts](../docs/OPERATIONAL_CONTRACTS.md) define protocols. Release verdict: **NO-GO** until every T10 gate passes.

**Verified main:** `24dd0a2a` (T5 PR #11 merged at reviewed head `6a70eac6`; tree identical). T4b #10 `1ce242b1`, T4a #9 `2b0db1bd`, T3 #8 `539688b3`, T2 #7 `27e3c7da`, T1 #6 `c1664985`; planning PRs #3–#5 merged earlier.

| Task                                       | Status                                                               | Evidence                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1 command boundary and import guard       | **Merged** (#6, `c1664985`)                                          | Combined + security fresh-context reviews (3 cycles, all must-fix resolved); CI `qualify` on exact head; Windows tests + Edge E2E                                                                                                                                           |
| T2 SQLite snapshot authority               | **Merged** (#7, `27e3c7da`)                                          | Combined + security reviews (3 cycles, 3 must-fix resolved); CI `qualify` on exact head after a Linux-only permission fix; Windows tests + Edge E2E                                                                                                                         |
| T3 canonical v1 and migration              | **Merged** (#8, `539688b3`)                                          | Combined + security reviews (3 cycles; 4 must-fix resolved incl. source-aliasing writes); CI `qualify` on exact head; Windows tests + Edge E2E                                                                                                                              |
| T4a process ownership and owned probes     | **Merged** (#9, `2b0db1bd`)                                          | Combined + security reviews (3 cycles; 4 must-fix resolved incl. pipe-name traversal); CI `qualify` on exact head; 13 Windows ownership/probe tests; WMI job escape recorded as T9 release blocker                                                                          |
| T4b streaming import, asset tables, ≥2 GiB | **Merged** (#10, `1ce242b1`)                                         | Combined + security reviews (3 cycles + delta; must-fix resolved incl. slow-loris and admission race); CI `qualify` on exact head after a Linux-only publish-race fix; large-import receipt: 2.24 GB, peak 154 MiB ≤ 300 MiB                                                |
| T5 durable jobs + VFR derivatives          | **Merged** (#11, `24dd0a2a`)                                         | Combined + security reviews (2 cycles + deltas; 6 must-fix resolved incl. VFR rotation, upload loss on graceful stops, runaway conversions, orphaned objects); CI `qualify` on exact head (fresh build + E2E); Windows FFmpeg kill tests at service, owner and launch seams |
| T6 timeline reducers and donor adapters    | In review on `feat/t6-timeline-reducers`                             | Windows tests + fresh-build Edge E2E                                                                                                                                                                                                                                        |
| T7–T10                                     | Not started (T7 fonts/ASS groundwork on `feat/t7-render-typography`) | —                                                                                                                                                                                                                                                                           |

## T6 surface (in review)

- Canonical `yamakan.project` v2: audio gain and linear fades, scenes with shots. Edit view gains optional gain/fade/shot fields (lossless projection).
- `core/timeline/operations.ts`: typed operations (scene/shot, track, clip add/trim/split/move/remove, title, audio) reduced by `applyBatch` (1–64 operations, validated once). OpenCut overlap (placement checks) and snapping (`clip.move` with an optional `snapTicks`, start or end to the nearest clip edge) adapted behind checked tick types and qualified by fixtures (`core/donors/opencut`, pinned and noticed).
- Schema v4: `edit_history`, `edit_cursor`. `yamakan.project.applyBatch`, `undo`, `redo` are revision-bound mutations; a stale undo conflicts; only the principal that wrote a step may undo or redo it; non-batch commits clear history. Commits refuse when free space is below the import reserve plus one snapshot.
- The editor applies split and delete through the same reducer on its local edit view (`src/edit-ops.ts`) and clamps fades on drag/trim with the shared rule, so UI and tool edits give identical canonical bytes.
- Render applies audio gain (`volume`) and fades (`afade`).

## T5 surface (merged)

- Schema v3: `jobs` (intent: project, frozen revision, idempotency key, payload), `attempts` (generation, worker PID, outcome) and `supervisor` (generation). `core/jobs.ts` `JobSupervisor`: every transition is a fenced compare-and-swap in one transaction; a restart takes a new generation, marks earlier attempts failed and re-queues their jobs (local work only). Unknown payloads are quarantined; admission counts only active jobs (`activeJobs` 128).
- Export renders run on an owned FFmpeg worker (`renderWallSeconds` 180, `renderMemoryBytes` 2 GiB) whose identity is durable before it resumes; partial outputs are never registered, and success, artifact and cancellation are decided by the database.
- T5b: variable-frame-rate uploads return 202 with a job. The constant-rate derivative attaches as the asset's selected version with lineage; the original object stays retained; attachment and job success commit together. Import is split into stage and attach.

## T4b surface (merged)

- Streaming import: staged with incremental SHA-256, declared-size budget, early signature check, dynamic disk preflight, owned probe, streamed CAS publication, and object/version rows committed with the snapshot. HTTP uploads require Content-Length; playback/download stream byte ranges from disk.
- Schema v2: `asset_objects`, `asset_versions` (probe incl. time base, frame rate, VFR). Ordered transactional schema steps.
- `npm run qualify:large-import`: receipt in `docs/evidence/qualification/t4-large-import.json`.

## Release blockers recorded

- **WMI escape from worker jobs:** a compromised worker can start a process outside its Job Object via WMI. Requires a restricted/low-integrity/AppContainer worker token (T9).

## T4a surface (merged)

- `native/procd` (Rust, no dependencies): owns probe workers now; FFmpeg rendering moves onto it in T5. Each worker is created suspended inside its own KILL_ON_JOB_CLOSE, single-process Job Object (atomic `PROC_THREAD_ATTRIBUTE_JOB_LIST`, no breakaway), with an inherited-handle allowlist, a minimal environment, an executable allowlist and MSVCRT-exact argument quoting. Output travels over anonymous pipes relayed by procd (no named objects). Workers resume only after the service records their identity. Service death → procd stdin EOF → jobs terminated; procd death → the OS closes the jobs.
- `core/process/owner.ts` + `workers.ts`: one owner per service; FFmpeg/ffprobe resolved to absolute paths once. Non-Windows hosts run an explicitly unqualified development mode.
- `probe()` runs through the owner: file-only protocol whitelist, wall-clock and Job memory limits, bounded output, `MEDIA_INVALID` without paths. Records time base and frame rate and identifies VFR.
- Windows evidence: argv fidelity, minimal env, suspended-until-recorded, cancellation, service kill, owner kill, owner death between create and resume, and service death during identity recording all leave no live or suspended worker; a worker cannot start children; malformed protocol input is refused.

## T3 surface (merged)

- `core/time.ts`: integer flicks (705,600,000/s) with BigInt intermediates, explicit rounding and safe-integer checks; frame/PTS/time-base conversions.
- `core/canonical.ts`: `yamakan.project` formatVersion 1 (flicks, rational fps, language, source time base). Newer versions are inspectable but never edited or rewritten. The 30 fps editing shape is a lossless projection; unrepresentable values fail with `CAPABILITY_UNAVAILABLE`.
- The workspace DB stores canonical snapshots (`yamakan.project/1`); T2 `yamakan.edit-view/1` snapshots upgrade on read and are never rewritten. `yamakan.project.export` returns canonical JSON.
- `core/migrate.ts` + `npm run migrate`: legacy Darzain workspace → new root. The source is only read; its full file manifest is hashed before and after, and the migration fails if anything changed. Revisions keep their numbers; media is re-verified by hash. A project with an unverifiable head is skipped unless `--accept-latest-verified` is given, and the report says so.
- The server refuses to open a legacy root and no longer falls back to `.darzain`.

## T2 surface (merged)

- `core/store.ts` `ProjectStore` is now SQLite-backed (`workspace.sqlite`, WAL, `synchronous=FULL`, FK on, `STRICT` tables, `user_version` 1). Snapshot bytes, head CAS, revision, request receipt and outbox event commit in one `BEGIN IMMEDIATE` transaction; replay is checked before the revision. A newer DB version or failed `quick_check` refuses to open (`RECOVERY_REQUIRED`).
- `core/service-lock.ts`: one service per workspace through SQLite exclusive locking; the OS releases it on process death, so there is no manual unlock.
- The pre-database file store is `core/legacy-store.ts` (`LegacyProjectStore`), kept as the read-only migration source for T3. Legacy project folders in a workspace are listed as "requires migration", never adopted silently.
- Media objects stay content-addressed files outside the DB; the `asset_objects` table and GC follow T4/T9.

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

| Tool                | Status                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jev 2026.919.0      | Installed; **blocked**: no TypeSafe API key on this machine (`JEV_API_KEY` unset, no stored login). No Jev result is claimed.                            |
| Alibaba OCR 1.12.13 | Installed; no LLM provider configured. Only **delegate mode** (file/rule selection; host agent performs the review) runs. Not a model-backed OCR review. |
| Graft 0.21.1        | Keyless structural build works (`graft build`, no `--deep`).                                                                                             |
| PStack              | Markdown playbook at `~/.tooling/pstack`; applied as review discipline by the agent, not as an executed automated check.                                 |
| REA                 | Not reachable from the Claude Code session on this machine (no `rea` binary on PATH; MCP registration is Codex-only).                                    |
| E2E                 | Real Windows runs: `npm test` and `npm run test:e2e` (Microsoft Edge, headless).                                                                         |

## Blockers

- **Disk:** C: has ~3 GiB free (99% used); D: has ~20 GiB free. Clone and npm cache live on D:. T4's ≥2 GiB import and T10 media tests need a disk-capacity preflight and may need space freed by the founder.
- Jev key and an OCR LLM backend are founder-provided resources; without them those reviews stay recorded as unavailable.

**Next executable task:** T7 render plan and typography (versioned plan compiler, ASS/libass titles with pinned OFL Arabic/Latin fonts) after T6 merges.

**Recorded for T9 from T6 reviews:** undo/redo write full snapshots and consume the 10,000-revision budget (compaction or head re-pointing); edit history is pruned only by MAX_REVISION; track overlap is enforced by reducers, not by canonical validation (needs a migration decision for existing projects); a request retried across the snapshot format change (`/1`→`/2`) gets IDEMPOTENCY_MISMATCH. Undo binds to the principal, and the CLI and all MCP agents share `local-client` (per-agent identities come with grants).

**Recorded for T9 from T5 reviews:** GC for crash-window orphans and hidden retained originals; a retry/discard command for `reconciliationRequired` jobs; attempt reason codes instead of error text; conversion space in the import reservation.
