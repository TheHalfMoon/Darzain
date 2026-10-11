# Final independent architecture optimization

Reviewed live PR #3 `419bc356eaa6738ba546f38310687739177da6bb` and PR #4 `73910ba9db870a68c9b08c7c369c4bdd1ff3f420`, including Claude's review, evidence, founder packet, master plan and contracts. Base main `0d3bdacb51188294ba8d36ce2b218db72f6073a6`. **CONDITIONAL GO after exact-commit founder approval, NO-GO for release now.** No production implementation or planning merge occurred.

## What changed and why

Retain D′; no challenger demonstrated a lower migration cost or identical acceptance. Add in-DB canonical snapshots so an acknowledged edit does not depend on publishing a new JSON file. External media still needs staged publication and qualified recovery; power-loss durability is not established. Clarify replay before CAS, request digest scope, job/attempt fencing, cancellation races, bounded retention, corruption boundaries and live-DB backups. Provide FFmpeg reference preview because a common IR alone does not unify Canvas/libass/FFmpeg pixel semantics. Keep fast preview only for parity-qualified operations.

OpenCut Classic is better than originally dismissing it for missing Bun, but it is not a universally qualified editor donor. New original-source tests produced **53 pass/4 fail** after a real WASM loader and three pinned dependencies; two other files produced **23 pass/0 fail**. A new boundary test confirms `BatchCommand` leaves earlier mutations applied when a later command throws. Import pure algorithms through canonical adapters; do not reuse global editor commands as DB transactions. Preserve failures and do not relabel limited tests as whole-app proof.

Remove portable archives/JASSUB/desktop from the initial mandatory path, retaining backup/recovery, usable preview and real Windows E2E. Approve only mandatory MVP decisions; leave hardware, spending, packaging and naming deferred. Correct the implication that AGPL obligations disappear merely because a worker is out of process. Preserve notices and component-specific distribution qualification. Freeze prior source pins and inspect two new candidates without architecture expansion.

## Finding disposition

CONFIRMED means source/receipts substantiate the stated defect; it does not mean the final production fix exists. Existing Claude experiments are inherited evidence, explicitly not rerun without cause. [New evidence](final-2026-10-11/evidence.json) is separate.

| Finding | Disposition | Evidence and final action |
|---|---|---|
| B1 storage | CONFIRMED; proposed remedy PARTIALLY CONFIRMED | T1/T2b/T6 preserved; Graft traces all legacy persistence callers. New DB snapshot/replay/kill spike passes. Move snapshot bytes into transaction; external media/power loss still unqualified |
| B2 donor boundary | CONFIRMED | Exact donor heads/clean source verified; consumer-cookie/browser-emulation/config exclusions retained and enforcement required |
| H1 draft jobs (B3) | CONFIRMED | Claude T5 at frozen draft; retain transition rules only, SQLite job/attempt authority and active-vs-historical limits |
| H2 Arabic (B5) | CONFIRMED for recorded build/fixtures | T4 preserves actual drawtext base-direction failure; libass approach retained; engine/font equality, escaping, broader Arabic goldens remain qualification |
| H3 buffered imports | CONFIRMED | Source `body`/`readFile`, 50 MB policy; streaming CAS/ranges and dynamic disk preflight |
| H4 stale lock | CONFIRMED | Source exclusive lock file; OS lock plus DB lease, kill/restart test |
| H5 worker descendants (B4) | CONFIRMED; proposed host-owned lifecycle PARTIALLY CONFIRMED | T3 retained. Job Objects need assign-before-resume and service-death handling as well as last-host-handle close; disable descendant workers pending those tests |
| H6 parity (B6) | CONFIRMED | Preview/export source separation. Canonical IR alone insufficient; shared-engine reference preview plus measured fast subset |
| H7 ambiguous paid submission | CONFIRMED | MuAPI no idempotency/timeout pattern and recorded source; exact reservation/intent/reconciliation tests before enablement |
| H8 desktop on MVP path | CONFIRMED | Historical phase dependencies; optional desktop spike after DB, packaging later |
| M1 loopback | CONFIRMED | Header/source policy; origin/Host/Fetch Metadata tests and distinct authenticated local-client path |
| M2 Windows token ACL | CONFIRMED | File mode is not an explicit Windows ACL; second-account qualification required |
| M3 serializer | CONFIRMED | T7; schema rejects unsafe numbers/prototype keys; use checked time arithmetic |
| M4 disk full | NEEDS QUALIFICATION | Absence of physical ENOSPC evidence retained; injected fault seam + constrained-volume Windows/Linux run required |
| M5 filesystem support | PARTIALLY CONFIRMED | Hardlink/locking assumptions don't qualify every named FS; first support local NTFS only, reject network/sync roots pending tests |
| M6 FFmpeg build | CONFIRMED | Installed 8.1.1 advertises libass/HarfBuzz/FriBidi; this is not final bundle/hash/font or Arabic parity qualification |
| M7 OGA aggregator | CONFIRMED | Catalog references only; official adapters independent of donor provider client |
| M8 OpenCut unqualified | PARTIALLY CONFIRMED | New bounded tests now exist, but four failures and no complete app build/preview integration; eligible algorithms distinguished |
| M9 duplicate phase snapshot | CONFIRMED | Original machine plan remains historical, final Markdown owns tasks |
| M10 disk pressure | PARTIALLY CONFIRMED | Current preflight observed about 2.9 GiB free; ample for bounded tests, insufficient for large media/model qualification; do not recycle old 99% claim as current measurement |
| L1 cookie on errors | CONFIRMED | Recorded source path; bootstrap/navigation policy in T9 |
| L2 short-name root | NEEDS QUALIFICATION | Retained report; qualify path canonicalization on supported NTFS roots, avoid blanket case rules |
| L3 Comfy targeted interrupt | CONFIRMED correction | Pin supports prompt ID/delete; cancellation race and worker ownership still need runtime tests |
| L4 draft style | CONFIRMED but superseded | Draft excluded as authority; do not spend MVP work polishing rejected journal code |
| AGPL out-of-process exemption implication | DISPUTED WITH EVIDENCE | Source license and distribution terms remain obligations; a process boundary is not a grant. No legal blanket exemption claimed |
| Flicks conversion safety | PARTIALLY CONFIRMED | Exact tick/sample rates retained; safe persisted integers do not ensure safe multiplication intermediates (new spike shows unsafe intermediate at 213 s for 60000/1001). Use BigInt; no measured frame mismatch was found in the bounded search |

## REA and tool limits

Live REA MCP/CLI is **6.3.0**, aligned Codex registration, protocol 2025-06-18, 139 MCP tools; Claude's isolated 6.4.0 receipts are preserved separately. The new 50-file OpenCut algorithm/command subset parses with zero failures (708 findings). MCP analysis completed but its response exceeded 10 MB; the complete 20,610,544-byte retained evidence bundle exported successfully. Input/output hashes and evidence ID are recorded. Static graph and source inspection identify global-command/time/WASM coupling; no runtime or native claim follows. Native engines unavailable; audit-wide doctor reports unrelated registrations absent, while current Codex alignment is verified live.

Graft keyless graph: 9 core files, 95 nodes, 239 edges; query locates create/import/restore/save as persistence callers. No deep model review. Jev 2026.919.0/jev-1.13.0 ran one advisory judgment (0.81); this is not a correctness/security approval. Alibaba OCR 1.12.13 is delegate mode only; no OCR model-backed review configured. PStack skills are present now; final fresh-context panel report is recorded separately. Ascout lineage concepts are useful; Kodac auth remains excluded; neither runtime executed. No GPU, generation, native desktop or competitor-output benchmark occurred.

## Remaining uncertainties and adversarial corrections

The plan cannot guarantee survival of dishonest drive flushes, physically destroyed storage or missing external media; preserve corruption, recover from verified backups and state the bounds. A renderer can produce incorrect staging output but has no DB writer/grants; only validation/current-attempt fencing can publish. A native worker can survive a service crash if lifecycle ownership is wrong; both host and service death are tests. GC cannot delete retained revisions or active assets. Agent approval binds exact operations and base revision, not a mutable proposal. Paid ambiguity retains reservation and requires reconciliation. Whole donor stores/renderers remain maintenance hazards. Reference preview latency, Arabic shaping/version parity, source timestamp handling, actual NTFS locks/ACLs/disk-full and full source-import integration remain release gates.

These corrections are integrated into the sole master plan and operational contracts. The [fresh-context combined and security panel](final-2026-10-11/panel-review.json) found three publication/lifecycle gaps and scope/profile contradictions. The revised delta addresses them: fenced GC/quarantine generations; a destination-derived backup manifest protected by GC exclusion and durable pins; atomic service-owned Job Object assignment for both MVP probes and render jobs; nested compositions deferred; phase/profile guidance reconciled; early preview spike and frozen qualification policy. Both reviewers report no remaining must-fix in their reviewed planning scope. Their report is evidence of planning review, not runtime acceptance or founder approval. No overall superiority claim is earned by planning.
