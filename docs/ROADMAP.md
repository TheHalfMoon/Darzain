# Authoritative roadmap

Each phase advances only on its acceptance evidence. Implementation and production readiness are tracked separately; no invented completion percentage. The exact live task is specs/CURRENT.md.

| Phase | Scope | Acceptance gates | Frontier |
|---|---|---|---|
| P00 | Sources, competitor workflows, licenses, foundation decisions | Actual source inspection, strongest builds, REA decisions and reuse ledger | Partial: 7 donors and 13 owner snapshots inventoried; remaining sources pending |
| P01 | Imported-media creative slice | Editable project, actual timeline/preview/export, local agent surface, negative tests, review and exact-head CI | Integrated via PR #1; exact-head CI passed; release qualification remains scoped |
| P02 | Durable owned projects and jobs | Checksummed history, explicit recovery, crash-safe writes, verified media store, portable archives, restart/cancel/idempotency evidence | In progress: media storage and explicit history/recovery implemented; remaining durability tasks pending |
| P03 | Local generation execution | Real ComfyUI/Wan2GP adapter, capability/hardware gating, validated generated artifacts and E2E | Pending |
| P04 | Agent creative parity | Granular typed creative tools, MCP transport, permissions, auditable/idempotent edits | Pending |
| P05 | Scene composition and art direction | ArtCraft state reuse, camera transforms, layers/poses, render/generation integration | Pending |
| P06 | Production planning and advanced editing | Story/shot/script continuity, real trim/effects/audio workflows, canonical parity | Pending |
| P07 | Performance, security, extensibility | Representative workloads, isolation/quotas, adapter contracts, fault injection | Pending |
| P08 | Desktop and release qualification | Reproducible packages, supported-platform CI, docs, independent reviews and no critical open defects | Pending |
| P09 | Competitive benchmark and continuing improvement | Matched tasks, honest comparison, measured reliability/quality and maintenance | Pending |

MVP requires P00-P04 acceptance for its explicitly supported workflow. V1 requires P05-P08. P09 remains the longer-term competitive improvement frontier. Optional cloud providers must never become mandatory operating costs.
