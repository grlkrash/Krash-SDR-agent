# CURSOR GUIDE — SDR Agent v2

How to use Cursor effectively to build the Sobriety Select SDR Agent.

**Repo docs (exact filenames):**

| File | Purpose |
| --- | --- |
| `PRD - SDR agent v2.md` | Product contract — workflows, schema, cron, non-goals |
| `INSTRUCTIONS- SDR agent v2.md` | Build prompts (one block per Cursor turn) |
| `CURSOR GUIDE - SDR agent v2.md` | This file — operator workflow + troubleshooting |

---

## Setup (one time)

1. **Clone or open the repo in Cursor.** The `.cursorrules` file at the repo root is read automatically on every prompt. You don’t need to paste rules manually.
2. **Verify Cursor sees the rules:** open a new chat and ask “What rules are you operating under?” You should see references to `PRD - SDR agent v2.md`, the six-table schema, no Redis/queues, etc. If not, restart Cursor.
3. **Use Claude Sonnet 4 as your Cursor model** for code generation. Cmd/Ctrl+I → click the model selector. The PRD prompts assume Sonnet-class quality.
4. **Prefer Composer (Cmd/Ctrl+I)** over inline chat for any prompt that creates or modifies files. Composer can write multiple files in one shot and shows you a unified diff.
5. **Open `PRD - SDR agent v2.md` and `INSTRUCTIONS- SDR agent v2.md` in tabs** — Cursor automatically includes open files in context.

---

## How to run a prompt from INSTRUCTIONS- SDR agent v2.md

Each numbered block (e.g., “Prompt 1.2”) is one Cursor turn.

1. **Open Composer (Cmd/Ctrl+I).**
2. **Copy the entire code block** including the triple-backtick fence — Cursor handles the fences fine.
3. **Paste into Composer.** Hit enter.
4. **Read Cursor’s diff carefully** before accepting. Look for:

- Did it create only the files the prompt asked for? (`.cursorrules` says STOP after the prompt — verify.)
- Did it install only the dependencies the prompt mentioned?
- Are there any `any`, `console.log` in business logic, default exports, axios imports? (See `.cursorrules` DON’Ts.)

1. **Accept the diff.**
2. **Run the acceptance check** stated at the bottom of the prompt.
3. **Commit before the next prompt:** `git add -A && git commit -m "Prompt X.Y: <one line>"`. This gives you trivial rollback if a later prompt breaks something.

---

## When Cursor goes sideways

### Symptom: Cursor creates extra files you didn’t ask for

**Fix:** “Per .cursorrules, STOP after completing the prompt. Remove `<file>` — it wasn’t in the prompt scope.”

### Symptom: 300-line file when you asked for ~80 lines

**Fix:** “Compress to under 100 lines. Cut anything not in the acceptance criteria. No defensive try/catch, no premature abstractions, no JSDoc on internal functions.”

### Symptom: Cursor used `any` or default export or axios

**Fix:** “This violates .cursorrules — [name the rule]. Rewrite using [the rule’s preferred approach].”

### Symptom: Cursor wants to refactor existing files

**Fix:** “Don’t refactor — only do what the prompt asks. If you see a real issue, mention it at the bottom of your reply but don’t act.”

### Symptom: TypeScript errors after Cursor’s diff

**Fix:** Paste the exact `tsc` error: “Fix this error without using `any` or `@ts-ignore`: [paste]”. Don’t accept “just add `as any`” as a solution.

### Symptom: Test fails on the acceptance check

**Fix:** “Acceptance criteria says X but the output does Y. Show me the diagnosis (don’t write code yet).” Get the diagnosis first, then ask for the fix.

### Symptom: Cursor wants to add Redis / BullMQ / a new table / a microservice

**Fix:** Re-read `.cursorrules`. The answer is no. If you genuinely need it, update the PRD first and explain why.

---

## Verifying acceptance criteria

For each prompt, after Cursor accepts the diff:


| Type of acceptance                    | How to verify                                                 |
| ------------------------------------- | ------------------------------------------------------------- |
| “Compiles”                            | `npm run build` returns 0                                     |
| “Server starts, /health returns JSON” | `npm run dev`, then `curl localhost:3000/health`              |
| “Migration runs”                      | `npx prisma migrate dev`, then `npx prisma studio` to inspect |
| “Script inserts N rows”               | Run the script, then `npx prisma studio` or `psql` to count   |
| “Email arrives at test address”       | Send to your own Gmail; check it arrives with the footer      |
| “Test passes”                         | `npm test`                                                    |


If acceptance fails, **don’t move forward**. Fix it first. The build order is intentional — Phase 3 won’t work if Phase 2’s enrichment isn’t producing rows.

---

## Working in chunks

Don’t try to do all of Phase 1 in one Cursor session. Suggested cadence:

- **One Cursor session = one Phase** (or one prompt for the bigger ones)
- **Hard break between Phases** — close Cursor, run all acceptance checks, commit, take a 10-minute walk
- **Don’t paste Prompt 1.3 into the same Composer thread where you just did 1.2** — start a fresh Composer per prompt so Cursor’s context window stays clean

---

## When to override the PRD

The PRD is the contract. But it’s not sacred. Override is fine when:

1. You hit a real-world constraint the PRD didn’t anticipate (e.g., HubSpot Free actually doesn’t support property X — workaround needed)
2. You learn something from week 1 that changes the design (e.g., reply rate is 5% not 15% — we need a different angle)
3. Mark Beach gives you info that changes assumptions (e.g., pricing tiers shift)

When you override, **update `PRD - SDR agent v2.md` first**, then **`INSTRUCTIONS- SDR agent v2.md`**, then change code. Code-first overrides drift the docs out of sync and your future self pays the cost.

---

## What to do at the end of each Phase

1. All acceptance checks pass ✓
2. `npm run build` clean ✓
3. `npm test` passes (once tests exist) ✓
4. Commit with a clear message ✓
5. Update CHECKLIST.md if a launch-required item was completed ✓
6. Skim what you just built — does it match the PRD’s description of that workflow? If not, reconcile now.

---

## Survival tips from the trenches

- **Don’t fight Cursor on minor style preferences** — if it picks single quotes vs. double, who cares. Save your patience for the rules that actually matter (no Redis, no `any`, no default exports).
- **When stuck, paste the actual error.** Cursor is dramatically better at fixing concrete errors than abstract “this doesn’t work.”
- **If a prompt produces wildly different output than expected,** ask Cursor: “What did the .cursorrules tell you to do that you didn’t follow?” It’ll usually self-correct.
- **Don’t paste secrets into Cursor prompts.** Cursor sends to the model. Use `.env` placeholders in prompts, real values only in your local `.env`.
- **Use `git diff` after Cursor accepts** — sometimes Cursor edits files outside the diff view. `git status` is your friend.

---

## Build order at a glance

```
Phase 0  (scaffold)         ~30 min
Phase 1  (lead sourcing)    ~90 min
Phase 2  (enrichment)       ~90 min   ← biggest payoff for thought
Phase 3  (cold drafting)    ~60 min
Phase 4  (HubSpot sync)     ~60 min
Phase 5  (approval queue)   ~60 min   ← first time you'll demo to yourself
Phase 6  (send + sequence)  ~90 min
Phase 7  (scoring + brief)  ~45 min
Phase 8  (voicemail)        ~60 min   ← optional V1, can defer
Phase 9  (lifecycle)        ~45 min
Phase 10 (RAG copilot)      ~60 min
Phase 11 (deploy)           ~45 min
Phase 12 (tests + ship)     ~60 min
─────────────────────────────────────
Total: ~12-14 hours of focused work
```

Spread over a week, that’s ~2 hours/day. Done by May 27 (the contract start) if you start now.