# Mandatory offline MVP acceptance

Every MVP row must pass on the **exact release commit and artifact hashes**, on clean Windows Profile A, through UI and typed commands without paid AI. These are future gates, not completed product results. Claude's legacy evidence remains valid for its narrower prototype. [Master plan](IMPLEMENTATION_PLAN.md) owns scope; [contracts](OPERATIONAL_CONTRACTS.md) define persistence/render/job semantics. Portable media archives are post-MVP; backup/restore is mandatory now.

## Complete human and agent journey

| Step | Executable pass condition |
|---|---|
| 1 launch | Fresh Windows user profile, no keys/GPU/Python, pinned local bundle. Network disabled plus egress capture: zero external connections. Record OS/runtime/FFmpeg/browser/font hashes; cold launch ≤5 s target |
| 2 create | Create projects in English and Arabic UI with mixed names. Same versioned commands via REST/CLI/MCP and thin TS SDK; no browser clicks for agent run |
| 3 import | Still image, CFR H.264/AAC, VFR phone video, WAV and MP3; one ≥2 GiB import, streaming service RSS ≤300 MiB and separately bounded decoder. Asset/probe/hash/source-time receipts; VFR original retained and ready CFR derivative with timing/provenance |
| 4 scenes | Three scenes with ordered shots and media-version references; camera metadata clearly intent; reopen retains order and links |
| 5 edit | Real multitrack add/trim/split/move/track lock/target, title and two overlapping audio clips with source offsets/gain/fades. Ten operations and undo/redo match a specified canonical snapshot. Failed batch makes zero changes; stale undo conflicts |
| 6 Arabic | Titles include trailing punctuation, mixed Arabic/Latin, Arabic-Indic digits, diacritics, bidi isolates and wraps. Native Arabic reviewer approves expected glyph order and layout; preview/export use pinned same font bytes. Titles with braces/backslashes/newlines cannot inject ASS commands |
| 7 preview | Play/seek/pause at starts/ends/gaps and overlapping layers. Reference preview generated from current frozen plan; stale revision visibly identified. 720p ≥24 fps target. Reference still ≤1 s warm/≤3 s cold; 2 s segment ≤6 s cold on stated profile; bounded caches/queues |
| 8 export | Playable MP4; ffprobe confirms expected dimensions, reduced rational fps, duration ±1 frame, H.264/AAC and faststart. Boundary frames/layer order/fit/rotation/SDR conversion and title ranges match golden intent; audio onset within 20 ms and no accumulating drift on a 10-minute fixture |
| 9 cancel | Cancel queued and running exports; owned direct process exits ≤1 s target. Cancel/completion CAS determines outcome, no publication after winning cancel, no alive process labeled cancelled. Partial cleanup failures surfaced and retried |
| 10 interruption | Hard-kill during save/render/transcode/backup, restart with no manual unlock. A DB edit is fully committed or absent; lost-response retry returns original receipt. Kills at every native launch seam, including created-but-suspended and identity-persistence windows, leave no orphan; worker reconciliation fences stale output; no FFmpeg survives. No phantom revision/artifact |
| 11 reopen | Same canonical hash, media hashes/versions, timing, titles, scenes and audio; ≤2 s target on stated fixture. No silent fallback to a different acknowledged head |
| 12 recovery | Corrupt a copied snapshot/asset/job payload and separately a DB page/WAL copy. Preserve bytes. Individual job payload quarantines; DB integrity failure opens diagnostic mode. Unsaved draft downloadable; recover verified backup/history to new root with clear lost-data bounds |
| 13 backup | Backup with concurrent import/edit/GC, GC barrier and manifest derived from the completed destination DB, then durable pins/hash-sealed publication; restore to second clean profile/new root and match that snapshot and all its media hashes. Original corrupt/root bytes unchanged. Copying a live `.sqlite` without WAL is rejected as a backup recipe |
| 14 parity | Repeat 2–11 by MCP stdio and REST/CLI using same fixture IDs or explicit bijective replay mapping in isolated workspaces. Compare canonical bytes without dropping meaningful fields; same errors and receipts for conflict/replay/failure. API responses return object IDs, not path authority |

All performance limits above are proposed targets. T4/T8 must freeze a versioned hardware/fixture/resource policy and hard thresholds before qualification; approval I includes this requirement. A row with an unspecified policy cannot pass. Record p50/p95 distributions with fixture size and hardware, peak service/worker memory and cold/warm conditions. No target is an achieved benchmark today. Narrow supported limits explicitly if necessary; don't lower a threshold silently to pass.

## Preview/export and text comparison

Freeze one plan/snapshot/asset/font/compiler/engine profile. Compare reference stills and decoded export at ≥12 timestamps, **plus** every edit boundary ±1 frame, audio onset and title cue start/end. Same output size/color profile, no rescale/crop that hides differences. Frame SSIM ≥0.98 for reference path and ≥0.95 for the declared fast subset are proposed floors; also inspect per-layer/title ROI, intended glyph order, alpha/position and absence of unsupported effects. Whole-frame SSIM alone cannot pass a small incorrect title. Include negative fixtures that deliberately drop/move/reorder a title to prove the harness detects the defect. Lock metric/tolerances before implementation qualification and retain human-reviewed Arabic goldens. Browser decode/codec losses are reported, not used to excuse semantic errors.

JASSUB has its own gate: exact ASS/font bytes, engine/shaping versions, fonts offline, seek/disposal and text ROI parity. Failure keeps it disabled while shared FFmpeg reference preview remains available. Fast interactive overlays are not accepted as the reference output merely because they consume the same IR.

## Negative and fault matrix

| Area | Test and pass condition |
|---|---|
| Concurrency/replay | Two independent DB writers forced to same expected revision: exactly one commit. Request payload mismatch returns IDEMPOTENCY_MISMATCH. Retry after commit/before response returns original revision; no head/history/receipt partial state |
| Windows publication | Sharing denial/AV-style held handles during staging/publication/save; bounded retry or explicit safe failure, no overwrite of digest bytes/phantom asset. DB snapshots do not require renaming JSON heads |
| Disk full | ENOSPC at each import/save/export/backup write seam; real constrained-volume run on Windows and Linux. Head unchanged for failed edits, no partial published output; retained originals. Preflight is advisory, not correctness |
| Jobs/GC | >10,000 history records with active quotas, invalid payload quarantine, bounded cleanup sharing failures, retention roots and active pins. Stale lease generation cannot publish/delete; ready→gcPending fencing and generation-owned quarantine survive attach/import/GC races and kill seams; GC cannot discard any retained acknowledged revision or active input |
| Media | Truncated/zero/polyglot files, huge dimensions/streams, corrupt timestamp/discontinuities, remote and local HLS/concat/playlist subresources, image bombs. An instrumented sentinel outside granted inputs remains unread; restrict demuxers/nested local subresources, not just protocols. Rejected within memory/time budgets with no network access; probe process still belongs to supervisor |
| Loopback/auth | Other 127.0.0.1 port, invalid Host, Origin/Fetch Metadata forgery, cross-site bootstrap/POST/GET, cookie on missing files. Unauthorized browser denied; legitimate explicit-token CLI/stdio works. No wide CORS/Host wildcard |
| ACL/paths | Second local account cannot read workspace/token; UNC/drive traversal/reparse/junction swaps rejected within trusted-account threat scope. Output is only a granted workspace-derived key |
| Unknown versions | Future project version never written/downgraded/field-dropped; bounded safe inspection |
| Offline/accessibility | Egress capture including fonts/preview/probe; zero external requests. Keyboard journey, focus/labels, contrast, mixed RTL/LTR names, localized errors and recoverability |
| Release/update | Exact bundle hashes/SBOM/notices/source offer, clean install/update/rollback; uninstall keeps data. Update does not alter workspace schema without approved migration |

## Post-MVP gates retained

Portable archive: reject `../`, absolute/drive/UNC/reparse/symlink, duplicate and case-colliding entries, depth/entry/expanded bombs before outside writes; verified round trip and no secrets/absolute paths. Descendant workers: extend atomic-at-create service-owned Job Object launch, Python→FFmpeg, service death, host death and reboot. Paid adapter: fake fault matrix then approved capped real output/charge tests, zero automatic ambiguous resubmits. Desktop: IPC sender/grant and filesystem/codec/installer/update tests. GPU/weights/plugins/collaboration: separate hardware/rights/runtime/security gates.

## Required release evidence

Exact commit/artifacts, input/output/canonical hashes, build/FFmpeg/font versions, ffprobe JSON, sampled frames and text ROIs, audio report, parity reports, UI+MCP transcript, fault receipts, process exit/lifecycle reports, offline capture, second-account ACL and backup restore evidence. Browser page errors zero. Independent exact-diff review and founder ship decision. A screenshot, REA graph, Jev probability or green Linux prototype CI is never the complete Windows MVP pass.
