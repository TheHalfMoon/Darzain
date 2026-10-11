# Yamakan engineering instructions

@C:\Users\Shehr\.codex\RTK.md

Read specs/CURRENT.md and docs/IMPLEMENTATION_PLAN.md. The founder approved the final plan edbaba6c (docs/FOUNDER_DECISION_RECORD.md): implement T1–T10 in dependency order under the operational contracts. D/F/G stay deferred; paid inference, model weights, packaging and public release remain gated. Production code must pass the command registry, import guard (docs/provenance/import-policy.json) and provenance ledger.

Use English for engineering; plan Arabic/English product support. Keep one canonical project/timeline model and one current frontier. Preserve previous work, required notices and source attribution. Record exact SHA/path/hash/modifications for imports. Founder source rights do not grant model-weight/dataset/trademark/hosted capacity rights.

Prefix shell commands with rtk. Do not change donor source/remotes. Keep secrets/private raw donor source/large analysis captures out of public evidence. Never turn failed/skipped scans into passes. After approval use bounded branches, mechanical checks, actual E2E, fresh independent correctness/security review, exact-head CI, normal pinned-head merge commits and verified post-merge main. Never force push.
