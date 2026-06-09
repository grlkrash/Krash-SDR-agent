## Pre-launch
- [ ] SAMHSA API access form submitted
- [ ] Google Places billing enabled, daily quota set to $10 cap
- [ ] Serper subscription active (Developer tier)
- [ ] HubSpot Service Key configured with all required scopes
- [ ] HubSpot custom properties created (setupHubspotCustomProperties.ts)
- [ ] Gmail OAuth refresh token in Railway env (run gmailAuth.ts locally first)
- [ ] Twilio number purchased, US geo permissions enabled, env vars set (see `RAILWAY.md` §6 Twilio)
- [ ] ElevenLabs voice cloned — `ELEVENLABS_VOICE_ID=5cYnUBT6ZigM7aonjr3y` in Railway
- [ ] SPF, DKIM, DMARC on sobrietyselect.com confirmed via mxtoolbox
- [ ] Domain warmup started via Mailwarm (4 weeks before bulk)
- [ ] LegitScript status confirmed (or risk flagged)
- [ ] CAN-SPAM footer address confirmed with Mark
- [ ] Existing-client exclusion list pulled, loaded as Suppression rows
- [ ] /queue accessible at production URL
- [ ] /outbound — start outreach + log call 1 on a test lead
- [ ] /follow-ups — scheduled callback appears after setting follow-up date on a disposition
- [ ] Google Calendar scope verified (`npx tsx src/scripts/verifyCalendarScope.ts`) OR manual demo book path on /outbound works
- [ ] /copilot/ask returns answers from KB
- [ ] /prep-brief/:dealId works on a test deal
- [ ] /health all green
- [ ] First daily brief received in inbox

## Week 1 operational
- [ ] 5,000 leads in DB (FL/CA/TX)
- [ ] 200 enrichments with owner names ≥40%
- [ ] expectedProduct distributed: claimed/select/premium ratio sensible
- [ ] Signals populated: ≥30% of enrichments have at least one signal=true
- [ ] 30 cold drafts approved and sent
- [ ] Reply detection confirmed end-to-end
- [ ] First discovery call booked
- [ ] First prep brief used before a real call

## Week 4 review
- [ ] First closed-won deal
- [ ] Domain reputation green (Google Postmaster Tools)
- [ ] Reply rate ≥10%
- [ ] Approval rate ≥60%
- [ ] Personalization average ≥70% (with signals incorporated)
- [ ] Cost per booked discovery call calculated
- [ ] Commission-weighted scoring delivering better priorities than time-weighted

## Ongoing
- [ ] KB updated after every objection
- [ ] Golden tests updated quarterly
- [ ] Suppression list reconciled with HubSpot weekly
- [ ] DNC scrub monthly (once volume justifies)
