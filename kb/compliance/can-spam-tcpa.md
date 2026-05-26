# Compliance Reference — CAN-SPAM, TCPA, and HIPAA Basics

## Overview

Sobriety Select outreach operates under three primary compliance frameworks: CAN-SPAM (commercial email), TCPA (telephone and voicemail), and HIPAA (incidental to the addiction treatment space). This document is a working reference — not legal advice. Sonia should confirm current obligations with counsel annually and before any practice change.

## CAN-SPAM Requirements

All commercial emails sent through the SDR agent must include: (1) an accurate "From" display name and address (`sonia@sobrietyselect.com`), (2) a non-deceptive subject line — no fabricated urgency, no misleading personalization, (3) a physical mailing address for Sobriety Select in the email footer, and (4) a functional unsubscribe mechanism. The unsubscribe link is handled by `src/routes/unsubscribe.ts` which writes to the Suppression table and sets `Lead.doNotContact = true`. Processing time must be within 10 business days; our system processes unsubscribes immediately on click.

## TCPA and Voicemail Drop Rules

Voicemail drops to mobile numbers require prior express consent under the TCPA as interpreted post-2023 rulings. The SDR agent's voicemail drops are targeted at business phone lines (the facility's main number pulled from SAMHSA or Google Places), which are generally landlines or business VoIP lines not covered by the residential-mobile TCPA provisions. Before expanding voicemail campaigns to any mobile-direct numbers, confirm consent basis. Do not call numbers on the National Do Not Call Registry for consumer-facing outreach.

## HIPAA Considerations

Sobriety Select is a marketing vendor, not a covered entity or business associate. The SDR agent does not receive, store, or transmit Protected Health Information (PHI) about patients. All lead data in our database relates to facilities and their operators, not to any patient's treatment history. Maintain this boundary strictly: never ask a facility contact for patient-level data, and never store any such data if offered.

<!-- Sonia: update with any state-specific requirements (e.g., California CCPA implications for B2B outreach) as needed. -->
