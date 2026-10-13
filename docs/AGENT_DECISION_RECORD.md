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
    - **Method:** each worker's peak committed Job Object memory, read by procd when the worker exits.
    - **Thresholds:** import probes 896 MiB; conversion, export and preview 1,792 MiB each. Each is 87.5% of the Job Object limit that applies at run time (1 GiB for probes, 2 GiB for render-class workers).
    - **Corpus:** every accepted container; the largest accepted dimensions; and the heaviest supported decoders (4K and 4096x2160 10-bit HEVC, AV1, VP9, ProRes). It also includes ten-minute audio, a 60 s 1080p variable-frame-rate (VFR) conversion, a 720p reference export with an Arabic/Latin title, a 1080p export cutting between the heavy decoders, and reference previews.
  - **Worst-case concurrent memory:**
    - **Includes:** the service, one job worker, one preview renderer and two import probes, each at its limit.
    - **Limit:** half of the machine's RAM (6.3 GiB of 16 GiB).
  - **Enforced values carried forward, unchanged:**
    - **Disk:** 256 MiB disk reserve after staging plus publication; 4 GiB import size.
    - **Concurrency:** 2 concurrent imports; 128 active jobs; 4 conversions per project.
    - **Time limits:** probe 10 s; render 180 s; conversion 900 s; preview 30 s.
    - **Threads:** 2 per render.
- **Rationale:**
  - The kernel limit is the real bound on an external FFmpeg process; a service RSS ceiling does not constrain it. So decoders are bounded by the Job Object limit and qualified against a fixed fraction of it.
  - The 12.5% headroom keeps every supported codec in the corpus clear of allocation failure. The heaviest measured case, a 1080p export from a 4096x2160 10-bit HEVC source, peaked at 1,497 MiB, 73% of its limit.
  - The 300 MiB service ceiling keeps the existing proposal. The T4b measurement was 154 MiB, which is evidence for that fixture only, not proof that every codec stays bounded.
- **Failure behaviour, tested:**
  - At its limit, a worker's allocations fail and it exits non-zero. A probe then reports MEDIA_INVALID, and a job ends FAILED.
  - Committed memory may overshoot the limit by a few MiB: up to 4.5 MiB measured, at limits from 32 to 192 MiB.
- **Evidence:** `scripts/qualify-resources.ts` writes `docs/evidence/qualification/resource-policy.json`, and `tests/resource-policy.test.ts` covers the behaviour above.
- **Change rule:** a value changes only with a new policy version, a new entry here and a re-measurement. A threshold is never raised to make a run pass.
