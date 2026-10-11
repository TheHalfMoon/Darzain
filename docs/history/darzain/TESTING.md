# Testing

Executed local evidence: filmmaker donor 145/145 tests; three candidate web builds; Darzain 15/15 tests; actual Edge workflow creates/imports/edits/saves/previews/exports/downloads/reopens with no page errors. See bounded receipts under docs/evidence/.

Required gate commands: npm ci --ignore-scripts; npm run lint; npm run format:check; npm run provenance:check; npm test; npm run build. Browser workflow runs against the production loopback server and real FFmpeg. No mocked export is counted.

Core tests cover source integrity, concurrent revision conflicts, schema/reference restrictions, title escaping, junction rejection, queue idempotency and queued cancellation. HTTP test forks the actual server, tests auth/Origin/unknown tools, performs a save, shuts down through private supervisor IPC and reopens after restart.

REA static output is evidence of relationships, not a test pass. Graft currently qualifies only code wiring synchronization, not deep semantic correctness. Installed Jev performs probabilistic judgment and cannot satisfy deterministic validation despite the requested generic role. Alibaba OCR attempts use the actual CLI; provider failures are preserved and cannot be treated as a clean review.

Linux CI and final-head independent review remain integration gates. Broader codec/large-project/editor parity, crash/power loss, generation, cross-platform installers and portable archives remain unqualified.

Independent fresh-context PStack review identified and fixed cancellation/publication and queue-close races, dirty project switching, locked duplication, shared playback elements, embedded video audio and portrait fitting. Regressions include actual browser source offsets and authenticated byte-range behavior. Delta verdicts are recorded after execution; no OCR LLM success is inferred from the skipped run.

P02-T01 adds seven recovery/storage integration tests and eleven adopted Skelet byte-storage tests. Local Windows result: 32 total pass, zero fail, one POSIX-permission skip. Browser E2E additionally restores an older revision and recovers after a real head-file corruption; no page errors. The interruption test injects failure at head publication and verifies orphan preservation; it is not a physical power-loss experiment.

Review-driven regressions additionally cover a 3 MiB damaged head and a valid current head with a damaged receipt. The browser recovery case preserves a dirty draft as an actual downloadable JSON file before restoration.
