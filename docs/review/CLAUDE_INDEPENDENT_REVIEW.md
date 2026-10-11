# Independent Claude review of the Yamakan plan

**Reviewer:** Claude (Opus 5.5), independent principal-architect review, 2026-10-11.
**Repository:** [TheHalfMoon/Darzain](https://github.com/TheHalfMoon/Darzain). **Reviewed PR:** #3, draft, head **419bc356eaa6738ba546f38310687739177da6bb** (the requested review SHA, verified live). **Base main:** 0d3bdacb51188294ba8d36ce2b218db72f6073a6.
**Verdict on the Codex package as submitted:** NO-GO. **Verdict on the plan as revised on this review branch:** CONDITIONAL GO (conditions in [section 9](#9-recommendation)).
**Machine evidence:** [evidence.json](claude-2026-10-11/evidence.json). **Reproducible tests:** [harness](claude-2026-10-11/harness/README.md). **Founder decisions:** [FOUNDER_DECISION_PACKET.md](../FOUNDER_DECISION_PACKET.md).

This review did not start production implementation, did not merge PR #3, did not change donor repositories, did not download models and did not run paid inference.

## 1. What was verified, and how

| Item | Method | Result |
|---|---|---|
| PR #3 state | `gh pr view 3` | Open, draft, head = review SHA, base = 0d3bdacb |
| Package integrity | Recomputed SHA-256 of all 121 manifest entries against the delivered ZIP and against `git show 419bc356:<path>` | 121/121 match; identical file sets |
| Production code at review SHA | `git diff 0d3bdacb 419bc356 -- core server cli src tests scripts package*.json` | No change; PR #3 is documentation only |
| Durable-jobs draft | `git diff --cached \| sha256sum` in the `feat/durable-jobs` worktree | 998f50c7…ca6, matches handoff; unchanged after review |
| Existing qualification | `npm test`, typecheck, lint, format, provenance, build, browser E2E (Edge) at the review SHA | All exit 0; 33 tests (32 pass, 1 POSIX-only skip); E2E 26 steps, 0 page errors |
| REA | Installed 6.3.0 verified; upstream 6.4.0 installed in isolation and used for two new static investigations | Both exit 0; see section 4 |
| Failure injection | Seven bounded experiments T1–T7 on this Windows host | Four defects confirmed, one design validated (section 3) |
| Donor claims | Direct source inspection at catalog pins | Five claims corrected or added (section 4) |

Independent tool status is honest, not upgraded: Open Code Review v1.12.13 ran in delegate mode (file selection and rules only; the judgments are this review's, not an OCR LLM pass). Jev had no configured key, Graft needs an LLM key, and PStack is not installed; none of them ran, and none is counted as a pass.

## 2. Executive summary

The direction of option D is right. The repository already has a working, tested offline slice on this Windows host, and starting from it is the fastest path. But the package overstates how ready its foundations are, and it misses concrete defects and donor hazards that change the plan:

1. **The project store cannot be the durable authority as built.** It loses acknowledged edits as soon as a second writer process exists (T2b), and it fails saves when Windows security or indexing software holds the head file open (T1). Every planned agent, worker and desktop process makes the first defect reachable. Correction: a single per-workspace SQLite database (built into Node 24, no native dependency) owns heads, revisions, idempotency, jobs, attempts, reservations and leases. Immutable canonical-JSON snapshots and media remain content-addressed files. Measured: 10/10 hard kills and 6,000 contended writes kept every invariant (T6).
2. **The durable-jobs draft should be rejected as the job authority.** One damaged record disables exports permanently, and exports stop forever after 1,000 lifetime jobs (T5). Reuse its transition table and its validate-before-complete rule only.
3. **Arabic titles render incorrectly in export.** FFmpeg `drawtext` applies a left-to-right base direction, so RTL punctuation and mixed lines come out wrong while the browser preview shows them correctly (T4). libass with `Encoding: -1` renders them correctly. Titles and subtitles should use one libass engine in both export (FFmpeg) and preview (JASSUB, libass compiled to WebAssembly).
4. **Windows orphan processes:** Node-spawned grandchildren survive a service crash (T3). Before any local inference worker is enabled, the desktop host must own a no-breakaway Job Object.
5. **Donor hazards the package did not flag:** ArtCraft ships TLS-fingerprint browser emulation with captured consumer cookies (Sora, Grok, Midjourney, WorldLabs, Kinovi) and a permissive Tauri configuration. It must not be the template for the Yamakan desktop host. Open Generative AI is a single-aggregator (MuAPI) client, not a provider orchestrator.
6. **Better donor overlooked:** OpenCut Classic (MIT) has integer-tick time, a command/undo system, keyframes, masks, retime, versioned storage migrations with tests, and one renderer for preview and export. It was dismissed only because Bun was missing, and it should be qualified as the v1 editing-depth donor.
7. **The fastest safe MVP is local web first.** The local web path is already E2E-proven. The desktop shell becomes a parallel spike with an ADR, not a P01 blocker.

## 3. Failure-injection results

| ID | Question | Result |
|---|---|---|
| T1 | Save while another process holds `head.json` without share-delete | **Fail.** `EPERM` after 17 ms, no retry. Revision 1 is left on disk and reported as "verified" although the caller was told the save failed |
| T2 | Two writers, natural timing, 40 trials | Exactly one writer acknowledged every time (`link()` acts as an accidental compare-and-swap) |
| T2b | Writer B validates before A commits and allocates after | **Fail: lost update.** A acknowledged revision 1; B, based on revision 0, became revision 2 |
| T3 | Hard-kill the Node service | Direct FFmpeg child is killed. **The grandchild of a Python worker survives**, and execution-alias launchers survive entirely |
| T4 | Arabic title in the actual export path | Shaping correct on this FFmpeg build. **Base direction wrong** (punctuation, mixed lines). libass with `Encoding:-1` is correct ([before](claude-2026-10-11/t4-punct.png), [after](claude-2026-10-11/t4-libass-auto.png)) |
| T5 | Jobs draft: one damaged record; 1,000 lifetime jobs | **Fail** in both cases: a permanently rejected initialization, and all exports refused after the cap |
| T6 | `node:sqlite` compare-and-swap, idempotency, hard kill | 5,996/6,000 committed and 4 stale writers rejected; 10/10 kills consistent; `integrity_check` ok |
| T7 | Canonical serializer edge cases | Accepts unsafe integers and `__proto__` keys; these must be enforced in schema validators |

Not executed, and still required: true disk-full (ENOSPC) during export and import, power loss, FAT32/exFAT workspaces, multi-account ACL exposure, and long-video memory profiles.

## 4. REA and source investigations

REA 6.3.0 (Codex receipts) was verified as installed. REA 6.4.0, published 2026-10-11, was installed with `--ignore-scripts` into an isolated prefix. `rea doctor` reports that the native engines (Hopper, Ghidra, IDA) are not configured, so only static JavaScript analysis was available. Neither run below executed donor code.

| Target (pin) | Evidence ID | Findings |
|---|---|---|
| Filmmaker `electron/` boundary (752cd43d), 8 files | ev_27e25b61…3f940c | 55 IPC main handlers, 70 bridge members, **0 sender-validation observations**. Source corroborates `webSecurity:false`, `sandbox:false`, a renderer-supplied command spawned with `shell:true` (`comfyui:start`), and an arbitrary-path `project:readFile`. Confirms exclusion of the shell |
| OpenCut Classic web subset (cf5e79e9), 141 files | ev_c9f0020060…afac80 | Parse failures 0. Persistence is IndexedDB + OPFS behind `StorageAdapter<T>`; one canvas scene graph serves preview and export; mediabunny writes the MP4 to an in-memory buffer; integer ticks at 120,000/s |

Direct source inspection, with REA not needed:

- **ArtCraft (28a39a0d):** `crates/lib/browser_emulation` impersonates browser TLS fingerprints so that captured cookies pass Cloudflare. The `openai_sora_client`, `grok_consumer_client`, `midjourney_client`, `worldlabs_consumer_client` and `kinovi_web_client` crates authenticate with consumer-session cookies. Its `tauri.conf.json` has `withGlobalTauri: true`, asset-protocol scope `**` (the entire filesystem) and CSP `'unsafe-eval'`. Founder source authorization does not cure these problems: the risk lies in third-party terms, bot-detection evasion and user credentials, not in the code license.
- **Open Generative AI (d8d624dc):** `packages/studio/src/muapi.js` and `src/lib/muapi.js` send all generation to `https://api.muapi.ai`. Submit carries no idempotency key, and a poll timeout throws while the paid remote job continues. Reuse is limited to parameter and UI catalogs.
- **ComfyUI (7f7fd918):** `/interrupt` accepts a `prompt_id`, and `/queue` deletes by ID. "Global interrupt only" is outdated. One race remains: the running check and the global flag set are not atomic.
- **OpenCut (e6680107):** the rewrite's timeline is a placeholder (confirms Codex). **OpenCut Classic** is the functioning editor, under MIT.
- **Tick arithmetic:** 120,000/s cannot represent 16, 22.05, 44.1, 48, 88.2 or 96 kHz sample positions, or the 1/90000 timebase. Flicks (705,600,000/s) represent all of them except FFmpeg's 1/15360 MP4 timescale, and stay within JavaScript's safe-integer range for 147.7 days.

## 5. Architecture re-evaluation

Ratings use only measured or inspected facts. "Unq." means unqualified.

| Criterion | A ArtCraft-first | B Filmmaker-first | C OGA-first | E OpenCut-Classic-first | **D′ Yamakan core + bounded modules** |
|---|---|---|---|---|---|
| Real implemented function | Rich 2D/3D, provider clients | Editor, 145 donor tests | Studio UIs over one aggregator | Mature browser editor | Working offline slice, E2E on this host |
| Source reuse | High, but includes excluded crates | High (UI) | Low beyond catalogs | High for editing | High, by bounded modules |
| Migration complexity | Very high (Rust/Tauri state) | High (Electron state) | High | High (browser storage) | Low (owned schema) |
| Desktop / web | Tauri, unq. | Electron (unsafe) | Next/Electron, unq. | Web; desktop rewrite placeholder | Local web proven; desktop spike |
| Editing quality | Not an editor | Good | Minimal | Best of set | Basic now; OpenCut modules for v1 |
| Project persistence | Own DB | Folder JSON | Remote/aggregator | IndexedDB/OPFS | Content-addressed snapshots, becoming SQLite-indexed |
| Runtime reliability | Unq. | Unq. shell | Unq. | Unq. (Bun) | Measured, with defects T1, T2b fixed by plan |
| Test coverage | Unknown | 145 tests | Low | 30 test files, unrun | 33 tests + E2E |
| Security boundaries | Permissive config, cookie clients | RCE-prone IPC | Proxy to aggregator | Browser sandbox | Loopback + token; hardening planned |
| Integration difficulty | High | Medium | High | Medium-high | Low |
| Maintainability | 3,254 Rust files | Medium | Medium | Good, active | Small owned core |
| Extensibility | High | Medium | Medium | Plugin-first (rewrite) | Typed command registry |
| Agent-native | No headless core | MCP server, unsafe | No | Rewrite promises MCP | Same API for UI/agents now |
| Time to first release | Longest | Medium | Long | Medium-long | **Shortest** |

**Recommendation: D′.** One canonical Yamakan core: owned schema, SQLite operational index, content-addressed blobs, a typed command registry, and FFmpeg as the export authority driven by a render-plan IR. Bounded modules come from Skelet (streaming CAS), Ninerr (canonical JSON), the filmmaker UI (timeline and preview components already imported), libass/JASSUB (text), and Gomrey (transition table). Then, after qualification: OpenCut Classic (time/snapping/placement/keyframes/retime/migration patterns), OpenMontage (stage manifests and gates) and OpenVideoStudio (identity contracts). One timeline model and one persisted authority. Client editors hold working copies only.

### Import candidates (exact paths; each still requires ledger entry and tests)

| Source @ pin | Paths | Use |
|---|---|---|
| Darzain main @ 0d3bdacb | `core/donors/skelet/storage.ts`, `core/donors/ninerr/canonical.ts`, `src/donors/film-editor/**` | Keep; Skelet `put()` already streams, so use it for streaming import |
| Gomrey @ 5f299a7a (via draft) | `core/donors/gomrey/job-transitions.ts` | Extend with `cancelRequested`, `reconciliationRequired` |
| opencut-classic @ cf5e79e9 | `apps/web/src/wasm/media-time.ts` (pattern), `timeline/snapping/**`, `timeline/placement/**`, `animation/**`, `retime/**`, `services/storage/migrations/**` (framework and fixtures pattern), `commands/base-command.ts`, `commands/batch-command.ts` | v1 editing depth, after its tests run under Bun on a host with disk space |
| ThaUnknown/jassub @ dea3d2d3 (MIT; libass ISC) | Package | Preview title/subtitle rendering identical to export libass |
| OpenMontage @ 9327439d | Stage prerequisites/manifests/gates (Codex receipts) | P06, out of process if AGPL obligations are not accepted |
| OpenVideoStudio @ 175da996 | Identity/provider contracts (Codex receipts) | P06 |

### Do not import

| Source | Paths | Reason |
|---|---|---|
| artcraft | `crates/lib/browser_emulation/**`, `crates/api_clients/{openai_sora_client,grok_consumer_client,midjourney_client,worldlabs_consumer_client,kinovi_web_client}/**` | Bot-detection evasion and consumer-cookie authentication |
| artcraft | `crates/desktop/artcraft/tauri.conf.json`, `capabilities/default.json` as a template | Whole-filesystem asset scope, `unsafe-eval`, global Tauri API, `https://*` fetch |
| ai-video-production-editor | `electron/main.js`, `preload.js`, `local-agents.js`, `midjourney-agent.js`, `studio-mcp-server.js` | Unvalidated IPC, `shell:true` spawn, arbitrary file read, disabled web security |
| Open-Generative-AI | `packages/studio/src/muapi.js`, `src/lib/muapi.js`, `app/api/**` proxies, `electron/lib/localInference.js` downloader | Single-aggregator authority, no idempotency, silent retrying model downloads |
| opencut-classic | `core/managers/**`, `services/storage/{indexeddb,opfs}-adapter.ts` and `services/renderer/scene-exporter.ts` as persisted or export authority | A second persisted authority; in-memory export |
| Durable-jobs draft | `core/job-journal.ts` as job authority | T5 |
| OpenCut rewrite, Kodac auth helper | Whole | Placeholder; development-secret authentication (Codex) |

## 6. Findings

Each finding lists its location, evidence, impact, correction, verification method, and the release it blocks.

### BLOCKER

**B1. The store's commit protocol is unsafe beyond one process and unreliable on Windows.**
*Location:* `core/store.ts` `nextRevision`/`persist`, `core/durable.ts` `publishFile`, [PROJECT_DATA_MODEL](../PROJECT_DATA_MODEL.md) "atomically publish".
*Evidence:* T1, T2b.
*Impact:* Silent loss of acknowledged edits; spurious save failures; ambiguous commit point.
*Correction:* A SQLite operational index per workspace. The commit sequence is: (1) write and fsync the content-addressed snapshot blob; (2) a `BEGIN IMMEDIATE` transaction that updates the head where `revision = expected`, inserts the revision row and inserts the idempotency row. Only the committed row defines success. Unreferenced blobs are garbage, not history. The original JSON roots are migrated read-only.
*Verification:* T2b must report a conflict; T1 must succeed (SQLite does not rename its database); T6 invariants hold under hard kill; the existing 33 tests and E2E stay green.
*Blocks:* MVP (P02 exit).

**B2. ArtCraft is proposed as the desktop-boundary reference without exclusions.**
*Location:* [ARCHITECTURE_DECISION](../ARCHITECTURE_DECISION.md) ("Tauri host using ArtCraft/Ninerr patterns"), [IMPLEMENTATION_PLAN](../IMPLEMENTATION_PLAN.md) P01/P04, [SOURCE_CATALOG](../SOURCE_CATALOG.md).
*Evidence:* Section 4.
*Impact:* Importing bot-detection evasion and consumer-credential clients, or copying a whole-filesystem webview scope.
*Correction:* Add the explicit do-not-import list. Write the Yamakan Tauri capability file from deny-by-default.
*Verification:* A provenance check rejects the excluded paths. The desktop spike passes negative tests (webview cannot read outside the workspace grant and has no `eval`).
*Blocks:* P01 (any desktop work) and P04 (any ArtCraft import).

### HIGH

**H1. The durable-jobs draft fails safe-recovery requirements.**
*Location:* draft `core/job-journal.ts`, `core/render.ts` `recover`/`admit`.
*Evidence:* T5, plus review: no PID or orphan reconciliation, artifact hash re-verified on every range request, a 10 s hash deadline on artifacts up to 1 GB, nested ternaries and duplicated limits (OCR rule set).
*Correction:* **Reject as authority; reuse narrowly.** Jobs and attempts live in SQLite with quarantine of bad rows, retention/GC, recorded process identity (PID + start time) and restart reconciliation.
*Verification:* T5 inverted (a damaged row is quarantined and exports continue; 10,000 lifetime jobs still work), plus kill-during-render tests.
*Blocks:* MVP (P03).

**H2. Arabic/RTL titles mismatch between export and preview.**
*Location:* `core/render.ts` drawtext; `src/adapter.ts` titles (`font: "sans-serif"`).
*Evidence:* T4.
*Correction:* One text engine. Titles and subtitles become ASS events (`Encoding: -1`, bundled OFL Arabic+Latin fonts via `fontsdir`), rendered by FFmpeg `subtitles` on export and by JASSUB in preview. Preflight fails closed unless FFmpeg reports libass and `subtitles`.
*Verification:* Golden-frame tests for pure RTL with punctuation, mixed RTL/LTR, Arabic-Indic digits and line wrap, in both preview capture and export, with a perceptual-difference threshold.
*Blocks:* MVP.

**H3. Imports are capped at 50 MB and media is fully buffered.**
*Location:* `server/main.ts` `body()` and `media()` (`readFile` per range request), `core/media.ts` `MAX_ASSET_BYTES`.
*Impact:* Real camera footage cannot be imported, and memory spikes on scrubbing.
*Correction:* Streaming upload through hash-while-write (Skelet `put` already accepts async iterables), streamed range responses, and a configurable cap with a free-space preflight.
*Verification:* Import a 4 GB file with service RSS under 300 MB; seek storms under a memory ceiling.
*Blocks:* MVP.

**H4. A stale `server.lock` prevents restart after a crash.**
*Location:* `server/main.ts` (`open(..., "wx")`).
*Impact:* "Close → restart → reopen" fails for a normal user after any crash, because the error message asks them to delete files by hand.
*Correction:* Use an OS-released lock: SQLite `locking_mode=EXCLUSIVE` on a lock database, or a named pipe on Windows and a Unix socket on POSIX. Record the owner PID and start time for diagnostics.
*Verification:* Kill -9 the service; the next start succeeds without manual action, while a concurrent second start is refused.
*Blocks:* MVP.

**H5. Local workers leak orphans on Windows.**
*Location:* [LOCAL_INFERENCE](../LOCAL_INFERENCE.md) "Supervisor owns processes"; any Python/ComfyUI worker.
*Evidence:* T3.
*Correction:* The desktop host (Rust) creates a Job Object with `KILL_ON_JOB_CLOSE` and no breakaway, containing the service and every worker tree. Workers are launched by absolute interpreter path, never through execution aliases. Startup reconciliation kills recorded PIDs whose start time matches.
*Verification:* T3 variants report no surviving descendant.
*Blocks:* v1 (Profile B). The MVP's direct FFmpeg children are already covered by libuv.

**H6. Preview and export are two renderers with no parity contract.**
*Location:* `src/donors/film-editor/components/PreviewPlayer.tsx` against `core/render.ts`.
*Correction:* A render-plan IR compiled from a frozen revision, with FFmpeg as the export backend and preview consuming the same IR. The MVP effect set is limited to what both implement: fit/scale, position, opacity, cut, crossfade, gain, fades, and libass titles. Everything else fails preflight.
*Verification:* An automated parity harness compares N timestamps (exported frame against captured preview canvas, SSIM ≥ 0.95, plus audio onset ±1 frame).
*Blocks:* MVP.

**H7. The provider submission state machine is under-specified for duplicate-charge prevention.**
*Location:* [MODEL_CAPABILITIES](../MODEL_CAPABILITIES.md), [COST_ROUTER](../COST_ROUTER.md).
*Correction:* Write-ahead "submission intent": persist the attempt (`submitting`, client reference, quote, reservation) before any network send; use the provider idempotency key where documented; persist the external ID on response. A crash between those steps yields `reconciliationRequired`, which only reconciliation lookup or an explicit user decision can clear. A hard cap is offered only when the quote has a documented upper bound; otherwise the cap is labeled soft and requires acknowledgment.
*Verification:* A fake-provider fault matrix (drop before send, after send, after response; duplicate response; timeout) shows zero automatic resubmits.
*Blocks:* v1.

**H8. Desktop shell qualification is on the MVP critical path.**
*Location:* [IMPLEMENTATION_PLAN](../IMPLEMENTATION_PLAN.md) P01.
*Impact:* Native toolchain risk delays every data and editing task.
*Correction:* Ship the MVP as a local web application (already E2E-proven), with the desktop spike as a parallel track ending in an ADR. Desktop packaging enters at P11.
*Verification:* Founder decision D.
*Blocks:* Schedule only.

### MEDIUM

- **M1. Same-site loopback pages are trusted.** `server/main.ts` rejects only `Sec-Fetch-Site: cross-site`, but every `127.0.0.1:<other port>` page is same-site. Such a page can obtain the cookie by navigation and embed authenticated GET media. *Fix:* Accept only `same-origin`/`none`, and set the cookie only on top-level same-origin navigation. *Test:* A page served from another loopback port cannot load `/api/v1/projects/*/assets/*`. Blocks MVP.
- **M2. The token file has no ACL on Windows.** `mode: 0o600` is ignored. *Fix:* Default the workspace to `%LOCALAPPDATA%` and set an explicit owner-only ACL at initialization; the desktop host hands the token over without a file. *Test:* A second local account cannot read it. Blocks MVP release (not development).
- **M3. Serializer guarantees are overstated (T7).** *Fix:* Zod refinements for safe integers and a key denylist, plus property tests. Blocks MVP schema.
- **M4. Disk-full behavior is untested, and export has no free-space preflight** (`core/render.ts`). *Fix:* An estimate-based preflight, plus an fs fault-injection seam (ENOSPC at call N) and a size-limited volume in Linux CI. *Test:* Head unchanged and partial output removed. Blocks MVP.
- **M5. Hardlink preservation fails on FAT32/exFAT and some network shares** (`core/durable.ts preserveFile`). *Fix:* Require NTFS/ReFS/APFS/ext4 for workspaces in the MVP, with a preflight message. Blocks MVP.
- **M6. FFmpeg build capabilities are assumed.** Shaping, libass and encoders are build-dependent, and CI uses distribution FFmpeg. *Fix:* Bundle and pin one build, probe its capabilities at startup, and record its license obligations. Blocks release.
- **M7. Open Generative AI is misclassified as a provider-orchestration donor** (section 4). *Fix:* Write adapters from official provider documentation. Blocks v1 planning accuracy.
- **M8. OpenCut Classic is unqualified despite being the strongest editing donor.** *Fix:* Run its tests under Bun on a host with free disk, then decide on module adoption. Blocks v1 editing scope.
- **M9. `docs/evidence/yamakan/phase-plan.json` duplicates the master plan.** *Fix:* Mark it as a snapshot of the 419bc356 proposal, superseded by IMPLEMENTATION_PLAN. Documentation only.
- **M10. Host disk is at 99%.** Large builds or model downloads will fail mid-way. *Fix:* A free-space preflight in all qualification scripts, and a 20 GB minimum for Profile B work. Blocks qualification.

### LOW

- L1. The cookie is set before the static file lookup, so it is issued on error responses too (`server/main.ts`).
- L2. `initializeRoot` compares realpaths case-insensitively and rejects 8.3 short-name roots (`core/paths.ts`).
- L3. ComfyUI interrupt documentation correction (section 4).
- L4. OCR rule findings in the draft: nested ternary, duplicated literal limits (1000, 64 KiB, 1 GiB).

### ACCEPTED RISK (founder to confirm)

- AR1. Process kill is not power loss. Even with SQLite `synchronous=FULL`, durability depends on drives honoring flush.
- AR2. The local trust model: a same-account attacker can rewrite data and hashes. Hashes detect corruption, not tampering.
- AR3. REA graphs are static and incomplete; absence is not proof.
- AR4. No GPU inference can be qualified on the current host, so Profile B stays disabled until qualified hardware exists.

## 7. Data-integrity review

| Topic | Decision |
|---|---|
| Legacy Darzain migration | Read-only open of the old root. Hash every file before and after (must be identical). Write a new Yamakan root. Record the original-root manifest hash in the new project. Never delete. |
| Canonical IDs | UUIDv7 for new entities (time-ordered). Preserve legacy UUIDs. |
| Timeline time | Integer **flicks** (705,600,000/s). Timeline fps is a reduced rational. Frame index is derived and checked. |
| Source time | Per-stream `time_base` rational plus integer PTS range. Never float seconds. |
| VFR | MVP: on import, VFR video gets a CFR mezzanine as a derived AssetVersion (with provenance), and editing references the mezzanine. A native VFR path is deferred. |
| Audio sync | Sample-exact in flicks for 8–96 kHz. Export resamples once, at mix. Test: onset error ≤ 1 audio frame. |
| Nested compositions | v1. A composition is a clip source, cycles are rejected, export pre-renders through the IR. Not in the MVP. |
| Asset versions | Immutable, content-addressed. A metadata correction creates a new version. |
| Undo/redo | A per-session command log of inverse operations in SQLite. Revisions are the persisted checkpoints. Undo after restart restores to a revision. |
| Concurrent updates | Compare-and-swap on `expectedRevision` in one transaction. Agents receive `REVISION_CONFLICT` and must rebase. |
| Snapshot publication | Blob fsync, then transaction commit (B1). |
| Crash recovery | SQLite rollback. Orphan blobs are collected after a grace period. Attempts in `submitting` become `reconciliationRequired`. |
| Unknown future schema | Open read-only in inspection mode; never write or downgrade. |
| Portable archives | Manifest plus blobs by hash. Limits on entries, depth, compressed and expanded size. Reject traversal, drive/UNC paths, reparse points, duplicates and case collisions. Import into a new project ID unless the user asks to replace. |
| Partial writes / disk-full / filesystem errors | No commit until the blob is verified. ENOSPC leaves the head unchanged. Required tests: fault seam plus a small-volume CI job. |
| Windows guarantees | Strong claims are allowed only for state committed in SQLite. Claims for rename-published files are withdrawn. |

## 8. Hardware profiles

| Profile | Scope | Minimum | Gate |
|---|---|---|---|
| A Offline CPU | Full MVP: edit, preview, FFmpeg export | 4 cores, 8 GB RAM, 10 GB free, NTFS, Windows 10 22H2+ | First-slice DoD on a clean host with the network disabled |
| B Local AI (optional) | ComfyUI or a pinned worker in its own environment | NVIDIA ≥ 12 GB VRAM (video) or ≥ 8 GB (image), 32 GB RAM, ≥ 60 GB free | Per-operation qualification receipt on that hardware; disabled otherwise. **The current host does not qualify.** |
| C BYOK cloud | User's own provider keys | Network, explicit consent per upload, a budget | Capped real test approved by the founder; never required for A |

## 9. Recommendation

**CONDITIONAL GO** for implementation of the revised plan, under these conditions:

1. The founder approves decisions A–J in the [decision packet](../FOUNDER_DECISION_PACKET.md) against this review branch's head commit.
2. Task 1 (the workspace database and commit protocol, B1) lands and passes T1/T2b/T6-equivalent tests before any other feature work merges.
3. The B2 exclusions are enforced by provenance tooling before any desktop or ArtCraft work.
4. No local-inference worker is enabled before H5, and no paid provider before H7.

The Codex package as originally submitted is **NO-GO**: it would build on a store with a demonstrated lost-update defect and would import hazardous donor code. This review does **not** approve the plan; approval belongs to the founder.
