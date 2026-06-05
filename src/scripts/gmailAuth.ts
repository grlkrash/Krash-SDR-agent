// Run once: tsx src/scripts/gmailAuth.ts
// Then paste the printed refresh_token into GMAIL_REFRESH_TOKEN in .env
import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { exec } from 'node:child_process';
import { google } from 'googleapis';

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}`;
// Include both send (cold + followups) and readonly (replyWatcher in 6.3) so
// we only run this OAuth dance once per environment.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  // Discovery demo booking — creates Calendar events with Google Meet links.
  'https://www.googleapis.com/auth/calendar.events',
];

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
};

const openInBrowser = (url: string): void => {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {
    // Best effort — user can still copy the URL printed below.
  });
};

const waitForCode = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error !== null) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`OAuth error: ${error}`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (code === null) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing ?code parameter');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Auth complete. You can close this tab and return to the terminal.');
      server.close();
      resolve(code);
    });
    server.on('error', reject);
    server.listen(PORT);
  });

const client = new google.auth.OAuth2({
  clientId: requireEnv('GMAIL_CLIENT_ID'),
  clientSecret: requireEnv('GMAIL_CLIENT_SECRET'),
  redirectUri: REDIRECT_URI,
});

const authUrl = client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
});

console.log('\nOpening browser for Gmail OAuth consent...');
console.log(`If it doesn't open, visit:\n${authUrl}\n`);
openInBrowser(authUrl);

const code = await waitForCode();
const { tokens } = await client.getToken(code);

if (tokens.refresh_token === undefined || tokens.refresh_token === null) {
  throw new Error(
    'No refresh_token returned. Revoke prior consent at https://myaccount.google.com/permissions and re-run.',
  );
}

const refreshToken = tokens.refresh_token;
console.log('\nGMAIL_REFRESH_TOKEN=');
console.log(refreshToken);

const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const raw = fs.readFileSync(envPath, 'utf8');
  const line = `GMAIL_REFRESH_TOKEN=${refreshToken}`;
  const next = /^GMAIL_REFRESH_TOKEN=.*$/m.test(raw)
    ? raw.replace(/^GMAIL_REFRESH_TOKEN=.*$/m, line)
    : `${raw.trimEnd()}\n${line}\n`;
  fs.writeFileSync(envPath, next);
  console.log(`\nUpdated ${envPath} with new GMAIL_REFRESH_TOKEN.`);
} else {
  console.log('\nNo .env found — paste the token above into .env and Railway.');
}
