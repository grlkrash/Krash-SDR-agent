// Quick check: does GMAIL_REFRESH_TOKEN include calendar.events scope?
import 'dotenv/config';
import { google } from 'googleapis';

const client = new google.auth.OAuth2({
  clientId: process.env.GMAIL_CLIENT_ID,
  clientSecret: process.env.GMAIL_CLIENT_SECRET,
});
client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
const cal = google.calendar({ version: 'v3', auth: client });

try {
  await cal.events.list({ calendarId: 'primary', maxResults: 1 });
  console.log(JSON.stringify({
    ok: true,
    calendarId: 'primary',
    hint: 'Calendar scope is active — Book demo will send Google Meet invites.',
  }));
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  const apiDisabled = msg.includes('has not been used in project') || msg.includes('it is disabled');
  console.log(JSON.stringify({
    ok: false,
    error: msg,
    hint: apiDisabled
      ? 'Enable Google Calendar API in Google Cloud Console (free), wait 2 min, re-run verify. Or use manual booking on /outbound.'
      : 'Re-run: npx tsx src/scripts/gmailAuth.ts and update GMAIL_REFRESH_TOKEN',
  }));
  process.exitCode = 1;
}
