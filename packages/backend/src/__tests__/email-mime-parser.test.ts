/**
 * Regression tests for utils/email-mime-parser.ts (and the shared body
 * extraction used by ThreadFetchingService).
 *
 *   E3  — body extraction only looked at top-level parts, so a reply with
 *         an attachment (mixed → alternative) or an inline signature logo
 *         (related) reached the agent with an EMPTY body.
 *   E13 — the charset was read from `part.mimeType`, which Gmail always
 *         sends bare ("text/plain"), so every part decoded as UTF-8.
 *   S2/E14 — extractEmail took the FIRST <...> in the raw From header, so
 *         `"x <client@corp.com>" <attacker@evil.com>` parsed as the client;
 *         addresses were also not lowercased.
 *   L2  — `new Date(internalDate)` is always Invalid Date because Gmail
 *         sends internalDate as an epoch-ms STRING.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// thread-divergence (parseEmailAddresses) pulls in the DB + Slack modules.
jest.mock('../utils/database', () => ({ prisma: {} }));
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: { notifyThreadDivergence: jest.fn() },
}));

jest.mock('../utils/gmail-auth', () => ({
  // No credentials → ThreadFetchingService constructs without a Gmail client.
  loadGmailCredentials: jest.fn().mockReturnValue(null),
  createOAuth2Client: jest.fn(),
  acquireTokenRefreshLock: jest.fn(),
  releaseTokenRefreshLock: jest.fn(),
}));

import type { gmail_v1 } from 'googleapis';
import {
  parseEmailMessage,
  extractEmail,
  extractAllEmails,
  extractBodyFromPayload,
  extractDeliveryStatus,
  parseGmailInternalDate,
} from '../utils/email-mime-parser';
import { ThreadFetchingService } from '../services/thread-fetching.service';
import { parseEmailAddresses } from '../services/thread-divergence.service';

type Part = gmail_v1.Schema$MessagePart;

const b64 = (text: string | Buffer): string =>
  (typeof text === 'string' ? Buffer.from(text, 'utf-8') : text).toString('base64url');

function textPart(mimeType: 'text/plain' | 'text/html', text: string, charset = 'UTF-8'): Part {
  return {
    mimeType,
    filename: '',
    headers: [{ name: 'Content-Type', value: `${mimeType}; charset="${charset}"` }],
    body: { size: text.length, data: b64(text) },
  };
}

function container(mimeType: string, parts: Part[]): Part {
  return {
    mimeType,
    filename: '',
    headers: [{ name: 'Content-Type', value: `${mimeType}; boundary="b-${mimeType}"` }],
    body: { size: 0 },
    parts,
  };
}

function attachment(mimeType: string, filename: string, disposition = 'attachment'): Part {
  return {
    mimeType,
    filename,
    headers: [
      { name: 'Content-Type', value: `${mimeType}; name="${filename}"` },
      { name: 'Content-Disposition', value: `${disposition}; filename="${filename}"` },
    ],
    body: { size: 12345, attachmentId: 'ANGjdJ-attachment-id' },
  };
}

function message(payload: Part, headers: Record<string, string> = {}, extra: Partial<gmail_v1.Schema$Message> = {}): gmail_v1.Schema$Message {
  const allHeaders = {
    From: 'Jane Doe <jane.doe@example.com>',
    To: 'scheduler@spill.chat',
    Subject: 'Re: Your session',
    Date: 'Mon, 28 Sep 2026 10:00:00 +0000',
    ...headers,
  };
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    ...extra,
    payload: {
      ...payload,
      headers: [
        ...Object.entries(allHeaders).map(([name, value]) => ({ name, value })),
        ...(payload.headers ?? []),
      ],
    },
  };
}

const REPLY = 'Tuesday 3pm works for me.';

describe('body extraction walks the whole MIME tree (E3)', () => {
  it('reply with an attachment: mixed(alternative(text, html), pdf)', () => {
    const payload = container('multipart/mixed', [
      container('multipart/alternative', [
        textPart('text/plain', REPLY),
        textPart('text/html', `<div>${REPLY}</div>`),
      ]),
      attachment('application/pdf', 'notes.pdf'),
    ]);
    const parsed = parseEmailMessage(message(payload));
    expect(parsed?.body).toBe(REPLY);
  });

  it('inline signature logo: related(alternative(text, html), image)', () => {
    const payload = container('multipart/related', [
      container('multipart/alternative', [
        textPart('text/plain', `${REPLY}\n\n-- \nDr Sarah Jones`),
        textPart('text/html', `<p>${REPLY}</p><img src="cid:logo">`),
      ]),
      attachment('image/png', 'logo.png', 'inline'),
    ]);
    const parsed = parseEmailMessage(message(payload));
    expect(parsed?.body).toContain(REPLY);
    expect(parsed?.body).toContain('Dr Sarah Jones');
  });

  it('Outlook shape: alternative(text, related(html, image))', () => {
    const payload = container('multipart/alternative', [
      textPart('text/plain', REPLY),
      container('multipart/related', [
        textPart('text/html', `<p>${REPLY}</p>`),
        attachment('image/png', 'image001.png', 'inline'),
      ]),
    ]);
    expect(parseEmailMessage(message(payload))?.body).toBe(REPLY);
  });

  it('html-only reply with an inline image: related(html, image) → stripped html', () => {
    const payload = container('multipart/mixed', [
      container('multipart/related', [
        textPart('text/html', `<div><p>${REPLY}</p><p>Thanks &amp; best,<br>Sam</p></div>`),
        attachment('image/jpeg', 'sig.jpg', 'inline'),
      ]),
      attachment('application/pdf', 'form.pdf'),
    ]);
    const body = parseEmailMessage(message(payload))?.body;
    expect(body).toContain(REPLY);
    expect(body).toContain('Thanks & best,\nSam');
    expect(body).not.toMatch(/<[a-z]/i);
  });

  it('skips a text/plain ATTACHMENT and uses the html body instead', () => {
    const txtAttachment: Part = {
      ...textPart('text/plain', 'CONFIDENTIAL ATTACHMENT CONTENT'),
      filename: 'notes.txt',
      headers: [
        { name: 'Content-Type', value: 'text/plain; charset="UTF-8"; name="notes.txt"' },
        { name: 'Content-Disposition', value: 'attachment; filename="notes.txt"' },
      ],
    };
    const payload = container('multipart/mixed', [textPart('text/html', `<p>${REPLY}</p>`), txtAttachment]);
    expect(parseEmailMessage(message(payload))?.body).toBe(REPLY);
  });

  it('prefers text/plain in document order even when html comes first in the tree', () => {
    const payload = container('multipart/mixed', [
      container('multipart/alternative', [textPart('text/html', '<p>HTML version</p>')]),
      textPart('text/plain', 'Plain version'),
    ]);
    expect(extractBodyFromPayload(payload)).toEqual({ body: 'Plain version', source: 'text/plain' });
  });

  it('still handles a single-part text/plain payload', () => {
    const parsed = parseEmailMessage(message(textPart('text/plain', 'Hello &amp; welcome')));
    expect(parsed?.body).toBe('Hello & welcome');
  });

  it('still handles a single-part text/html payload', () => {
    const parsed = parseEmailMessage(message(textPart('text/html', '<p>Hi</p><p>there</p>')));
    expect(parsed?.body).toBe('Hi\n\nthere');
  });

  it('returns an empty body (source none) when there is no text part at all', () => {
    const payload = container('multipart/mixed', [attachment('application/pdf', 'only.pdf')]);
    expect(extractBodyFromPayload(payload)).toEqual({ body: '', source: 'none' });
    expect(parseEmailMessage(message(payload))?.body).toBe('');
  });

  it('ThreadFetchingService uses the same extraction for thread context', () => {
    const service = new ThreadFetchingService();
    const payload = container('multipart/mixed', [
      container('multipart/alternative', [
        textPart('text/plain', REPLY),
        textPart('text/html', `<div>${REPLY}</div>`),
      ]),
      attachment('application/pdf', 'notes.pdf'),
    ]);
    const parsed = (service as unknown as {
      parseGmailMessage: (m: gmail_v1.Schema$Message) => { body: string; from: string; date: Date } | null;
    }).parseGmailMessage(message(payload, { Date: '' }, { internalDate: '1790589600000' }));
    expect(parsed?.body).toBe(REPLY);
    expect(parsed?.from).toBe('jane.doe@example.com');
    expect(parsed?.date.getTime()).toBe(1790589600000);
  });
});

describe('charset comes from the part Content-Type header (E13)', () => {
  it('decodes windows-1252 smart quotes when mimeType is the bare type', () => {
    // “Tuesday” works — café  (0x93 / 0x94 are cp1252 curly quotes, 0xE9 is é)
    const bytes = Buffer.from([
      0x93, ...Buffer.from('Tuesday'), 0x94, ...Buffer.from(' works '), 0x96, ...Buffer.from(' caf'), 0xe9,
    ]);
    const part: Part = {
      mimeType: 'text/plain', // Gmail: bare type, no charset
      filename: '',
      headers: [{ name: 'Content-Type', value: 'text/plain; charset="windows-1252"' }],
      body: { size: bytes.length, data: b64(bytes) },
    };
    const payload = container('multipart/alternative', [part]);
    expect(parseEmailMessage(message(payload))?.body).toBe('“Tuesday” works – café');
  });

  it('decodes iso-8859-1 on a single-part payload', () => {
    const bytes = Buffer.from([...Buffer.from('Z'), 0xfc, ...Buffer.from('rich')]);
    const payload: Part = {
      mimeType: 'text/plain',
      headers: [{ name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1' }],
      body: { size: bytes.length, data: b64(bytes) },
    };
    expect(parseEmailMessage(message(payload))?.body).toBe('Zürich');
  });

  it('falls back to UTF-8 for an unknown charset label', () => {
    const payload: Part = {
      mimeType: 'text/plain',
      headers: [{ name: 'Content-Type', value: 'text/plain; charset=x-made-up' }],
      body: { data: b64('café') },
    };
    expect(parseEmailMessage(message(payload))?.body).toBe('café');
  });
});

describe('extractEmail — forged display names and normalisation (S2 / E14)', () => {
  it('ignores an address hidden in a quoted display name', () => {
    expect(extractEmail('"x <client@corp.com>" <attacker@evil.com>')).toBe('attacker@evil.com');
  });

  it('takes the last angle-addr when the display name is unquoted', () => {
    expect(extractEmail('x <client@corp.com> <attacker@evil.com>')).toBe('attacker@evil.com');
    expect(extractEmail('client@corp.com <attacker@evil.com>')).toBe('attacker@evil.com');
  });

  it('ignores addresses inside comments', () => {
    expect(extractEmail('(client@corp.com <client@corp.com>) <attacker@evil.com>')).toBe('attacker@evil.com');
    expect(extractEmail('attacker@evil.com (client@corp.com)')).toBe('attacker@evil.com');
  });

  it('handles escaped quotes inside the display name', () => {
    expect(extractEmail('"Ann \\"<client@corp.com>\\" Lee" <ann@evil.com>')).toBe('ann@evil.com');
  });

  it('lowercases and trims', () => {
    expect(extractEmail('Jane Doe <Jane.Doe@Example.COM>')).toBe('jane.doe@example.com');
    expect(extractEmail('  Client@Corp.com  ')).toBe('client@corp.com');
    expect(extractEmail('< Jane@Example.com >')).toBe('jane@example.com');
  });

  it('does not split a quoted display name containing a comma', () => {
    expect(extractEmail('"Smith, Jane" <jane@example.com>')).toBe('jane@example.com');
  });

  it('returns the first mailbox of an address list', () => {
    expect(extractEmail('"A" <a@x.com>, "B" <b@y.com>')).toBe('a@x.com');
    expect(extractEmail('a@x.com, b@y.com')).toBe('a@x.com');
  });

  it('parseEmailMessage exposes the real (lowercased) sender for a forged From', () => {
    const parsed = parseEmailMessage(
      message(textPart('text/plain', 'hi'), { From: '"Client <client@corp.com>" <Attacker@Evil.com>' }),
    );
    expect(parsed?.from).toBe('attacker@evil.com');
  });

  it('parseEmailMessage lowercases a mixed-case sender', () => {
    const parsed = parseEmailMessage(message(textPart('text/plain', 'hi'), { From: 'Jane <Jane.Doe@Example.com>' }));
    expect(parsed?.from).toBe('jane.doe@example.com');
  });
});

describe('internalDate handling (L2)', () => {
  it('parses Gmail\'s epoch-ms string', () => {
    expect(parseGmailInternalDate('1695897600000')).toBe(1695897600000);
    expect(new Date('1695897600000').getTime()).toBeNaN(); // why Number() is needed
  });

  it('returns null for missing or garbage values', () => {
    expect(parseGmailInternalDate(undefined)).toBeNull();
    expect(parseGmailInternalDate(null)).toBeNull();
    expect(parseGmailInternalDate('')).toBeNull();
    expect(parseGmailInternalDate('not-a-number')).toBeNull();
  });

  it('parseEmailMessage falls back to internalDate when there is no Date header', () => {
    const parsed = parseEmailMessage(
      message(textPart('text/plain', 'hi'), { Date: '' }, { internalDate: '1695897600000' }),
    );
    expect(parsed?.date.getTime()).toBe(1695897600000);
  });

  it('parseEmailMessage falls back to internalDate when the Date header is garbage', () => {
    const parsed = parseEmailMessage(
      message(textPart('text/plain', 'hi'), { Date: 'not a date' }, { internalDate: '1695897600000' }),
    );
    expect(parsed?.date.getTime()).toBe(1695897600000);
  });
});

describe('delivery-status report detection', () => {
  it('flags multipart/report; report-type=delivery-status and captures the status fields', () => {
    const payload: Part = {
      mimeType: 'multipart/report',
      headers: [{ name: 'Content-Type', value: 'multipart/report; report-type=delivery-status; boundary="x"' }],
      body: { size: 0 },
      parts: [
        textPart('text/plain', "Address not found. Your message wasn't delivered."),
        { mimeType: 'message/delivery-status', body: { data: b64('Action: failed\nStatus: 5.1.1') } },
        { mimeType: 'message/rfc822', body: { size: 0 }, parts: [] },
      ],
    };
    expect(extractDeliveryStatus(payload)).toEqual({
      isDeliveryStatusReport: true,
      deliveryStatus: 'Action: failed\nStatus: 5.1.1',
    });
    const parsed = parseEmailMessage(message(payload, { From: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' }));
    expect(parsed?.isDeliveryStatusReport).toBe(true);
    expect(parsed?.body).toContain('Address not found');
  });

  it('does NOT flag a read receipt (report-type=disposition-notification)', () => {
    const payload: Part = {
      mimeType: 'multipart/report',
      headers: [{ name: 'Content-Type', value: 'multipart/report; report-type=disposition-notification' }],
      body: { size: 0 },
      parts: [
        textPart('text/plain', 'Your message was read.'),
        { mimeType: 'message/disposition-notification', body: { data: b64('Disposition: displayed') } },
      ],
    };
    expect(extractDeliveryStatus(payload).isDeliveryStatusReport).toBe(false);
    expect(parseEmailMessage(message(payload))?.isDeliveryStatusReport).toBeUndefined();
  });

  it('does NOT flag an ordinary multipart reply', () => {
    const payload = container('multipart/alternative', [textPart('text/plain', REPLY)]);
    expect(extractDeliveryStatus(payload).isDeliveryStatusReport).toBe(false);
  });
});

describe('address extraction stays linear on hostile headers', () => {
  // The old unbounded /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g took
  // ~6.5s on a 100KB '@'-free Cc header.
  const hostile = 'a'.repeat(100_000);

  const time = (fn: () => void): number => {
    const start = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - start) / 1e6;
  };

  it('extractAllEmails (Cc parsing)', () => {
    expect(time(() => extractAllEmails(hostile))).toBeLessThan(500);
    expect(extractAllEmails('"A" <A@X.com>, b@y.co.uk, A@x.com')).toEqual(['a@x.com', 'b@y.co.uk']);
  });

  it('parseEmailAddresses (divergence Cc parsing)', () => {
    expect(time(() => parseEmailAddresses(hostile))).toBeLessThan(500);
  });

  it('extractEmail', () => {
    expect(time(() => extractEmail(hostile))).toBeLessThan(500);
    expect(time(() => extractEmail(`"${hostile}" <${hostile}>`))).toBeLessThan(500);
  });
});
