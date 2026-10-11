# Yamakan master implementation plan — proposed

This is the single authoritative plan. The current frontier is P00 planning at the independent Claude review gate. P01–P11 are not approved or complete. Previous Darzain phase numbers and release milestones are historical evidence, not completion of these Yamakan phases. Base main: 0d3bdacb51188294ba8d36ce2b218db72f6073a6. Exact source pins: [SOURCE_CATALOG.md](SOURCE_CATALOG.md).

## Execution rules

Independent Claude review must deliver findings/revised decisions, then the founder records approval of the reviewed plan before production implementation. Each later phase uses a bounded patch, exact-head checks, independent review and evidence before integration. A dependency has to satisfy its actual contract; a source README, synthetic fixture or earlier differently scoped phase cannot satisfy a runtime exit gate. Start with qualified reused modules; write only missing integration/contracts. Preserve donor remotes and provenance. No whole-app transplantation or multiple timeline/store authorities.

The modular architecture is conditional on schema migration, preview/export semantics, durable jobs and a genuinely bounded desktop shell. All domains use the project format and generation contract. Optional model runtimes are isolated and never required for launch. Developer artifacts are English; Arabic/English product experience is an acceptance requirement. Remote commercial mode is future scope until rights and hosted security are qualified.

## First ten tasks after approval

1. Record independent Claude review, reconcile findings and obtain founder approval for foundation/schema/license/runtime/MVP decisions; freeze reviewed plan commit.
2. Create implementation branch from the approved base; establish Yamakan user-facing identity, source notices, reproducible build/CI and bounded shell/API ownership.
3. Specify and implement pure legacy-project migration into a new root using rational time and canonical serialization; retain original bytes and hashes.
4. Implement immutable asset-version imports, media probes, stable project references, provenance and explicit rights/consent metadata.
5. Independently review the preserved durable-jobs draft; adapt only accepted pieces into canonical attempt/ownership/cancellation semantics.
6. Qualify stale-lock, orphan-worker, disk-full and interrupted-publication recovery on Windows; add ambiguous provider-submit state without automatic rebilling.
7. Implement and qualify bounded archive export/import with manifests, hashes, no secrets, traversal/reparse/case/expansion rejection and recovery preservation.
8. Connect scene/shot/timeline trim/split/title/audio commands to one state engine and actual preview; qualify timing and Arabic text shaping.
9. Render a frozen revision with an owned FFmpeg process through UI and API; validate actual MP4 picture, title, audio and cancellation outputs.
10. Run clean-host offline launch/import/edit/export, service close/restart/reopen and programmatic repeat; publish exact-head evidence and independently review the first slice.

## Dependency order and release scope

~~~mermaid
flowchart LR
  P00[Research and Claude / founder gate] --> P01[Foundation]
  P01 --> P02[Project and assets]
  P02 --> P03[Offline production slice]
  P02 --> P09m[Minimal agent commands]
  P09m --> P03
  P03 --> P05[Adapter / router contract]
  P05 --> P04[Image and cinema]
  P04 --> P06[Director]
  P06 --> P07[Qualified advanced engines]
  P05 --> P08[Flows and ads]
  P06 --> P08
  P08 --> P09[Full agent platform]
  P03 --> P10[Continuous quality and security]
  P09 --> P10
  P10 --> P11[Scope-specific release qualification]
~~~

Phase numbers are scope labels, not a rule that the full router must wait for image work: shared P05 descriptor/policy scaffolding precedes P04 adapter usage. P09 minimal commands are part of P03, not deferred until after advanced features. P10 checks run continuously. MVP includes P00–P03, minimal P09, and scoped P10/P11 qualification. Production v1 includes only actually qualified P04–P08 operations and full P09 with P10/P11. See [ROADMAP.md](ROADMAP.md) for boundaries and planning estimates.

## P00 — Source Research and Qualification

**Scope:** Planning, source boundaries, REA setup, four foundation strategies and review package. No full implementation.

**Selected donor modules:** All 58 pins in SOURCE_CATALOG; actual reusable-module prototype at current main; four additional alternatives explicitly justified. Exact source pins and inspected paths are in the catalog/module receipts; imports require a bounded path list and ledger update.

**Bounded tasks:**

- Verify owner/canonical main and freeze all donor references.
- Inspect selected actual source modules, rights/assets and dependency/runtime boundaries.
- Run bounded builds/original tests and REA diagnostics; retain failures and exact inputs.
- Produce contracts, provider snapshot, plan and independent Claude handoff.

**Dependencies:** None. Replaces previous Darzain implementation directive for the current frontier.

**Acceptance criteria:** All required documents resolve; every recommended donor has exact pin, scope, evidence and unresolved gates; no inferred runtime/security/rights pass.

**Test strategy:** Mechanical document/link/JSON/provenance verification; bounded donor experiments already recorded. No fabricated model benchmark.

**Security requirements:** No private donor code or secrets in public package; inert source analysis; no expensive tests or unrestricted external code execution.

**E2E requirements:** Historical real application export/recovery evidence informs the foundation; it is not Yamakan release acceptance.

**Evidence needed:** Source/module hashes, builds, donor test receipts, REA CLI/MCP receipts, official provider sources and current repository verification.

**Exit gate:** Package complete for review. Independent Claude review and founder decisions are REQUIRED before P01. Qualification of every GPU/provider remains partial.

**Risks:** Unequal source depth, restricted weights/assets, unqualified native runtimes, evolving provider pages, limited disk/hardware.

## P01 — Foundation and Identity

**Scope:** Approved modular core, coherent Yamakan identity, one data/service authority, desktop boundary and CI.

**Selected donor modules:** Bounded filmmaker web modules already qualified; existing main; Ninerr encoding/history concepts; ArtCraft desktop boundary reference. Tauri is proposed, not qualified. Exact source pins and inspected paths are in the catalog/module receipts; imports require a bounded path list and ledger update.

**Bounded tasks:**

- Record Claude findings and founder decisions; pin approved plan revision.
- Rename user-facing product and package namespace while preserving legal provenance; repository rename only by separate explicit decision.
- Specify typed command boundary and loopback service ownership; qualify Tauri spike versus Electron fallback with no unrestricted IPC.
- Make reproducible build/CI and baseline clean-host launch.

**Dependencies:** P00 + independent Claude review + recorded founder approval. Production changes cannot start before these.

**Acceptance criteria:** Offline app launches on supported Windows host without Python/GPU/API key; one canonical store; build reproducible and legacy data discoverable.

**Test strategy:** Build/type/schema checks; bounded shell file/command ownership checks; CI exact head; launch smoke on a second clean host.

**Security requirements:** Loopback/origin validation; no arbitrary filesystem/shell IPC; CSP and scoped file handles; secret-free logs; no default shared dev secret.

**E2E requirements:** Launch both web and desktop configurations, choose a local workspace and verify blocked cross-origin/unscoped access.

**Evidence needed:** Installed artifact/version/hash, build logs, clean-host launch recording and shell adapter permission tests.

**Exit gate:** Approved foundation actually runs; notices retained; no empty studios exposed; no migration or packaging acceptance claimed by UI branding alone.

**Risks:** Tauri/native toolchain packaging unknown; Electron fallback expands update/security burden; old names in persisted roots require careful migration.

## P02 — Canonical Projects and Assets

**Scope:** Versioned project envelope, immutable asset versions, history, migrations, archives and recovery.

**Selected donor modules:** Skelet content-addressed recovery module at qualified pin; Ninerr canonical encoding/history reference; Pluma store patterns evaluated, not a second database authority; OTIO rational-time/interchange reference. Exact source pins and inspected paths are in the catalog/module receipts; imports require a bounded path list and ledger update.

**Bounded tasks:**

- Define exact schema/operation unions and validate all references and numeric domains.
- Implement pure Darzain-to-Yamakan migration into a new root preserving original bytes.
- Add stable asset/version/probe/provenance identities and scoped import streaming.
- Adapt qualified storage with revision conflicts, bounded undo, recovery and archive publication.

**Dependencies:** P01; approved PROJECT_DATA_MODEL; independently review current storage limitations before extending.

**Acceptance criteria:** Semantic and editable migration round-trip; atomic revision publication; corrupt/incomplete roots recover without silent data replacement; archives preserve referenced assets.

**Test strategy:** Golden schema/migrations; broken refs, unsafe numbers, duplicate IDs; concurrent writers; crash points; case/reparse/traversal/expansion-limit archive corpus.

**Security requirements:** No credentials/absolute host paths in project archives; bounded media and metadata; symlink/reparse protection and corruption preservation.

**E2E requirements:** Import mixed media, edit/save/undo, close service, restart, recover and export/import an archive; original root unchanged.

**Evidence needed:** Original/migrated/round-trip hashes, probe metadata, revision journals, injected-crash receipts and malicious-archive rejection logs.

**Exit gate:** One stable data authority with measured recovery semantics; no data-loss or silent unknown-version downgrade cases open.

**Risks:** Windows directory sync/lock semantics; ambiguous interrupted publication; disk-full failures; future-schema compatibility.

## P03 — First Real Production Vertical Slice

**Scope:** The 12-step offline project/import/scene/shot/timeline/title/audio/preview/export/reopen/API journey. No paid inference dependency.

**Selected donor modules:** Qualified filmmaker timeline/preview primitives and FFmpeg integration references; actual installed FFmpeg renderer; owned workspace storage; durable jobs draft is unapproved and requires independent review. Exact source pins and inspected paths are in the catalog/module receipts; imports require a bounded path list and ledger update.

**Bounded tasks:**

- Review and selectively adapt durable-worker draft; define attempts, restart reconciliation and owned child termination.
- Implement shared scene/shot/timeline commands, trim/split, title and audio placement with rational time.
- Use frozen revisions for owned FFmpeg export and probe all outputs; preflight unsupported effects.
- Repeat same journey through UI and REST/CLI; cancel, restart, reopen and recover.

**Dependencies:** P02 and minimal scoped command/API surface from P09 planned in parallel; actual preview/export parity contracts.

**Acceptance criteria:** Real playable MP4 contains expected picture/title/audio and timing; saved edits reopen intact; API produces the same semantic project; zero mandatory cloud compute.

**Test strategy:** Actual image/video/audio fixtures; trim/title/audio placement frame/sound checks; cancellation races; restart orphan cleanup; fixed output bounds; browser and API tests.

**Security requirements:** Argv-based subprocesses with bounded paths/profiles/time/output; untrusted media quotas; no arbitrary FFmpeg filter/shell input; owned process groups; failed artifacts quarantined.

**E2E requirements:** All steps in E2E_ACCEPTANCE plus actual close/restart, failed/cancelled attempt recovery, fresh-host offline export and Arabic title shaping fixture.

**Evidence needed:** MP4/hash/ffprobe/frame/audio checks, project/reopen hash, browser/API trace, process/cancel/restart receipts and clean-host recording.

**Exit gate:** First real production slice passes exact-head CI and independent implementation review. No placeholder interaction or screenshot substitutes.

**Risks:** Preview/export semantic mismatch; font shaping; VFR/audio rounding; process orphan races; disk pressure and local-server lifecycle.

## P04 — Image and Cinema

**Scope:** Qualified image generation/editing plus bounded scene/camera/light staging linked to one project.

**Selected donor modules:** ArtCraft scene/camera/pose; InvokeAI canvas/layers reference; ComfyUI protocol; diffusers optional worker; SAM2/GroundingDINO optional segmentation/detection. Exact source pins and inspected paths are in the catalog/module receipts; imports require a bounded path list and ledger update.

**Bounded tasks:**

- Translate scene/camera/lighting into canonical entities without inheriting donor state engines.
- Provide layers/masks and non-destructive image edits with asset-version lineage.
- Qualify one optional local image engine/profile and explicit camera/pose conditioning receipt.
- Add measured preview/conditioning/identity tests and unavailable-capability UX.

**Dependencies:** P03; P05 descriptor/adapter/policy foundation; optional supported hardware/model rights.

**Acceptance criteria:** Image operations create real editable/versioned outputs; camera input is either an applied supported control with receipt or clearly labeled textual intent; offline scene editing still works without inference.

**Test strategy:** Mask/layer golden round trips, real bounded image jobs, scene translation fixtures, conditioning mapping and output quality rubric.

**Security requirements:** Custom nodes and model code isolated; no automatic plugin installation; approved egress; safe model loaders; reference consent and credential redaction.

**E2E requirements:** Stage a scene, place a consented character/reference, edit mask, generate via a qualified engine, compare and import selected take.

**Evidence needed:** Exact engine/model/weights rights and hashes, hardware report, actual generated images and input/conditioning/quality receipts.

**Exit gate:** Only qualified operations exposed; source build or GPU detection alone cannot satisfy generation acceptance.

**Risks:** No suitable discrete GPU on current host; incompatible CUDA stacks; weights/asset rights; prompt-only camera control and identity drift.

## P05 — Model Providers and Smart Router

**Scope:** Versioned capabilities, direct and aggregator BYOK adapters, explicit consent, cost quotas and reconciled jobs.

**Selected donor modules:** Open Generative AI bounded provider references; official vendor documentation; MiniMax MCP contract reference requiring v2 rewrite; Gomrey pure budget/job rules; Ecra/kernux policy patterns. Exact source pins and inspected paths are in the catalog/module receipts; imports require a bounded path list and ledger update.

**Bounded tasks:**

- Implement describe/validate/quote/submit/poll/cancel/reconcile/collectOutputs on versioned adapters.
- Qualify first founder-selected provider/region/model with user credentials and a capped approved real test.
- Implement hard eligibility filters before ranking, decimal reservations and price freshness.
- Persist remote task receipts; do not auto-repeat ambiguous chargeable submissions or silently switch providers.

**Dependencies:** P03 job/data semantics; P04 can use shared adapter scaffold without all cloud adapters being ready.

**Acceptance criteria:** Unsupported parameters fail before spend; offline/BYOK have no founder key dependency; max budget is enforced under declared billing bounds; every charged attempt has receipt/reconciliation state.

**Test strategy:** Fake-provider contract/fault tests plus approved capped real tests per enabled model; quote/input surcharge/rounding/rate/expiry tests; multi-provider cancellation semantics.

**Security requirements:** Secret storage outside project; scoped network consent and region policy; SSRF validation on upload/download; no secret echoes or cross-workspace credentials.

**E2E requirements:** Configure own key, review quote/media disclosure, submit/cancel/reconcile, import actual output; remove key and confirm no fallback to founder capacity.

**Evidence needed:** Official doc/account/model revision, redacted task IDs and usage/cost receipts, output hashes, actual entitlement/region/cancellation behavior.

**Exit gate:** Enable only tested/entitled capabilities; retired/unknown models disabled; all commercial resale functions gated separately.

**Risks:** Public docs change; missing hard billing cap; uploaded-media retention; unresolved regional eligibility; input charges and ambiguous remote retries.

## P06 — Director and Storyboard

**Scope:** Script, versioned characters, brand references, shot planning, take review and measured continuity.

**Selected donor modules:** OpenMontage production manifests/stage gates; OpenVideoStudio identity metadata; StoryMind planner references; filmmaker director/storyboard; Morize memory types. Exact source pins and inspected paths are in the catalog/module receipts; imports require a bounded path list and ledger update.

**Bounded tasks:**

- Convert script to validated proposed scene/shot plans with human review before generation.
- Version character/brand references and applied conditioning lineage.
- Adapt OpenMontage stage prerequisites to Yamakan jobs and persist approvals/artifacts.
- Measure multi-shot continuity and invalidate caches/takes after reference changes.

**Dependencies:** P02/P03 entities and P04/P05 qualified generation; memory retrieval optional and version filtered.

**Acceptance criteria:** A script creates an editable storyboard; references and approvals survive restart; no identity claim without measurable generated outputs and consent.

**Test strategy:** Original donor prerequisite/identity tests plus adapter tests; adversarial prompt/plan validation; cache invalidation; blind continuity evaluation.

**Security requirements:** Treat script/reference metadata and LLM output as untrusted proposals; no prompt-derived privileges or automatic external uploads; consent for likeness/voice.

**E2E requirements:** Plan three scenes with one character, approve shots, generate qualified takes, reject/regenerate a take, assemble and reopen editable production.

**Evidence needed:** Versioned script/refs, approved plan, stage job receipts, real multi-shot outputs, continuity rubric and human ratings.

**Exit gate:** Resumable production passes actual interruption/review flow; no claim that metadata fixtures prove video identity.

**Risks:** Identity drift and narrative quality; model limitations; OpenMontage external tools/durability and AGPL obligations; no strong measured continuity baseline yet.

## P07 — Video, Motion, 3D, and Audio

**Scope:** Incrementally qualified advanced media controls. Each engine/operation independently gated.

**Selected donor modules:** Wan2GP/diffusers/LTX-2/HunyuanVideo/FramePack/Wan-Move; LivePortrait/LatentSync; Blender/R3F/Hunyuan3D/TRELLIS; faster-whisper/Piper; RIFE/Real-ESRGAN; MLT/Remotion optional workers. Exact source pins and inspected paths are in the catalog/module receipts; imports require a bounded path list and ledger update.

**Bounded tasks:**

- Prioritize one video and one audio workflow using approved hardware/rights; keep other engines disabled until measured.
- Add versioned motion/pose/reference mapping and explicit native-audio separation.
- Add transcription/subtitles/lip-sync and optional 3D staging/import through isolated worker contracts.
- Qualify codec/effects/interchange/renderer parity before professional options are advertised.

**Dependencies:** P04–P06 and suitable environments/assets; no mandatory GPU/Python for core launch.

**Acceptance criteria:** Each exposed operation returns probed real outputs, correct references and cancellation/recovery receipts; incompatible hardware yields a useful disabled reason.

**Test strategy:** Real bounded model jobs, camera/motion obedience, audio alignment/Arabic intelligibility, 3D mesh/resource checks, interpolation/upscale artifact evaluation; renderer golden parity.

**Security requirements:** Worker resource isolation; safe weight loading; likeness/voice controls; no arbitrary JSX/Python in trusted host; bound mesh/textures and model downloads.

**E2E requirements:** A qualified operation contributes media to the same editable timeline and actual export; restart/cancel and offline editing stay functional.

**Evidence needed:** Per-engine environment/weights/license/hardware receipts, outputs, quality judgments, latency/memory/cost and failure cases.

**Exit gate:** Per-operation acceptance, not a blanket all-model pass. Unsupported models remain candidates in inventory.

**Risks:** Current host lacks verified suitable GPU; community/territorial/weight conditions; Python/CUDA conflict; audio/face consent; performance and severe hallucinated control compliance.

## P08 — Workflow Automation and Ads

**Scope:** Declarative reusable workflows, batch runs, brand/product references, ad variants and social-format exports.

**Selected donor modules:** xyflow graph UI; OpenMontage stage schemas; Gomrey pure rules; Open Generative AI marketing references; MoneyPrinterTurbo workflow concepts, without silent cloud/stock/publishing defaults. Exact source pins and inspected paths are in the catalog/module receipts; imports require a bounded path list and ledger update.

**Bounded tasks:**

- Implement typed nodes/edges with dependency validation and durable per-node jobs.
- Add brand kits, consented product/reference assets and reusable composition templates.
- Produce bounded batches with per-run/spend/resource limits and review loops.
- Export editable variants in qualified aspect/resolution formats; publication remains separate explicit action.

**Dependencies:** P03 timeline/render; P05 budget/adapter; P06 continuity; selected P07 operations as optional nodes.

**Acceptance criteria:** Graph UI and agent API execute the same registered node definitions; interrupted batches resume without duplicate spend; brand lineage and selected takes remain editable.

**Test strategy:** Cycle/type/budget/branch tests; deterministic pure nodes; retry/restart/cancellation; template/export comparisons; misleading stock/brand-reference tests.

**Security requirements:** No eval/dynamic donor scripts; no privileged workflow-injected nodes; references and assets have rights; social posting/stock downloads need explicit authorization.

**E2E requirements:** Run an approved campaign brief into three variants, interrupt/resume, review outputs and export social formats without publication.

**Evidence needed:** Graph schema/version, node receipts, batch budget, actual variant exports and reference/provenance record.

**Exit gate:** Actual resumable workflow, not xyflow graph drawing alone; no silent stock/TTS/upload/network.

**Risks:** Graph UI mistaken for scheduler; duplicate charge/retry; brand drift; rights; autogenerated claims/content; template rendering parity.

## P09 — Agent-Native Platform

**Scope:** Shared scoped commands exposed through MCP, REST, CLI and typed TS/Python SDKs; minimal subset shipped in first slice.

**Selected donor modules:** Ninerr MCP/session patterns; Orcel input queue/tool boundaries; Ascout independence rules; Ecra budget/recovery and kernux policies. Reject Kodac dev-secret fallback as authentication. Exact source pins and inspected paths are in the catalog/module receipts; imports require a bounded path list and ledger update.

**Bounded tasks:**

- Define one typed tool/command schema, errors, progress and audit contract.
- Ship minimal project/import/scene/timeline/render/job/reopen tools with P03.
- Add SDKs and discovery/resource scopes; MCP stdio first, remote auth later.
- Add durable agent proposals with reviewable operations and least privilege.

**Dependencies:** P01/P02 contracts; MVP subset alongside P03; full platform after P05/P08 scopes mature.

**Acceptance criteria:** Agents complete the first slice without browser clicks; permissions/expectedRevision/requestId are identical across interfaces; SDKs never embed credentials in project.

**Test strategy:** Schema/codegen parity, structured-error contract, authorization denial, retries/idempotency, disconnect/progress/cancel and CLI actual output tests.

**Security requirements:** Separate transport identity from project scopes; stdio session boundary; remote OAuth/auth before exposure; no shared dev fallback; audit without secrets or forged tool-output authority.

**E2E requirements:** Standalone agent/client creates and exports/reopens production, loses connection, resumes and cancels owned work through tools.

**Evidence needed:** Tool schema/version, SDK examples, API/MCP/CLI transcripts, denied calls and identical semantic outputs.

**Exit gate:** Minimal parity is an MVP requirement, full permissioned SDK platform a v1 gate; source patterns are not proof of runtime safety.

**Risks:** Transport auth complexity; task ownership; context injection; overlapping permission models; unfinished owner runtimes.

## P10 — Quality, Security, and Performance

**Scope:** Quality Lab benchmarks, adversarial resource/security/recovery checks and measured supported limits; starts alongside each phase.

**Selected donor modules:** Ascout/SpecGrain evidence/independence contracts; Diffcipline bounded harness concepts; Jev secondary judgments; independent review tools when operational, never substituted passes. Exact source pins and inspected paths are in the catalog/module receipts; imports require a bounded path list and ledger update.

**Bounded tasks:**

- Build reproducible consented workload/output benchmarks and blind human evaluation.
- Attack archives/media/SSRF/plugin/workflow/scopes/cost boundaries with bounded fixtures.
- Measure CPU/GPU/disk/memory/preview/export/cancel/reopen distributions and set supported limits.
- Resolve severe independent-review findings and document residual risk by actual release scope.

**Dependencies:** Cross-cutting P01 onward; full benchmark engine set from enabled P04–P09 operations only.

**Acceptance criteria:** No unresolved release-blocking security/data-loss/billing defects; measured supported limits and honest unavailable operations; quality results reproducible with artifact provenance.

**Test strategy:** Adversarial corpus, crash injection, fuzz/property checks on critical serialization/time/money, load/cancel/restart distributions, accessibility/RTL/Arabic export.

**Security requirements:** Threat-based tests and independent review; tool unavailable/failure states are explicit; protect consented datasets and secrets in evidence.

**E2E requirements:** Repeat full production journeys under disk pressure, cancellation, interrupted jobs and malicious input; verify no data loss or unauthorized network/spend.

**Evidence needed:** Exact patch/test hashes, fresh independent judgments, resource distributions, quality outputs/ratings and triaged findings.

**Exit gate:** Release-scope checks pass with evidence; do not require unused unqualified GPU engines or accept static audits as E2E.

**Risks:** Insufficient independent provider tooling; narrow fixtures; tiny benchmark samples; misleading automated creative scores; resource limitations.

## P11 — Release Qualification

**Scope:** Supported desktop and local web delivery, clean installation/update/recovery, offline operation, documentation and notices.

**Selected donor modules:** Approved bounded source modules only; established render/media libraries; qualified shell/update patterns, not copied complete donor application installers. Exact source pins and inspected paths are in the catalog/module receipts; imports require a bounded path list and ledger update.

**Bounded tasks:**

- Build signed/versioned artifacts where signing is available; document any unsigned preview limitation.
- Test clean-host install, offline first slice, update/rollback and legacy project migration.
- Verify Arabic/English navigation, text shaping/accessibility and API/SDK guide against actual release.
- Freeze SBOM/provenance/notices, qualification matrix and supported capability limits.

**Dependencies:** MVP: P01–P03 + minimal P09 + scoped P10. Production v1: enabled P04–P09 + P10. Never advertise all inventory as released.

**Acceptance criteria:** User downloads/install/launches without founder cloud, paid inference, Python or GPU for editing; actual export/reopen works; update does not overwrite data.

**Test strategy:** Clean Windows host plus separately qualified web browser; install/uninstall without user-data deletion; offline network capture; full UI/API journeys; migration/update rollback.

**Security requirements:** Integrity/signature and update-source checks; permission-minimal installer; secrets not bundled; dependency/notices and codec-build compliance.

**E2E requirements:** Fresh supported-host installation executes entire first slice and programmatic repeat; production-v1 adds only qualified creative/provider workflows.

**Evidence needed:** Artifact hash/build commit, install recording, actual MP4/project, offline network report, notices/SBOM, support matrix and rollback receipt.

**Exit gate:** Independent release review and founder ship decision against concrete artifacts; no claim desktop delivery from a web preview.

**Risks:** Signing/distribution/toolchain gaps; FFmpeg build-specific GPL/nonfree components; untested OS/browser/media combinations; update migration safety.

## Changes and decisions

Record approved changes as scoped ADRs and update this plan and CURRENT together. Never create another master plan. The proposed foundation ADR must become accepted only after the review/approval gate. Every phase must state what remains unqualified and its release impact; disable optional unavailable capabilities rather than advertise placeholder studios. A concrete change needs reviewer findings, tests and evidence linked to its own immutable commit or patch.
