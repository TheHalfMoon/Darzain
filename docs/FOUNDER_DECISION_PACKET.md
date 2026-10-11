# Founder decision packet — final proposal

**CONDITIONAL GO for scoped offline implementation after approval. NO-GO for release today.** Every choice remains unapproved. Read [assessment](review/FINAL_OPTIMIZATION_REVIEW.md), [plan](IMPLEMENTATION_PLAN.md), [contracts](OPERATIONAL_CONTRACTS.md) and [acceptance](E2E_ACCEPTANCE.md). Based on Claude PR #4 `73910ba9db870a68c9b08c7c369c4bdd1ff3f420`; approval binds the final PR's exact head. Earlier packets remain at their commits.

| Decision | Preferred and implication | Alternative / approval scope |
|---|---|---|
| A architecture | Refined D′: SQLite including snapshots, external immutable media, unified timeline/commands/jobs, FFmpeg/libass reference preview | Whole OpenCut only after identical acceptance/migration experiment. Mandatory MVP choice |
| B scope | Local-web Windows offline slice, Arabic/English, API/MCP, recovery/backups; archives later; no AI/desktop prerequisite | Desktop adds estimated 8–15 days; archives separate parser gate. Mandatory MVP choice |
| C migration | Flicks with checked BigInt/rational math, source PTS, VFR derivative; new root, originals byte-identical | Deferral requires explicitly accepting a later second migration. Mandatory MVP choice |
| D desktop | Defer packaging; bounded later shell/IPC/install comparison and ADR. Native service-owned probe/render lifetime is mandatory in T4/T5 | Tauri provisionally preferred; hardened Electron admissible. Packaging may stay deferred |
| E reuse/distribution | Exact hashes/notices and mandatory exclusions; meet actual GPL/source-offer obligations | AGPL/other terms need component-specific grant/distribution review; out-of-process alone is not a license exemption. Mandatory MVP choice, no blanket future-donor approval |
| F local AI | Deferred/disabled; each hardware/model/weight/environment separately qualified | Procure/rent later under a named budget. May stay deferred |
| G providers | Deferred/disabled; later one entitled adapter with upload consent, reservations/reconciliation and capped approved tests | Aggregator is a separate disclosed route; no ambiguous retry/cloud fallback. May stay deferred |
| H naming | Keep `TheHalfMoon/Darzain`; product-facing Yamakan naming after approval | Eventual repository rename needs separate founder action, not automatic at MVP tag. May stay deferred |
| I release | All MVP Windows E2E/fault/security/parity/backup/accessibility gates, exact CI and independent review | Narrow internal preview needs recorded risk and cannot be called accepted MVP. Mandatory MVP choice |
| J residual risks | Local-account trust; hardware flush/power-loss limits; incomplete static evidence; no GPU/competitor quality proof; conditional 24–42 builder days +5–10 contingency | Stronger promises require more qualification and estimate. Mandatory MVP choice |

Approval format: `Final plan <full commit SHA>: A/B/C/E/I/J approved as preferred; D/F/G/H deferred; <name, date>`. Record alternatives separately. This authorizes the ten implementation PRs and bounded qualification, **not** planning merges, production release, paid generation, repository rename or unrelated assets/weights/services.

Compared with Claude: reduce cross-store snapshot failures; specify replay/fencing/cancel/backup; add a shared-engine truth preview; constrain imports using real OpenCut failure evidence; move optional archives/WASM/shell work off the initial path. Compared with original Codex: retain Claude's storage/security/job/Arabic corrections and replace broad claims with executable gates. Faster effort is an estimate, not observed productivity.

Storage builder owns B1; Security reviewer owns exclusions/loopback/ACL; Runtime builder owns jobs/lifecycle; Media builder and Arabic reviewer own text/reference parity. Optional-worker/provider blockers cannot delay offline work and cannot be waived by general source permission.

**Stop at founder approval. No decision has been inferred or recorded by this optimization.**
