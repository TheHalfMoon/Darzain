# Provider matrix — official snapshot, 2026-10-11

The authoritative full-field research registry is [provider-registry.json](evidence/yamakan/provider-registry.json). Every record includes modalities, duration, resolution, native audio, frames, references, motion, asynchronous jobs, account/rate/region limitations, units/prices, BYOK, reseller/white-label status, business contact, date, official evidence and uncertainties. Null means unknown, never an advertised capability. This is a reviewed-source snapshot, not a running or commercially entitled service registry. No inference requests were made.

| Provider | Model | Maximum output seconds | Resolution | Pricing unit | Price detail | State |
|---|---|---|---|---|---|---|
| Alibaba Cloud / Wan | wan3.0-video | 30 | 480p, 720p, 1080p | USD per output second | See exact keyed entries in registry | documented_not_runtime_qualified |
| Alibaba Cloud / Wan | wan3.0-video-prime | 30 | 480p, 720p, 1080p | USD per output second | See exact keyed entries in registry | documented_not_runtime_qualified |
| Alibaba Cloud / Wan | wan2.7-t2v | 15 | 720p | USD per output second | See exact keyed entries in registry | documented_not_runtime_qualified |
| Alibaba Cloud / Wan | wan2.6-i2v / wan2.6-i2v-flash | 15 | 720p, 1080p | USD per output second | See exact keyed entries in registry | documented_not_runtime_qualified |
| ByteDance / Volcengine | doubao-seedance-2-5 | 30 | 480p, 720p, 1080p | CNY per million video tokens | See exact keyed entries in registry | documented_not_runtime_qualified |
| ByteDance / Volcengine | doubao-seedance-2-0 / fast / mini | Unknown / not applicable | Unknown / model-specific | CNY per million video tokens | See exact keyed entries in registry | documented_not_runtime_qualified |
| ByteDance / Volcengine | doubao-seedream-5-0-pro / flash | Unknown / not applicable | Unknown / model-specific | CNY per generated image/layer; input-image surcharges separate | See exact keyed entries in registry | documented_not_runtime_qualified |
| Kuaishou / Kling | Kling 3.0 / 3.0 Turbo | Unknown / not applicable | 720p, 1080p, 4k (specific standard modes) | USD per generated second, mode/resolution dependent | See exact keyed entries in registry | documented_not_runtime_qualified |
| MiniMax / Hailuo | MiniMax-H3 | 15 | 768p, 2k | USD per output second plus input charges | See exact keyed entries in registry | documented_not_runtime_qualified |
| MiniMax / Hailuo | MiniMax-H3-Max | 15 | 480p, 768p | USD per output second plus input charges | See exact keyed entries in registry | documented_not_runtime_qualified |
| Google Gemini API | Veo 3.1 Standard / Fast / Lite | 8 | 720p, 1080p, 4k (Standard/Fast) | USD per generated second | See exact keyed entries in registry | documented_not_runtime_qualified |
| Runway | gen4.5 / gen4_turbo | Unknown / not applicable | Unknown / model-specific | credits per generated second; USD 0.01 per credit | See exact keyed entries in registry | documented_not_runtime_qualified |
| fal.ai | model-specific endpoints; H3 Max example | Unknown / not applicable | Unknown / model-specific | endpoint-specific; example USD per second | See exact keyed entries in registry | documented_not_runtime_qualified |
| Replicate | model/version-specific endpoints | Unknown / not applicable | Unknown / model-specific | model output or hardware-runtime dependent | Unverified / retired | documented_not_runtime_qualified |
| Adobe | Firefly Services | Unknown / not applicable | Unknown / model-specific | contract/operation specific; public comparable quote not verified | Unverified / retired | documented_not_runtime_qualified |
| OpenAI | gpt-image-2.5-sunburst / gpt-image-2.5-flare | Unknown / not applicable | Unknown / model-specific | USD per million tokens by token type | See exact keyed entries in registry | documented_not_runtime_qualified |
| OpenAI | Sora 2 / Videos API | Unknown / not applicable | Unknown / model-specific | Unknown | Unverified / retired | retired |
| MiniMax | speech-2.8-hd / speech-2.8-turbo | Unknown / not applicable | Unknown / model-specific | USD per million characters | See exact keyed entries in registry | documented_not_runtime_qualified |
| MiniMax | Speech Recognition | Unknown / not applicable | Unknown / model-specific | USD per input audio hour | See exact keyed entries in registry | documented_not_runtime_qualified |

Important verified changes: Alibaba documents Wan 3.0 2–30 s with audio/references and retained Wan 2.6/2.7; Volcengine lists Seedance 2.5 and Seedream 5.0. MiniMax now documents H3/H3 Max through v2, while its pinned MCP donor targets an older generation API. OpenAI's current official guide explicitly retires Sora 2/Videos API on September 24, 2026; the router must not enable an old adapter on the strength of historical examples.

## Exact commercial distinctions

Wan 3.0 International list rates are $0.05/$0.10/$0.20 per second for 480/720/1080p; Prime $0.068/$0.14/$0.28. Do not mix International, Global or US prices. Wan 2.6 I2V 720p International is $0.10/s; Flash with audio is $0.05/s. Flash without audio and different resolution require another keyed quote.

Seedance 2.5 is CNY 70/42 per million tokens at 480/720p without/with input video, and 77/46 at 1080p. Token counting and billable input must be known before quoting; these are not per-second prices. Seedream 5.0 Pro single-image output is CNY 0.30 at <=2.61 million pixels or 0.60 above; layer splitting halves those output rates and charges each layer. First input image is free, then CNY 0.02/image. Flash output is CNY 0.12/image. Exact source units and service scope remain required.

H3 output is $0.08/s at 768p or $0.13/s at 2k, plus charged input video/image references. H3 Max output is $0.05/s at 480p or $0.08/s at 768p; its input video costs are $0.0553/$0.143 per input second and excess-image cost is $0.074. An output-only estimate would understate these jobs. Kling prices vary by Turbo, resolution, audio and voice control; do not apply a single provider rate. Veo 3.1 Standard is $0.40/s at 720/1080p, $0.60/s at 4k; Fast $0.10/$0.12/$0.30; Lite $0.05/$0.08 and no 4k. Runway's $0.01 credit yields $0.12/s for gen4.5 and $0.05/s for gen4_turbo.

OpenAI image rates are token based; equal token rates do not guarantee equal cost per image. fal.ai prices are endpoint/configuration specific. Replicate can charge output units or hardware runtime. Adobe overview does not establish a comparable unit quote. An unknown estimate blocks an automatic paid job until the user approves a explicit capped budget under suitable provider billing semantics.

## Availability and contacts

API documentation establishes a technical access path, not this account's entitlement, location availability, media retention policy or resale rights. All adapters need a credential-free describe phase and an explicit account qualification phase. No reseller program or discount is verified here. Founder source authorization does not cover hosted capacity, model weights, trademarks or reference assets. BYOK stores each user's own credentials and never falls back to founder credits.

Verified public contact paths: [Alibaba sales](https://www.alibabacloud.com/contact-sales), [Volcengine contact](https://www.volcengine.com/product/contact), and [fal.ai sales section](https://fal.ai/pricing#contact-sales); fal's official page also publishes support@fal.ai. Contacts for other suppliers remain unverified. No outreach was sent. Dreamina, Wan consumer and Hailuo consumer products do not establish white-label API rights. The KlingAI organization/Skills navigation is not evidence of a qualified official MCP server.

## Evidence and refresh gate

Read [official page excerpts](evidence/yamakan/provider-excerpts.json), [limit excerpts](evidence/yamakan/provider-limit-excerpts.json) and [Seedance tutorial retry](evidence/yamakan/seedance-tutorial.json), then use the official URLs in each registry entry. Successful HTTP scrape does not mean runtime success. Failed docs.klingai.com and guessed MiniMax pricing URL are excluded as successful evidence. Seedance tutorial first failed but a fresh retry succeeded, documenting 4–30 s output, 480/720/1080p, audio/references, editing/extension, first/last frames and published account classes. 1080p uses 10-bit HEVC and needs playback/proxy qualification. Draft is 480p and draft-to-final only 1080p; records/draft references expire after seven days. Direct real-face reference uploads are disallowed and authorized-person assets use a separate route. Public limits are 600 RPM / 10 concurrent for enterprise and 180 RPM / 3 concurrent for individuals; actual account eligibility remains unverified. Other provider account-specific concurrency/tier limits remain unknown. Before implementation enablement, bind model revision, region, parameters, price date, retention terms and billing rounding; refresh documentation and run an approved capped real request. Rate limits should be read from verified service/account information, not guessed from another customer.
