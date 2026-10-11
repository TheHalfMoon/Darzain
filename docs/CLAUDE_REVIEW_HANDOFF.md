# Independent Claude review handoff

## Review request and hard gate

Independently challenge this Yamakan plan before implementation. Use the source pins, actual module receipts and official URLs below. Return severity-ranked findings, revised decisions/contracts/phase tasks, accepted residual risks and an explicit recommendation to the founder. Do not assume this package is approved. Claude review has NOT been performed; no Claude runtime/tool was available in this session. Prior GPT or tool judgments do not substitute for the required independent Claude review. Full implementation may begin only after that review and founder approval of the reviewed revision.

## Verified repository state

Product: Yamakan; previous product: Darzain. Verified canonical repository: [TheHalfMoon/Darzain](https://github.com/TheHalfMoon/Darzain). Main at research verification: **0d3bdacb51188294ba8d36ce2b218db72f6073a6**. Owner authenticated GitHub access resolved it; TheHalfMoon/Yamakan did not resolve through that connection. A repository rename has not been performed. Planning branch: docs/yamakan-master-plan, based on that exact main. This package is documentation/evidence only; it changes no production application code. The package manifest identifies all delivered bytes without a circular self-hash.

Merged historical prototype work includes PR1 production slice and PR2 recoverable storage. Main has actual offline export/reopen and narrow agent API evidence. It does not contain the complete proposed project schema, local inference or full Yamakan product. The unmerged feat/durable-jobs draft is preserved separately: immutable patch SHA-256 **998f50c7479d55fc34c3aa1b8e1b12533ceafc64e964a90941828cee7f959ca6**, based on 0d3bdacb51188294ba8d36ce2b218db72f6073a6; reviewer attempts failed at service usage limits, so it is not independently approved. Treat it only as candidate code for task 5, not a merged foundation guarantee.

## Inventory and exact donors

58 distinct repository snapshots were examined at varying depths. The complete named inventory and exact 40-character references are in [SOURCE_CATALOG.md](SOURCE_CATALOG.md); selected actual module paths/hashes are in [source-modules.json](evidence/yamakan/source-modules.json). All 13 TheHalfMoon ecosystem candidates are included; private source text is not published. New additional alternatives are OpenTimelineIO, Mediabunny, LangGraph and maintained Piper, justified by the specific time/interchange, browser media, checkpoint and offline-voice gaps. Snapshotting is not application-wide qualification. [SOURCE_REUSE_LEDGER.md](SOURCE_REUSE_LEDGER.md) distinguishes legacy imported modules from proposed source reuse and unresolved weight/asset/service rights.

Measured reusable evidence: filmmaker web build 44.966 s and 145 tests; ArtCraft frontend build 138.841 s (native unqualified); Open Generative AI Vite build 24.527 s (full Next/provider runtime unqualified); original OpenVideoStudio 22 tests passed in 2.28 s with fake LLMs and fixture media bytes; original OpenMontage six prerequisite/gate tests passed in 1.70 s. Skelet recovery and Gomrey pure rules have earlier scoped tests. Original donor code was preserved. No local video/image/3D inference or commercial generation was run.

## Foundation recommendation and rejected alternatives

**Recommend D: small canonical Yamakan core with qualified adapted modules.** Preserve the actually working offline core and integrate filmmaker editing/preview primitives, mature FFmpeg render/probe, qualified content storage, optional ArtCraft scene controls and scoped OpenMontage production manifests/gates. One timeline, one project authority and one shared command/job contract. OpenMontage is a production-stage donor, not the sole worker supervisor. Tauri is a conditional desktop candidate and needs qualification; web/local service is already evidenced. See [competition](ARCHITECTURE_OPTIONS.md), [decision](ARCHITECTURE_DECISION.md) and [proposed ADR](adr/0002-yamakan-modular-foundation.md).

ArtCraft-first is rejected as current whole-app base due unqualified native/services and state translation burden; filmmaking-first has stronger tested editing but unrestricted Electron/IPC and inherited state are unacceptable; OGA-first provides breadth but incomplete full runtime and separate studios/state. Challenger React Video Editor depends on an unresolved engine source and company-size terms; OpenCut's pin is a placeholder and Classic build was unavailable. Native Kdenlive/MLT/Blender need separate build/distribution/interchange experiments. None is rejected as a future bounded donor simply because it is not the initial base.

## REA and tool evidence

REA 6.3.0 is installed/registered; Node 24.19.0 compatible; real MCP handshake protocol 2025-11-25 lists 139 tools and analyze_javascript_application succeeds. Four bounded static CLI analyses succeeded for filmmaker shell/render, OGA provider/Electron, ArtCraft scene and OpenMontage composer. Current upstream README advertises 6.4.0, not installed/qualified. Native analysis provider unavailable; full-tree attempts failed ENOBUFS. See [REA findings](REA_FINDINGS.md), [target matrix](REA_TARGET_MATRIX.md), [integration decisions](research/REA_INTEGRATION_DECISIONS.md) and receipts under evidence/rea. Static graphs do not prove security or runtime correctness. OCR CPU review failed/timed out or skipped oversized inputs, Graft was structural only, Jev probabilistic, PStack full scaffold and Ascout/Kodac runtimes unqualified. [TEST_STRATEGY.md](TEST_STRATEGY.md) records the limits.

## Contracts to challenge

Review [PROJECT_DATA_MODEL.md](PROJECT_DATA_MODEL.md): new yamakan.project v1 envelope distinct from legacy schemaVersion 1, stable IDs, immutable asset versions, checked rational time, revision conflicts, migration preserving originals, bounded undo and crash recovery. Review [MODEL_CAPABILITIES.md](MODEL_CAPABILITIES.md): operation unions and evidence-backed conditioning, describe/validate/quote/submit/poll/cancel/reconcile/collectOutputs, documentation/readiness/entitlement/actual-output separation. Review [AGENT_MCP_ARCHITECTURE.md](AGENT_MCP_ARCHITECTURE.md): shared tool/REST/CLI/TS/Python contracts, scopes, structured errors and audit. These are proposed contracts; exact executable schemas are tasks after approval.

Review [COST_ROUTER.md](COST_ROUTER.md) and full-field [provider registry](evidence/yamakan/provider-registry.json): hard capability/region/privacy/entitlement filters before scoring; known estimates, decimal reservations, input surcharges, price freshness, no silent fallback and no automatic replay of ambiguous paid submits. Latest official guide retires OpenAI Sora 2/Videos API; Alibaba Wan 3.0 and MiniMax H3 v2 must not be confused with older wrappers or open-weight Wan2.2. Account limits, resale/white-label rights and many modality contracts remain unverified. No provider contact or paid test was made.

## Ranked risks and hardware

1. Critical: crossing the review gate, inherited unrestricted shell/auth, archive/media/path/SSRF privilege escalation, duplicate paid attempts or destructive migration. Resolve before affected implementation/release.
2. High: canonical time/effect/preview-export mismatch, data-loss/recovery and process ownership, model weights/assets/services rights, local model hardware and provider eligibility/retention. Keep affected operations disabled until qualified.
3. High: identity/camera/motion/native-audio claims without real generated-output evaluation; source metadata and prompt suffixes cannot establish creative quality.
4. Medium: Arabic shaping/RTL/accessibility, desktop/native builds, signing/updating, source maintenance and developer-tool unavailability; increase severity if they block agreed release scope.

Current Windows host: Intel i5-13420H, 12 logical processors, 16 GiB RAM, Intel UHD reported, no suitable discrete GPU verified. Node 24.19.0, Python 3.14.7, FFmpeg 8.1.1. Ollama/Qwen CPU text execution is not image/video inference qualification. Actual historical 30-second 720p CPU export took 6.052 s once, not an SLA. Disk filled during research; only task-created donor node_modules caches were removed, restoring about 1.8 GB. Product data and donor source/receipts were retained. Model downloads and large builds need explicit free-space preflight. See [LOCAL_INFERENCE.md](LOCAL_INFERENCE.md) and [SECURITY.md](SECURITY.md).

## Roadmap, first ten tasks and acceptance

[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) is the only authoritative master plan and contains P00–P11 with scope, donors, bounded tasks, dependencies, acceptance, tests, security, E2E, evidence, exits and risks. [ROADMAP.md](ROADMAP.md) separates MVP, v1 and expansion and supplies conditional effort estimates.

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

First-slice acceptance: offline launch → create → import images/video → create scene/shot → timeline → title → audio → actual preview → playable MP4 → close → reopen losslessly → programmatic repeat through scoped API. Add actual restart/cancel/orphan/disk-full and Arabic title checks. Actual output probes/frame/audio checks and project/reopen receipts are required; generated screenshots are not acceptance. [E2E_ACCEPTANCE.md](E2E_ACCEPTANCE.md) owns the detailed test.

## Questions Claude must challenge

1. Is D actually the smallest coherent integration given measured source maturity, and what exact donor paths should be imported/replaced? Does the desktop choice deserve a separate spike before committing?
2. Is rational frame/tick time sufficient for VFR, audio precision, speed changes and nested compositions? Which effect semantics must remain identical in preview/export?
3. Are migration/atomic publication/recovery guarantees honest on Windows, and should the canonical snapshot journal or a transactional database own durable jobs?
4. Can the preserved jobs draft safely own child processes, cancel races and restarts? What independent fault tests and patch review are missing?
5. Can an adapter reliably enforce a hard spending cap for token-based and input-charged services? How should unknown final charge and ambiguous remote submit be represented?
6. Are local worker/package/model/plugin isolation, egress, scopes and archive/media limits enforceable rather than policy-only? What must be impossible before remote exposure?
7. Which donor/model/weight/asset/commercial restrictions affect the release boundary despite founder source authorization? Are required notices and licensing isolation adequate?
8. Which actual engines/providers can be qualified on available hardware without making expensive GPU or founder cloud a launch requirement?
9. Does the MVP include all 12 first-slice steps, true agent API parity and Arabic/English acceptance? Are estimates credible given native packaging and recovery work?
10. Which quality metrics require blind humans, and how will identity/motion/camera/audio claims be limited to measured configurations?

## Exact founder decisions after Claude review

Approve or revise: (a) D modular core and one project/timeline authority; (b) MVP boundary and conditional effort range; (c) proposed data/generation contract and preserved-original migration; (d) desktop spike and Tauri/Electron fallback criteria; (e) distribution/license policy and module isolation for GPL/AGPL/commercial/community sources and separately lawful weights/assets; (f) first optional local engine profile and available test hardware; (g) first BYOK provider/model/region with explicit capped testing budget and media-upload consent, or offline-only initial release; (h) repository rename/migration policy, independently from product branding; (i) zero founder-funded cloud plus no silent provider fallback; (j) security/quality/release acceptance and any documented residual risk. Each decision must refer to the reviewed plan revision. No decision is inferred from the founder's general source-reuse authorization.
