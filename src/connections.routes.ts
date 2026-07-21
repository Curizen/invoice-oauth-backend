import { Router, type Request, type Response } from 'express';
import { providers, type Provider } from './providers.js';
import { buildAuthorizeUrl, exchangeCode, revokeAtProvider } from './oauth.js';
import { pkcePair, randomState, seal, unseal } from './crypto.js';
import {
  upsertConnection, listConnections, getConnection, deleteConnection, audit,
  getInvoiceStore, setInvoiceStore,
} from './db.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { strictLimiter } from './middleware/rateLimit.js';

export const connections = Router();

connections.use(['/connect/:provider', '/callback/:provider'], strictLimiter);

interface OAuthTx {
  state: string;
  verifier: string;
  provider: Provider;
  userId: string;
  exp: number;
}

const TX_COOKIE = 'oauth_tx';

function isProvider(p: string): p is Provider {
  return p === 'google' || p === 'microsoft';
}

function redirectUri(provider: Provider): string {
  return `${config.appUrl}/callback/${provider}`;
}

// Step 1: user clicks "Connect Gmail" / "Connect Microsoft"
connections.get('/connect/:provider', (req: Request, res: Response) => {
  const provider = req.params.provider;
  if (!isProvider(provider)) return res.status(404).send('Unknown provider');
  const userId = req.userId!; // set by auth middleware

  const { verifier, challenge } = pkcePair();
  const state = randomState();

  // Bind state + verifier + user to the browser via an encrypted,
  // HttpOnly, short-lived cookie (server-side session store works too).
  const tx: OAuthTx = { state, verifier, provider, userId, exp: Date.now() + 10 * 60_000 };
  res.cookie(TX_COOKIE, seal(tx), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.appUrl.startsWith('https'),
    maxAge: 10 * 60_000,
  });

  res.redirect(
    buildAuthorizeUrl(providers[provider], {
      redirectUri: redirectUri(provider),
      state,
      codeChallenge: challenge,
    }),
  );
});

// Step 2: provider redirects back with ?code=...&state=...
connections.get('/callback/:provider', async (req: Request, res: Response) => {
  const provider = req.params.provider;
  if (!isProvider(provider)) return res.status(404).send('Unknown provider');

  const tx = unseal<OAuthTx>(String(req.cookies?.[TX_COOKIE] ?? ''));
  res.clearCookie(TX_COOKIE);

  const { code, state, error, error_description } = req.query as Record<string, string>;
  if (error) {
    return res.status(400).send(`Provider returned an error: ${error} ${error_description ?? ''}`);
  }
  if (!tx || tx.exp < Date.now() || tx.provider !== provider) {
    return res.status(400).send('OAuth session expired — please try connecting again.');
  }
  if (!state || state !== tx.state) {
    return res.status(400).send('State mismatch (possible CSRF) — request rejected.');
  }
  if (tx.userId !== req.userId) {
    // The browser session changed mid-flow; refuse to link across sessions.
    return res.status(400).send('Session changed during OAuth flow — please try again.');
  }

  try {
    const p = providers[provider];
    const tokens = await exchangeCode(p, {
      code,
      redirectUri: redirectUri(provider),
      codeVerifier: tx.verifier,
    });
    if (!tokens.refresh_token) {
      return res
        .status(400)
        .send('No refresh token returned. For Google, remove prior consent at myaccount.google.com/permissions and retry.');
    }

    // Resolve a STABLE account id (never key on email — emails change).
    const identity = await p.fetchIdentity(tokens.access_token);

    const conn = await upsertConnection({
      userId: tx.userId,
      provider,
      accountId: identity.accountId,
      email: identity.email,
      scopes: tokens.scope ? tokens.scope.split(' ') : p.scopes,
      refreshToken: tokens.refresh_token,
    });
    await audit(conn.id, 'connected', { email: identity.email });

    // TODO: enqueue initial backfill job + register Gmail watch / Graph subscription here.
    res.redirect('/app.html');
  } catch (err) {
    logger.error({ err }, 'OAuth callback failed');
    res.status(500).send('Failed to complete the connection. Please try again.');
  }
});

// List the current user's connections
connections.get('/connections', async (req: Request, res: Response) => {
  const rows = await listConnections(req.userId!);
  res.json(
    rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      email: r.provider_email,
      scopes: r.scopes,
      status: r.status,
    })),
  );
});

// Which OneDrive (Microsoft connection) all invoices are filed into.
connections.get('/settings/invoice-store', async (req: Request, res: Response) => {
  try {
    const connectionId = await getInvoiceStore(req.userId!);
    res.json({ connectionId });
  } catch (err) {
    logger.error({ err }, 'get invoice-store failed');
    res.status(500).json({ error: 'Failed to read invoice storage setting' });
  }
});

// Choose the storage OneDrive. Must be one of the user's Microsoft connections.
connections.put('/settings/invoice-store', async (req: Request, res: Response) => {
  try {
    const connectionId = (req.body as { connectionId?: string })?.connectionId;
    if (!connectionId) return res.status(400).json({ error: 'connectionId is required' });
    const ok = await setInvoiceStore(req.userId!, connectionId);
    if (!ok) {
      return res
        .status(400)
        .json({ error: 'Must be one of your connected Microsoft accounts' });
    }
    res.json({ connectionId });
  } catch (err) {
    logger.error({ err }, 'set invoice-store failed');
    res.status(500).json({ error: 'Failed to save invoice storage setting' });
  }
});

// Disconnect: revoke at the provider, then delete our ciphertext
connections.delete('/connections/:id', async (req: Request, res: Response) => {
  try {
    const conn = await getConnection(req.params.id);
    if (!conn || conn.user_id !== req.userId) return res.status(404).end();

    await revokeAtProvider(providers[conn.provider], conn.refreshToken);
    await audit(conn.id, 'revoked_by_user');
    await deleteConnection(conn.id, req.userId!);
    // TODO: cancel Gmail watch / Graph subscription + purge queued jobs for this connection.
    res.status(204).end();
  } catch (err) {
    logger.error({ err }, 'Disconnect failed');
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});
