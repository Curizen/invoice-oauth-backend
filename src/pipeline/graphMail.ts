import { getAccessToken } from '../tokenService.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

async function graphGet<T>(connectionId: string, path: string): Promise<T> {
  const token = await getAccessToken(connectionId);
  const res = await fetch(`${GRAPH}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Graph GET ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface GraphMessage {
  id: string;
  subject: string;
  bodyPreview: string;
  receivedDateTime: string;
  hasAttachments: boolean;
  from?: { emailAddress?: { address?: string; name?: string } };
}

/** Port of the Outlook trigger: messages with attachments since the cursor. */
export async function listNewMessages(
  connectionId: string,
  sinceIso: string,
): Promise<GraphMessage[]> {
  const filter = encodeURIComponent(
    `receivedDateTime gt ${sinceIso} and hasAttachments eq true`,
  );
  const data = await graphGet<{ value: GraphMessage[] }>(
    connectionId,
    `/me/messages?$filter=${filter}&$orderby=receivedDateTime asc&$top=25` +
      `&$select=id,subject,bodyPreview,receivedDateTime,hasAttachments,from`,
  );
  return data.value;
}

export interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

export async function listAttachments(
  connectionId: string,
  messageId: string,
): Promise<GraphAttachment[]> {
  const data = await graphGet<{ value: GraphAttachment[] }>(
    connectionId,
    `/me/messages/${messageId}/attachments?$select=id,name,contentType,size`,
  );
  return data.value;
}

export async function downloadAttachment(
  connectionId: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const data = await graphGet<{ contentBytes?: string }>(
    connectionId,
    `/me/messages/${messageId}/attachments/${attachmentId}`,
  );
  if (!data.contentBytes) throw new Error('Attachment has no contentBytes (not a fileAttachment)');
  return Buffer.from(data.contentBytes, 'base64');
}

/**
 * Upload into the app's OneDrive folder. NOTE: intentionally `special/approot`
 * (the folder users consented to via Files.ReadWrite.AppFolder), not
 * `/drive/root:` like the n8n node used — with the least-privilege scope the
 * old root path would be rejected. Files land in Apps/<your app>/Invoices/...
 * Parent folders are created automatically by the path-based PUT.
 */
export async function uploadToOneDrive(
  connectionId: string,
  relativePath: string, // e.g. "Invoices/Amazon/INV-123_Amazon_2026-07-01.pdf"
  content: Buffer,
  contentType: string,
): Promise<{ webUrl?: string; id: string }> {
  if (content.length > 4 * 1024 * 1024) {
    return uploadLargeToOneDrive(connectionId, relativePath, content);
  }
  const token = await getAccessToken(connectionId);
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`${GRAPH}/me/drive/special/approot:/${encoded}:/content`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body: new Uint8Array(content),
  });
  if (!res.ok) throw new Error(`OneDrive upload: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ webUrl?: string; id: string }>;
}

/** Upload session for files over 4 MB. */
async function uploadLargeToOneDrive(
  connectionId: string,
  relativePath: string,
  content: Buffer,
): Promise<{ webUrl?: string; id: string }> {
  const token = await getAccessToken(connectionId);
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
  const sessionRes = await fetch(
    `${GRAPH}/me/drive/special/approot:/${encoded}:/createUploadSession`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }),
    },
  );
  if (!sessionRes.ok) throw new Error(`Upload session: ${sessionRes.status}`);
  const { uploadUrl } = (await sessionRes.json()) as { uploadUrl: string };

  const chunkSize = 5 * 1024 * 1024;
  let result: { webUrl?: string; id: string } | null = null;
  for (let offset = 0; offset < content.length; offset += chunkSize) {
    const chunk = content.subarray(offset, Math.min(offset + chunkSize, content.length));
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${offset}-${offset + chunk.length - 1}/${content.length}`,
      },
      body: new Uint8Array(chunk),
    });
    if (!res.ok && res.status !== 202) throw new Error(`Chunk upload: ${res.status}`);
    if (res.status === 200 || res.status === 201) {
      result = (await res.json()) as { webUrl?: string; id: string };
    }
  }
  if (!result) throw new Error('Upload session finished without a final item');
  return result;
}
