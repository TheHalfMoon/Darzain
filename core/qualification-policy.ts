// Frozen performance qualification policy (E2E_ACCEPTANCE: "T4/T8 must
// freeze a versioned hardware/fixture/resource policy and hard thresholds
// before qualification ... A row with an unspecified policy cannot pass").
// Approved by the founder on 2026-10-13 (approval I; scope and source in
// docs/FOUNDER_DECISION_RECORD.md): the plan's proposed performance targets, frozen as hard thresholds on the stated hardware profile and
// fixtures. Qualification scripts read their thresholds from here; a
// threshold is never adjusted to pass. A change needs a new policy version
// and a new approval.
export const QUALIFICATION_POLICY = Object.freeze({
  policy: "yamakan.qualification-policy/v1",
  approved: "2026-10-13, founder (approval I)",
  // The qualification hardware profile (the machine the receipts were
  // measured on; not Profile A, which is a clean Windows user profile). A run
  // on other hardware is flagged as a mismatch and must state its own.
  hardware: Object.freeze({
    os: "Windows 11 (10.0.26300)",
    cpu: "13th Gen Intel Core i5-13420H, 12 logical cores",
    memoryGiB: 16,
    storage: "512 GB NVMe SSD (WD PC SN740)",
  }),
  // Each threshold applies to the p95 (the policy's reading of the plan's
  // targets) over the stated runs of the stated fixture.
  thresholds: Object.freeze({
    coldLaunch: Object.freeze({
      p95Ms: 5000,
      fixture:
        "service start to its ready line on a fresh workspace, OS file cache warm; 5 runs (scripts/qualify-release.ts)",
    }),
    reopen: Object.freeze({
      p95Ms: 2000,
      fixture:
        "service start to project open over the authenticated API; one 10 s 1280x720 H.264/AAC clip, 200 saved revisions; 5 runs (scripts/qualify-release.ts)",
    }),
    referenceStillWarm: Object.freeze({
      p95Ms: 1000,
      fixture:
        "cached reference frame of a 30 s 1280x720 timeline with video, audio and an Arabic/Latin title; 10 runs, frames 30, 120, 210, 300, 390, 510, 600, 690, 780, 870 (scripts/qualify-preview.ts)",
    }),
    referenceStillCold: Object.freeze({
      p95Ms: 3000,
      fixture:
        "uncached reference frame of the same timeline; 10 runs, the same frames, after one first frame at 450",
    }),
    referenceSegmentCold: Object.freeze({
      p95Ms: 6000,
      fixture:
        "uncached 2 s (60-frame) reference segment of the same timeline; 5 runs, starting at frames 0, 180, 360, 540, 720",
    }),
    playback720p: Object.freeze({
      minFps: 24,
      fixture:
        "interactive editor playback of a 720p timeline; not yet measured (release proposal, step 7)",
    }),
  }),
});
