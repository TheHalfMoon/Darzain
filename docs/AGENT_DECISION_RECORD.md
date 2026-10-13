# Agent decision record

Decisions the implementing agent (Claude, Claude Code) made under authority the founder delegated. They are **not** founder approvals and are never attributed to one. Each records its authority, rationale, evidence and how to change it. Founder decisions are in the [founder decision record](FOUNDER_DECISION_RECORD.md).

## 2026-10-13: resource policy v2 frozen

- **Authority:** the founder's continuation directive of 2026-10-13 ("Choose and freeze a measurable resource policy"; [founder decision record](FOUNDER_DECISION_RECORD.md#2026-10-13-continuation-to-verified-completion)).
- **Decision:** `RESOURCE_POLICY` in [`core/command/policy.ts`](../core/command/policy.ts) becomes `yamakan.resource-policy/v2`, adding a frozen `qualification` section:
  - **Import service peak:** 300 MiB.
    - **Scope:** the service process alone, during a streamed HTTP import of at least 2 GiB.
    - **Method:** the larger of 200 ms working-set samples and Windows' exact `PeakWorkingSet64`.
    - **Enforcement:** none at run time; a breach fails `qualify-large-import`.
  - **Worker peaks, measured:**
    - **Method:** each worker's peak committed Job Object memory, read by procd when the worker exits. A peak procd could not read is reported as unmeasured and fails the run.
    - **Rule:** every worker the corpus starts must peak at no more than 87.5% of the Job Object limit it ran under, and that limit must be an enforced one: 1 GiB for probes and capability checks, 2 GiB for renders, conversions and previews.
    - **Corpus:** every accepted container; 4096x4096 stills and video; 4K H.264; 4K and 4096x2160 10-bit HEVC; AV1; VP9; ProRes; ten-minute WAV, MP3 and Ogg; a 60 s 1080p variable-frame-rate conversion; a 720p reference export with an Arabic/Latin title; a 1080p export cutting between six heavy sources (three runs); reference previews.
    - **Threads:** every decoder and encoder runs with two threads, so memory does not grow with the host's cores.
  - **Worst-case concurrent memory:**
    - **Includes:** the service, one job worker, one preview renderer, two import probes and one engine check, each at its limit: 7,468 MiB.
    - **Limit:** half of the machine's RAM (8,052 MiB on the 16 GiB qualification profile).
  - **Enforced values carried forward, unchanged:**
    - **Disk:** 256 MiB disk reserve after staging plus publication; 4 GiB import size.
    - **Concurrency:** 2 concurrent imports; 128 active jobs; 4 conversions per project.
    - **Time limits:** probe 10 s; render 180 s; conversion 900 s; preview 30 s.
    - **Threads:** 2 per decoder and encoder.
- **Rationale:**
  - The kernel limit is the real bound on an external FFmpeg process; a service RSS ceiling does not constrain it. So workers are bounded by their Job Object limit and qualified against a fixed share of it.
  - The 12.5% headroom keeps every supported codec in the corpus clear of allocation failure. The heaviest case, a 1080p export from six heavy sources, peaked at 985 MiB (48.1% of its limit), with under 1% spread over three runs.
  - The 300 MiB service ceiling keeps the existing proposal. The measurements (154 MiB at T4b; 163 MiB now) are evidence for that fixture only, not proof that every input stays bounded.
- **Found while qualifying:** `-threads` is a per-input FFmpeg option, so multi-clip exports decoded with one thread per core and conversions encoded without a limit. Both are fixed in the same change; the heavy export's peak fell from 1,522 to 985 MiB.
- **Failure behaviour, tested:**
  - At its limit, a worker's allocations fail and it exits non-zero. A probe then reports MEDIA_INVALID, and a job ends FAILED.
  - Committed memory may overshoot the limit by a few MiB: up to 7.5 MiB was seen at limits of 32–192 MiB, so the test allows 16 MiB.
- **Evidence:** `scripts/qualify-resources.ts` writes `docs/evidence/qualification/resource-policy.json`, and `tests/resource-policy.test.ts` covers the behaviour above.
- **Change rule:** a value changes only with a new policy version, a new entry here and a re-measurement. A threshold is never raised to make a run pass.
