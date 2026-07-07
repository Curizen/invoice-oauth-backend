import { providers } from './providers.js';
import { refreshAccessToken, OAuthError } from './oauth.js';
import { getConnection, rotateRefreshToken, setConnectionStatus, audit } from './db.js';

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// Simple in-process cache. For multiple server instances, move this to
// Redis (SET key value EX <ttl>) so instances don't each refresh.
const cache = new Map<string, CachedToken>();

/**
 * Returns a valid access token for a connection, refreshing if needed.
 * Workers call ONLY this — they never see refresh tokens.
 */
export async function getAccessToken(connectionId: string): Promise<string> {
  const cached = cache.get(connectionId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const conn = await getConnection(connectionId);
  if (!conn) throw new Error(`Unknown connection ${connectionId}`);
  if (conn.status !== 'active') {
    throw new Error(`Connection ${connectionId} is ${conn.status}; user must reconnect`);
  }

  const provider = providers[conn.provider];
  try {
    const tokens = await refreshAccessToken(provider, conn.refreshToken);

    // Microsoft rotates refresh tokens; Google occasionally reissues.
    // Whenever a new one arrives, atomically replace the stored token.
    if (tokens.refresh_token && tokens.refresh_token !== conn.refreshToken) {
      await rotateRefreshToken(connectionId, tokens.refresh_token);
      await audit(connectionId, 'refresh_token_rotated');
    }

    cache.set(connectionId, {
      accessToken: tokens.access_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    });
    return tokens.access_token;
  } catch (err) {
    if (err instanceof OAuthError && err.code === 'invalid_grant') {
      // Token was revoked or expired. Do NOT retry in a loop — flag the
      // connection and surface "reconnect needed" in the UI.
      await setConnectionStatus(connectionId, 'reauth_required', err.message);
      await audit(connectionId, 'refresh_failed_invalid_grant');
      cache.delete(connectionId);
    }
    throw err;
  }
}
