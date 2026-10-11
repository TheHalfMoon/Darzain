# Canonical project contract — proposed, amended by independent review

Final proposal supersedes the PR #4 contract where amended below. [Operational contracts](OPERATIONAL_CONTRACTS.md) define the exact SQLite snapshot, asset publication, job, render and command protocols. Claude's original review remains unchanged; prior document versions remain at their commits. No schema/protocol here is claimed implemented.

Use envelope format=yamakan.project, formatVersion=1, stable UUIDs and monotonic revision. Legacy Darzain schemaVersion=1 is a different format: migrate explicitly into a new destination, preserving original bytes/hash, IDs, media and timing. Do not reinterpret its version number as a new universal schema.

| Entity | Canonical responsibility |
|---|---|
| Workspace / Project | Root authority, policy, language, revision, stable refs and budgets |
| Script / Character / BrandKit | Versioned narrative/identity, approved references and rights/consent |
| Asset / AssetVersion | Logical identity plus immutable content hash, probe and derivation |
| Scene / Shot / Storyboard | Ordered intent, approved takes, cast/reference/scene links |
| Camera / Lighting / MotionPath | Physical/semantic controls and applied-conditioning receipt |
| Timeline / Track / Clip | One time/layer model, non-destructive media-version refs/source bounds |
| Keyframe / Effect | Registered versioned type, bounded values and interpolation |
| Audio / Subtitle | Sample/time base, language/speaker, consent and cue bounds/shaping |
| Workflow / WorkflowNode | Registered declarative nodes, typed edges and definition versions |
| GenerationRequest / GenerationJob | Immutable intent/input hashes, adapter/policy/cost/receipt |
| Model / Provider | Registry/capability/entitlement refs; no credential bytes |
| RenderJob / Export | Frozen input revision, render profile, terminal/output-validation receipt |
| ProvenanceRecord | Donor/model/input/output hashes, transforms, rights and engine versions |

Serialization: qualify Ninerr canonical encoding for JSON/I-JSON edge cases. Sorted object keys, explicitly ordered arrays, normalized negative zero; reject NaN/Infinity, unsafe integers, duplicate IDs, prototype keys and missing refs. SHA-256 binds canonical UTF-8 bytes. Media is outside JSON; UI selections, paths/handles and secrets are excluded. Content objects have schema/probe and version references rather than mutable paths.

Time (amended): timeline positions and durations are integer **flicks** (705,600,000 per second; exact for 24/25/30/50/60/120 fps, the NTSC 1001 rates and 8–96 kHz sample positions; safe-integer horizon 147.7 days). Timeline frame rate is a positive reduced rational; frame indices are derived with checked arithmetic and explicit rounding. Source references keep the stream `time_base` rational and integer PTS bounds, because some container time bases (for example FFmpeg's 1/15360 MP4 timescale) are not exact in flicks. Never accumulate floating seconds. VFR sources get a CFR mezzanine AssetVersion with provenance in the MVP; editing references the mezzanine. Composition-as-clip execution is post-MVP: v1 MVP validators reject unsupported nested sources. Future activation requires cycle/depth/resource validation, recursive dependency hashing and qualified pre-render/parity tasks. Preview and export consume one render-plan IR; titles and subtitles use libass in both paths; unsupported effects fail preflight rather than disappear.

Mutations (final proposal): typed operation, requestId, expectedRevision and scoped principal. Check same-request receipt before CAS; mismatched request digest fails. In one SQLite transaction insert immutable canonical snapshot bytes, CAS the head to expectedRevision+1, and append revision/receipt/outbox rows. Only commit acknowledges an edit. JSON files are portable exports/caches; media remains externally content-addressed. A failed batch commits nothing. Undo/redo is a new revision-bound mutation, never overwriting another writer. See operational contracts for busy/fencing/retention rules.

Migrations are pure versioned transforms into a new root, verified by editable and render round trips. Unknown future versions cannot be written or silently have fields dropped; safe inspection mode can report incompatibility. Archives include manifest, media objects and rights/provenance, exclude secrets/executables/absolute paths, reject traversal/reparse/duplicate/case collisions, enforce entry/depth/compressed/expanded budgets and publish only after hash checks.

Recovery distinguishes committed DB snapshots, staged external assets, worker attempts and provider submissions. SQLite does not make external media publication durable. Use online DB backup plus pinned asset manifests; preserve corrupt DB/WAL/SHM/bytes and recover into a new root. Never silently rewind acknowledged state. Stronger physical-power-loss claims need actual hardware/filesystem qualification. Schema validators enforce safe numeric/key/ref rules; checked BigInt/rational intermediates prevent time-math overflow. Same-account tampering is outside the local trust model; hashes detect accidental corruption.


## Required field contracts for implementation review

These are proposed field responsibilities, not executed schemas. Implement versioned JSON schemas and shared command validators after approval; serialized times, revisions and money must meet safe-integer/rational domain rules; finite bounded transform/gain values follow their own numeric schemas. UUIDs are stable opaque identities; registry keys may be namespaced strings. Timestamps are UTC ISO-8601 with source clock metadata; they do not order revisions.

| Entity group | Required data / relationships | Invariant |
|---|---|---|
| Workspace | id, format policy, project index, local root handle, permission/budget policy refs | Root handle stays outside portable project; project cannot grant its own scope |
| Project | id, name, format/version, revision, language, output profile, entity maps, primaryTimelineId | All stable refs resolve; no secret/host absolute path; expectedRevision checked on mutation |
| Script | id, revision, language, ordered sections and scene/shot links | Generated plan is proposal until approved |
| Character / BrandKit | id, revision, name, referenceAssetVersionIds, descriptive metadata, consent/rights refs | Reference revisions enter request/provenance hashes; changing a ref invalidates affected caches |
| Asset | id, media kind, immutable version IDs, selected version ID, name/tags and rights refs | Logical identity is distinct from content digest; no mutable file path reference |
| AssetVersion | id, assetId, SHA-256, byte length, MIME, probe, derivedFrom version refs, provenance ID | Bytes verified before publication; immutable metadata corrections create a new version |
| Scene / Shot / Storyboard | id, ordered shot IDs, script/character refs, camera/lighting/motion refs, proposed/approved status, candidate and selected take versions | No take selection silently mutates its input references; review is persisted |
| Camera / Lighting / MotionPath | id, units/convention, transform/projection or lighting parameters, time-indexed control points | Declare coordinate convention and validation range; applied mapping requires adapter receipt |
| Timeline | id, positive reduced fps rational, integer frame duration, ordered track IDs, output profile | One authority; checked conversions; no floating-point accumulated time |
| Track / Clip | kind/order, clip IDs; clip assetVersionId, start/duration frames, source tick range/timebase, transform/effect refs, gain and mute | Source range valid; no mutation of media bytes; overlaps and compositing order deterministic |
| Keyframe / Effect | registry type/version, target property, frame/tick time, typed value and interpolation | No executable source in project; only registered renderer-supported effects |
| Audio / Subtitle | assetVersionId/sample timebase/gain; cue start/end/language/text/speaker/style refs | No negative cue duration; shaping and bidi handled identically in preview/export |
| Workflow / WorkflowNode | definition version, typed registered nodes, input/output refs, edges and policies | DAG or explicit bounded iteration; no dynamic eval; graph UI does not own job state |
| GenerationRequest | operation/version, immutable inputs, model constraints, output spec, conditioning, quote/policy/consent refs | Immutable validated intent, no arbitrary worker filesystem/URL authority |
| GenerationJob / RenderJob | request/frozen project revision, attempts, owner, status, progress, cancel state, receipt refs and result versions | Durable attempt boundary; terminal success only after output validation |
| Model / Provider | namespaced IDs, model/adapter versions, capability descriptor and evidence refs, region/entitlement status | No credential bytes; unknown/retired/ineligible capabilities disabled |
| Export / ProvenanceRecord | render/job ID, artifact version/hash/probe/profile; donor/engine/model/input/prompt/rights/transform refs | Output lineage reproducible within backend limits; retain ambiguity and failed attempts |

Canonical local jobs distinguish queued, preparing, running, validating, cancelRequested, succeeded, failed, cancelled and reconciliationRequired. Future provider attempts add submitting/submitted as explicitly versioned adapter states; they do not change the local MVP state contract. Attempts carry their own stable IDs and external task IDs. A locally cancelled process does not imply a remote provider acknowledged cancellation. An interrupted submitting state with uncertain billing becomes reconciliationRequired; do not queue a fresh paid attempt automatically. Proposed state graph and migration fixtures must receive independent implementation review.

Command envelope: version, requestId, actor/session, projectId, expectedRevision, registered operation, typed arguments and scope proof. Operation result: new revision, modified stable IDs, warnings, artifact/job refs and audit receipt. Idempotency is bound to actor/project/operation/input digest; reuse with different input is an error. Secrets, raw scope proofs and machine paths must not enter project snapshots or portable receipts. Persistence of idempotency results must be atomic with the mutation to avoid duplicate effects after a crash.
