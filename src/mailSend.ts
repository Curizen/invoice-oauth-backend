import { getAccessToken } from './tokenService.js';
import type { Provider } from './providers.js';

// Send an HTML email FROM the user's connected mailbox. Microsoft uses Graph
// /me/sendMail (needs Mail.Send); Google uses Gmail messages.send (needs
// gmail.send). Both require the scope to have been granted — if the connection
// predates the scope, the send 403s and the user must reconnect.

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
}

async function sendViaGraph(connectionId: string, mail: OutgoingMail): Promise<void> {
  const token = await getAccessToken(connectionId);
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: mail.subject,
        body: { contentType: 'HTML', content: mail.html },
        toRecipients: [{ emailAddress: { address: mail.to } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) throw new Error(`Graph sendMail ${res.status}: ${await res.text()}`);
}

async function sendViaGmail(connectionId: string, mail: OutgoingMail): Promise<void> {
  const token = await getAccessToken(connectionId);
  // Build a minimal RFC 5322 message, then base64url-encode for the API.
  const mime =
    `To: ${mail.to}\r\n` +
    `Subject: ${mail.subject}\r\n` +
    'MIME-Version: 1.0\r\n' +
    'Content-Type: text/html; charset="UTF-8"\r\n\r\n' +
    mail.html;
  const raw = Buffer.from(mime, 'utf8').toString('base64url');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail send ${res.status}: ${await res.text()}`);
}

export async function sendMailViaConnection(
  connectionId: string,
  provider: Provider,
  mail: OutgoingMail,
): Promise<void> {
  if (provider === 'microsoft') return sendViaGraph(connectionId, mail);
  return sendViaGmail(connectionId, mail);
}
