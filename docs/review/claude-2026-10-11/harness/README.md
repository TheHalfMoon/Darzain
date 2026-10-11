# Review harness (2026-10-11)

Bounded, reversible experiments behind [the independent review](../../CLAUDE_INDEPENDENT_REVIEW.md). Results: [evidence.json](../evidence.json). They are review evidence, not product tests; port the useful ones into `tests/` during implementation.

Layout assumed by the relative imports: a directory containing this repository checked out at 419bc356 as `darzain/` and these scripts copied to a sibling `harness/`. Run from `harness/` with Node 24.19.0 and FFmpeg 8.1.1 on Windows unless noted. Every script writes only under the OS temp directory or `harness/`.

| Script | Command | Expected on 419bc356 |
|---|---|---|
| t1-rename-lock.ts | `node t1-rename-lock.ts` (Windows, PowerShell available) | `SAVE FAILED while locked: EPERM` |
| t2-cross-process.ts | `node t2-cross-process.ts` | `{ 'one-acked': 40 }` |
| t2b-interleave.ts | `node t2b-interleave.ts` | `LOST UPDATE` |
| t3-parent2.mjs | Start with `Start-Process node t3-parent2.mjs progress out.json`, then `Stop-Process -Force` the recorded node PID | FFmpeg child does not survive |
| t3-py.mjs | Same, with the spawn path replaced by an absolute `python.exe` | Python child dies; **FFmpeg grandchild survives** |
| t4.mjs, t4b.mjs | `node t4.mjs; node t4b.mjs` | Joined glyphs; wrong RTL base direction (`!` at right) |
| t4c.mjs + titles.ass | Copy `titles.ass` into `t4/`, then `node t4c.mjs` | Correct RTL with style `Encoding` = -1 |
| t5-draft.ts | From the `feat/durable-jobs` worktree root: `DRAFT_ROOT=$PWD node <path>/t5-draft.ts` | Both (a) and (b) fail as described |
| t6-writer.mjs, t6-check.mjs | Two concurrent writers, then check; or repeated `Stop-Process -Force` during a writer | `invariant_head_eq_rows_eq_idem: true`, `integrity: ok` |
| t7-canon.ts | `node t7-canon.ts` | Unsafe integer and `__proto__` accepted |
