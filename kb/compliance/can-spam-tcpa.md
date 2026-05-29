# Compliance Reference — CAN-SPAM, TCPA, and HIPAA Basics

## Overview

Sobriety Select outreach operates under three primary compliance frameworks: CAN-SPAM (commercial email), TCPA (telephone and voicemail), and HIPAA (incidental to the addiction treatment space). This document is a working reference — not legal advice. Sonia should confirm current obligations with counsel annually and before any practice change.

## CAN-SPAM Requirements

All commercial emails sent through the SDR agent must include: (1) an accurate "From" display name and address (`sonia@sobrietyselect.com`), (2) a non-deceptive subject line — no fabricated urgency, no misleading personalization, (3) a physical mailing address for Sobriety Select in the email footer, and (4) a functional unsubscribe mechanism. The unsubscribe link is handled by `src/routes/unsubscribe.ts` which writes to the Suppression table and sets `Lead.doNotContact = true`. Processing time must be within 10 business days; our system processes unsubscribes immediately on click.

## TCPA and Voicemail Drop Rules

### Policy (May 29, 2026)

**Cold-prospect AI voicemail is paused.** Live calls for hot cold leads are manual only.

**Post-sale AI vm (consent-gated):** Automated vm drafts trigger only when:
1. `Lead.priorWrittenConsent = true` (click-through on renewal/reactivation email via `/consent-phone`), AND
2. A `renewal` or `reactivation` email was sent in the last 30 days.

**Auto-send is off** until counsel sign-off (`VM_AI_AUTO_SEND=true`). Until then, vm drafts in `/queue` are reference scripts only — use **Left VM manually** to log HubSpot call engagements.

Renewal and reactivation emails append an optional phone opt-in link when the lead has a phone on file and has not yet opted in.

### FCC AI-voice ruling (Feb 2024)

The FCC ruled that AI-generated / synthetic voices are **"artificial"** under the TCPA — legally equivalent to prerecorded robocalls. ElevenLabs TTS on our voicemail drops is in scope. Penalties: $500–$1,500 per call at federal level; state mini-TCPA laws can add private rights of action and higher damages.

**What the agent does today:**

1. **Disclosure (code-enforced).** Every MP3 is wrapped by `wrapVoicemailScript()` in `src/shared/voicemailCompliance.ts` before ElevenLabs render. The opening states: automated, pre-recorded, artificial voice; business name (Sobriety Select); purpose (sales / marketing follow-up). The closing gives opt-out: call `SONIA_PHONE` or reply **stop** to email.
2. **No live-person impersonation.** Prompts forbid "this is Sonia" — the voice is synthetic. Live bridges (human answers) connect to the real Sonia on `SONIA_PHONE`.
3. **Landline-only gate.** Twilio Line Type Intelligence blocks mobile/VoIP before draft or send. Prerecorded voice to wireless without prior express written consent violates 47 U.S.C. § 227(b)(1)(A).
4. **TCPA quiet hours.** All vm-1 and vm-2 drops defer outside local **8 AM–9 PM** (`isTcpaCallingHoursOpen`). Vm-1 additionally defers Mon–Fri 9 AM–6 PM so AMD is more likely to reach a mailbox.
5. **AMD, not ringless.** Outbound calls ring normally. MP3 plays only when Twilio AMD classifies a machine. Not carrier-side silent injection.

### Consent — open counsel question

Cold email approval **does not** equal TCPA consent for AI marketing voicemails. Prior express written consent (PEWC) for artificial/prerecorded voice is required for many use cases — especially wireless, high-risk states, and under aggressive mini-TCPA statutes.

**Current posture:** B2B **landline** path in non-restricted states, with disclosures above. Restricted states (FL, OK, WA, IN, MA, TX, CA) require manual outreach unless `Lead.priorWrittenConsent = true`.

**Recommended next steps with counsel:**

- Confirm whether B2B landline + disclosure is sufficient for your consent basis, or whether PEWC is required before any AI vm drop.
- Implement National DNC scrub before scaling (see CHECKLIST.md).
- Do not expand automated drops to mobile-direct numbers without documented PEWC.

### State-by-state matrix (automated vs manual)

The code gate lives in `src/shared/voicemailEligibility.ts` (`MANUAL_ONLY_US_STATES`: FL, OK, WA, IN, MA, TX, CA). Non-US numbers are blocked until a per-country program exists. Generate a printable matrix for counsel:

```bash
npm run compliance:matrix
```

Outputs land in `data/exports/` as PDF + HTML. When a lead has documented prior express written consent on file, set `Lead.priorWrittenConsent` (via `/manual-vm-queue` → **Grant consent** or DB) so automated drops are allowed even in restricted states; landline and suppression checks still apply.

Restricted-state leads appear in `/manual-vm-queue` until marked **Called** — they do not disappear after 24h like the daily-brief snapshot.

## HIPAA Considerations

Sobriety Select is a marketing vendor, not a covered entity or business associate. The SDR agent does not receive, store, or transmit Protected Health Information (PHI) about patients. All lead data in our database relates to facilities and their operators, not to any patient's treatment history. Maintain this boundary strictly: never ask a facility contact for patient-level data, and never store any such data if offered.

<!-- Sonia: update with any state-specific requirements (e.g., California CCPA implications for B2B outreach) as needed. -->
