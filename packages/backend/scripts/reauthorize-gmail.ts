/**
 * Re-authorize Gmail (mint a fresh OAuth refresh token)
 *
 * Background: the app authenticates to Gmail with a long-lived refresh token,
 * supplied as `GMAIL_TOKEN_BASE64` (base64 of a token.json) alongside
 * `GMAIL_CREDENTIALS_BASE64` (the OAuth client). See `utils/gmail-auth.ts`.
 * When that refresh token stops working, every Gmail call fails with
 * `invalid_grant` and BOTH directions of email die at once:
 *
 *   - inbound: the missed-message scanner and the poller can't read mail
 *     (you'll see "Missed Message Scanner Unhealthy … OAuth token invalid:
 *     invalid_grant" in Slack)
 *   - outbound: `core/email/outbound/send.ts` calls Gmail synchronously, so
 *     every send throws — agent replies, nudges, and the weekly mailing all
 *     stop silently
 *
 * Common causes of `invalid_grant`: the OAuth consent screen is still in
 * "Testing" (Google expires those refresh tokens after 7 DAYS — if so,
 * publish the app or you will be back here next week), access was revoked on
 * the Google account, the mailbox password changed, the client secret was
 * rotated, the requested scopes changed, or more than 50 refresh tokens were
 * issued for the same client+account (the oldest are silently revoked).
 *
 * This script performs the authorization-code flow against your EXISTING
 * OAuth client and prints a ready-to-paste `GMAIL_TOKEN_BASE64`. It does not
 * write to the database, Redis, or any deployment — the only side effect is
 * at Google (a new refresh token is issued).
 *
 * Usage:
 *   # Uses GMAIL_CREDENTIALS_BASE64 from the environment:
 *   npx tsx scripts/reauthorize-gmail.ts
 *
 *   # Or point at a credentials.json directly:
 *   npx tsx scripts/reauthorize-gmail.ts --credentials ./credentials.json
 *
 *   # Override the redirect URI (must be registered on the OAuth client):
 *   npx tsx scripts/reauthorize-gmail.ts --redirect-uri http://localhost:3000
 *
 *   # Override scopes (default: gmail.modify, which covers read + send + watch):
 *   npx tsx scripts/reauthorize-gmail.ts --scopes https://www.googleapis.com/auth/gmail.modify
 *
 * The redirect URI does NOT need to serve anything. After you approve the
 * consent screen Google redirects with `?code=…` in the address bar; a broken
 * page or 404 there is expected and harmless — copy the whole URL and paste it
 * back here. That way you don't have to register a new URI in Cloud Console.
 *
 * SECURITY: the output contains a live credential for the mailbox. Treat it
 * like a password — put it straight into your secret store. Don't paste it
 * into Slack, a PR, or an issue.
 */

import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

/** Least-privilege single scope covering messages.get, messages.send and users.watch. */
const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

interface OAuthClientConfig {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/**
 * Load the OAuth client config the app itself uses, so the new token is
 * issued to the same client. Mirrors `utils/gmail-auth.ts` resolution order:
 * env var first, then a file path.
 */
function loadClientConfig(): OAuthClientConfig {
  const path = arg('credentials') || process.env.MCP_GMAIL_CREDENTIALS_PATH;
  let raw: string;

  if (process.env.GMAIL_CREDENTIALS_BASE64 && !arg('credentials')) {
    raw = Buffer.from(process.env.GMAIL_CREDENTIALS_BASE64, 'base64').toString('utf-8');
  } else if (path) {
    raw = readFileSync(path, 'utf-8');
  } else {
    throw new Error(
      'No OAuth client config found. Set GMAIL_CREDENTIALS_BASE64 (as production does) ' +
        'or pass --credentials <path to credentials.json>.',
    );
  }

  const parsed = JSON.parse(raw) as { installed?: OAuthClientConfig; web?: OAuthClientConfig };
  const client = parsed.installed || parsed.web;
  if (!client?.client_id || !client?.client_secret) {
    throw new Error('credentials JSON must contain an "installed" or "web" client with id and secret.');
  }
  return client;
}

/** Accept either a bare code or the whole redirected URL pasted from the browser. */
function extractCode(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('No code supplied.');
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;

  const url = new URL(trimmed);
  const error = url.searchParams.get('error');
  if (error) {
    throw new Error(`Google returned an error instead of a code: ${error}`);
  }
  const code = url.searchParams.get('code');
  if (!code) {
    throw new Error('That URL has no ?code= parameter. Copy the full address bar after approving.');
  }
  return code;
}

async function main(): Promise<void> {
  const client = loadClientConfig();
  const redirectUri = arg('redirect-uri') || client.redirect_uris?.[0];
  if (!redirectUri) {
    throw new Error(
      'No redirect URI. The credentials JSON has none, so pass --redirect-uri <uri> ' +
        '(it must be registered on this OAuth client in Google Cloud Console).',
    );
  }
  const scopes = arg('scopes')?.split(',').map((s) => s.trim()) ?? DEFAULT_SCOPES;

  const oauth2Client = new OAuth2Client(client.client_id, client.client_secret, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    // offline is what produces a refresh token at all.
    access_type: 'offline',
    // Without prompt=consent Google omits refresh_token when the account has
    // already granted this client — which is exactly the case we're recovering
    // from, so it must be forced.
    prompt: 'consent',
    scope: scopes,
  });

  process.stdout.write(
    `\nClient ID:    ${client.client_id}\n` +
      `Redirect URI: ${redirectUri}\n` +
      `Scopes:       ${scopes.join(' ')}\n` +
      `\n1. Open this URL and approve it AS THE MAILBOX ACCOUNT the agent sends from:\n\n${authUrl}\n\n` +
      `2. You'll be redirected to ${redirectUri} — a 404 or error page there is fine.\n` +
      `3. Copy the FULL address-bar URL (or just the code= value) and paste it below.\n\n`,
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let code: string;
  try {
    code = extractCode(await rl.question('Pasted URL or code: '));
  } finally {
    rl.close();
  }

  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token. Revoke this app at ' +
        'https://myaccount.google.com/permissions and run this again — a re-grant ' +
        'from scratch always issues one.',
    );
  }

  // Prove the token actually works before anyone deploys it. `expiry` (not
  // `expiry_date`) is the field createOAuth2Client reads, so emit that name.
  oauth2Client.setCredentials(tokens);
  const profile = await google.gmail({ version: 'v1', auth: oauth2Client }).users.getProfile({
    userId: 'me',
  });

  const tokenJson = {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token ?? undefined,
    token_type: 'Bearer',
    expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : undefined,
  };
  const base64 = Buffer.from(JSON.stringify(tokenJson)).toString('base64');

  process.stdout.write(
    `\n✅ Verified against Gmail as: ${profile.data.emailAddress}\n` +
      `   (If that is not the agent's mailbox, STOP — you authorized the wrong account.)\n` +
      `\nSet this as GMAIL_TOKEN_BASE64 in the backend environment, then restart:\n\n${base64}\n\n` +
      `Treat that string as a password — it grants ongoing access to the mailbox.\n` +
      `Verify afterwards with GET /api/admin/gmail/status.\n\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`\nFailed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
