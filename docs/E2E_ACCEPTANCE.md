# Mandatory first vertical slice — Definition of Done

Revised by the [independent review](review/CLAUDE_INDEPENDENT_REVIEW.md); the original 12-step proposal is preserved at commit 419bc356. After founder approval, the MVP is done only when **every** item below passes on the exact release head, through the UI **and** through typed tools (MCP stdio or REST/CLI) without browser clicks, with no paid inference. Historical Darzain receipts and the unmerged jobs draft are not passes.

## Journey (UI and agent, both required)

1. **Clean-host offline launch.** Fresh Windows user profile on a Profile A host, no keys, no GPU, no Python, network adapter disabled. Capture egress (for example `pktmon`) for the whole run: zero external connections.
2. **Create a project** in English UI and in Arabic UI (`dir="rtl"`), with mixed-script names.
3. **Import** a still image, a CFR H.264/AAC video, a VFR phone video, a WAV and an MP3. Each records SHA-256, probe and an immutable AssetVersion. The VFR source produces a CFR mezzanine with provenance. One import is ≥ 2 GB, with service RSS below 300 MB throughout.
4. **Scene/shot structure:** three scenes, shots linked to media, camera metadata labeled as intent.
5. **Timeline edits:** add, trim, split, move, ripple-free overlap, track lock and target, then undo and redo across ten operations, with the result checked against the expected canonical snapshot hash.
6. **Titles and audio:** an English title, an Arabic title with trailing punctuation, a mixed Arabic/Latin title with Arabic-Indic digits, two overlapping audio clips with source offsets, gain and fades.
7. **Preview:** play, seek and pause at boundaries. The parity harness compares preview captures with exported frames at ≥ 12 timestamps (SSIM ≥ 0.95), and title glyph order matches in both.
8. **Export** an MP4. ffprobe shows the expected width, height, frame rate, duration (±1 frame), H.264 + AAC stream presence, and faststart. Sampled frames match the expected picture at clip boundaries. Audio onset error is ≤ 1 video frame at each clip start. Titles appear only within their time ranges.
9. **Cancel** a second export mid-run: the owned process exits within 1 s, no `render.mp4` exists, the job is `cancelled`, and the partial output is removed.
10. **Crash and restart:** hard-kill the service during an export and during a save. The next start succeeds without manual steps. The save is either fully committed or absent, and the export attempt is reconciled to `failed` or `cancelled` with its partial output removed.
11. **Reopen:** identical canonical snapshot hash, media and timing.
12. **Corruption recovery:** corrupt a copy of the head blob. The UI and the tool both report it, offer verified history, restore without deleting the corrupt bytes, and preserve the unsaved draft for download.
13. **Archive round trip:** export an archive, import it on a second clean profile, and get a byte-identical snapshot and media hashes, with no absolute paths or secrets in the archive.
14. **Programmatic repeat:** steps 2–11 via MCP stdio produce the same canonical snapshot hash as the UI run (excluding IDs and timestamps, normalized by a documented rule), and the same structured errors for conflicts.

## Negative and fault tests (all required)

| Area | Test | Pass condition |
|---|---|---|
| Concurrency | Two writers, same `expectedRevision`, forced interleave | Exactly one commit, the other gets `REVISION_CONFLICT` |
| Windows locking | Another process holds a project file without share-delete | Save succeeds (DB commit) or fails without a phantom revision |
| Disk full | ENOSPC injected at every write call of import, save and export; plus a small-volume CI run | Head unchanged, no partial artifact published, actionable error |
| Adversarial media | Truncated MP4, huge dimensions, 10,000 streams, HLS/concat referencing remote URLs, polyglot file, zero-length file, decompression bomb image | Rejected with `MEDIA_INVALID` within the time/memory budget; no network attempt |
| Archives | `../`, absolute, drive and UNC paths, reparse points, duplicate and case-colliding entries, expansion bomb | Rejected before any write outside the staging directory |
| Loopback | Page served from another `127.0.0.1` port; DNS-rebinding Host; cross-site POST | All denied; no cookie issued |
| Worker restart | Kill the service with an export in flight | No surviving FFmpeg; attempt reconciled |
| Unknown schema | Open a project with `formatVersion` = 99 | Read-only inspection; writes refused |

## Evidence bundle

Exact commit, build and FFmpeg build hashes; input and output hashes; ffprobe JSON; sampled frames; audio onset report; parity report; MCP transcript; process exit codes; egress capture; page errors (must be zero). A screenshot alone never passes a step.
