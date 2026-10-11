# Test and evidence strategy

Contracts, builds, static graphs, actual UI/API journeys, playable output checks and human creative evaluation establish different facts. No screenshot/static audit substitutes for real export or generation.

| Layer | Required checks |
|---|---|
| Contracts | Serialization/migration/refs/revisions; rational time; capability mapping; money arithmetic |
| Data/jobs | Interrupted publication, corrupt head/journal, restart/cancel races, ambiguous external submit |
| Media/render | Actual image/video/audio/title fixtures, ffprobe, sampled frames/audio timing, preview/export parity |
| UI/API | Same journey via browser and tools; actual service close/restart/reopen and draft protection |
| Inference | Engine/model/input/seed/hardware hashes, real generation/cancel/import and quality rubric |
| Security | Malicious archives/media, traversal/reparse, SSRF/egress/scopes/secrets, quota exhaustion |
| Release | Clean supported-host install, offline launch, update/rollback, crash recovery and notices |

Evidence already exists for three frontend builds, filmmaker 145 tests, historical prototype MP4/browser/API recovery, Skelet storage and Gomrey pure rules. New OpenVideoStudio 22 original tests use fake LLMs/fixture bytes and prove contracts only. New OpenMontage six tests prove prerequisites/gates/style validation, not full pipelines or power-loss durability. Receipts record failed initial collection/temp-directory attempts as well as successful runs.

REA 6.3 MCP/bounded static runs succeeded; newer 6.4 is not installed. Earlier full-tree REA failed ENOBUFS. Graft ran structural analysis but zero build/wiring/deep qualification. Jev judgment is probabilistic. Alibaba OCR CPU scans failed/timed out or skipped oversized dispatch; zero-token looks-good is not a pass. PStack skills are available, a complete runtime scaffold is not claimed. Ascout/Kodac full verification runtimes were not executed. Fresh durable-job review attempts failed at service usage limits; independent Claude planning review is pending.

Representative proposed workload: 30-second 720p/1080p, three scenes, 20 clips, mixed audio, title/subtitles. Measure preview dropped frames/latency, memory, startup/reopen, render wall time, artifact throughput and cancel latency with repeated distributions and fixed hardware. Historical CPU 30-second 720p export was 6.052 s; one run is not an SLA. Set release budgets from actual workload distributions; test maximum configured limits and reduce advertised limits if qualification fails.
