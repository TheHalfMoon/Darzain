# REA findings

Installed/qualified REA 6.3.0 on Node 24.19.0. MCP re-handshake and a real analyze_javascript_application call succeeded: protocol 2025-11-25, 139 tools. Current official README retrieval shows 6.4.0; that newer version is not installed/qualified here. Earlier documented setup and Codex registration remain recorded; unrelated MCP configuration was preserved. No commercial native provider qualified.

Four bounded CLI investigations succeeded: filmmaker Electron main/preload/FFmpeg handler, Open Generative AI Electron/provider boundary, ArtCraft scene serialization, and new OpenMontage cinematic renderer/types/captions. New run exit 0, 26.304 s, evidence ev_a6186a4571bfa1d51f655ff025a5ded9e6d0038275a49551beb2fa246e3d4158. Exact input hashes, command and limitations are in [receipt](evidence/rea/openmontage.json). Earlier receipts are retained under evidence/rea.

Findings: filmmaker shell/IPC requires a bounded replacement; provider module relationships do not establish service support; ArtCraft scene state needs canonical translation; OpenMontage composer has Remotion, external-font and asset-resolution dependencies. Direct source inspection supplements static evidence: offline fonts, scoped asset resolution and renderer isolation are required before importing the composer.

The graphs were constructed from inert text, without bundle execution. Dynamic imports, omitted files and native/runtime behavior remain unresolved. Three earlier whole-tree analyses failed with ENOBUFS; they are not completed investigations. Static graph success does not prove output correctness, security, reconstruction completeness or native compatibility.

## Independent review investigations (2026-10-11)

The installed 6.3.0 was verified. Upstream **6.4.0** (published 2026-10-11) was installed into an isolated prefix with `--ignore-scripts` and used for two new bounded static runs. `rea doctor` reports that no native engine (Hopper, Ghidra, IDA) is configured. Receipts: [evidence.json](review/claude-2026-10-11/evidence.json).

- **Filmmaker `electron/` (752cd43d), 8 files:** exit 0, 10.5 s, ev_27e25b61…3f940c. 55 IPC handlers, 70 bridge members, 0 sender-validation observations. Source corroboration: `webSecurity:false`, `shell:true` spawn of a renderer-supplied command, arbitrary-path read. Confirms exclusion of the shell.
- **OpenCut Classic web subset (cf5e79e9), 141 files:** exit 0, 29.5 s, ev_c9f0020060…afac80, 0 parse failures. Persistence is IndexedDB/OPFS behind `StorageAdapter<T>`; one canvas scene graph serves preview and export; export is held in memory (mediabunny `BufferTarget`).

Direct source inspection was sufficient, so REA was not used, for: the ArtCraft consumer clients and `browser_emulation`, the Open Generative AI MuAPI routing, and ComfyUI targeted interrupt. Static graphs remain incomplete, and the absence of a finding is not proof of absence.

## Final live verification

Current MCP/CLI verified **6.3.0**, aligned Codex registration, negotiated protocol 2025-06-18, 139 tools. Claude's isolated 6.4.0 evidence remains historical and unchanged. New bounded 50-file OpenCut algorithm/command investigation: 124,734 bytes, zero parse failures, 708 findings. Evidence `ev_f468aa4d1595355be05ad9d6d31c6d86d257ccce597326bafed3f08ded75dbe9`. MCP response exceeded 10 MB after analysis; complete retained bundle exported successfully (20,610,544 bytes), hash in [receipt](review/final-2026-10-11/evidence.json). Source corroborates global EditorCore command glue, non-atomic BatchCommand and opencut-wasm coupling. Action: pure algorithms through canonical reducers; no editor singleton/job/persistence authority. Static text only, no native engine/runtime proof.
