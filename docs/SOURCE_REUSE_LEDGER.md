# Source reuse ledger

Founder statement authorizes copying/adapting/rebranding discussed source code. Record this authorization without fabricating signed documents. Preserve provenance and required notices. Weights, datasets, trademarks, face/voice assets and hosted services have separate rights.

No new product source imports occurred in this planning branch. [Legacy import ledger](provenance/imports.json) preserves exact original/adapted hashes and notices for the existing prototype. Filmmaker editing/preview/FFmpeg construction, Ninerr serialization and Skelet storage are already integrated legacy modules. Gomrey transition rules are qualified but their port is only in the unmerged draft.

| Proposed reuse | Actual qualification | Remaining boundary |
|---|---|---|
| OpenVideoStudio identity formatting and provider contracts | 22 original tests passed using fake-LLM/fixture responses | No generated identity-quality or full pipeline proof |
| OpenMontage stage prerequisites/manifests/gates | Six original tests passed; bounded composer REA | No full production, crash/power-loss or scheduler proof |
| ArtCraft scene/camera | Frontend build and scoped static REA | Applied camera/viewport/desktop behavior unqualified |
| Other engines/adapters | Targeted source/contracts or inventory | Actual environment, rights, output and integration tests |

Every future import record must contain repository/SHA, original path/hash, imported path/hash, license/notice source, authorization reference, modifications, executable qualification and remaining restrictions. New code is not accepted merely because it belongs to the founder.

Observed restrictions retained alongside source authorization: OpenMontage/StoryMind AGPL; Storyboard CC BY-NC-SA; OpenVideo/Remotion/tldraw commercial/company-size terms; WanGP/Tencent/LTX community terms; non-commercial FLUX weight variants; face-analysis/voice assets; exact FFmpeg binary codec/distribution terms. No separately owned weight or hosted capacity was enabled. Isolate unresolved components and continue independent offline work.

## Mandatory do-not-import list (independent review, 2026-10-11)

Founder source-code authorization does not cure the issues below, because they concern third-party terms, bot-detection evasion, user credentials or unsafe boundaries rather than code licensing. `provenance:check` must reject these paths. Evidence: [review section 5](review/CLAUDE_INDEPENDENT_REVIEW.md#do-not-import).

| Source @ pin | Excluded paths | Reason |
|---|---|---|
| artcraft @ 28a39a0d | `crates/lib/browser_emulation/**`; `crates/api_clients/{openai_sora_client,grok_consumer_client,midjourney_client,worldlabs_consumer_client,kinovi_web_client}/**` | TLS-fingerprint impersonation; consumer-session cookie authentication |
| artcraft @ 28a39a0d | `crates/desktop/artcraft/tauri.conf.json`, `capabilities/default.json` (as templates) | Whole-filesystem asset scope, `unsafe-eval`, global Tauri API |
| ai-video-production-editor @ 752cd43d | `electron/{main,preload,local-agents,midjourney-agent,studio-mcp-server}.js` | 55 IPC handlers without sender validation; `shell:true` spawn; arbitrary file read |
| Open-Generative-AI @ d8d624dc | `packages/studio/src/muapi.js`, `src/lib/muapi.js`, `app/api/**`, `electron/lib/localInference.js` | Single-aggregator authority without idempotency; silent retrying model downloads |
| opencut-classic @ cf5e79e9 | `core/managers/**`, `services/storage/{indexeddb,opfs}-adapter.ts`, `services/renderer/scene-exporter.ts` as authority | Second persisted/export authority |
| feat/durable-jobs draft (998f50c7…) | `core/job-journal.ts` as job authority | Review T5 |
| OpenCut @ e6680107; Kodac @ 406b3352 | Whole; auth helper | Placeholder; development-secret authentication |

Narrow reuse retained from the draft: `core/donors/gomrey/job-transitions.ts` (transition table, to be extended) and the rule that completion requires artifact validation.

## Final selection and qualification

The [final import matrix](SOURCE_IMPORT_MATRIX.md) narrows exact modules and records new OpenCut failures and selected algorithm qualifications. No new product import occurred. Out-of-process execution does not itself settle AGPL or other distribution terms. Current selected unsafe donor paths remain excluded; add a complete dependency-closure check so an allowed file cannot transitively reintroduce them. Pin runtime binaries, transitive licenses and font hashes, not only repository heads.
