# Security and privacy proposal

The legacy trusted-local-account boundary is not internet tenancy or a same-account adversary defense. Planned controls below need their own qualification; static types/graphs do not prove enforcement.

| Threat | Required boundary | Attack acceptance |
|---|---|---|
| Malicious media | Signatures plus bounded probes; decoder time/resource/stream limits | Malformed containers, huge dimensions, remote protocols |
| Project archives | Strict manifest/entry/depth/expanded limits; separate import root | ZIP bombs, traversal/drive/UNC paths, symlinks, duplicate/case collisions |
| Filesystem escape | Workspace grants, safe ancestry/reparse checks, verified handles | Traversal, junction swap, unauthorized outputs |
| Workflow/plugin injection | Registered declarative nodes; sandbox arbitrary code only after qualification | eval/shell/project JSX, malicious template/skill authority |
| Credentials | OS store or qualified secret service, opaque refs, redaction/rotation | Project/archive/log/browser/SDK leaks, stale sessions |
| Upload/SSRF | Default-deny provider allowlists, DNS/IP/redirect checks, asset/region consent | Metadata/LAN redirects, hidden cloud fallback |
| Unauthorized jobs | Scoped transport auth, local Host/Origin/session protection, owned workers | Cross-site bootstrap, forged grant/job/paths |
| Resource/cost abuse | CPU/GPU/disk/queue quotas, timeout, cancellation/reserved spend | Flood/hung worker/disk full/ambiguous paid retry |
| Agent escalation | Trusted grants separate from model content and revision/schema validation | Prompt injection, tool-output scope forgery |
| Likeness/voice misuse | Version/purpose/use/expiry/revocation consent and provenance | Missing/revoked consent, unauthorized voice uploads |

A photo import does not authorize voice cloning. Derived biometric/voice assets inherit access/deletion policy; avoid unnecessary raw biometric retention. Disclose provider retention/region/upload metadata. Prompts, generations and retrieved documents remain untrusted proposals.

Executed legacy controls include bounded schemas/media probes, traversal defense, local auth, verified history and real export checks. Gaps include Windows directory fsync, stale locks/orphans, same-account path/handle races, buffered media serving, secure decoder sandbox and public tenancy. Do not inherit filmmaker unrestricted Electron IPC or Kodac development-secret auth.

Release requires fresh independent review of immutable diffs, actual adversarial media/archive/network/credential/quota tests, dependency/binary provenance, exact-head CI and clean install/update workflows. Failures and unavailable tooling remain explicit. No sandbox claim follows from Ecra/kernux policy types alone.

## Independent review: blockers versus deferrable (2026-10-11)

From the [independent Claude review](review/CLAUDE_INDEPENDENT_REVIEW.md). Each control needs a negative test; policy text alone does not count.

| Control | Status at 419bc356 | Gate | Negative test |
|---|---|---|---|
| Single persisted authority with compare-and-swap (B1) | Lost update demonstrated (T2b) | MVP blocker | Forced-interleave conflict |
| Donor exclusions enforced by provenance tooling (B2) | Not listed | Blocker for any desktop or ArtCraft import | `provenance:check` rejects excluded paths |
| Loopback: accept only `Sec-Fetch-Site` same-origin/none; cookie only on top-level same-origin navigation (M1) | Same-site loopback ports accepted | MVP blocker | Page from another 127.0.0.1 port is denied |
| Token/workspace owner-only ACL on Windows (M2) | `0o600` ignored on Windows | MVP release blocker | Second account cannot read |
| Streaming, bounded media handling (H3) | Whole-file buffering, 50 MB cap | MVP blocker | 4 GB import within memory ceiling; corpus rejection |
| Owned process trees: Job Object without breakaway (H5) | Grandchildren survive crash (T3) | Blocker for any local worker | No descendant survives a service kill |
| Write-ahead paid submission intents (H7) | Specified only in prose | Blocker for any paid provider | Fault matrix with zero automatic resubmits |
| Single outbound HTTP module: allowlist, DNS/IP checks, redirect re-validation | Policy only | Blocker for any network feature | Metadata, LAN and redirect SSRF corpus |
| Credentials in the OS credential store via the desktop host, never in projects, logs or archives | Policy only | Blocker for BYOK | Archive, log and crash-dump scan |
| Archive extraction limits and reparse checks | Policy only | MVP blocker (archive feature) | Malicious archive corpus |
| Decoder sandboxing (AppContainer or similar) for FFmpeg | None | Deferrable to v1; bounded by probe limits, timeouts and protocol whitelist | Fuzzed-media timeouts |
| Remote/multi-user exposure | Out of scope | Deferred; requires separate auth/tenancy review | None |

ArtCraft's desktop configuration (`withGlobalTauri`, asset scope `**`, `'unsafe-eval'`, `https://*` fetch) and the filmmaker Electron shell (`webSecurity:false`, renderer-controlled `shell:true` spawn, arbitrary file read) are anti-patterns, not references.
