# Agent-native command platform

All transports use one typed command service: UI, REST, CLI, MCP and TypeScript/Python SDKs share schema validation, scopes, revision checks, audit, consent and quotas. Core production does not require browser clicks. The legacy whole-project tool surface proves a path; granular scopes/full MCP are proposed work.

| Family | Tools | Scope |
|---|---|---|
| Projects | create/open/list/history/restore/archive | project read/write and explicit recovery |
| Assets | import/search/version/probe | asset access/import within workspace |
| Director | script/character/scene/shot/storyboard | project write plus likeness grants |
| Generation | capabilities/quote/submit/status/cancel/reconcile | local or provider-specific network execution |
| Timeline | add/trim/split/move/keyframe/effect/audio/subtitle | revision-bound project write |
| Render | preview/export/inspect | resource-bounded render execution |
| Workflows | validate/start/pause/resume/cancel | approved node types and job budget |

Mutations require requestId/expectedRevision. Structured errors: VALIDATION, REVISION_CONFLICT, CAPABILITY_UNAVAILABLE, CONSENT_REQUIRED, BUDGET_EXCEEDED, PROVIDER_RATE_LIMIT, AMBIGUOUS_SUBMISSION, MEDIA_INVALID, CANCEL_UNSUPPORTED, RECOVERY_REQUIRED. Include safe retry/reconciliation hints; no secrets. Return artifact IDs/hash receipts, not unrestricted filesystem authority.

Desktop MCP stdio binds an explicit workspace grant. Remote MCP needs independently qualified auth/tenant isolation. Resources expose schemas/evidence/project summaries under media-read grants. Progress reflects actual units/state and unknown estimates. Model/tool content cannot grant scopes.

REST OpenAPI/CLI stable JSON and generated/thin TS/Python clients use identical schema versions. Python SDK remains optional. Resume from durable stages/jobs, not chat history. Ninerr session/policy and Ascout lineage are bounded candidates; Kodac's inspected auth helper is rejected as an authority boundary.

Acceptance: an external agent creates an editable multi-scene film, imports media, adds titles/audio, renders, restarts/reopens, inspects/cancels through typed tools, with no browser clicks and the same canonical project as UI.
