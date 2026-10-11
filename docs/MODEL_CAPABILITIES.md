# Versioned generation and capability contract

GenerationRequest v1 is an operation union, not a flat universal parameter list. Common fields: requestId, projectId/revision, operation, immutable input asset-version refs/hashes, prompt, optional seed, output spec, model/provider constraints, region/privacy policy, maximum cost, approved quote and consent refs. Callers cannot supply arbitrary worker paths/URLs.

Operations: textToImage, imageToImage, inpaint, outpaint, textToVideo, imageToVideo, videoToVideo, extendVideo, audioToVideo, lipSync, upscale, interpolateFrames and generate3D. Camera/motion/character/multiple references are typed conditioning items with declared adapter mapping. Each operation has its own fields and limits; unsupported inputs return CAPABILITY_UNAVAILABLE before a paid call.

CapabilityDescriptor v1 records provider/model/adapter version, operations, dimension/duration/frame-rate domains, native audio, reference roles/counts, mask/first-last frames, motion/camera control, formats, seed semantics, async/status/cancel/reconcile behavior, region/rate limits, billing formula, rights/entitlement, hardware and evidence freshness. Unknown remains unknown and disabled. Documentation, installed readiness, account entitlement and actual output qualification are separate states.

Adapter interface: describe → validate → quote → submit → poll/cancel/reconcile → collectOutputs. Poll progress is observational. Completion requires actual artifact probe/hash/provenance. Report cancellation as requested, locally stopped, provider acknowledged or unsupported. Preserve native audio as explicit assets/tracks.

Namespace provider-specific controls under versioned schemas. Unsupported camera geometry can produce labeled textual intent only; a rendered depth/pose/path reference requires an applied receipt. Seed reproducibility and identity preservation require backend-specific measured quality, not identical prompts.

Current docs distinguish cloud Wan 3.0 from open Wan2.2 source, MiniMax H3 v2 from the older inspected MCP v1 wrapper, and retired Sora 2/Videos API from older remaining examples. A stale wrapper cannot enable a retired/changed model.


## Operation-specific inputs

| Operation | Required typed inputs | Capability checks before submit |
|---|---|---|
| textToImage | prompt, image output dimensions/format | Supported size/aspect/quality/count, moderation/rights and quote |
| imageToImage | source AssetVersion, instruction, output spec | Reference/fidelity/strength supported; no assumed seed equivalence |
| inpaint / outpaint | source image, mask or expansion bounds, instruction | Mask/alpha convention, dimensions and explicit mask mapping |
| textToVideo | prompt, duration rational, dimensions/fps/audio preference | Supported duration-resolution-audio combination, billing unit and region |
| imageToVideo | first image, optional last image, duration/output spec | First-last mode actually supported; reference count and media limits |
| videoToVideo | source video, edit/reference role, output spec | Input size/duration/fps, edit vs reference distinction, charged input seconds |
| extendVideo | source video/version, extension direction/length | Extension mode and cumulative limits; no silent concatenation presented as native extension |
| audioToVideo / lipSync | audio and source face/video refs, consent | Input sample/duration limits, likeness/voice policy and alignment semantics |
| upscale / interpolateFrames | media input, scale or target fps | Frame/sound timing, tile/VRAM limits, artifacts and output validation |
| generate3D | image/text conditioning, mesh/material output spec | Format/topology/size limits, assets/weights rights and worker readiness |

Conditioning union: imageReference(role), videoReference(role), audioReference(role), characterReference(version), cameraIntent(convention), motionReference(type), poseReference and segmentation/depth mask. Roles and control types map to versioned adapter schemas; unsupported values cannot be silently dropped. A UI camera position is not proof the generator obeyed it. Router descriptions expose supported combinations rather than independently combining incompatible flags.

Capability lifecycle: candidate → documentationVerified → environmentReady → accountOrModelEntitled → runtimeQualified → releaseEnabled. Local editing-only capabilities may skip provider account entitlement but still need environment/output qualification. Retirement/expiry or failed configuration revokes enablement. Runtime qualification records operation/configuration, exact engine/model/weights where available, hardware, input/output hashes, cost and limitations; it never implies all combinations passed.

## Review amendment: separate states

Every capability records five independent facts: **sourceAvailable**, **weightsLicensed**, **apiEntitled**, **runtimeQualified** (exact hardware or account) and **qualityMeasured** (rubric and sample). Enablement requires the facts relevant to its route. None implies another. Open Generative AI's model list is a MuAPI catalog and establishes none of these facts for direct providers.
