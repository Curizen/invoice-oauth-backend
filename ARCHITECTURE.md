# Architecture & Flow Reference

A multi-user invoice-extraction backend. Users connect their own Gmail /
Microsoft mailboxes over OAuth 2.0 (PKCE); the service stores their refresh
tokens **encrypted**, mints short-lived access tokens on demand, and turns
invoice emails into structured rows + files in the user's OneDrive.

There are **two interchangeable pipelines** that do the actual invoice work.
Run exactly one at a time:

- **External (n8n)** — an n8n workflow calls this service's `/internal/*`
  endpoints to list connections and mint tokens, then does the mail/LLM/upload
  work itself. This is the default active pipeline.
- **In-process** — the `src/pipeline/*` scheduler does the same work inside
  this Node process. Enabled with `ENABLE_SYNC=true`. See the double-processing
  warning in [DEPLOYMENT.md](DEPLOYMENT.md).

---

## Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node 22, TypeScript (ESM, `NodeNext`) |
| HTTP | Express 4 |
| DB | Postgres (Supabase), `pg` pool |
| Auth (users) | Supabase Auth (JWT) → mapped to local `app_users` |
| Auth (machines) | `X-Internal-Key` shared secret on `/internal/*` |
| Crypto | AES-256-GCM for refresh tokens & sealed OAuth cookies |
| Logging | pino + pino-http (with redaction) |
| Hardening | helmet, express-rate-limit, graceful shutdown |
| LLM | OpenAI (`gpt-4o` by default) for field extraction |
| Deploy | Docker → Railway (primary) / Render (fallback) |

---

## Directory map

```
src/
  index.ts              Express app: middleware wiring, routes, startup, shutdown
  config.ts             Loads + validates all env vars (throws early on misconfig)
  logger.ts             pino logger with secret redaction
  healthz.ts            GET /healthz (DB ping + version)
  middleware/
    rateLimit.ts        strict / moderate / light rate limiters
  crypto.ts             AES-256-GCM encrypt/decrypt, sealed cookies, PKCE helpers
  providers.ts          Google + Microsoft endpoints, scopes, identity lookup
  oauth.ts              authorize URL / code exchange / refresh / revoke client
  db.ts                 pg pool + connection persistence (encrypt on write)
  tokenService.ts       getAccessToken(connectionId): refresh, rotate, cache
  supabaseAuth.ts       verifies Supabase JWT → sets req.userId (real auth)
  demoAuth.ts           stub auth for local dev (single demo user)
  connections.routes.ts /connect, /callback, list, disconnect
  internalApi.ts        /internal/connections, /internal/token (n8n contract)
  providerApis.ts       Gmail search / Graph messages / OneDrive upload (test route)
  scripts/migrate.ts    idempotent SQL migration runner (no psql dependency)
  pipeline/
    scheduler.ts        setInterval poller over active Microsoft connections
    graphMail.ts        Graph: list messages, list/download attachments, upload
    llm.ts              OpenAI prompt + JSON extraction/cleanup
    invoicePipeline.ts  orchestration: vendor → dedupe → invoice → anomaly → audit
db/
  schema.sql            app_users, connected_accounts, connection_audit_log (+RLS)
  migration_002_invoices.sql  multi-tenancy columns, dedupe index, sync-state table
public/
  login.html            Supabase auth UI (password + OTP verify + Google)
  app.html              dashboard: list/connect/test/disconnect connections
```

> **Note on tables:** `db/schema.sql` + `migration_002` create the *connection*
> tables and add columns to the *accounting* tables. The core accounting tables
> themselves (`invoices`, `vendors`, `audit_log`, `duplicate_log`, `anomaly_log`)
> pre-exist directly in Supabase and are **not** created by this repo.

---

## Flow 1 — Connecting a mailbox (OAuth + PKCE)

Browser routes in [connections.routes.ts](src/connections.routes.ts). Rate-limited to 20/min.

1. **`GET /connect/:provider`** — user clicks "Connect Gmail/Microsoft".
   - `supabaseAuth` has already set `req.userId`.
   - Generate a PKCE `verifier`/`challenge` (`pkcePair`) and a random `state`.
   - Build an **encrypted, HttpOnly, SameSite=Lax** cookie `oauth_tx`
     containing `{state, verifier, provider, userId, exp}` via `seal()`
     (AES-256-GCM). `secure` is on whenever `APP_URL` is https.
   - Redirect to the provider's authorize URL (`buildAuthorizeUrl`) with the
     `code_challenge` and `state`.
2. **User consents** at Google/Microsoft.
3. **`GET /callback/:provider?code=…&state=…`**
   - `unseal()` the `oauth_tx` cookie; immediately clear it.
   - Reject if: cookie missing/expired, provider mismatch, `state` mismatch
     (CSRF), or `userId` changed mid-flow (session swap).
   - `exchangeCode()` swaps the `code` + PKCE `verifier` for tokens. If no
     `refresh_token` comes back, tell the user to remove prior consent & retry.
   - `fetchIdentity()` resolves a **stable** provider account id (never keys on
     email — emails change).
   - `upsertConnection()` encrypts the refresh token (AAD =
     `userId:provider:accountId`) and stores it; status `active`.
   - Audit `connected`, redirect to `/app.html`.

**Disconnect** — `DELETE /connections/:id`: revoke at provider (best-effort),
audit `revoked_by_user`, delete the ciphertext row.

---

## Flow 2 — Minting an access token (the heart)

[tokenService.ts](src/tokenService.ts) · `getAccessToken(connectionId)`. Everything that
touches a provider API goes through this; **callers never see refresh tokens.**

1. In-process cache hit? (valid for >60s of remaining life) → return it.
2. Load the connection (`getConnection` decrypts the refresh token). If status
   ≠ `active`, throw ("user must reconnect").
3. `refreshAccessToken()` posts the refresh token to the provider.
4. If the provider returns a **new** refresh token (Microsoft always rotates),
   atomically `rotateRefreshToken()` + audit `refresh_token_rotated`.
5. Cache the access token with its `expires_in`, return it.
6. On `invalid_grant` (revoked/expired): set status `reauth_required`, audit
   `refresh_failed_invalid_grant`, evict cache, rethrow. **No retry loop** —
   the UI surfaces "reconnect needed".

---

## Flow 3 — Machine endpoints (the n8n contract)

[internalApi.ts](src/internalApi.ts). Mounted **before** user auth. Guarded by the
`X-Internal-Key` header; rate-limited 120/min. **Do not change this contract —
the n8n workflow depends on it.**

- **`GET /internal/connections?provider=`** → active connections
  (`id, user_id, provider, provider_email`).
- **`POST /internal/token`** `{connectionId}` → `{accessToken, tokenType:'Bearer'}`
  via `getAccessToken`. Returns `409` if the connection needs re-auth.

---

## Flow 4 — Invoice sync pipeline (in-process, `ENABLE_SYNC=true`)

[scheduler.ts](src/pipeline/scheduler.ts) → [invoicePipeline.ts](src/pipeline/invoicePipeline.ts).
The scheduler ticks every `SYNC_INTERVAL_SECONDS` (default 60), skips if a run
is still in progress, and processes each active **Microsoft** connection,
isolating per-connection failures.

### Per connection — `syncConnection`
1. **Cursor** — upsert `invoice_sync_state` and read `last_received_at`
   (the high-water mark; defaults to "1 day ago" for a new connection).
2. `listNewMessages()` — Graph `/me/messages` filtered
   `receivedDateTime gt <cursor> and hasAttachments eq true`, ordered ascending.
   *(The `receivedDateTime`-first ordering matters — it matches `$orderby` and
   avoids Graph's "restriction or sort order is too complex" error.)*
3. For each message → `processMessage` (below). After each message, advance the
   cursor to that message's `receivedDateTime` so one bad email can't wedge
   progress. On error, record `last_error` and stop this connection's run.

### Per attachment — `processMessage`
Only PDF/image attachments are considered. Each step's SQL is listed in order:

1. **Attachment dedupe** — `SELECT 1 FROM invoices WHERE connected_account_id
   = … AND email_message_id = … AND attachment_name = …`; skip if already seen.
2. **Download** the attachment; extract PDF text via `pdf-parse` (images pass
   empty text — the LLM then works from subject/body).
3. **LLM extract** — `extractInvoiceFields()` calls OpenAI and returns a clean
   `{vendor, invoice_number, amount, currency, invoice_date, due_date,
   category, description, tax_amount}` (with safe fallbacks).
4. **Duplicate check** (only if `invoice_number` present) — `SELECT id FROM
   invoices WHERE user_id=… AND vendor=… AND invoice_number=…`. If matched:
   - `INSERT INTO duplicate_log (… action='skipped', reason='vendor+invoice_number match')`
   - `INSERT INTO audit_log (… action='DUPLICATE_BLOCKED', actor_role='accountant')`
     with the matched invoice id in `notes`
   - connection-level `audit('invoice_duplicate_skipped')`
   - **skip** (runs *before* the vendor upsert so a dupe never pollutes stats).
5. **Currency normalize** — `normalizeAmount()` returns `{normalized, rate}`
   (fetches daily rates, caches 12h, fails open to `rate=1`).
   `exchange_date` = today only when a real rate was applied.
6. **Vendor upsert (VENDOR FIRST)** — `INSERT INTO vendors … ON CONFLICT (name)
   DO UPDATE SET invoice_count+1, total_spent += normalized, min/max via
   LEAST/GREATEST, last_invoice_date via GREATEST … RETURNING id, typical_amount`.
   `typical_amount` is the anomaly baseline (untouched on update).
7. **Upload** to OneDrive (`Invoices/<VendorClean>/<file>.pdf`, app folder scope).
8. **Invoice insert** — full column list (multi-tenancy + provenance + OneDrive
   ids + `exchange_rate`/`exchange_date`, `source='email'`). Only conflict
   target is the `invoices_message_dedupe` partial unique index →
   `ON CONFLICT (connected_account_id, email_message_id, attachment_name)
   WHERE email_message_id IS NOT NULL DO NOTHING RETURNING id`. `status` and
   `anomaly_level` fall back to DB defaults. If no row returned (race), skip.
9. **Anomaly check** — if `typical_amount > 0` and `|deviation| ≥ 50%`:
   `anomaly_level` = `high` (>100%) else `medium`.
   - `INSERT INTO anomaly_log (… anomaly_level, insight)`
   - `UPDATE invoices SET anomaly_level=…, anomaly_insight=…`
   - `INSERT INTO audit_log (… action='ANOMALY_FLAGGED')` with insight in notes.
10. **Audit** — `INSERT INTO audit_log (… action='INVOICE_SAVED',
    actor_name='Email Bot', actor_role='accountant', invoice_id, …)`; notes
    include subject + OneDrive URL.

> A flagged invoice therefore writes **two** `audit_log` rows: `ANOMALY_FLAGGED`
> then `INVOICE_SAVED`.

---

## Flow 5 — User auth (every browser/API request)

[supabaseAuth.ts](src/supabaseAuth.ts) (real) or [demoAuth.ts](src/demoAuth.ts) (dev).
The app picks `supabaseAuth` whenever `SUPABASE_URL` is set.

1. Read the JWT from `Authorization: Bearer …` or the `sb_token` cookie
   (cookie needed for the browser-redirect OAuth routes).
2. `supabase.auth.getUser(token)` verifies it (network call today — see
   Next Steps for local JWT verification).
3. Upsert into `app_users` keyed on `(auth_provider='supabase', auth_subject=sub)`
   and set `req.userId` to our internal id.

The frontend ([login.html](public/login.html)) supports password sign-in, **OTP email
verification** at signup (6-digit code → `verifyOtp`, with resend cooldown),
and Google OAuth. [app.html](public/app.html) manages the `sb_token` cookie and lists
connections.

---

## Startup, health, shutdown

[index.ts](src/index.ts) middleware order (top to bottom):
`trust proxy` → **helmet (CSP)** → **pino-http** → **light limiter** →
`json` + `cookie-parser` → `/healthz` → `/config` → static → `internalApi`
→ **user auth** → `connections` → `/test/:id`. Then `startScheduler()` if
`ENABLE_SYNC=true`.

- **`GET /healthz`** — `SELECT 1` + `{ok, uptime, version}`; used by the
  platform health check. No auth.
- **Graceful shutdown** — on `SIGTERM`/`SIGINT`: stop accepting connections,
  `pool.end()`, exit (10s force-exit fallback). Railway sends `SIGTERM` on deploy.

---

## Data model (essentials)

**Created by this repo** (`db/schema.sql`):
- `app_users` — internal users; `(auth_provider, auth_subject)` unique.
- `connected_accounts` — one row per linked mailbox; encrypted refresh token
  (`…_ciphertext/iv/tag` BYTEA), `status`, unique `(user_id, provider, account_id)`.
- `connection_audit_log` — connection lifecycle events.

**Added by `migration_002`** to pre-existing Supabase tables:
- `invoices`: `user_id, connected_account_id, email_subject, email_from,
  email_message_id, attachment_name` + `invoices_message_dedupe` partial unique
  index; `audit_log`: `user_id`; new `invoice_sync_state` (per-connection cursor).

**Pre-existing in Supabase** (documented, not created here): `invoices`,
`vendors`, `audit_log` (`action`/`actor_role` enums; known-good values
`INVOICE_SAVED`/`DUPLICATE_BLOCKED`/`ANOMALY_FLAGGED`, `accountant`),
`duplicate_log`, `anomaly_log` (`anomaly_level` enum, NOT NULL).

---

## Security model

- **Refresh tokens** encrypted at rest (AES-256-GCM); AAD binds each ciphertext
  to its account row so a copied ciphertext won't decrypt. `crypto.ts` is the
  only module that touches key material (swap for KMS in prod — see Next Steps).
- **OAuth state** carried in a sealed, HttpOnly cookie — no server session store.
- **Log redaction** — pino strips `authorization`, `cookie`, `x-internal-key`,
  `set-cookie`, and any `*token*`/`*secret*` field. Request bodies are never logged.
- **Rate limits** — 20/min on connect/callback, 120/min on `/internal/*`,
  300/min global backstop.
- **Supabase RLS** — connection tables have RLS enabled with no policies, so the
  anon/authenticated API keys are deny-by-default; the backend connects as
  `postgres` and bypasses RLS.
- **`/internal/*`** guarded only by a shared secret today — see the in-code note
  and Next Steps about IP-allowlisting.

---

## Config & environment

All env vars are validated at boot in [config.ts](src/config.ts) — the process refuses
to start on misconfiguration. In production it additionally requires `APP_URL`
to be https and `MASTER_KEY_HEX` to be a valid 64-hex-char key. Full table with
descriptions and which values are secrets: **[DEPLOYMENT.md](DEPLOYMENT.md) §2**.

---

## Local dev quick reference

```bash
cp .env.example .env      # fill in real values
npm install
npm run db:migrate        # runs schema.sql + migration_002 (idempotent, via tsx)
npm run dev               # tsx watch on src/index.ts
# build / prod
npm run build             # tsc -> dist/
node dist/index.js
npm run db:migrate:prod   # node dist/scripts/migrate.js (release step)
```

Deploy steps, provider redirect URIs, and the post-deploy smoke test live in
**[DEPLOYMENT.md](DEPLOYMENT.md)**. Planned improvements are in **[NEXT_STEPS.md](NEXT_STEPS.md)**.
