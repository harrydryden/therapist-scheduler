import { google } from 'googleapis';
import * as fs from 'fs';

async function checkRecentEmails() {
  // Load credentials from mcp-gmail directory
  const credPath = '/Users/h_dryden/Documents/Scheduler/mcp-gmail/credentials.json';
  const credentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(
    credentials.installed.client_id,
    credentials.installed.client_secret,
    credentials.installed.redirect_uris[0]
  );

  // Load tokens
  const tokensPath = '/Users/h_dryden/Documents/Scheduler/mcp-gmail/token.json';
  const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
  oauth2Client.setCredentials(tokens);

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Get messages from the last 2 hours
  const twoHoursAgo = Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000);

  const response = await gmail.users.messages.list({
    userId: 'me',
    q: `after:${twoHoursAgo}`,
    maxResults: 30
  });

  const messages = response.data.messages;
  if (!messages || messages.length === 0) {
    console.log('No messages in the last 2 hours');
    return;
  }

  console.log(`Found ${messages.length} messages in the last 2 hours\n`);

  for (const msg of messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id!,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date']
    });

    const headers = detail.data.payload?.headers || [];
    const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
    const to = headers.find(h => h.name === 'To')?.value || 'Unknown';
    const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
    const date = headers.find(h => h.name === 'Date')?.value || 'Unknown';
    const labels = detail.data.labelIds || [];

    // Check if it's incoming (not sent by us)
    const isIncoming = !labels.includes('SENT');
    const isUnread = labels.includes('UNREAD');

    const direction = isIncoming ? 'IN' : 'OUT';
    const readStatus = isUnread ? 'UNREAD' : 'READ';

    console.log(`[${direction}] [${readStatus}] ${date}`);
    if (isIncoming) {
      console.log(`  From: ${from}`);
    } else {
      console.log(`  To: ${to}`);
    }
    console.log(`  Subject: ${subject}`);
    console.log(`  Thread ID: ${detail.data.threadId}`);
    console.log(`  Message ID: ${msg.id}`);
    console.log('');
  }
}

checkRecentEmails().catch(console.error);
