# Yamakan

Yamakan is an AI-native creative production platform. Canonical repository: [TheHalfMoon/Yamakan](https://github.com/TheHalfMoon/Yamakan) (formerly `TheHalfMoon/Darzain`). The current product is an **offline local-web engineering preview**, not a release.

**Phase: implementation (P01).** The founder approved the final plan `edbaba6c` on 2026-10-11 ([decision record](docs/FOUNDER_DECISION_RECORD.md)). [CURRENT](specs/CURRENT.md) is the live frontier and [the master plan](docs/IMPLEMENTATION_PLAN.md) is the sole task authority. The planning PRs #3–#5 are merged.

## Run locally

```bash
npm ci
npm run build:native
npm run build
npm start
```

`build:native` builds the Windows process owner and the workspace access helper (Rust toolchain with MSVC); media workers run only through the owner on Windows, and the service does not open a workspace it cannot make private to your account.

Open the launch link the service prints when it starts (`http://127.0.0.1:4318/#launch=…`, also saved in the workspace's `launch` file); the bare address shows only a sign-in notice. Agents use `npm run cli -- yamakan.project.list {}` or the MCP stdio server (`npm run mcp`) against the running service; both authenticate with the workspace client token, separately from the browser session.

Source/weight/service rights and capability availability remain distinct. No paid inference, cloud account or model weights are used.

## Planning package (historical)

The planning package below is preserved as reviewed at `edbaba6c`; `manifest.json` and `validation.json` describe that package, not later implementation.

Read the self-contained [research report](docs/RESEARCH_REPORT.md) for source names, bounded reuse qualifications, ranked risks, MVP scope and remaining work. Package integrity is recorded in manifest.json; validation.json distinguishes mechanical document validation from architecture or Claude approval. Historical documents are under docs/history; their old MVP/phase/tool statements do not control the new frontier.
