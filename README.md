# Invoice OAuth starter

A minimal, production-shaped implementation of the "connections" layer for an
invoice-extraction SaaS: users connect their own Gmail and Microsoft accounts
via OAuth 2.0 + PKCE, refresh tokens are stored encrypted (AES-256-GCM), and a
token service mints short-lived access tokens for background work.

## What's included

```
db/schema.sql              users, connected_accounts, audit log
src/config.ts              env loading
src/crypto.ts              AES-256-GCM encryption, sealed cookies, PKCE helpers
src/providers.ts           Google + Microsoft endpoints, scopes, identity lookup
src/oauth.ts               generic authorize/exchange/refresh/revoke client
src/db.ts                  connection persistence (encrypt on write, decrypt on read)
src/tokenService.ts        getAccessToken(connectionId) — refresh, rotation, invalid_grant
src/connections.routes.ts  /connect/:provider, /callback/:provider, list, disconnect
src/providerApis.ts        Gmail search, Graph messages, OneDrive app-folder upload
src/index.ts               Express app with a tiny test UI
src/demoAuth.ts            stub auth (replace with Clerk/Auth0/your own)
```

Not included (next steps, marked with TODOs): job queue, Gmail `users.watch`
+ Pub/Sub push, Microsoft Graph change-notification subscriptions, invoice
parsing, KMS envelope encryption.

## Setup

### 1. Prerequisites
Node 20+, PostgreSQL 14+.

### 2. Google Cloud console (console.cloud.google.com)
1. Create a project → APIs & Services → enable **Gmail API**.
2. OAuth consent screen: External, add yourself as a test user.
   - Add scope `.../auth/gmail.readonly`.
   - Note: this is a *restricted* scope. In Testing mode refresh tokens
     expire after 7 days; production requires app verification + a CASA
     security assessment.
3. Credentials → Create OAuth client ID → **Web application**.
   - Authorized redirect URI: `http://localhost:3000/callback/google`
4. Copy client ID/secret into `.env`.

### 3. Azure portal (portal.azure.com)
1. Microsoft Entra ID → App registrations → New registration.
   - Supported account types: "Accounts in any organizational directory and
     personal Microsoft accounts" (multi-tenant + personal).
   - Redirect URI (type **Web**): `http://localhost:3000/callback/microsoft`
2. API permissions → Microsoft Graph → Delegated: `Mail.Read`,
   `Files.ReadWrite.AppFolder`, `openid`, `email`, `offline_access`.
3. Certificates & secrets → New client secret.
4. Copy application (client) ID and the secret into `.env`.

### 4. Run

```bash
cp .env.example .env          # fill in the values
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # -> MASTER_KEY_HEX
createdb invoice_app
npm install
npm run db:migrate
npm run dev
```

Open http://localhost:3000, click **Connect Gmail**, approve consent, then hit
"test API call" — it lists recent messages with attachments using a token
minted from your encrypted refresh token, exactly like a background worker would.

## Deploying to production

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full Railway/Render setup, env var
reference, migration step, and post-deploy smoke-test checklist.

Still open (not covered by the current hardening pass, tracked as follow-up):
replacing `demoAuth` with real session auth, moving `src/tokenService.ts`'s
in-process token cache to Redis with a per-connection lock for multi-instance
deployments, adding the queue + webhook layer (BullMQ/SQS; Gmail watch, Graph
subscriptions), and completing Google OAuth verification (+ CASA for
gmail.readonly) and Microsoft publisher verification before public launch.
