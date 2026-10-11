# Capability, privacy and cost router

Final proposal: [master plan](IMPLEMENTATION_PLAN.md) and [operational contracts](OPERATIONAL_CONTRACTS.md) own current scope and exact protocols. Earlier evidence remains bounded; no final implementation or founder approval is implied.

Apply hard filters first: actual operation/conditioning support, rights/entitlement, user credentials, asset/region egress consent, output limits, hardware/readiness, quota and remaining budget. Rank eligible routes by measured quality, estimated total cost and latency; never trade away a required capability for price/popularity.

Return eligible/rejected routes with reason codes, evidence freshness, selected adapter and quote. Quality scores bind fixtures, model/version/hardware and human rubrics. Missing scores remain unknown; marketing claims do not become quality rankings. Offline mode permits no cloud route.

Quote v1: currency, integer minor units or decimal-string formula, duration/resolution, output/input/reference charges, minimums, retries, expiry and official price source/date. Include documented storage/upload fees; expose unknown taxes/FX. A reliable upper bound is required for a hard spending promise. Seedance's per-million-token pricing cannot be converted to per-second cost without model token rules.

Atomically reserve the authorized worst-case amount before submission. Settle actual receipts, release reservations only after reconciled outcomes, preserve ambiguous reservations across restart, enforce user/project/day caps, parallelism and retry budgets. A local ceiling cannot undo charges already accepted externally. Never use binary floating point as money authority.

Fallback uses only preapproved providers/regions/assets plus a fresh quote within remaining budget. No silent local-to-cloud switch, hidden reference upload or automatic retry of ambiguous paid submission. Resale/white-label rights and discounts are unknown without an actual agreement. Commercial credits wrap this same receipt/quota contract later and do not fund MVP by default.

## Write-ahead submission protocol (independent review H7)

1. Persist the attempt as `submitting` with a client reference, frozen quote, reservation and request digest **before** any network send.
2. Send with the provider's documented idempotency key if one exists. Otherwise mark the adapter `nonIdempotentSubmit`.
3. On response, persist the external task ID and set the attempt to `submitted`.
4. A crash, timeout or transport error between steps 1 and 3 sets `reconciliationRequired`. Only a provider lookup by client reference (where supported) or an explicit user decision can clear it, and a fresh paid attempt never starts automatically.
5. A poll timeout never fails a paid job locally. It moves the attempt to `reconciliationRequired`, because the remote job may still be running and billing (as the Open Generative AI `pollForResult` pattern shows).

Spending caps are labeled **hard** only when the quote formula has a documented upper bound and the reservation covers it at the concurrency limit. Otherwise the cap is **soft** and requires explicit acknowledgment. Money uses integer micro-units. Price tables carry their source URL, fetch time and expiry, and a stale table disables the route until it is refreshed. Aggregators (fal.ai, Replicate, MuAPI) are separate routes with their own terms, retention and pricing; they are never a silent substitute for a direct provider.

## Final reservation scope

Intent/reservation/reconciliation uses the same workspace DB, with shared workspace/user/project/day caps checked atomically across processes. Timeout/cancel does not establish stopped billing; ambiguous reservations remain held. A non-idempotent route never automatically retries an ambiguous submit. The offline MVP has no network-eligible route. Quotes/entitlement/runtime quality are qualified per exact operation, not provider name.
