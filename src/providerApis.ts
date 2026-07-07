import { getAccessToken } from './tokenService.js';

/** List recent Gmail messages that have attachments (invoice candidates). */
export async function listGmailInvoiceCandidates(connectionId: string) {
  const token = await getAccessToken(connectionId);
  const q = encodeURIComponent('has:attachment (invoice OR receipt OR bill)');
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=10`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Gmail list failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** List recent Outlook messages with attachments via Microsoft Graph. */
export async function listOutlookInvoiceCandidates(connectionId: string) {
  const token = await getAccessToken(connectionId);
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?$filter=hasAttachments eq true&$top=10&$select=id,subject,from,receivedDateTime`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Graph messages failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Upload a file into the app's own OneDrive folder (Files.ReadWrite.AppFolder).
 * Files land under "Apps/<your app name>/" — no access to the rest of the drive.
 * For files > 4 MB, switch to an upload session (createUploadSession).
 */
export async function uploadInvoiceToOneDrive(
  connectionId: string,
  filename: string,
  content: Buffer,
  contentType = 'application/pdf',
) {
  const token = await getAccessToken(connectionId);
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${encodeURIComponent(filename)}:/content`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body: new Uint8Array(content),
    },
  );
  if (!res.ok) throw new Error(`OneDrive upload failed: ${res.status} ${await res.text()}`);
  return res.json();
}
