import { getAccessToken } from '../tokenService.js';
import type { GraphMessage, GraphAttachment } from './graphMail.js';

// Gmail counterpart of graphMail. Returns the SAME shapes (GraphMessage /
// GraphAttachment) so the pipeline can treat both providers uniformly — only
// the source module differs. OneDrive upload is NOT here: Gmail accounts have
// no OneDrive, so uploads always go through graphMail using the user's chosen
// Microsoft storage connection.

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function gmailGet<T>(connectionId: string, path: string): Promise<T> {
  const token = await getAccessToken(connectionId);
  const res = await fetch(`${GMAIL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Gmail GET ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

interface GmailHeader { name: string; value: string }
interface GmailPart {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  snippet?: string;
  internalDate?: string; // epoch ms as string
  payload?: { headers?: GmailHeader[]; parts?: GmailPart[]; filename?: string; mimeType?: string; body?: { attachmentId?: string; size?: number } };
}

function header(headers: GmailHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/** Parse a From header ("Sara K" <s@x.com> | s@x.com) into name + address. */
function parseFrom(value: string): { address: string; name: string } {
  const angle = value.match(/<([^>]+)>/);
  if (angle) {
    const name = value.slice(0, value.indexOf('<')).trim().replace(/^"|"$/g, '');
    return { address: angle[1].trim(), name };
  }
  return { address: value.trim(), name: '' };
}

/**
 * Messages with an attachment matching invoice keywords, received after the
 * cursor. Gmail's `after:` takes a unix timestamp (second-granular); the
 * per-attachment dedupe in the pipeline covers any boundary re-fetch. Sorted
 * ascending by received time so the pipeline advances its cursor correctly.
 */
export async function listNewMessages(
  connectionId: string,
  sinceIso: string,
): Promise<GraphMessage[]> {
  const afterEpoch = Math.floor(new Date(sinceIso).getTime() / 1000);
  const q = encodeURIComponent(`has:attachment (invoice OR receipt OR bill) after:${afterEpoch}`);
  const list = await gmailGet<{ messages?: { id: string }[] }>(
    connectionId,
    `/messages?q=${q}&maxResults=25`,
  );
  const ids = list.messages ?? [];

  const messages: GraphMessage[] = [];
  for (const { id } of ids) {
    const m = await gmailGet<GmailMessage>(
      connectionId,
      `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
    );
    const from = parseFrom(header(m.payload?.headers, 'From'));
    messages.push({
      id: m.id,
      subject: header(m.payload?.headers, 'Subject'),
      bodyPreview: m.snippet ?? '',
      receivedDateTime: new Date(Number(m.internalDate ?? Date.now())).toISOString(),
      hasAttachments: true,
      from: { emailAddress: { address: from.address, name: from.name } },
    });
  }
  messages.sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime));
  return messages;
}

/** Flatten the MIME tree and return the parts that are real file attachments. */
function collectAttachments(part: GmailPart | undefined, out: GraphAttachment[]): void {
  if (!part) return;
  if (part.filename && part.body?.attachmentId) {
    out.push({
      id: part.body.attachmentId,
      name: part.filename,
      contentType: part.mimeType ?? 'application/octet-stream',
      size: part.body.size ?? 0,
    });
  }
  for (const child of part.parts ?? []) collectAttachments(child, out);
}

export async function listAttachments(
  connectionId: string,
  messageId: string,
): Promise<GraphAttachment[]> {
  const m = await gmailGet<GmailMessage>(connectionId, `/messages/${messageId}?format=full`);
  const out: GraphAttachment[] = [];
  // The top-level payload can itself be an attachment (single-part message).
  collectAttachments(m.payload as GmailPart, out);
  return out;
}

export async function downloadAttachment(
  connectionId: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const data = await gmailGet<{ data?: string }>(
    connectionId,
    `/messages/${messageId}/attachments/${attachmentId}`,
  );
  if (!data.data) throw new Error('Gmail attachment has no data');
  return Buffer.from(data.data, 'base64url');
}
