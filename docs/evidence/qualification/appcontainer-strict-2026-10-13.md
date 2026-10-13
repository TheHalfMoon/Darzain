# Less-privileged Windows AppContainer qualification — 2026-10-13

**Scope:** Recovery of worker security tests when Node.js cannot initialize in a more restrictive AppContainer. This is Windows development-host evidence, not release-artifact or clean-profile qualification.

## Baseline and cause

- Repository: `TheHalfMoon/Yamakan`, draft PR #29 (`feat/appcontainer`).
- Source branch base: `b9cfae195063a459adf22225bd16cc5891825649`.
- The previously uncommitted launcher change opts out of `ALL APPLICATION PACKAGES` access using `PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY` and `ALL_APPLICATION_PACKAGES_OPT_OUT`.
- With that policy, Node stand-in processes terminated at `0x80000003` before executing any JavaScript payload; FFprobe continued to run.
- A new dependency-free Rust binary (`native/procd/src/bin/worker-probe.rs`) performs only the documented test actions. **No production worker is exempted from the AppContainer policy.**
- The native probe initially panicked when Rust Winsock startup returned 10107 (network stack unavailable). It now detects that status directly and records network denial without crashing.
- A native ACL probe attempts to re-apply an object's *unchanged* DACL, proving it cannot acquire WRITE_DAC without risking a broader ACL. Positive controls remain in the test suite.
- The WMI test may encounter PowerShell startup denial before reaching WMI; a nonzero worker exit and absent escape marker prove this executable did not escape, **not** that WMI authorization was exercised.

## Local verified commands and results

Development machine: Windows 11, Node 24.19.0, Rust cargo 1.97.1.

| Command | Result |
| --- | --- |
| `cargo build --release --bins --manifest-path native/procd/Cargo.toml` | PASS |
| `node --test tests/process-owner.test.ts tests/containment.test.ts tests/sandbox.test.ts tests/hostile-media.test.ts` | 20 passed, 0 failed |
| `npm test` | 215 total: 213 passed, 2 POSIX-only skipped, 0 failed |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run format:check` | PASS |
| `npm run build` | PASS |
| `npm run provenance:check` | PASS; 25 pinned source records, 2 font files, notices |
| `npm run test:e2e` | PASS; Edge workflow, 0 page errors, 0 external page requests |

Relevant uncommitted diagnostic logs from the qualification machine are in the ignored local `work/` folder; do not copy arbitrary local temp data or credentials into Git.

## Remaining release and review gates

- Independently review the Rust Windows FFI, process attribute use, security descriptors, grant/revoke semantics, and test validity.
- Require a clean Windows profile and the exact release artifact; a development-host test does not qualify packaged security.
- Broader hardening ambitions (job UI restrictions, desktop separation, profile isolation) are **not** established by the tests above.
- Do not infer WMI API-level denial from a process that never initialized.
- Yamakan's release verdict remains **NO-GO** until its remaining acceptance gates pass.
