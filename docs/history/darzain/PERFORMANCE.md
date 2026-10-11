# Performance evidence

The three candidate web builds completed in 44.966s (filmmaker), 138.841s (ArtCraft frontend) and 24.527s (Open Generative AI Vite). These measure this workstation and are not comparative product benchmarks. Desktop/native builds and inference performance were not measured.

Darzain builds 106 frontend modules into approximately 284.5KB JS (88.3KB gzip) and 48.7KB CSS (10.6KB gzip). A 3-second imported-media browser production yields a verified MP4 around 85KB. Core E2E completes real media rendering; A separate 30-second 1280x720 production with three scene records, seven image/video/audio/title clips, actual audio and verified reopening rendered in 6.052s on a 12-thread i5-13420H / 16GiB Windows workstation. Its 3,320,493-byte artifact hash is recorded in evidence/30-second-production.json. This is a single imported-media fixture run, not AI generation or a competitive benchmark. GPU throughput remains unmeasured.

Current limits: 50MiB per import, 200 assets, 100 scenes, 16 tracks, 200 clips, 10 minutes, 1920x1080 project dimensions and 4096x4096 source dimensions. Render execution is serialized, uses two encoding threads and a 180-second deadline. Limits are safeguards, not proven interactive capacity budgets.

P07 must measure UI latency at representative project sizes, peak memory, import/probe time, 30-second and multi-minute export time, cancellation latency, disk growth and generation VRAM. Record hardware, backend, resolution, codecs and failures. Optimize only after profiling.
