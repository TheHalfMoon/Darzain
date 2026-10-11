# Source reuse ledger

The machine-readable authority is [imports.json](provenance/imports.json). It records exact source snapshots, source file hashes, destination hashes and intentional modifications. Required texts are in notices/.

The initial adopted boundary contains Timeline, PreviewPlayer, Waveform, icons, shared types, timecode/color/effects utilities, history/export settings and associated tests, plus scoped editor CSS from AI Video Production Editor. Cloud-backed library coupling was replaced with a local type. Clip duplication now uses canonical UUIDs. Two tiny canonical persistence modules come from Ninerr.

The local FFmpeg renderer adapts the donor buildTimelineCommand algorithm, adding explicit audio, safe title text, bounded process execution, cancellation and artifact verification. It does not adopt the donor Electron filesystem IPC or disabled web security.

ArtCraft scene state and Open Generative AI providers were inspected and built but are not yet imported. Their value remains on the roadmap. OpenCut's placeholder timeline was rejected. New custom code exists only around the narrower canonical and trust boundaries required by this adopted architecture; mature storage and generation workers will be evaluated before expanding it.

P02-T01 imports the standalone content-addressed storage module and its real qualification tests from TheHalfMoon/Skelet at 5d4778636de8fbb3c8ef71efbfe46d473f8e97e3. The module is byte-for-byte unchanged. Test changes are restricted to the import, formatting, and safe temporary-directory cleanup. No runtime dependency was added. Founder-provided authorization covers adoption; the inspected snapshot contains no repository license file. Direct tests were sufficient, so REA was not necessary for this module.
