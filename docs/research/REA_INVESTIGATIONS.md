# REA investigations

Film question: extract independently testable editing/rendering without privileged shell coupling. Exact staged files: electron/main.js, electron/preload.js and electron/ffmpeg-handler.js at the qualified filmmaker SHA. Static CLI analysis exit 0, sealed evidence recorded in ../evidence/rea/film.json. Source inspection confirms disabled Electron web security, broad file IPC and omitted HQ audio; those boundaries were excluded. Real Darzain renderer/browser tests validate the selected replacement boundary.

Provider question: understand worker dispatch and localAI coupling. Exact staged files: electron/main.js and electron/lib/wan2gpMcp.js from Open Generative AI. Static analysis exit 0; evidence in providers.json. Missing source container dependencies and dynamic calls remain unresolved; no inference or native provider runtime equivalence claim.

Scene question: determine compact serialized scene/object extraction boundaries. Exact staged files: editor_state_json.ts, scene_state_json.ts and object_3d_json.ts from ArtCraft's EditorStateJSON module. Static analysis exit 0; evidence in scene.json. This stage did not qualify camera-to-generation rendering or character posing. No ArtCraft code is imported yet.

All analyses use REA 6.3.0 on Windows/Node 24.19.0. Raw local graphs are intentionally not committed (film around 26MB). Earlier full-tree analyses exceeded an 80MB capture limit and failed; narrowed streamed analyses supersede them. MCP schema requires input_path; a real diagnostic succeeded after correcting the argument. Receipts retain evidence identifiers and artifact hashes, not user filesystem paths.
