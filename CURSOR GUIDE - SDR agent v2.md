# CURSOR GUIDE — SDR Agent v2

How to use Cursor effectively to build the Sobriety Select SDR Agent — and how Sonia operates it day-to-day.

**PRD version:** 2.0 (June 9, 2026)

**Repo docs (exact filenames):**

| File | Purpose |
| --- | --- |
| `PRD - SDR agent v2.md` | Product contract — workflows, schema, cron, non-goals (**v2.0**) |
| `INSTRUCTIONS- SDR agent v2.md` | Build prompts (Phases 0–12 = initial build; Phase 13+ = post-launch) |
| `CURSOR GUIDE - SDR agent v2.md` | **This file** — operator workflow + Cursor troubleshooting |

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

When you override, **update `PRD - SDR agent v2.md` first**, then **`INSTRUCTIONS- SDR agent v2.md`** (if adding a new Phase 13+ prompt), then change code. Code-first overrides drift the docs out of sync and your future self pays the cost.

---

## Operator daily workflow (PRD v2.0)

This section is for **running** the service — not building it. Open routes with `?pw=$QUEUE_PASSWORD` (or your saved cookie).

### Morning triage (~15 min)

1. **`/queue`** — start here. Read the triage strip counts top-to-bottom by leverage:
   - **Pending emails** — approve/edit/kill cold, follow-ups, renewals, reactivations
   - **Outbound cadence** → `/outbound` — active call-first sequences (your primary live path)
   - **Follow-ups to call** → `/follow-ups` — customer-requested callbacks you scheduled
   - **Renewals to call** → `/renewals-call` — post-sale renewal call cadence
   - **Manual VM** — restricted-state leads only
   - **Awaiting reply** — leads silent 10+ days (nudge candidates)
2. Expand **engagement dashboard** on `/queue` if you want open/reply/book rates for the last 7d or 30d (`?period=30d`).
3. Check **`/follow-ups`** for anything **due now** (overdue tag).
4. Check **`/outbound`** — log touches for any active sequences at their current step.

### Two cold-outreach paths (don't mix them up)

| Path | When it applies | Operator surface | Trigger |
| --- | --- | --- | --- |
| **Call-first outbound** | You started outreach from `/outbound` | `/outbound` through demo + follow-up | `POST /outbound/start/:leadId` |
| **Legacy post-email calls** | Batch cold email sent without outbound sequence | `/cold-call` (BD 2, 5, 9) | `flagColdForCall` on cold send when **not** on outbound |

When a cold email sends, `sender.ts` picks the path automatically. If you're on outbound, legacy `/cold-call` won't open for that lead.

**Call-first cadence steps:** Call 1 → VM 1 → Cold email (approve on `/queue`) → Call 2 (demo book) → Demo → Follow-up.

**Connected on Call 1 skips VM** — sequence jumps straight to cold-email step.

### Scheduling follow-up callbacks

On **`/outbound`** (any step) or **`/cold-call`** (Connected / No answer), fill optional **Follow-up when** + note before submitting. Creates:

- HubSpot CALL task due at that time (date-only → **9:00 AM Eastern**)
- Row on **`/follow-ups`** sorted by due date

Mark **Complete** on `/follow-ups` (or the `/queue` preview) when done — closes HubSpot task too.

### Demo booking on `/outbound`

Two paths on the **Book demo** form:

1. **Auto-send (API)** — requires Google Calendar scope on `GMAIL_REFRESH_TOKEN`. Run `npx tsx src/scripts/verifyCalendarScope.ts` once after re-auth. Sends Calendar invite with Meet + logs HubSpot meeting.
2. **Manual** — fill fields → **Open Google Calendar** → send invite yourself → **Mark invite sent** back on `/outbound`.

HubSpot scheduler link in cold emails still works for self-bookers — those sync via HubSpot.

### Prep before live calls

- **`/prep-brief/lead/:leadId`** or **`/prep-brief/:dealId`** — 5-minute read before discovery calls
- Linked from `/outbound`, `/follow-ups`, `/cold-call`, `/renewals-call` rows

### End of day

- 5 PM **pipeline brief** email — triage `📬 New replies` first, then outbound cadence, renewals, cold calls, meeting follow-ups
- Clear **`/follow-ups`** due today if possible
- Approve anything time-sensitive for tomorrow's `sendApproved` cron

---

## Operator route reference

| Route | Purpose |
| --- | --- |
| `/queue` | Email draft review, triage strip, engagement stats, follow-up preview |
| `/outbound` | Call-first cadence — start outreach, log touches, book demos |
| `/follow-ups` | Scheduled callbacks from dispositions |
| `/cold-call` | Legacy post-email 3-touch calls (not on outbound) |
| `/renewals-call` | Renewal live-call cadence (BD 3–7) |
| `/manual-vm-queue` | Restricted states — human VM/call only |
| `/copilot` | RAG sales co-pilot |
| `/prep-brief/:dealId` | Discovery call prep (deal) |
| `/prep-brief/lead/:leadId` | Prep brief by lead |

All operator routes use **`queueAuth`** — same password as `/queue`.

---

## Operator troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Cold draft not appearing after outbound call 1 | Sequence not advanced / not connected or VM skipped | Log touch on `/outbound`; connected or VM left/skipped triggers `maybeDraftColdEmail` |
| Lead on `/cold-call` and `/outbound` both | Shouldn't happen — outbound cold send skips legacy flag | Check `hasActiveOutboundSequence` in sender.ts |
| Follow-up not on `/follow-ups` | Empty follow-up date, past due rejected, or no phone on lead | Re-disposition with future date; lead needs `phoneE164` |
| Book demo auto-send fails | No Calendar scope | `tsx src/scripts/gmailAuth.ts` with calendar scope, or use manual calendar path |
| Outbound count wrong | Completed sequence still in lookback window | Normal — `buildOutboundRows` filters `status === 'active'` only |
| Engagement stats include test data | Smoke lead in production stats | Set `SMOKE_TEST_LEAD_ID` only for smoke lanes; smoke leads excluded from stats |
| AI voicemail not dropping | **Paused by design** (v1.8+) | Use `/outbound`, `/cold-call`, or reactivation HubSpot tasks instead |

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
Phase 8  (voicemail)        ~60 min   ← optional V1; PAUSED in prod (v1.8+)
Phase 9  (lifecycle)        ~45 min
Phase 10 (RAG copilot)      ~60 min
Phase 11 (deploy)           ~45 min
Phase 12 (tests + ship)     ~60 min
─────────────────────────────────────
Phase 13 (outbound + follow-ups)  ← PRD v2.0; see INSTRUCTIONS Phase 13
─────────────────────────────────────
Total initial build (Phases 0–12): ~12–14 hours of focused work
```

**Already shipped?** Don't re-run Phases 0–12. For new work, use **Phase 13+** prompts in INSTRUCTIONS or point Cursor at **PRD § + feature map appendix**.

Spread over a week, that's ~2 hours/day.

---

## Cursor sessions for maintenance (post-launch)

When fixing or extending shipped code:

1. Open the relevant **PRD §** (e.g. §9.6 for outbound/follow-ups).
2. Check **INSTRUCTIONS Appendix — PRD v2.0 feature map** for file paths.
3. One scoped Composer prompt — e.g. "Fix X in `followUpTask.ts` per PRD §9.6. Don't refactor unrelated files."
4. Verify acceptance from the PRD section, not from ancient Phase prompts.
5. Update PRD first if behavior changes; add a Phase 13.x prompt to INSTRUCTIONS if the change is substantial.

Don't paste Phase 5.1 into Cursor to "fix" outbound — that prompt predates `/outbound` entirely.