# Yamakan current frontier

Updated: 2026-10-12. Canonical repository: `TheHalfMoon/Yamakan` (default branch `main`).

**Phase:** P01 authority (T1–T3), implementation authorized by the [founder decision record](../docs/FOUNDER_DECISION_RECORD.md) against plan `edbaba6c4f5f2f42e968b4ab2273c8e11620d9af`. [IMPLEMENTATION_PLAN](../docs/IMPLEMENTATION_PLAN.md) is the sole task authority; [operational contracts](../docs/OPERATIONAL_CONTRACTS.md) define protocols. Release verdict: **NO-GO** until every T10 gate passes.

**Verified main:** `e9944262` (T8b PR #15 merged at reviewed head `4e22895e`; tree identical). T8a #14 `530b1c51`, T7 #13 `54d2f9ba`, T6 #12 `f6843990`, T5 #11 `24dd0a2a`, T4b #10 `1ce242b1`, T4a #9 `2b0db1bd`, T3 #8 `539688b3`, T2 #7 `27e3c7da`, T1 #6 `c1664985`; planning PRs #3–#5 merged earlier.

| Task                                       | Status                                   | Evidence                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1 command boundary and import guard       | **Merged** (#6, `c1664985`)              | Combined + security fresh-context reviews (3 cycles, all must-fix resolved); CI `qualify` on exact head; Windows tests + Edge E2E                                                                                                                                           |
| T2 SQLite snapshot authority               | **Merged** (#7, `27e3c7da`)              | Combined + security reviews (3 cycles, 3 must-fix resolved); CI `qualify` on exact head after a Linux-only permission fix; Windows tests + Edge E2E                                                                                                                         |
| T3 canonical v1 and migration              | **Merged** (#8, `539688b3`)              | Combined + security reviews (3 cycles; 4 must-fix resolved incl. source-aliasing writes); CI `qualify` on exact head; Windows tests + Edge E2E                                                                                                                              |
| T4a process ownership and owned probes     | **Merged** (#9, `2b0db1bd`)              | Combined + security reviews (3 cycles; 4 must-fix resolved incl. pipe-name traversal); CI `qualify` on exact head; 13 Windows ownership/probe tests; WMI job escape recorded as T9 release blocker                                                                          |
| T4b streaming import, asset tables, ≥2 GiB | **Merged** (#10, `1ce242b1`)             | Combined + security reviews (3 cycles + delta; must-fix resolved incl. slow-loris and admission race); CI `qualify` on exact head after a Linux-only publish-race fix; large-import receipt: 2.24 GB, peak 154 MiB ≤ 300 MiB                                                |
| T5 durable jobs + VFR derivatives          | **Merged** (#11, `24dd0a2a`)             | Combined + security reviews (2 cycles + deltas; 6 must-fix resolved incl. VFR rotation, upload loss on graceful stops, runaway conversions, orphaned objects); CI `qualify` on exact head (fresh build + E2E); Windows FFmpeg kill tests at service, owner and launch seams |
| T6 timeline reducers and donor adapters    | **Merged** (#12, `f6843990`)             | Combined + security reviews (cycle + deltas; 4 must-fix resolved: editor shares the reducer, still images, per-writer undo, parity without blanking); CI `qualify` on exact head (fresh build + E2E)                                                                        |
| T7 render plan and typography              | **Merged** (#13, `54d2f9ba`)             | Combined + security reviews (cycle + deltas; 4 must-fix resolved: per-clip inputs, frame-exact cues, robust fit check, stale benchmark); CI `qualify` on exact head; typography frames at `be95f1c` (Arabic review **pending**)                                             |
| T8a reference preview                      | **Merged** (#14, `530b1c51`)             | Combined + security reviews (2 cycles + deltas; 6 must-fix resolved: frame-exact previews at any source rate, black clip first frames, vacuous tests, queue flooding, cache bound); CI `qualify` on exact head; latency receipt at `c958b97`                                |
| T8b localized UI                           | **Merged** (#15, `e9944262`)             | Combined + security reviews (cycle + deltas; 2 must-fix resolved: bidi isolation of inserted text, language switch named by its visible text); CI `qualify` on exact head; Arabic interface screenshot (native review **pending**)                                          |
| T9a recovery: backups, restore, GC         | In review on `feat/t9-recovery-boundary` | Windows tests (online backup during concurrent edits/imports/GC restores identical snapshots; damaged media quarantined; corrupt DB diagnosed byte-identically) + fresh-build Edge E2E (keyboard backup and restore)                                                        |
| T9b local boundary, T10                    | Not started                              | —                                                                                                                                                                                                                                                                           |

## T9 split

T9 exceeds the plan's four-day bound, so it is split at its interface: **T9a** recovery (online backup with pinned media, restore into a new root through the interface and CLI, read-only diagnosis, garbage collection of crash leftovers) and **T9b** local boundary (token ACL so a second Windows account is denied, loopback hardening so another local port cannot obtain credentials or read media, worker sandbox token for the WMI release blocker, authenticated CLI/MCP and the keyboard/RTL journey).

## T9a surface (in review)

- `core/recovery.ts`: a backup is the database copied online with SQLite's backup API through the service's own connection (the copy holds every commit up to its completion), then every ready media object it registers, re-hashed as copied, then a manifest (`backup.json`, `yamakan.backup/1`) written last; a folder without a manifest is listed as incomplete and cannot be restored. While a backup runs, the store holds objects: nothing deletes an object file (a released staged version's file is left for garbage collection).
- Backups leave out the client token, the service lock, exports (an export of a restored workspace is made again; its download says so), staging and preview caches, as each manifest states. Damaged media found while backing up is recorded in the manifest and not copied; the source file is left as found.
- Restore builds a new, empty root only: the database must match the manifest's hash, project heads must match the manifest, and each object is verified against its content address; what cannot be verified is quarantined (registered, never served) and listed in `restore.json`. A failed restore removes only the folder it built.
- Service commands (no host paths accepted; folders chosen by the service under `YAMAKAN_RECOVERY`, default `<workspace>-recovery`, which must be outside the workspace): `yamakan.workspace.backup`, `.backups`, `.restore` (by backup id, into `restored/<id>-<n>`), `.collectGarbage`. The project list has a Backups panel (back up, list, restore into a new folder) in English and Arabic.
- `npm run recovery -- diagnose <workspace> [--verify-objects]` reads a workspace without changing it (the database and its WAL are examined as copies); `restore <backup> <new folder>`; `backup <workspace>` while no service runs. A damaged database now refuses to open with `RECOVERY_REQUIRED` and that guidance, instead of a raw SQLite error.
- Garbage collection (at service start and on command) removes only crash leftovers older than an hour: unregistered objects, object-store temporary files and upload staging files; never a registered object, never during a backup, and not in a project with a publication in flight.

## T8b surface (merged)

- `src/i18n.ts`: English and Arabic interface messages with placeholders, a test that both languages define every message with the same placeholders, and Arabic-Indic digits for numbers in Arabic.
- The page follows the language: `<html lang dir>` is `ar`/`rtl` for Arabic; the timeline keeps left-to-right time (`dir="ltr"`); layout CSS uses logical properties. The choice is remembered (local storage, optional) and defaults to the browser language. Title text is shaped by libass at render time, independent of the interface language.
- Names and other inserted text are wrapped in directional isolates (and user text uses `dir="auto"`), so a Latin name cannot reorder an Arabic sentence and bidi controls stay contained. Status messages re-translate when the language changes. Stored defaults (scene, track names) stay canonical English, as the core creates them; only what the interface shows is translated.
- Not localized yet: messages from the service (errors are English), strings inside the donor timeline component, the browser's own file picker, default scene and track names (stored canonical English, so shown in English in the Arabic interface), and the few interface errors raised as exceptions (track missing, asset missing, import failed), which stay in the language active when they were raised.
- Evidence: `docs/evidence/qualification/t8b-arabic-interface.png` (from the browser E2E); **native Arabic review of the interface strings is pending** (founder or delegate), as for the T7 typography frames.

## T8a surface (merged)

- `core/render.ts` renders any window of a plan: the whole plan for export, one frame (PNG) or a short segment (MP4) for reference preview. Timestamps stay absolute so the plan's title script times titles in any window; offsets are rounded from exact flicks (setpts truncates).
- `core/render/preview.ts`: previews of a stored revision through the same plan compiler, filtergraph, ASS script and fonts; cached per project under `cache/preview`, keyed by plan hash, window, kind and the FFmpeg build; bounded by `previewCacheBytes` (256 MiB, least recently used first, entries used within a minute kept); one render at a time with identical requests shared; segments up to `previewSegmentFrames` (150).
- `GET /api/v1/projects/:id/preview?revision&kind=frame|segment&start&frames` (scope `project:read` via `yamakan.project.open`), with `X-Plan-Hash` and `X-Preview-Cache`.
- Editor: a reference panel under the interactive preview shows the saved revision's frame at the resting playhead, names the revision, says **Stale** while edits are unsaved, and plays a 2-second reference segment.
- Evidence: preview frames match export frames (PSNR > 35 dB at the same profile); `npm run qualify:preview` records cold/warm frame and 2 s segment latency against the plan's proposed targets.

## T7 surface (merged)

- `core/render/plan.ts`: immutable `yamakan.render-plan/v1` compiled from the canonical project at a revision and its stored snapshot hash: profile (size, rational fps, 48 kHz, yuv420p, contain), ordered video layers, audio instructions (gain/fades), title cues with the ASS hash, pinned font hashes and a deterministic `planHash`. No paths, URLs or filters.
- `core/render.ts`: renders only from a plan; filter values come from integer ticks; inputs are checked against the plan's asset hashes and pinned to the accepted container formats; titles use one ASS script through libass (Encoding -1) with the pinned fonts; a fit check refuses titles wider than the frame instead of clipping them. Schema v5 keeps the plan hash on the job and a probe receipt on the attempt; job status exposes `planHash`.
- `core/render/ass.ts`: escaped plain text (no override, escape or line injection), centisecond times from flicks, deterministic bytes. `core/render/fonts.ts`: IBM Plex Sans Arabic (OFL-1.1, unmodified, hash-verified, `docs/provenance/fonts.json`) and cmap coverage that refuses characters the font cannot draw. `core/render/capability.ts`: libass ≥ 0.17 probe, fail closed.
- `npm run qualify:typography`: Arabic/Latin fixtures (punctuation, bidi isolates, diacritics, Arabic-Indic digits, lam-alef, mixed lines, wraps, long and overlong words) rendered through the export path; frames and receipt in `docs/evidence/qualification/`. **The Arabic reviewer sign-off is pending (founder or delegate).**
- Plan v1 omits, against the contract: per-asset probe hashes, encoder settings (crf/preset/AAC bitrate are fixed in the renderer), effect-registry versions (no effects yet), explicit source PTS mappings (sources are trimmed by flick time) and the title script bytes (its hash is kept). Titles draw above all video layers. The profile is fixed at 30/1 until other rates are qualified.

## T6 surface (merged)

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

- **WMI escape from worker jobs:** a compromised worker can start a process outside its Job Object via WMI. Requires a restricted/low-integrity/AppContainer worker token (T9b).

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

- **Disk (2026-10-12):** C: has ~1.9 GiB free; D: has ~18 GiB free. Clone and npm cache live on D:. T4's ≥2 GiB import and T10 media tests need a disk-capacity preflight and may need space freed by the founder.
- Jev key and an OCR LLM backend are founder-provided resources; without them those reviews stay recorded as unavailable.

**Next executable task:** T9b local boundary (token ACL, loopback hardening, worker sandbox token for the WMI blocker, authenticated CLI/MCP, keyboard/RTL journey) after T9a merges; then T10.

**Recorded for T9 from T6 reviews:** undo/redo write full snapshots and consume the 10,000-revision budget (compaction or head re-pointing); edit history is pruned only by MAX_REVISION; track overlap is enforced by reducers, not by canonical validation (needs a migration decision for existing projects); a request retried across the snapshot format change (`/1`→`/2`) gets IDEMPOTENCY_MISMATCH. Undo binds to the principal, and the CLI and all MCP agents share `local-client` (per-agent identities come with grants).

**Recorded for T9 from T5 reviews:** GC for crash-window orphans (done in T9a) and hidden retained originals (open: a converted VFR original stays registered); a retry/discard command for `reconciliationRequired` jobs; attempt reason codes instead of error text; conversion space in the import reservation.
