import type { ProviderConfig } from './providers.js';

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

export class OAuthError extends Error {
  constructor(
    public code: string,
    public description?: string,
  ) {
    super(`${code}${description ? `: ${description}` : ''}`);
  }
}

export function buildAuthorizeUrl(
  p: ProviderConfig,
  opts: { redirectUri: string; state: string; codeChallenge: string },
): string {
  const url = new URL(p.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: p.clientId,
    response_type: 'code',
    redirect_uri: opts.redirectUri,
    scope: p.scopes.join(' '),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    ...p.extraAuthParams,
  }).toString();
  return url.toString();
}

async function tokenRequest(p: ProviderConfig, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new OAuthError(
      String(json.error ?? `http_${res.status}`),
      json.error_description ? String(json.error_description) : undefined,
    );
  }
  return json as unknown as TokenResponse;
}

export function exchangeCode(
  p: ProviderConfig,
  opts: { code: string; redirectUri: string; codeVerifier: string },
): Promise<TokenResponse> {
  return tokenRequest(p, {
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: p.clientId,
    client_secret: p.clientSecret,
    code_verifier: opts.codeVerifier,
  });
}

export function refreshAccessToken(p: ProviderConfig, refreshToken: string): Promise<TokenResponse> {
  return tokenRequest(p, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: p.clientId,
    client_secret: p.clientSecret,
  });
}

/** Best-effort revocation at the provider (Google supports it; Microsoft
 *  consent removal happens via the user's account portal). */
export async function revokeAtProvider(p: ProviderConfig, refreshToken: string): Promise<void> {
  if (!p.revokeUrl) return;
  await fetch(p.revokeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken }),
  }).catch(() => undefined);
}
