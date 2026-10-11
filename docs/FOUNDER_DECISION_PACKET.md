# Founder decision packet

Prepared by the independent Claude review of PR #3 at 419bc356eaa6738ba546f38310687739177da6bb. Evidence: [CLAUDE_INDEPENDENT_REVIEW](review/CLAUDE_INDEPENDENT_REVIEW.md). Each decision must be recorded against the head commit of the review branch that carries this file, not against 419bc356. **None of these is approved yet.** The founder's general source-reuse authorization does not decide any of them.

Record each one as: `Decision X: Preferred | Alternative | Revised — <initials, date, commit>`.

## A. Canonical architecture

- **Preferred:** D′. One Yamakan core: owned schema, SQLite operational index, content-addressed snapshots and media, typed command registry, and FFmpeg as export authority driven by a render-plan IR. Donors are imported only as bounded modules.
- **Alternative:** E, an OpenCut-Classic-first editor with a Yamakan server-side storage adapter.
- **Why:** D′ is the only option already proven end to end on the target host, and it keeps one persisted authority for UI and agents. E has better editing depth but browser-local persistence, an unrun test suite and no headless path.
- **Consequences:** Editing depth for v1 comes from qualified OpenCut Classic modules rather than its whole application. Reverse this choice only if E passes the same first-slice DoD with headless agent parity.

## B. MVP scope

- **Preferred:** A local-web MVP on Windows (Profile A) covering the first-slice DoD in [E2E_ACCEPTANCE](E2E_ACCEPTANCE.md): Arabic/English titles via libass, streaming import, SQLite-backed recovery, UI/REST/CLI/MCP-stdio parity, and archive round trip. No AI generation, no desktop installer.
- **Alternative:** MVP plus a desktop installer (Tauri). Adds roughly 8–15 working days and native toolchain risk.
- **Consequences:** The first user-visible release runs in a browser served from loopback. Desktop packaging becomes the first post-MVP release.

## C. Data model and migration policy

- **Preferred:** `yamakan.project` v1 with flicks timeline time, rational fps, per-stream source time bases, and CFR mezzanine assets for VFR sources. Legacy Darzain roots are migrated read-only into new roots, with byte-identical originals verified by hash manifests. Unknown future versions open read-only.
- **Alternative:** Keep frame-integer time at 30 fps for the MVP and defer the time model. This is cheaper now but forces a second migration.
- **Consequences:** One migration now. The 30 fps, 1080p and 10-minute caps are lifted under measured limits.

## D. Desktop technology and qualification

- **Preferred:** A parallel spike that ends in an ADR. Tauri 2 is preferred if it passes: a deny-by-default capability file (not ArtCraft's), a Job Object owning all workers, a single-instance lock, fileless token handoff, H.264/AAC playback in WebView2, and an installer under 120 MB.
- **Alternative:** Hardened Electron (`sandbox`, `contextIsolation`, no `shell`, sender validation, utilityProcess workers, native Job Object helper).
- **Consequences:** The desktop shell no longer blocks the MVP. Tauri on Linux (WebKitGTK codecs) is out of scope until tested.

## E. Source reuse and required notices

- **Preferred:** Import only through ledger entries recording repository, SHA, original and imported paths and hashes, license or notice, the founder's authorization reference, modifications and qualification. The do-not-import list in the review is mandatory and enforced by `provenance:check`. AGPL donors (OpenMontage, StoryMind) run out of process unless the founder accepts AGPL terms for the distributed product. Non-commercial assets (storyboard CC BY-NC-SA, FLUX non-commercial weights) are excluded from commercial builds unless the founder documents a separate grant.
- **Alternative:** Relicense the product as AGPL-3.0-or-later and link AGPL modules in process.
- **Consequences:** The repository is currently GPL-3.0-or-later and bundles FFmpeg GPL builds, so source-offer obligations apply to every desktop distribution.

## F. Local inference and hardware

- **Preferred:** Profile A for everyone. Profile B is disabled by default and enabled per operation only after a qualification receipt on named hardware (NVIDIA ≥ 12 GB VRAM for video, ≥ 60 GB free disk). The current laptop is a Profile A machine only.
- **Alternative:** Procure or rent one qualified GPU host for P04/P07 qualification. The founder sets the budget.
- **Consequences:** No local generative claim ships without a receipt.

## G. BYOK and paid-provider activation

- **Preferred:** An offline-only MVP. For v1, enable one provider and model chosen by the founder, using the user's own key, write-ahead submission intents, no automatic resubmission of ambiguous attempts, and a hard cap only when the price is bounded. The founder approves a capped real-test budget in writing.
- **Alternative:** Use an aggregator (fal.ai or MuAPI) as the first route, which is faster but introduces aggregator pricing, retention and terms.
- **Consequences:** Zero founder-funded inference in the MVP. There is no silent local-to-cloud fallback.

## H. Repository naming

- **Preferred:** Keep `TheHalfMoon/Darzain` until the MVP tag, then rename it to `Yamakan` (GitHub keeps redirects). Product UI and package name become Yamakan in task 2. `DARZAIN_*` environment variables and the `.darzain` root remain readable aliases for one release.
- **Alternative:** Rename now, which disrupts open PRs and receipts that cite the old URL.
- **Consequences:** Evidence links remain stable through the MVP.

## I. Security and release acceptance

- **Preferred:** The MVP release is blocked by: B1, B2, H2, H3, H4, H6, M1, M2, M4, M5, an adversarial media/archive corpus, negative loopback tests, clean-host offline network capture, and an independent review of the exact release diff.
- **Alternative:** Ship a developer preview with M2/M5 open and documented. This is acceptable only for internal testers.
- **Consequences:** Release gates are executable tests, not policy statements.

## J. Accepted residual risks

Confirm or reject each one:

- AR1: power-loss durability depends on drive flush.
- AR2: the local same-account attacker is out of scope.
- AR3: static REA evidence is incomplete.
- AR4: no GPU qualification on the current host.
- AR5: the time estimates in [ROADMAP](ROADMAP.md) are planning ranges, not commitments.
