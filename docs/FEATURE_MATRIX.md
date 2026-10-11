# Feature evidence

| Capability | Status | Evidence / limit |
|---|---|---|
| Local project create/save/reopen | Verified preview | Core and process restart tests |
| Image/audio import | Verified preview | Real ffprobe, hash checks, browser E2E |
| Video import | Implemented, qualification partial | Media probing exists; broader codec E2E pending |
| Multitrack editor and preview | Verified basic workflow | Donor timeline + browser E2E; advanced editing matrix pending |
| Undo/redo | Implemented, utility tests pass | Browser history stress/reopen semantics pending |
| Titles and explicit audio MP4 | Verified preview | Real FFmpeg output/probe + browser download |
| Mute/solo/target/lock | Implemented | Full preview/export parity tests pending |
| Camera settings | Metadata only | Scene schema and 85mm reopen test |
| Recovery / portable project | Planned | P02 acceptance gate |
| Durable jobs / artifacts | Planned | Current registry is memory-only |
| Local AI generation | Planned | No enabled model backend |
| 3D scenes / poses / camera transforms | Planned | ArtCraft extraction candidate; no adopted code yet |
| REST / CLI tools | Verified basic workflow | Eight validated tools; granular editing and MCP pending |
| Installers / cross-platform release | Planned | Only local Windows preview tested so far |
