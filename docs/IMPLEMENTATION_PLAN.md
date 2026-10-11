# Yamakan master implementation plan — reviewed, pending founder approval

This is the single authoritative plan. **Revision:** independent Claude review of PR #3 head 419bc356eaa6738ba546f38310687739177da6bb ([review](review/CLAUDE_INDEPENDENT_REVIEW.md)). The original Codex proposal is preserved unchanged at commit 419bc356 and as the machine snapshot [phase-plan.json](evidence/yamakan/phase-plan.json), which this document **supersedes**; do not plan from that snapshot. Base main: 0d3bdacb51188294ba8d36ce2b218db72f6073a6. Source pins: [SOURCE_CATALOG](SOURCE_CATALOG.md). Founder decisions: [FOUNDER_DECISION_PACKET](FOUNDER_DECISION_PACKET.md).

**Frontier:** P00 is complete for review. Implementation is **not authorized** until the founder records decisions A–J against this revision. Recommendation: CONDITIONAL GO.

## Execution rules

- Founder approval, then bounded PRs. Each PR has an exact-head CI pass, the listed tests, an independent review of the immutable diff, and evidence linked to its commit. No placeholder UI, and no screenshot used as acceptance.
- **One persisted authority per workspace:** a SQLite operational index (`node:sqlite`, built into Node 24) plus immutable content-addressed snapshot and media blobs. Client editors hold working copies only. No donor store, donor timeline engine or donor job queue becomes an authority.
- **One command registry** serves UI, REST, CLI, MCP and SDKs.
- **One export authority**, FFmpeg, driven by a render-plan IR. Preview consumes the same IR. One text engine (libass) serves titles and subtitles in both paths.
- Imports follow [SOURCE_REUSE_LEDGER](SOURCE_REUSE_LEDGER.md), including its mandatory do-not-import list. `provenance:check` enforces both.
- Optional runtimes (Python, ComfyUI, GPU, cloud) are never required to launch, edit or export. Failing closed with an explanation is better than a partial feature.
- Qualification scripts preflight free disk space. Nothing downloads models without explicit consent showing size and license.

## Dependency order and release scope

~~~mermaid
flowchart LR
  P00[P00 Review + founder gate] --> P01[P01 Foundation: workspace DB, identity, CI]
  P01 --> P02[P02 Projects, assets, migration]
  P01 -.parallel.-> DS[Desktop spike ADR]
  P02 --> P03[P03 Offline production slice + minimal P09]
  P03 --> P10m[P10 scoped quality/security]
  P10m --> P11m[P11 MVP local-web release]
  DS --> P11d[P11 desktop packaging]
  P03 --> P05[P05 Adapter/router contract]
  P05 --> P04[P04 Image and cinema]
  P04 --> P06[P06 Director]
  P06 --> P07[P07 Qualified advanced engines]
  P05 --> P08[P08 Flows and ads]
  P06 --> P08
  P08 --> P09[P09 Full agent platform]
  P09 --> P11v[P11 v1 release]
~~~

**MVP** = P01 + P02 + P03 (including minimal P09) + scoped P10 + P11 (local web). **Desktop release** = MVP + desktop ADR + P11 packaging. **v1** = qualified subsets of P04–P08, full P09, P10 and P11.

Ownership: **Builder** implements; **Reviewer** is an independent reviewer of the exact diff (a fresh session, never the author); **Founder** approves gates, budgets and licenses.

## First ten implementation tasks (executable order, PR-sized)

Precondition: founder decisions A–J are recorded.

| # | Task | Done when |
|---|---|---|
| 1 | **Workspace DB + commit protocol.** Add `core/workspace-db.ts` (`node:sqlite`, WAL, `synchronous=FULL`) with tables `heads`, `revisions`, `idempotency`, `leases`. Commit = fsync snapshot blob, then a `BEGIN IMMEDIATE` compare-and-swap on `expectedRevision`. Add an OS-released single-instance lock. Import existing JSON heads read-only on first open | Review tests T1/T2b/T6 inverted pass; kill -9 then restart needs no manual step; existing 33 tests + E2E green |
| 2 | **Identity + provenance guard.** Yamakan UI and package name, with `DARZAIN_*` aliases. `provenance:check` rejects do-not-import paths and unledgered donor files. Workspace defaults to `%LOCALAPPDATA%\Yamakan` with an owner-only ACL | Negative provenance test; ACL test; legacy root discovered |
| 3 | **`yamakan.project` v1 + pure migration.** Zod schema (flicks, rational fps, stream time bases, safe-integer and key guards), a pure Darzain v1 → Yamakan v1 transform into a new root, and a read-only inspection mode for unknown versions | Golden migrations; original root hash manifest identical before and after; property tests on time math |
| 4 | **Streaming import and serving.** Hash-while-write into Skelet CAS, streamed range responses, a configurable size cap with free-space preflight, VFR→CFR mezzanine, and adversarial media corpus v1 | 4 GB import under 300 MB RSS; corpus rejected with structured errors; seek storm under memory ceiling |
| 5 | **Jobs and attempts in SQLite.** States `queued, preparing, running, cancelRequested, succeeded, failed, cancelled, reconciliationRequired`. Reuse the Gomrey transition table (extended). Record PID + start time, quarantine bad rows, add retention/GC and restart reconciliation. Render runs as an owned attempt | Draft defects (T5) inverted; cancel race; kill during render then restart reconciles; 10,000 lifetime jobs |
| 6 | **Render-plan IR + FFmpeg backend + libass titles.** Extract IR compilation from `core/render.ts`; titles/subtitles as ASS (`Encoding:-1`) with bundled OFL fonts; FFmpeg capability probe; export disk preflight; ENOSPC fault seam | Arabic golden frames (pure RTL, punctuation, mixed, digits); ffprobe + sampled frame/audio-onset checks; ENOSPC leaves head unchanged |
| 7 | **Preview from the IR.** Preview player consumes the IR; JASSUB renders the same ASS; automated parity harness | SSIM ≥ 0.95 at sampled timestamps for the MVP effect set; audio onset ±1 frame; unsupported effects fail preflight in both paths |
| 8 | **Command registry + undo/redo + transport parity.** Scene/shot/clip add, trim, split, move, title, audio, gain and fades with `requestId`/`expectedRevision`; inverse-operation log; REST, CLI and MCP stdio generated from one registry | The same journey via UI and via MCP produces an identical canonical snapshot hash; idempotent replay; conflict on stale revision |
| 9 | **Archives + recovery UX + loopback hardening.** Archive export/import (manifest + blobs, limits, traversal/reparse/case/expansion rejection, no secrets); corrupt-head recovery; `Sec-Fetch-Site` same-origin only; cookie on navigation only | Malicious archive corpus rejected; round trip byte-identical; page from another loopback port is denied |
| 10 | **Clean-host first-slice qualification.** Full [E2E_ACCEPTANCE](E2E_ACCEPTANCE.md) DoD on a clean Windows host with the network disabled and captured; publish exact-head evidence; independent review of the slice | All DoD items pass with receipts; independent review has no open BLOCKER/HIGH |

Parallel from task 1: the **desktop spike** (Tauri 2 against hardened Electron), ending in an ADR under decision D. It does not gate tasks 2–10.

## Phases

Each phase lists: **Deliverables · Depends · Imports · Boundaries · Acceptance · Security · Performance · Evidence · Risks · Exit · Owner · Recovery.**

### P00 — Research, review and approval (complete for review)

- **Deliverables:** Codex package (419bc356), independent review, decision packet, this revised plan.
- **Depends:** None.
- **Imports:** None.
- **Boundaries:** Documentation and bounded experiments only.
- **Acceptance:** Review findings recorded with reproducible evidence; founder decisions recorded.
- **Security:** No secrets or private donor code published.
- **Performance:** None.
- **Evidence:** [evidence.json](review/claude-2026-10-11/evidence.json).
- **Risks:** Approving without reading the blockers.
- **Exit:** Founder records A–J against this revision.
- **Owner:** Founder.
- **Recovery:** If any decision is revised, update this plan, ROADMAP and CURRENT in one PR.

### P01 — Foundation: workspace authority, identity, CI

- **Deliverables:** Tasks 1–2; CI matrix (Windows + Linux) running the review harness equivalents.
- **Depends:** P00.
- **Imports:** None new (`node:sqlite` is built in).
- **Boundaries:** All persistence goes through `workspace-db` + CAS blobs; nothing writes the head except the commit function.
- **Acceptance:** Concurrent-writer conflict; antivirus-style lock tolerance; crash restart without manual steps; one instance per workspace.
- **Security:** Owner-only workspace ACL; no token in world-readable paths; provenance guard.
- **Performance:** Commit p95 < 50 ms for a 2 MB snapshot on SSD.
- **Evidence:** CI logs, kill/restart receipts, ACL test output.
- **Risks:** `node:sqlite` API stability (Node 24: release candidate). Pin the Node version and wrap the module behind an interface.
- **Exit:** Tasks 1–2 merged with green exact-head CI and independent review.
- **Owner:** Builder / Reviewer.
- **Recovery:** If `node:sqlite` is unusable, use `better-sqlite3` (prebuilt) behind the same interface.

### P02 — Canonical projects, assets, migration, archives

- **Deliverables:** Tasks 3, 4 and the archive part of task 9.
- **Depends:** P01.
- **Imports:** Skelet streaming `put` (already in tree), Ninerr canonical JSON (with schema guards); OpenCut Classic migration-framework pattern (design only until qualified).
- **Boundaries:** Media bytes never enter JSON; derived assets carry provenance; VFR handled via mezzanine.
- **Acceptance:** Migration preserves original bytes; unknown versions read-only; archive limits enforced; ENOSPC safe.
- **Security:** Path/reparse/case checks on every import and extraction; protocol whitelist on probes; decoder time and size limits.
- **Performance:** 4 GB import under 300 MB RSS; probe ≤ 10 s; archive of 2 GB project ≤ disk throughput + 20%.
- **Evidence:** Before/after root hash manifests, corpus results, archive round-trip hashes.
- **Risks:** Exotic containers; exFAT/FAT32 workspaces (refused by preflight in MVP).
- **Exit:** No open data-loss path in tests; independent review clean.
- **Owner:** Builder / Reviewer.
- **Recovery:** If mezzanine cost is too high, restrict the MVP to CFR sources with a clear import message.

### P03 — First real production slice (+ minimal P09)

- **Deliverables:** Tasks 5–8 and 10.
- **Depends:** P02.
- **Imports:** Gomrey transition table; libass via FFmpeg; JASSUB @ dea3d2d3 (MIT); bundled OFL Arabic/Latin fonts (pin at import).
- **Boundaries:** Render-plan IR is the only description of output; the MVP effect set is fit/scale, position, opacity, cut, crossfade, gain and fades, plus libass titles.
- **Acceptance:** The full [E2E_ACCEPTANCE](E2E_ACCEPTANCE.md) DoD.
- **Security:** argv-only subprocesses; no user-supplied filtergraph text; titles via ASS file with escaped text; cancellation kills the owned process.
- **Performance:** 30 s 1080p, 3 scenes, 20 clips: export ≤ 3× real time on Profile A minimum; preview ≥ 24 fps at 720p proxy; cancel ≤ 1 s; reopen ≤ 2 s.
- **Evidence:** MP4 + ffprobe + sampled frames + audio onset + parity report + MCP transcript + clean-host network capture.
- **Risks:** Parity threshold tuning; JASSUB font loading offline; font licensing.
- **Exit:** DoD passes on a clean host; independent review clean.
- **Owner:** Builder / Reviewer / Founder (accepts slice).
- **Recovery:** If preview parity fails for an effect, drop that effect from the MVP set rather than lowering the threshold.

### P04 — Image and cinema (v1)

- **Deliverables:** Scene/camera/light entities, layers/masks, one qualified image operation.
- **Depends:** P03, P05 scaffold, decision F/G.
- **Imports:** react-three-fiber (viewport); ArtCraft scene/camera code **only** after per-file review and never the excluded crates or configuration; InvokeAI canvas as reference; ComfyUI protocol with targeted interrupt.
- **Boundaries:** Camera input is an applied control with receipt or labeled textual intent.
- **Acceptance:** Generated images become versioned assets with lineage; offline scene editing works without inference.
- **Security:** No custom-node auto-install; workers in Job Object (H5); model loaders refuse pickle.
- **Performance:** Viewport 30 fps on integrated GPU at 720p for 50 objects.
- **Evidence:** Engine/model/weights hashes and license, hardware report, outputs.
- **Risks:** No qualified GPU host yet (decision F).
- **Exit:** Per-operation receipts only.
- **Owner:** Builder / Reviewer / Founder (hardware).
- **Recovery:** Ship scene staging without generation if no qualified engine exists.

### P05 — Providers and router (v1)

- **Deliverables:** Adapter interface `describe → validate → quote → submit → poll → cancel → reconcile → collectOutputs`; write-ahead submission intents; reservations in integer micro-units; price tables with source and fetch date and expiry; one founder-chosen provider.
- **Depends:** P03 jobs; decision G.
- **Imports:** Official provider documentation; OpenVideoStudio contracts; MuAPI code only as parameter-catalog reference.
- **Boundaries:** One outbound HTTP module with allowlist + SSRF checks; credentials in the OS credential store via the desktop host, never in projects.
- **Acceptance:** Fault matrix with zero automatic resubmission; caps hard only for bounded quotes.
- **Security:** Upload consent per asset and provider; retention disclosed; redirect re-validation.
- **Performance:** Quote ≤ 200 ms (cached price table).
- **Evidence:** Redacted receipts, reconciliation logs, capped real test approved in writing.
- **Risks:** Price/term drift; token-billed models without bounds.
- **Exit:** Only tested, entitled operations enabled.
- **Owner:** Builder / Reviewer / Founder (budget).
- **Recovery:** Disable the route; keep the offline product unaffected.

### P06 — Director and storyboard (v1)

- **Deliverables:** Script → proposed shots (human approval), versioned characters/references, stage gates.
- **Depends:** P04/P05.
- **Imports:** OpenMontage stage manifests (out of process unless AGPL accepted), OpenVideoStudio identity metadata, StoryMind planner as reference (its default third-party LLM endpoint disabled).
- **Boundaries:** LLM output is a proposal; approvals persisted.
- **Acceptance:** Resumable plan → takes → timeline; continuity measured by blind human rating.
- **Security:** No prompt-derived privileges; likeness/voice consent records.
- **Performance:** Plan of 20 shots in ≤ 30 s with a local LLM.
- **Evidence:** Plans, approvals, takes, ratings.
- **Risks:** Identity drift.
- **Exit:** Interruption/resume flow passes.
- **Owner:** Builder / Reviewer.
- **Recovery:** Ship manual storyboard without generation.

### P07 — Video, motion, 3D, audio engines (v1, per operation)

- **Deliverables:** One video and one audio operation first (for example faster-whisper subtitles on CPU, which fits Profile A).
- **Depends:** P04–P06, decision F.
- **Imports:** As the catalog lists, each behind a worker contract.
- **Boundaries:** Workers are separate processes in a Job Object with pinned environments.
- **Acceptance:** Probed outputs, cancellation and recovery receipts.
- **Security:** Safe weight loading; download consent.
- **Performance:** Measured per hardware profile.
- **Evidence:** Per-engine receipts.
- **Risks:** Hardware, community licenses.
- **Exit:** Per operation.
- **Owner:** Builder / Reviewer / Founder.
- **Recovery:** Keep operations disabled.

### P08 — Workflows and ads (v1)

- **Deliverables:** Declarative node registry, durable per-node jobs, brand kits, variant export.
- **Depends:** P03, P05, P06.
- **Imports:** xyflow (UI only).
- **Boundaries:** The graph UI is not a scheduler.
- **Acceptance:** Interrupted batch resumes without duplicate spend.
- **Security:** No eval or dynamic nodes; publication is a separate explicit action.
- **Performance:** 3 variants rendered concurrently within CPU quota.
- **Evidence:** Node receipts.
- **Risks:** Duplicate charges.
- **Exit:** Resume test.
- **Owner:** Builder / Reviewer.
- **Recovery:** Sequential execution only.

### P09 — Agent platform

- **Deliverables:** MVP: MCP stdio + REST + CLI from the registry (task 8). v1: SDKs, scopes, durable proposals.
- **Depends:** P03; full version after P05/P08.
- **Imports:** Ninerr session patterns (bounded); **not** the Kodac auth helper.
- **Boundaries:** Transport identity is separate from project scopes.
- **Acceptance:** Same snapshot hash via UI and MCP.
- **Security:** Stdio binds an explicit workspace grant; remote MCP waits for qualified auth.
- **Performance:** Command p95 < 100 ms excluding render.
- **Evidence:** Transcripts, denied-call tests.
- **Risks:** Scope sprawl.
- **Exit:** Parity tests.
- **Owner:** Builder / Reviewer.
- **Recovery:** Ship read-only tools first.

### P10 — Quality, security, performance (continuous)

- **Deliverables:** Adversarial corpora, fault seams, parity harness, measured limits.
- **Depends:** From P01.
- **Imports:** None.
- **Boundaries:** Tool failures are recorded, never converted into passes.
- **Acceptance:** No open release-blocking defect.
- **Security:** Negative tests for every boundary in [SECURITY](SECURITY.md).
- **Performance:** Distributions, not single runs.
- **Evidence:** Exact-head reports.
- **Risks:** Narrow fixtures.
- **Exit:** Per release.
- **Owner:** Reviewer.
- **Recovery:** Narrow the advertised limits.

### P11 — Release

- **Deliverables:** MVP: local-web release (Node runtime + app + pinned FFmpeg, with notices and source offer). Then desktop installer per the ADR. Then v1.
- **Depends:** MVP gates in decision I.
- **Imports:** Pinned FFmpeg build.
- **Boundaries:** Update never touches user data.
- **Acceptance:** Clean-host install, offline first slice, update/rollback, uninstall keeps data.
- **Security:** Signed artifacts where possible; SBOM; notices.
- **Performance:** Cold start ≤ 5 s.
- **Evidence:** Artifact hashes, install recording, network capture.
- **Risks:** Signing procurement; FFmpeg license compliance.
- **Exit:** Founder ship decision against artifacts.
- **Owner:** Founder / Reviewer.
- **Recovery:** Ship as an internal preview.

## Changes and decisions

Record approved changes as scoped ADRs, and update this plan, [ROADMAP](ROADMAP.md) and [CURRENT](../specs/CURRENT.md) in the same PR. Never create a second master plan. ADR 0002 stays *proposed* until the founder records decision A.
