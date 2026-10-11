# Implementation plan

1. P01-Q01: finish provenance, lint, independent review, HTTP/browser evidence and initial canonical integration. Empty remote needs a minimal documentation bootstrap before its first feature PR; after that use reviewed feature branches and normal merge commits. Verify exact-head CI and post-merge main.
2. P02-T01: qualify Skelet's LocalContentAddressedStorage against existing asset tests, adopt its fsync/verified-read boundary, add snapshot hash sidecars and explicit history/recovery. Gate: damaged head recovery preserves originals; partial files never become committed state.
3. P02-T02: persist job records and idempotency mappings; reconcile interrupted jobs; expose verified artifact history after restart; retain cancellation semantics. Gate: restart mid-render, reopen completed exports, bounded stale cleanup.
4. P02-T03: portable project archive with manifest, hash validation, limits, traversal/symlink defense and independent import workspace. Gate: full round-trip editable project and media, corruption rejected.
5. P03-T01: inspect exact Wan2GP source and ComfyUI API contracts; select reusable adapters from Open Generative AI. Probe local hardware/models before enabling capabilities. Gate: real generation, cancellation and validated import; unsupported hardware reported honestly.
6. P04-T01: granular scene/timeline/asset tools with revision checks, audit records and MCP transport; use Ninerr/Kodac contracts only after qualification. Gate: agent produces the same editable 30-second project as UI.
7. P05-T01: qualify bounded ArtCraft scene/camera modules with renderer tests and integrate a canonical scene viewport. Gate: visual controls alter the output/generation conditioning rather than merely recording intent.
8. P06-T01: filmmaker production-planning extraction and advanced editing parity; inspect remaining editor alternatives before replacing weak code. Gate: multi-scene film stays editable with consistent references and verified audio/effects.
9. P07-P08: measure representative workloads, harden failure boundaries, package only supported platforms, run genuine independent reviews and all release gates.

Every import needs source SHA, hashes, notices, an integration question and behavioral evidence. Every substantial milestone updates CURRENT and bounded receipts. A failed tool/provider does not block unrelated implementation, and it never becomes fabricated success evidence.
