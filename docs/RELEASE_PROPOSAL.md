# Yamakan offline MVP — release proposal (T10)

**Verdict: NO-GO for release.** T1–T9 are merged with independent review and exact-head CI, and every gate measured on this machine passes its target. But the [MVP acceptance](E2E_ACCEPTANCE.md) requires every row to pass on the exact release commit **and artifact hashes, on clean Windows Profile A**. Several rows need a pinned distributable bundle, a clean profile, a second account, a native Arabic reviewer or harnesses that do not exist yet. This document is the gate-by-gate account, for the founder's ship decision.

**Measured at commit `80896701`:** receipt [`docs/evidence/qualification/t10-release.json`](evidence/qualification/t10-release.json), produced by `npm run qualify:release` on a clean tree.

## Measured on this machine (development profile)

**Machine:** Windows 11 Home 10.0.26300, Node 24.19, FFmpeg 8.1.1 (gyan.dev full build); hashes are in the receipt.

| Measure                                                                                                      | Result                                                                                                           | Target                               |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Cold launch (service start to ready, 5 runs)                                                                 | p50 537 ms, p95 637 ms                                                                                           | ≤ 5 s ✓                              |
| Reopen (service start to project open over the API, one 10 s 720p clip, 200 revisions; 5 runs)               | p50 508 ms, p95 544 ms                                                                                           | ≤ 2 s ✓                              |
| Test suite                                                                                                   | 203 tests: 201 pass, 2 POSIX-only skips                                                                          | all pass ✓                           |
| Browser E2E (Edge): full journey, Arabic interface, keyboard backup, launch-link session, other-port refusal | passes, 0 page errors                                                                                            | 0 ✓                                  |
| Offline (TCP of the service and every descendant during the E2E)                                             | 10 samples, about 1.2 s apart; 12 endpoints, all loopback; 0 external                                            | 0 external ✓, **sampled only**       |
| Pinned fonts                                                                                                 | both IBM Plex Sans Arabic files match the ledger hashes                                                          | ✓                                    |
| Earlier receipts                                                                                             | ≥ 2 GiB import peak 154 MiB (T4b); reference preview: cold frame p95 410 ms, warm 2 ms, 2 s segment 894 ms (T8a) | ≤ 300 MiB ✓; ≤ 3 s / ≤ 1 s / ≤ 6 s ✓ |

The offline row is sampled, not a packet capture: UDP (DNS) is not seen, and a connection shorter than the sample gap can be missed. A full egress capture (for example `pktmon` or firewall auditing) needs an administrator.

## Journey (E2E_ACCEPTANCE §Complete human and agent journey)

Status:

- **Met (dev):** passes with evidence on this machine's development profile.
- **Partial:** part of the row has evidence; what is missing is named.
- **Open:** no evidence yet.

| Step            | Status    | Evidence / what is missing                                                                                                                                                                             |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 launch        | Partial   | Launch time and offline sample above; versions and hashes recorded. Missing: a fresh Windows profile, a pinned local bundle (FFmpeg is the host's winget install), and a packet-level egress capture   |
| 2 create        | Met (dev) | English and Arabic interface E2E; one command registry behind REST, CLI, MCP and the SDK (`tests/command.test.ts`, `tests/mcp.test.ts`, `tests/http.test.ts`)                                          |
| 3 import        | Partial   | Image, CFR video, VFR video (original retained, CFR derivative with provenance), WAV, and the 2.24 GB import within the memory bound. Missing: an MP3 fixture, and a separately measured decoder bound |
| 4 scenes        | Partial   | Scene and camera edits in the E2E; camera metadata labelled as intent. Missing: a three-scene ordered fixture that is reopened                                                                         |
| 5 edit          | Met (dev) | The ten-operation reducer fixture, failed batch commits nothing, stale undo conflicts, per-writer undo (T6)                                                                                            |
| 6 Arabic        | Partial   | Typography goldens and ASS-injection tests (T7); bidi isolation and Arabic-Indic digits (T8b). Missing: **native Arabic review** of the goldens and interface strings                                  |
| 7 preview       | Partial   | Plan-compiled reference preview, stale-revision notice, bounded cache and queue, latency receipt (T8a). Missing: a measurement of 720p playback ≥ 24 fps                                               |
| 8 export        | Partial   | ffprobe receipt (dimensions, rate, duration, H.264/AAC, faststart) and frame parity with preview (T7/T8a). Missing: the full golden boundary/title-range harness and the 10-minute audio-drift fixture |
| 9 cancel        | Met (dev) | Cancel and completion race, no publication after a winning cancel, owned FFmpeg ends (T5)                                                                                                              |
| 10 interruption | Met (dev) | Kills at every native launch seam leave no orphan, fencing, commit-or-absent, replay returns the original receipt (T2/T4a/T5)                                                                          |
| 11 reopen       | Met (dev) | Canonical hash and history survive restart; reopen time above                                                                                                                                          |
| 12 recovery     | Met (dev) | Damaged database and write-ahead log diagnosed and refused with bytes preserved; damaged media quarantined; job payload quarantine; unsaved draft download; restore to a new root (T5/T9a)             |
| 13 backup       | Partial   | Online backup during concurrent import/edit/GC restores identical snapshots and media hashes to a new root (T9a). Missing: a restore on a second clean profile                                         |
| 14 parity       | Open      | MCP runs the shared command path. Missing: a replay of steps 2–11 over MCP and REST with canonical byte comparison                                                                                     |

## Negative and fault matrix

| Area                      | Status    | Evidence / what is missing                                                                                                                                                                             |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Concurrency and replay    | Met (dev) | Two-process CAS, IDEMPOTENCY_MISMATCH, retry after commit (T2)                                                                                                                                         |
| Windows publication       | Partial   | Sharing and held-handle tests in the streaming import (T4b). Missing: an AV-style held handle during save and backup                                                                                   |
| Disk full                 | Partial   | Injected ENOSPC at import, export and publication seams (T4b/T5); free-space checks for backup and restore (T9a). Missing: real constrained-volume runs on Windows and Linux                           |
| Jobs and GC               | Met (dev) | >10,000-job history, payload quarantine, fencing (T5); GC with backup holds (T9a)                                                                                                                      |
| Media                     | Partial   | Playlist and concat subresources denied, format whitelist, bounded probes (T4); worker sandbox (T9c). Missing: a hostile corpus (polyglot, image bomb, timestamp discontinuities) with a sentinel file |
| Loopback and auth         | Met (dev) | Launch-link session with no cookie; other-port pages refused in a real browser; Host, Origin and Fetch Metadata checks (T9b)                                                                           |
| ACL and paths             | Partial   | Owner-only workspace, denied to a restricted token that stands in for another account; junctions, links and other owners refused (T9b). Missing: a **real second Windows account**                     |
| Unknown versions          | Met (dev) | Newer formats inspected, never written (T3)                                                                                                                                                            |
| Offline and accessibility | Partial   | Sampled offline capture; keyboard journey in English and Arabic; localized interface. Missing: packet-level capture, a contrast audit, and localized service errors                                    |
| Release and update        | Open      | No bundle, SBOM, installer, update, rollback or uninstall yet                                                                                                                                          |

## Worker sandbox (release blocker from T4a)

**Resolved in T9c:**

- Workers run with a restricted, low-integrity token, and WMI process creation is denied to them, tested against a control that succeeds.
- Published files carry only the main data stream, in service-created files.

**Residuals stated in [`specs/CURRENT.md`](../specs/CURRENT.md):**

- A worker can still read what the account can, and has network access.
- A compromised worker can lock its own folder until an administrator resets it.
- A write-restricted token or an AppContainer would close these. That is open work.

## What remains before a ship decision

**Engineering (can be done without the founder):**

1. A pinned distributable bundle with Node runtime, FFmpeg and ffprobe, fonts, notices, an SBOM and artifact hashes, plus install, update, rollback and uninstall.
2. Harnesses:
   - MCP/REST parity replay (step 14);
   - the export golden boundary/title-range comparison with negative fixtures, and the 10-minute audio-drift fixture (step 8);
   - 720p playback rate (step 7);
   - an MP3 and three-scene fixture (steps 3–4);
   - a hostile media corpus with a sentinel file;
   - an AV-style held-handle run.
3. Open work recorded in the spec:
   - the write-restricted worker token;
   - repeat-run reproducibility checks of the backup race;
   - the undo snapshot budget;
   - a repair path for quarantined media.

**Founder or administrator only:**

1. A clean Windows Profile A run of the whole journey with the bundle, plus a packet-level egress capture (administrator).
2. A real second Windows account denied the workspace, and a restore on a second clean profile.
3. Native Arabic review of the T7 title goldens and the T8b/T9 interface strings, including the choice of digits.
4. Real constrained-volume disk-full runs.
5. The artifact-bound ship decision, after an independent release review of the exact release commit.
