# Founder decision record

This records the founder's implementation authorization against the [decision packet](FOUNDER_DECISION_PACKET.md). The packet and earlier review evidence remain unchanged historical records.

## Source of authorization

- **Source:** written founder instruction titled "YAMAKAN — FOUNDER IMPLEMENTATION AUTHORIZATION & AUTONOMOUS ENGINEERING EXECUTION", delivered to the implementing agent (Claude, Claude Code) in an interactive session on the founder's Windows device `Abdulaziz` on 2026-10-11, followed by a confirming instruction in the same session.
- **Bound plan commit:** `edbaba6c4f5f2f42e968b4ab2273c8e11620d9af` (PR #5 head; PR #3 `419bc356…`, PR #4 `73910ba9…`).
- **Form:** chat instruction only. There is no separate signed approval and no founder GitHub review; none is claimed.

Approval line in the packet's format:

`Final plan edbaba6c4f5f2f42e968b4ab2273c8e11620d9af: A/B/C/E/I/J approved as preferred; D/F/G deferred; H superseded by completed repository rename; founder (repository owner TheHalfMoon), 2026-10-11.`

## Decisions

| Choice               | Recorded decision                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A architecture       | Approved: final refined D′.                                                                                                                                                                                                                             |
| B MVP scope          | Approved: offline local-web Windows MVP, Arabic/English, durable projects, editing, rendering, recovery, core API/MCP.                                                                                                                                  |
| C migration          | Approved: checked Flicks/BigInt timing, source timestamp preservation, migration into a new root, byte-identical originals.                                                                                                                             |
| D desktop            | Deferred: packaging/installers wait for separate qualification. MVP Windows process-lifecycle requirements stay mandatory.                                                                                                                              |
| E reuse/distribution | Approved: qualified source reuse with precise provenance, legal notices and the mandatory security exclusions.                                                                                                                                          |
| F local AI           | Deferred until qualified hardware, models, weights and runtime exist.                                                                                                                                                                                   |
| G providers          | Deferred: no paid API activation or cloud spend; future-compatible contracts only.                                                                                                                                                                      |
| H naming             | The founder states the repository was renamed `TheHalfMoon/Darzain` → `TheHalfMoon/Yamakan`; verified live on 2026-10-11. Yamakan is the canonical identity; historical Darzain provenance is preserved and active product-facing branding is migrated. |
| I release gates      | Approved without weakening: full technical acceptance criteria and independent verification.                                                                                                                                                            |
| J residual risks     | Accepted as planning assumptions, not as acceptance of implementation defects.                                                                                                                                                                          |

## Additional founder statements

- **Planning integration.** The founder directed integration of the stacked planning PRs. They were merged in dependency order with normal merge commits at their exact reviewed heads: #3 → `4e2f4b2b`, #4 → `237518ef`, #5 → `559ac7f7`. The resulting main tree is identical to `edbaba6`.
- **Source reuse.** The founder states: "I have official legal permission to copy, use, modify, combine, adapt, integrate, and rebrand the source code of all the donor projects previously identified and discussed for Yamakan." This is the founder's statement; no separate written grant is held in this repository. It does not extend to model weights, datasets, trademarks, proprietary media, hosted capacity or third-party services. AGPL and other notice or source-offer obligations still apply.
- **Repository writes.** The founder directed that authorized GitHub write operations use the `TheHalfMoon` credentials per command, without switching the machine's active GitHub account.
- **Autonomy.** Routine, reversible engineering work under the plan proceeds without per-step approval. This does not waive security, financial, rights or release gates, and it does not authorize paid purchases or a public release.

## 2026-10-13: performance targets frozen (approval I)

- **Source and form:** chat instruction only, in the same interactive session on the founder's device. The founder replied "approve, continue." to the T10 release proposal, which listed three open founder items. The agent asked which items the approval covered; the founder's answer covered only freezing the proposed performance targets. There is no signed approval and no founder GitHub review; none is claimed.
- **Scope:** the plan's proposed performance targets, frozen as hard thresholds in [`core/qualification-policy.ts`](../core/qualification-policy.ts) (`yamakan.qualification-policy/v1`):
  - cold launch p95 ≤ 5 s;
  - reopen p95 ≤ 2 s;
  - reference still p95 ≤ 1 s warm and ≤ 3 s cold;
  - 2 s reference segment p95 ≤ 6 s cold;
  - 720p playback ≥ 24 fps.

  The approval also covers the hardware profile and the fixtures stated in that file.

- **Offered but not selected** in the founder's answer, so not approved:
  - treating worker read containment as ship-blocking;
  - the proposed engineering order.
- **Not covered** by the question or the answer: any memory or resource ceiling. The 300 MiB large-import ceiling in `scripts/qualify-large-import.mjs` is a proposed value, not part of policy v1.
- **Change rule:** a threshold is never adjusted to pass. A change needs a new policy version and a new founder approval.

## 2026-10-13: continuation to verified completion

- **Source and form:** chat instruction only, in the same interactive session, titled "YAMAKAN — AUTONOMOUS CONTINUATION TO VERIFIED PROJECT COMPLETION". There is no signed approval and no founder GitHub review; none is claimed.
- **Key sentences, verbatim:**
  - "Treat hostile-media read containment as release-blocking."
  - "Prefer a correctly implemented Windows AppContainer when feasible. Otherwise use a fully restricted token with restricting SIDs on every relevant access and brokered inputs."
  - "A write-restricted or low-integrity token alone does not satisfy read containment."
  - "If containment cannot be demonstrated, leave the affected worker feature disabled and retain NO-GO for release."
  - "Choose and freeze a measurable resource policy", covering import-service peak RSS, decoder/probe memory and runtime, render memory, disk admission and reserve, and active job/resource budgets.
  - "Do not falsely attribute an agent-selected policy to an earlier founder decision."
  - "Do not publish a public release, deploy paid infrastructure, enable paid AI providers, or incur charges without the corresponding explicit authorization."
- **Scope, summarized by the agent:** continue autonomously through the remaining MVP gates and then the roadmap approved with the plan ([ROADMAP.md](ROADMAP.md) and [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), plan `edbaba6c`), without routine approval; the engineering order is the agent's.
- **Attribution:** values the agent chooses under this delegation are recorded as agent decisions, with their rationale, and are not attributed to approval I or any earlier founder decision.
- **Not authorized without a further explicit authorization:** purchases, paid services or inference, cloud spend, and a public release. Human- and administrator-only gates stay open until they genuinely run: native Arabic review, clean profiles, a second account, packet capture and disk-full runs.
