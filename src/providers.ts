import { config } from './config.js';

export type Provider = 'google' | 'microsoft';

export interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  scopes: string[];
  /** Extra query params for the authorize redirect. */
  extraAuthParams: Record<string, string>;
  /** Fetch a stable account id + email using a fresh access token. */
  fetchIdentity(accessToken: string): Promise<{ accountId: string; email: string }>;
}

export const providers: Record<Provider, ProviderConfig> = {
  google: {
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    // Least privilege: read-only Gmail + send (for emailing reports from the
    // user's own mailbox). NOTE: both gmail.readonly and gmail.send are Google
    // "restricted" scopes — production requires OAuth verification + a CASA
    // security assessment. While your app is in "Testing" mode, refresh tokens
    // expire after 7 days. Adding a scope requires users to reconnect to consent.
    scopes: [
      'openid',
      'email',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ],
    extraAuthParams: {
      access_type: 'offline',        // required to receive a refresh token
      prompt: 'consent',             // re-issue refresh token on reconnect
      include_granted_scopes: 'true', // enables incremental auth later
    },
    async fetchIdentity(accessToken) {
      const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Google userinfo failed: ${res.status}`);
      const u = (await res.json()) as { sub: string; email: string };
      return { accountId: u.sub, email: u.email };
    },
  },

  microsoft: {
    clientId: config.microsoft.clientId,
    clientSecret: config.microsoft.clientSecret,
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    // offline_access is what yields a refresh token on the Microsoft side.
    // Files.ReadWrite.AppFolder confines OneDrive access to your app's own
    // folder instead of the user's whole drive.
    scopes: [
      'openid',
      'email',
      'offline_access',
      'https://graph.microsoft.com/User.Read',
      'https://graph.microsoft.com/Mail.Read',
      'https://graph.microsoft.com/Mail.Send',
      'https://graph.microsoft.com/Files.ReadWrite.AppFolder',
    ],
    extraAuthParams: {},
    async fetchIdentity(accessToken) {
      const res = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Graph /me failed: ${res.status}`);
      const u = (await res.json()) as {
        id: string;
        mail?: string;
        userPrincipalName?: string;
      };
      return { accountId: u.id, email: u.mail ?? u.userPrincipalName ?? '' };
    },
  },
};
