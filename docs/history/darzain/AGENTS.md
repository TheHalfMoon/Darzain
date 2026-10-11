# Darzain engineering instructions

Read specs/CURRENT.md first. It is the sole current frontier; docs/ROADMAP.md owns phase scope. Continue the user-authorized roadmap without routine permission requests. Preserve founder changes, source notices and provenance.

Use normal merge commits and never force push. Check CI on the exact PR head and verify main after merging. Do not change donor remotes. Do not merge unresolved critical correctness or security defects.

Prefer qualified existing source over rebuilding a capability. Inspect real code and run real checks. REA 6.3.0 is qualified for bounded static investigations; record exact inputs and limitations. Never equate static relationships with runtime correctness.

No fake generation, mock export, misleading capability toggles, paid mandatory infrastructure or secrets in evidence. Assets remain local by default. Capability availability must reflect an actual backend and hardware check.

Run npm run lint, npm run format:check, npm run provenance:check, npm test and npm run build for core changes. Run browser E2E for user workflow changes. Independent review and exact-head CI are integration gates. Update ledger hashes intentionally after source changes. Do not reformat preserved donor files without recording that modification.

On Windows prefix shell commands with rtk. Keep local analysis artifacts out of commits; publish bounded, redacted receipts. Never copy owner model caches, private credentials, copyrighted binaries or licensed fonts into this repository.
