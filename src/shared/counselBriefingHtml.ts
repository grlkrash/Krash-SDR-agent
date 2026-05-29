import { MATRIX_VERSION } from './voicemailStateMatrix.js';

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });

export const COUNSEL_BRIEFING_VERSION = '2026-05-29';

export const buildCounselBriefingHtml = (generatedAt: string): string => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Counsel briefing — Sobriety Select SDR voicemail program</title>
  <style>
    @page { margin: 0.55in; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 10px; color: #111; line-height: 1.4; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    h2 { font-size: 13px; margin: 16px 0 6px; page-break-after: avoid; }
    h3 { font-size: 11px; margin: 10px 0 4px; page-break-after: avoid; }
    .meta { color: #444; margin-bottom: 10px; font-size: 9.5px; }
    .disclaimer { background: #fef3c7; border: 1px solid #f59e0b; padding: 10px; border-radius: 6px;
      margin: 10px 0 14px; font-size: 9.5px; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0 12px; }
    th, td { border: 1px solid #cbd5e1; padding: 5px 6px; vertical-align: top; text-align: left; }
    th { background: #f1f5f9; font-size: 9px; }
    ul { margin: 4px 0 8px; padding-left: 18px; }
    li { margin-bottom: 3px; }
    .q { background: #f8fafc; border-left: 3px solid #64748b; padding: 6px 8px; margin: 6px 0; }
    .sig { margin-top: 28px; page-break-inside: avoid; }
    .sig-line { border-bottom: 1px solid #333; height: 22px; margin: 18px 0 4px; }
    code { font-size: 9px; background: #f1f5f9; padding: 1px 3px; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>Counsel briefing — Sobriety Select SDR voicemail program</h1>
  <p class="meta">
    Generated ${escapeHtml(generatedAt)} · Briefing v${escapeHtml(COUNSEL_BRIEFING_VERSION)}
    · Matrix v${escapeHtml(MATRIX_VERSION)} · Operator: Sonia / Sobriety Select
  </p>

  <div class="disclaimer">
    <strong>Not legal advice.</strong> This packet is an engineering summary for qualified counsel review.
    <strong>Policy update (May 29, 2026):</strong> We are restricting AI voicemail to opted-in customers only
    (renewal / reactivation + documented PEWC via email link). Cold-prospect AI vm is paused; operator places live calls manually.
    Attach the state matrix PDF (<code>npm run compliance:matrix</code>) and sample vm scripts from <code>/queue</code>.
  </div>

  <h2>1. Program summary</h2>
  <ul>
    <li><strong>Product:</strong> Sobriety Select — curated directory connecting families to treatment centers with open beds.</li>
    <li><strong>Outreach:</strong> Cold email sequence only (no AI vm on cold). Post-sale: renewal + reactivation emails include optional phone opt-in link; AI vm-1/vm-2 drafts only when <code>Lead.priorWrittenConsent = true</code>.</li>
    <li><strong>Call mechanics:</strong> Normal outbound Twilio calls that <em>ring</em>. Pre-rendered MP3 (ElevenLabs, artificial voice disclosed in script) plays only when AMD classifies a machine. Human answer bridges to operator cell. Not ringless voicemail.</li>
    <li><strong>Operator workflow:</strong> Live calls preferred for renewals/reactivation. AI vm auto-send is <strong>disabled</strong> (<code>VM_AI_AUTO_SEND</code> unset) until counsel sign-off; operator logs manual calls via <code>/queue</code> → “Left VM manually” (HubSpot call engagement).</li>
    <li><strong>Automated gates:</strong> PEWC required; landline-only (Twilio Lookups); restricted states FL, OK, WA, IN, MA, TX, CA unless PEWC; TCPA quiet hours 8 AM–9 PM local; FCC AI-voice disclosures injected in every script.</li>
  </ul>

  <h2>2. Executive summary — three verification items</h2>
  <table>
    <thead>
      <tr><th>Question</th><th>Research lean</th><th>Agent posture</th></tr>
    </thead>
    <tbody>
      <tr>
        <td><strong>B2B landline exemption scope</strong></td>
        <td>No blanket B2B exemption. 47 U.S.C. § 227(b)(1)(B) applies to <em>residential</em> lines only; § 227(b)(1)(A) blocks prerecorded/ATDS to <em>wireless</em> without prior express consent regardless of B2B intent. Carrier “landline” ≠ residential vs business use.</td>
        <td>Landline-only via Twilio Lookups. Federal auto path assumes non-residential business landline outside § 227(b)(1)(B). Counsel must confirm for treatment-center main lines.</td>
      </tr>
      <tr>
        <td><strong>Scripts = telemarketing / PEWC?</strong></td>
        <td>Likely telemarketing when content solicits commercial relationship. FCC (Feb 2024): AI/synthetic voice = artificial under TCPA.</td>
        <td><strong>PEWC required</strong> via click-through on renewal/reactivation emails (<code>/consent-phone</code>). Cold AI vm paused. Restricted states: FL, OK, WA, IN, MA, TX, CA.</td>
      </tr>
      <tr>
        <td><strong>Vm-2 landline re-check at send?</strong></td>
        <td>Yes — defense-in-depth. Wireless + prerecorded without consent is highest TCPA exposure under § 227(b)(1)(A).</td>
        <td><strong>Fixed:</strong> both vm-1 and vm-2 re-check <code>isLandline()</code> at send; non-landline → <code>sent-suppressed</code>.</td>
      </tr>
    </tbody>
  </table>

  <h2>3. Federal TCPA framework</h2>
  <h3>§ 227(b)(1)(A) — wireless / charged lines</h3>
  <p>Prohibits prerecorded voice or ATDS calls to cellular numbers without <strong>prior express consent</strong>. No B2B carveout. This is why the agent blocks mobile/VoIP/unknown line types.</p>
  <h3>§ 227(b)(1)(B) — residential landlines</h3>
  <p>Prohibits prerecorded voice to <strong>residential telephone lines</strong> without consent (subject to narrow FCC exemptions). True business landlines may fall outside (B); counsel should define how to classify treatment-center main numbers.</p>
  <h3>Telemarketing vs informational (47 C.F.R. § 64.1200)</h3>
  <p><strong>Telemarketing</strong> = encouraging purchase/rental/investment in goods or services. Vm scripts introduce Sobriety Select, describe the directory, and ask about census/intake/marketing — likely telemarketing, not purely informational. Informational residential calls without consent are capped at 3 per 30 days (post-TRACED Act); two-touch sequence within 7 days exceeds that if classified as informational.</p>

  <h2>4. Sample script structure (code-enforced disclosures + LLM middle)</h2>
  <ul>
    <li><strong>Prefix (deterministic):</strong> automated, pre-recorded, artificial voice; Sobriety Select; sales call; renewal or reactivation context.</li>
    <li><strong>Middle (LLM):</strong> facility-specific observation; warm CSM tone; callback number.</li>
    <li><strong>Suffix (deterministic):</strong> opt out via operator phone or reply “stop” to email.</li>
  </ul>
  <p>Vm-2: second touch ~3 business days after vm-1 dropped; same disclosure wrapper.</p>

  <h2>5. State overlay (manual-only without PEWC)</h2>
  <table>
    <thead><tr><th>State</th><th>Basis</th><th>Notes</th></tr></thead>
    <tbody>
      <tr><td>FL</td><td>Fla. Stat. § 501.059 (FTSA)</td><td>PEWC for automated/prerecorded telephonic sales calls.</td></tr>
      <tr><td>OK</td><td>15 Okla. Stat. § 775C.1 (OTSA)</td><td>PEWC required.</td></tr>
      <tr><td>WA</td><td>RCW 80.36.400</td><td>ADAD restrictions for commercial solicitation.</td></tr>
      <tr><td>IN</td><td>IC 24-5-14</td><td>Prerecorded message restrictions.</td></tr>
      <tr><td>MA</td><td>940 CMR 19</td><td>Telemarketing registration + artificial voice restrictions.</td></tr>
      <tr><td>TX</td><td>Tex. Bus. &amp; Com. Code Ch. 304</td><td>Strict automated/prerecorded voice rules; high penalties.</td></tr>
      <tr><td>CA</td><td>Cal. Bus. &amp; Prof. Code §§ 17511–17539</td><td>Mini-TCPA + privacy overlap on artificial voice marketing.</td></tr>
    </tbody>
  </table>
  <p>Full 50-state matrix: run <code>npm run compliance:matrix</code>. Restricted-state leads: <code>/manual-vm-queue</code>.</p>

  <h2>6. Agent safeguards (current)</h2>
  <ul>
    <li>PEWC click-through on renewal/reactivation emails → <code>Lead.priorWrittenConsent</code>.</li>
    <li>AI vm auto-send disabled until <code>VM_AI_AUTO_SEND=true</code> + counsel sign-off.</li>
    <li>Landline check at draft + send-time re-check.</li>
    <li>State law + TCPA quiet hours (8 AM–9 PM local).</li>
    <li>Artificial-voice + opt-out disclosures in every MP3 (code-enforced).</li>
    <li>Manual call logging → HubSpot call engagement from <code>/queue</code>.</li>
    <li>Suppression table + <code>doNotContact</code>; CAN-SPAM unsubscribe on emails.</li>
  </ul>

  <h2>7. Open questions for counsel</h2>
  <div class="q"><strong>Q1.</strong> Is email click-through PEWC on <code>/consent-phone</code> sufficient for automated artificial-voice vm to the facility line on file?</div>
  <div class="q"><strong>Q2.</strong> May we enable <code>VM_AI_AUTO_SEND</code> for opted-in renewal/reactivation accounts only, with live calls as default?</div>
  <div class="q"><strong>Q3.</strong> Confirm cold-prospect AI vm remains off-limits under current FCC AI-voice interpretation.</div>
  <div class="q"><strong>Q4.</strong> Sign-off on restricted-state list (FL, OK, WA, IN, MA, TX, CA) and landline-only gate.</div>
  <div class="q"><strong>Q5.</strong> Max daily automated call volume if/when <code>VM_AI_AUTO_SEND</code> is enabled post-sign-off.</div>

  <h2>8. References</h2>
  <ul>
    <li>47 U.S.C. § 227 — TCPA</li>
    <li>47 C.F.R. § 64.1200 — telemarketing / delivery restrictions</li>
    <li>FCC Order FCC-20-186 (TRACED Act exemptions, 3-call/30-day residential informational cap)</li>
    <li><em>Bradford v. Sovereign Pest Control</em>, 5th Cir. (Feb. 25, 2026) — prior express consent may suffice vs FCC PEWC rule</li>
    <li>Fla. Stat. § 501.059 · RCW 80.36.400 · Agent KB: <code>kb/compliance/can-spam-tcpa.md</code></li>
  </ul>

  <div class="sig">
    <h2>Counsel sign-off</h2>
    <p>I have reviewed the Sobriety Select SDR voicemail program summary, state matrix, and sample scripts.</p>
    <div class="sig-line"></div>
    <p>Signature &nbsp;&nbsp; Date</p>
    <div class="sig-line"></div>
    <p>Firm / jurisdiction</p>
    <p>Approved for automated AI vm (opted-in customers only): ☐ Yes &nbsp; ☐ No &nbsp; ☐ Yes with conditions: _______________</p>
    <p>Max daily automated call volume approved: _______________</p>
  </div>
</body>
</html>`;
