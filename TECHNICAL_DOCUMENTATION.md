# Curizen Portal — Technical Documentation

A single-user financial back-office web application. The owner connects their own
Gmail and Microsoft (Outlook/OneDrive) accounts over OAuth 2.0; the service then:

- **Watches connected mailboxes** for invoice emails, extracts structured fields
  with an LLM, files the original document into the user's OneDrive, and saves
  a row into Postgres (Supabase).
- Accepts **manual invoice uploads** (PDF/image) and **voice/chat dictation** of
  invoices through a conversational assistant.
- Tracks **subscriptions**, **employees** (contracts, leave, bonuses, salary
  history), and produces **financial reports** and **anomaly alerts** emailed
  from the user's own mailbox.

This document explains the tech stack, the architecture, every subsystem, the
database schema, the HTTP API, the security model, and the folder structure.

---

## 1. Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 22, TypeScript (ESM, `NodeNext` module resolution) |
| Web framework | Express 4 |
| Database | Postgres (hosted on Supabase), accessed with the `pg` pool — no ORM |
| User auth | Supabase Auth (JWT) mapped to a local `app_users` row; single-user allowlist |
| Machine auth | `X-Internal-Key` shared secret on `/internal/*` (the n8n contract) |
| Crypto | Node `crypto` — AES-256-GCM for refresh tokens at rest and sealed OAuth cookies |
| LLM | OpenAI — `gpt-4o` for extraction and the chat assistant, `whisper-1` for speech-to-text; Claude (via n8n) for contract extraction |
| Workflow engine | n8n — optional webhook workflows for currency, duplicates, vendor intel, contracts |
| PDF parsing | `pdf-parse` v1 (imported via `pdf-parse/lib/pdf-parse.js` to dodge its CJS debug side effect) |
| Logging | pino + pino-http, with secret redaction |
| Hardening | helmet (CSP), express-rate-limit, graceful shutdown |
| Frontend | Static HTML + vanilla JS pages served by Express (no build step); Supabase JS loaded from esm.sh |
| Dev tooling | `tsx` for dev/watch and scripts, `tsc` for production builds, `node --test` for unit tests |
| Deploy | Docker → Railway (primary) / Render (fallback); see [DEPLOYMENT.md](DEPLOYMENT.md) |

---

## 2. High-level architecture

```
                        ┌──────────────────────────────────────────────┐
                        │                Browser (static pages)        │
                        │  login.html  app.html  voice.html  ...       │
                        └───────┬──────────────────────────────────────┘
                                │  Supabase JWT (Authorization header or sb_token cookie)
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Express app (src/index.ts)                          │
│                                                                              │
│  helmet CSP → pino-http → rate limit → json(30mb) → cookies                  │
│  /healthz  /config  static  ──► /internal/* (X-Internal-Key, NO user auth)   │
│                                        │                                     │
│  supabaseAuth (JWT → req.userId) ──────┼──► user routes:                     │
│    connections  voice  uploads  subscriptions  reports  employees            │
│                                                                              │
│  ENABLE_SYNC=true ──► pipeline/scheduler ──► pipeline/invoicePipeline        │
└──────┬───────────────────────┬───────────────────────┬───────────────────────┘
       │                       │                       │
       ▼                       ▼                       ▼
  Postgres (Supabase)    Google / Microsoft       OpenAI  +  n8n webhooks
  invoices, vendors,     OAuth token endpoints,   (extraction, chat,      
  employees, subs, ...   Gmail API, MS Graph      whisper, Claude via n8n)
                         (mail read/send,
                          OneDrive upload)
```

### Two interchangeable invoice pipelines

The mailbox-watching work can run in one of two places — **run exactly one**:

1. **External (n8n)** — an n8n workflow polls, and calls this service's
   `/internal/*` endpoints only to list connections and mint access tokens. It
   does the mail/LLM/upload work itself. Controlled entirely from n8n.
2. **In-process** — [src/pipeline/scheduler.ts](src/pipeline/scheduler.ts) does the same
   work inside this Node process on a `setInterval` loop. Enabled with
   `ENABLE_SYNC=true`. Running both at once double-processes every mailbox
   (see the warning in [DEPLOYMENT.md](DEPLOYMENT.md)).

Independent of which pipeline is active, four **optional n8n webhook
workflows** enhance individual steps and *fail open* to an inline fallback when
unset or unreachable (see §6.5).

---

## 3. Folder structure

```
invoice-oauth-starter/
├── package.json                 Scripts + deps (see §12 for the scripts)
├── tsconfig.json                TypeScript config (ESM / NodeNext, outDir dist/)
├── .env.example                 Documented template for every env var
├── ARCHITECTURE.md              Original architecture/flow reference
├── DEPLOYMENT.md                Deploy steps, env table, redirect URIs, smoke test
├── NEXT_STEPS.md                Planned improvements / known tradeoffs
├── TECHNICAL_DOCUMENTATION.md   This document
│
├── db/                          SQL, run in order by src/scripts/migrate.ts
│   ├── schema.sql                     app_users, connected_accounts, connection_audit_log (+RLS)
│   ├── migration_002_invoices.sql     multi-tenancy cols on invoices/audit_log, dedupe index,
│   │                                  invoice_sync_state (per-connection cursor)
│   ├── migration_003_fk_ondelete.sql  invoices FK → ON DELETE SET NULL (disconnect keeps invoices)
│   ├── migration_004_invoice_store.sql app_users.invoice_store_connection_id (OneDrive target)
│   ├── migration_005_subscriptions.sql subscriptions table
│   ├── migration_006_employees.sql    employees + contracts/leaves/bonuses/salary_history (+RLS)
│   └── migration_007_contract_type.sql employees.contract_type (fixed | indefinite)
│
├── n8n/
│   └── contract-extractor.workflow.json  Exported n8n workflow (Claude contract extraction)
│
├── public/                      Static frontend — plain HTML/JS, no build step
│   ├── login.html               Supabase auth: password sign-in, OTP signup verify, Google
│   ├── app.html                 Dashboard: connections, invoice-storage picker, anomalies
│   ├── voice.html               Voice/chat invoice assistant (MediaRecorder → base64)
│   ├── reports.html             Monthly/quarterly/yearly report view + "email me this"
│   ├── subscriptions.html       Subscriptions tracker UI
│   ├── employees.html           Employee list, alerts, add-manually / add-from-contract
│   ├── employee.html            Single-employee detail: contract, leave, bonuses, salary
│   ├── sidebar.js               Shared nav sidebar injected into every page
│   └── portal.css               Shared styles
│
└── src/
    ├── index.ts                 Express wiring: middleware order, routes, startup, shutdown
    ├── config.ts                Loads + validates ALL env vars; refuses to boot on misconfig
    ├── logger.ts                pino logger with secret redaction
    ├── healthz.ts               GET /healthz (DB ping + uptime + version)
    ├── crypto.ts                AES-256-GCM encrypt/decrypt, sealed cookies, PKCE helpers
    ├── providers.ts             Google + Microsoft endpoints, scopes, identity lookup
    ├── oauth.ts                 Authorize-URL builder, code exchange, refresh, revoke
    ├── db.ts                    pg pool + connection persistence (encrypt-on-write),
    │                            invoice-store getter/setter, connection audit helper
    ├── tokenService.ts          getAccessToken(connectionId): cache → refresh → rotate
    ├── supabaseAuth.ts          Verifies Supabase JWT → upserts app_users → req.userId
    ├── demoAuth.ts              Dev-only stub auth (single demo user)
    ├── internalApi.ts           /internal/connections + /internal/token (n8n contract)
    ├── providerApis.ts          Gmail/Graph "list invoice candidates" (smoke-test route)
    ├── mailSend.ts              Send HTML mail FROM a connected mailbox (Graph sendMail / Gmail send)
    ├── anomalyAlert.ts          Fire-and-forget anomaly email to the user's own mailbox
    ├── reports.ts               Pure report builder (period math, aggregation, HTML email body)
    ├── employeeAlerts.ts        Pure alert logic (contract expiry / probation / no contract)
    ├── employeeAlerts.test.ts   Unit tests for the alert logic (node --test)
    │
    ├── connections.routes.ts    /connect, /callback, /connections, /settings/invoice-store
    ├── voice.routes.ts          POST /voice-invoice → assistant turn
    ├── uploads.routes.ts        POST /upload-invoice → manual invoice ingestion
    ├── subscriptions.routes.ts  CRUD for subscriptions
    ├── reports.routes.ts        GET /reports, GET /anomalies, POST /reports/send
    ├── employees.routes.ts      Employees CRUD + contracts + leaves + bonuses + alerts
    │
    ├── middleware/
    │   └── rateLimit.ts         strict (20/min) / moderate (120/min) / light (300/min) limiters
    │
    ├── pipeline/                Invoice-processing engine (in-process pipeline + shared helpers)
    │   ├── scheduler.ts         setInterval poller over active connections (bounded concurrency)
    │   ├── invoicePipeline.ts   Orchestration: cursor → messages → attachments → extract → save
    │   ├── graphMail.ts         MS Graph: list messages/attachments, download, OneDrive upload
    │   ├── gmailMail.ts         Gmail equivalent with the same list/download interface
    │   ├── llm.ts               OpenAI extraction (text + GPT-4o vision for images)
    │   ├── currency.ts          Base-currency normalization (n8n Frankfurter or inline, fails open)
    │   ├── duplicateCheck.ts    n8n "Smart Duplicate Detection" client (fails open → inline match)
    │   ├── vendorIntel.ts       n8n "Vendor Intelligence" anomaly client (fails open → inline %)
    │   ├── contractExtract.ts   pdf-parse + n8n Claude webhook for employment contracts
    │   ├── uploadInvoice.ts     Manual-upload ingestion (source='upload')
    │   ├── manualInvoice.ts     File-less invoice save for the assistant (source='voice')
    │   └── voiceAssistant.ts    Conversational agent: Whisper + GPT-4o tool-calling + memory
    │
    └── scripts/
        ├── migrate.ts           Idempotent SQL runner over db/*.sql (no psql dependency)
        ├── seedSingleUser.ts    Creates THE single allowed Supabase user (service-role key)
        └── _col.ts              One-off column inspection helper
```

---

## 4. Request lifecycle & middleware order

[src/index.ts](src/index.ts) wires middleware strictly in this order (it matters):

1. `app.set('trust proxy', 1)` — Railway/Render sit behind a reverse proxy;
   needed for secure cookies and for `req.ip` (rate limiting) to be correct.
2. **helmet** with an explicit CSP: scripts only from self/inline/esm.sh
   (the pages import Supabase JS from esm.sh and use inline scripts),
   `connect-src` includes the Supabase URL, `media-src` allows `blob:` so
   recorded voice notes can play back.
3. **pino-http** request logging (with redaction — see §10).
4. **light rate limiter** — 300 req/min global backstop.
5. `express.json({ limit: '30mb' })` — raised so a base64 voice note or a
   20 MB invoice/contract (~27 MB in base64) fits.
6. `cookie-parser`.
7. Unauthenticated endpoints: `GET /healthz`, `GET /config` (hands the browser
   the Supabase URL + anon key), static files from `public/`, `/` → `/app.html`.
8. **`internalApi`** — mounted *before* user auth; guarded by `X-Internal-Key`.
9. **User auth** — `supabaseAuth` when `SUPABASE_URL` is set, otherwise
   `demoAuth` (dev stub). Sets `req.userId`; everything below is per-user.
10. Feature routers: `connections`, `voice`, `uploads`, `subscriptions`,
    `reports`, `employees`, plus `GET /test/:connectionId` (smoke test that
    lists invoice-candidate emails using the stored token).
11. If `ENABLE_SYNC=true` → `startScheduler()`.

**Shutdown:** on `SIGTERM`/`SIGINT` the server stops accepting connections,
drains, closes the pg pool, and force-exits after 10 s if closing hangs.
Railway sends `SIGTERM` on every deploy.

---

## 5. Authentication & authorization

### 5.1 User auth (Supabase, single-user)

[src/supabaseAuth.ts](src/supabaseAuth.ts):

1. Reads the JWT from `Authorization: Bearer …` or the `sb_token` cookie (the
   cookie exists because browser-redirect OAuth routes can't send headers).
2. Verifies it with `supabase.auth.getUser(token)` (network call).
3. Upserts the identity into `app_users` keyed on
   `(auth_provider='supabase', auth_subject=sub)` and sets `req.userId` to the
   internal UUID. All queries below filter by `user_id = req.userId`.

The app is deliberately **single-user**: only the account created by
`npm run db:seed-user` (which uses the Supabase service-role key, never read at
app runtime) can log in. [public/login.html](public/login.html) supports password
sign-in, 6-digit OTP email verification at signup, and Google OAuth.

For local dev without Supabase, [src/demoAuth.ts](src/demoAuth.ts) stubs a single
demo user.

### 5.2 Machine auth (the n8n contract)

[src/internalApi.ts](src/internalApi.ts) — mounted before user auth, guarded by the
`X-Internal-Key` header, rate-limited 120/min. **This contract must not change;
the external n8n workflow depends on it:**

- `GET /internal/connections?provider=` → active connections
  (`id, user_id, provider, provider_email`).
- `POST /internal/token` `{connectionId}` → `{accessToken, tokenType:'Bearer'}`.
  Returns `409` when the connection needs re-auth.

### 5.3 Mailbox OAuth (PKCE) — connecting an account

[src/connections.routes.ts](src/connections.routes.ts), rate-limited 20/min:

1. **`GET /connect/:provider`** — generates a PKCE verifier/challenge and a
   random `state`, seals `{state, verifier, provider, userId, exp}` into an
   encrypted, HttpOnly, SameSite=Lax `oauth_tx` cookie (AES-256-GCM via
   `seal()` in [src/crypto.ts](src/crypto.ts)), then redirects to the provider's
   authorize URL. No server-side session store.
2. **`GET /callback/:provider`** — unseals and immediately clears the cookie;
   rejects on expiry, provider mismatch, `state` mismatch (CSRF), or a changed
   `userId` (session swap). Exchanges the code + verifier for tokens
   ([src/oauth.ts](src/oauth.ts)); `fetchIdentity()` resolves a **stable provider
   account id** (never keyed on email — emails change);
   `upsertConnection()` encrypts the refresh token and stores it with
   status `active`; audits `connected`; redirects to `/app.html`.
3. **`DELETE /connections/:id`** — best-effort revoke at the provider, audit
   `revoked_by_user`, delete the row. Thanks to `migration_003`, invoices
   extracted from that mailbox survive (their `connected_account_id` goes NULL).

### 5.4 Access-token minting

[src/tokenService.ts](src/tokenService.ts) · `getAccessToken(connectionId)` — every
provider API call in the codebase goes through this; **callers never see
refresh tokens**:

1. In-process cache hit (>60 s of life left) → return.
2. Load + decrypt the connection; throw if status ≠ `active`.
3. POST the refresh token to the provider.
4. If a new refresh token comes back (Microsoft always rotates), atomically
   `rotateRefreshToken()` + audit.
5. Cache with `expires_in`, return.
6. On `invalid_grant`: set status `reauth_required`, audit, evict cache,
   rethrow. No retry loop — the UI surfaces "reconnect needed".

### 5.5 Refresh-token encryption

[src/crypto.ts](src/crypto.ts) is the only module that touches key material
(`MASTER_KEY_HEX`, 32 bytes). Each refresh token is encrypted with
AES-256-GCM using AAD = `userId:provider:providerAccountId`, so a ciphertext
copied onto another row will not decrypt. Ciphertext/IV/tag are stored as
separate BYTEA columns with a key-version column for future rotation.
Production intent: replace raw env key with KMS envelope encryption.

---

## 6. Invoice ingestion

Invoices enter the system three ways — **email sync**, **manual upload**, and
**voice/chat dictation**. All three converge on the same DB writes (vendor
upsert → invoices insert → audit_log) and the same shared helpers (currency,
duplicate check, anomaly check), differing only in `source`
(`'email' | 'upload' | 'voice'`) and whether a file lands in OneDrive.

### 6.1 Central OneDrive invoice store

Every extracted document — regardless of which mailbox it arrived in — is filed
into **one OneDrive** the user picks in the dashboard. It is stored as
`app_users.invoice_store_connection_id` (migration_004) and must point at one
of the user's **Microsoft** connections (enforced in a single SQL statement in
`setInvoiceStore`, [src/db.ts](src/db.ts)). If that account is disconnected the
pointer clears (`ON DELETE SET NULL`) and the user must pick another.
Managed via `GET/PUT /settings/invoice-store`.

Files go to `Invoices/<VendorClean>/<invoiceNumber>_<VendorClean>_<date>.pdf`
under the app-folder scope.

### 6.2 Email sync (in-process pipeline)

[src/pipeline/scheduler.ts](src/pipeline/scheduler.ts) ticks every
`SYNC_INTERVAL_SECONDS` (default 60), skips if the previous tick is still
running, and processes **all active connections — Gmail and Outlook** — with
bounded parallelism (`SYNC_CONCURRENCY`, default 3), isolating per-connection
failures. The provider difference is abstracted: `graphMail.ts` and
`gmailMail.ts` expose the same `listNewMessages / listAttachments /
downloadAttachment` shape, so [invoicePipeline.ts](src/pipeline/invoicePipeline.ts)
is provider-agnostic.

Per connection (`syncConnection`):

1. **Cursor** — upsert `invoice_sync_state`, read `last_received_at`
   (high-water mark; defaults to "1 day ago" for a new connection).
2. List messages newer than the cursor with attachments
   (Graph: `receivedDateTime gt <cursor> and hasAttachments eq true`, ordered
   ascending — the `receivedDateTime`-first filter order matters to avoid
   Graph's "restriction or sort order is too complex" error).
3. For each message → `processMessage`. After each message, advance the cursor
   to that message's timestamp so one bad email can't wedge progress. On error,
   record `last_error` and stop this connection's run.

Per attachment (`processMessage`):

1. Skip non-PDF/image attachments.
2. **Attachment dedupe** — skip if `(connected_account_id, email_message_id,
   attachment_name)` already exists in `invoices`.
3. Download; PDFs get text via `pdf-parse` (images pass empty text — the LLM
   then works from the email subject/body).
4. **LLM extraction** ([src/pipeline/llm.ts](src/pipeline/llm.ts)) → clean
   `{vendor, invoice_number, amount, currency, invoice_date, due_date,
   category, description, tax_amount}` with safe fallbacks.
5. **Duplicate check** — n8n Smart Duplicate Detection when configured, else
   inline exact `(user, vendor, invoice_number)` match. A blocked duplicate
   writes `duplicate_log` + an `audit_log` row (`DUPLICATE_BLOCKED`) and skips
   *before* the vendor upsert so a dupe never pollutes vendor stats.
6. **Currency normalization** ([currency.ts](src/pipeline/currency.ts)) —
   `normalizeForSave` converts to `BASE_CURRENCY`; see §6.5.
7. **Vendor upsert (vendor first)** — `INSERT … ON CONFLICT (name) DO UPDATE`
   bumping `invoice_count`, `total_spent`, min/max, `last_invoice_date`.
   `typical_amount` (the anomaly baseline) is deliberately untouched on update.
8. **OneDrive upload** to the store connection (§6.1).
9. **Invoice insert** — full multi-tenancy + provenance + OneDrive ids +
   exchange columns, `source='email'`; conflict target is only the
   `invoices_message_dedupe` partial unique index (`DO NOTHING` → race-safe).
10. **Anomaly check** — n8n Vendor Intelligence when configured, else the
    inline rule: if `typical_amount > 0` and deviation ≥ 50 % →
    `medium` (or `high` over 100 %). A flagged invoice writes `anomaly_log`,
    updates the invoice row, writes an `ANOMALY_FLAGGED` audit row, **and
    triggers an email alert** (§8.2).
11. **Audit** — `INVOICE_SAVED` row (actor "Email Bot", role `accountant`)
    with subject + OneDrive URL in the notes.

### 6.3 Manual upload

`POST /upload-invoice` ([src/uploads.routes.ts](src/uploads.routes.ts)) takes a
base64 PDF/image (max 20 MB, 413 otherwise; 400 if no invoice store is chosen).
[uploadInvoice.ts](src/pipeline/uploadInvoice.ts) mirrors the email pipeline's
writes: PDFs go through pdf-parse + text LLM; **images go through GPT-4o
vision** (`extractInvoiceFromImage`); then the same duplicate check → currency
→ vendor upsert → OneDrive upload → insert (`source='upload'`) → anomaly →
audit chain. Returns `{status: 'saved' | 'duplicate', …, anomaly}`.

### 6.4 Voice / chat assistant

`POST /voice-invoice` ([src/voice.routes.ts](src/voice.routes.ts)) accepts
`{sessionId, text?  | audioBase64 + audioMime}`. The user's id and display name
are injected **server-side** so the browser can never dictate whose books an
invoice lands in.

[voiceAssistant.ts](src/pipeline/voiceAssistant.ts) is an in-repo replacement for
the old n8n "Voice Invoice" workflow — one conversational agent that can both
take dictation *and* answer questions about existing invoices:

- **Transcription** — audio is sent to OpenAI `whisper-1`; language pinned to
  English (auto-detect misread short accented clips).
- **Conversation memory** — in-process LRU `Map` keyed
  `userId:sessionId` (max 500 sessions, 24 retained turns). Single-instance
  only by design.
- **Tool-calling loop** (max 4 rounds) against `gpt-4o` with two tools:
  - `query_invoices` — read-only, parameterized search over *the user's own*
    invoices (vendor ILIKE, category, date/amount ranges, ordering, limit ≤ 25)
    plus an aggregate count/total, so the model answers with real numbers
    instead of guessing.
  - `save_invoice` — as soon as vendor + amount are known, saves via
    [manualInvoice.ts](src/pipeline/manualInvoice.ts): same currency
    normalization and vendor upsert, `source='voice'`, no file/OneDrive.
- Response: `{reply, intent: ADD_INVOICE | QUERY_INVOICES | CHAT, transcript,
  invoice}`.

### 6.5 Optional n8n enhancement webhooks (all fail open)

| Webhook (env var) | Purpose | Fallback when unset/unreachable |
|---|---|---|
| `N8N_NORMALIZE_WEBHOOK_URL` | Historical FX rates (Frankfurter) on the invoice date | Inline daily-rate converter (open.er-api.com, 12 h cache), fails open to rate 1:1 |
| `N8N_DUPLICATE_CHECK_WEBHOOK_URL` | LLM fuzzy duplicate match against vendor history | Inline exact `vendor + invoice_number` match |
| `N8N_VENDOR_INTEL_WEBHOOK_URL` | LLM anomaly analysis vs. vendor profile (3-tier + insight). Must run **before** the vendor upsert (it soft-touches vendor rows) | Inline `typical_amount` deviation-% rule |
| `N8N_CONTRACT_WEBHOOK_URL` | Claude extraction of employment-contract fields | No extraction — contract stored, user fills the fields manually |

The exported contract-extractor workflow lives in
[n8n/contract-extractor.workflow.json](n8n/contract-extractor.workflow.json).

---

## 7. Employees module

[src/employees.routes.ts](src/employees.routes.ts) + `migration_006/007`. Employee
records are rows owned by the app user (no employee logins). Features:

- **CRUD** with per-field validation; every route re-checks row ownership
  (`user_id = req.userId`).
- **Contract types** — `fixed` (has `contract_end`) or `indefinite`
  (end date forced NULL by definition; migration_007 backfilled the rule
  "start but no end = indefinite").
- **Contract PDFs** — stored as BYTEA in `employee_contracts` (always
  downloadable, independent of OneDrive), together with the raw Claude
  `extracted` JSON for audit. Latest row per employee is "the contract".
  Two flows:
  - *Per-employee upload* (`POST /employees/:id/contract`) — PDF is stored
    immediately; extracted fields are only **returned for review**, applied
    to the employee only when the user confirms via `PATCH`.
  - *One-shot create* (`POST /employees/from-contract`) — upload a contract,
    extract, and create the employee in one transaction. Nothing is created
    when extraction fails or finds no employee name (junk rows are worse
    than a retry).
- **Salary history** — any salary change (and the initial salary) is logged to
  `employee_salary_history` in the same transaction as the update
  (`SELECT … FOR UPDATE` guards the read-compare-write).
- **Leave & bonuses** — vacation/sick entries share one shape
  (`kind`, date, days, note); bonuses are date + amount + note.
- **Alerts** (`GET /employees/alerts`) — pure logic in
  [src/employeeAlerts.ts](src/employeeAlerts.ts), kept free of DB/Express so it is
  unit-testable with a fixed "today" ([employeeAlerts.test.ts](src/employeeAlerts.test.ts)):
  contract expired / expiring within 60 days, probation ending within 14 days,
  no contract uploaded — sorted most-urgent first.

---

## 8. Reports, anomalies & outgoing mail

### 8.1 Reports

[src/reports.ts](src/reports.ts) computes, per user and period
(`monthly | quarterly | yearly` — always the most recently **completed**
period): total spend, invoice count, % change vs. the prior period, top-10
vendors, and a category breakdown, all over `normalized_amount` in
`BASE_CURRENCY`. `reportHtml()` renders the styled HTML email body.
Routes ([reports.routes.ts](src/reports.routes.ts)):

- `GET /reports?period=` — JSON for the UI.
- `GET /anomalies` — latest 20 flagged anomalies (joined to invoices) for the
  dashboard panel.
- `POST /reports/send {period, connectionId}` — emails the report **from the
  user's own connected mailbox to itself** via [mailSend.ts](src/mailSend.ts).
  A 403/scope error maps to a friendly "reconnect to grant send permission"
  message (connections created before the send scope was added lack it).

### 8.2 Outgoing mail & anomaly alerts

[src/mailSend.ts](src/mailSend.ts) sends HTML mail from a connected account:
Microsoft via Graph `/me/sendMail` (needs `Mail.Send`), Google via Gmail
`messages.send` (needs `gmail.send`), building a minimal RFC 5322 message.

[src/anomalyAlert.ts](src/anomalyAlert.ts) emails the user whenever an invoice is
flagged (from any ingestion path). It picks the user's first active connection,
self-sends, and is **fire-and-forget** — a failed alert never fails the
invoice save.

---

## 9. Database schema

The app connects as `postgres` (bypasses RLS). All app tables have RLS enabled
with **no policies** (plus explicit REVOKEs on the newer tables), so Supabase's
anon/authenticated API roles are deny-by-default and the only path to data is
this backend.

### Created by this repo

| Table | Purpose |
|---|---|
| `app_users` | Internal users; unique `(auth_provider, auth_subject)`; `invoice_store_connection_id` → the OneDrive target connection |
| `connected_accounts` | One row per linked mailbox: provider ids/email/scopes/status + encrypted refresh token (`…_ciphertext/iv/tag` BYTEA, key version); unique `(user_id, provider, provider_account_id)` |
| `connection_audit_log` | Connection lifecycle events (connected, rotated, revoked, refresh failures) |
| `invoice_sync_state` | Per-connection sync cursor (`last_received_at`, `last_error`) |
| `subscriptions` | Recurring subscriptions: name, amount, currency, `started_on`, status `active|cancelled` |
| `employees` | Employee record incl. salary, contract dates, `contract_type`, probation, allowances, status |
| `employee_contracts` | Contract PDF bytes (BYTEA) + Claude-extracted JSONB + upload timestamp |
| `employee_leaves` | Vacation/sick entries (`kind`, date, days > 0, note) |
| `employee_bonuses` | Bonus log (date, amount ≥ 0, note) |
| `employee_salary_history` | One row per salary change; `old_amount NULL` marks the initial salary |

### Pre-existing in Supabase (documented, not created here)

`invoices`, `vendors`, `audit_log` (enums `action`/`actor_role`; known-good
values `INVOICE_SAVED` / `DUPLICATE_BLOCKED` / `ANOMALY_FLAGGED`,
`accountant`), `duplicate_log`, `anomaly_log` (`anomaly_level` enum, NOT NULL).
`migration_002` added multi-tenancy/provenance columns to them
(`user_id`, `connected_account_id`, email metadata, the
`invoices_message_dedupe` partial unique index) and `migration_003` re-pointed
`invoices.connected_account_id` to `ON DELETE SET NULL` so disconnecting a
mailbox keeps its invoices.

### Migrations

[src/scripts/migrate.ts](src/scripts/migrate.ts) runs `db/schema.sql` then the
migrations in order, splitting on semicolons and skipping benign
duplicate-object errors — every file is written to be idempotent
(`IF NOT EXISTS`, drop-then-add), so reruns are safe. No `psql` dependency.

---

## 10. Security model (summary)

- **Refresh tokens encrypted at rest** — AES-256-GCM, AAD-bound to the owning
  row; `crypto.ts` is the only module touching key material (KMS planned).
- **OAuth state in a sealed HttpOnly cookie** — no server session store; CSRF
  covered by the `state` check; session-swap detected via the sealed `userId`.
- **Single-user allowlist** — only the seeded Supabase account can log in.
- **Tenant scoping everywhere** — every user-facing query filters by
  `user_id`; the voice assistant's SQL tool is parameterized and scoped;
  server-side identity injection on ingestion routes.
- **Log redaction** — pino strips `authorization`, `cookie`, `x-internal-key`,
  `set-cookie`, and any `*token*`/`*secret*` field; request bodies are never
  logged.
- **Rate limits** — 20/min connect/callback, 120/min `/internal/*`, 300/min
  global.
- **CSP via helmet** — locked to self + esm.sh + Supabase; `object-src 'none'`.
- **Upload hygiene** — content-type allowlists (PDF/image; PDF-only for
  contracts), 20 MB cap, sanitized `Content-Disposition` filenames on download.
- **Supabase RLS deny-by-default** on all app tables (backend connects as
  `postgres` and bypasses it).
- **Input validation** at every route boundary; DB CHECK constraints as the
  second line (status/kind/type enums, non-negative amounts).
- Known tradeoffs (also in [NEXT_STEPS.md](NEXT_STEPS.md)): `/internal/*` is
  shared-secret-only (IP allowlisting planned); pg SSL uses
  `rejectUnauthorized: false` for Supabase's pooler; JWT verification is a
  network call per request (local verification planned).

---

## 11. Configuration

All env vars are loaded and validated at boot in [src/config.ts](src/config.ts) —
the process refuses to start on misconfiguration. In production it additionally
requires an https `APP_URL` and a valid 64-hex-char `MASTER_KEY_HEX`.

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV`, `PORT`, `APP_URL` | defaults | Runtime basics; `APP_URL` drives redirect URIs + secure cookies |
| `DATABASE_URL` | ✅ | Supabase Postgres (session pooler, port 5432) |
| `MASTER_KEY_HEX` | ✅ | 32-byte AES-256-GCM key (tokens at rest + sealed cookies) |
| `INTERNAL_API_KEY` | ✅ | Shared secret for `/internal/*` |
| `GOOGLE_CLIENT_ID/SECRET` | ✅ | Google OAuth app (redirect `…/callback/google`) |
| `MS_CLIENT_ID/SECRET` | ✅ | Azure app registration (redirect `…/callback/microsoft`) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | ✅ | Auth verification + handed to the browser via `/config` |
| `SUPABASE_SERVICE_ROLE_KEY`, `SEED_USER_EMAIL/PASSWORD` | seed only | Used only by `db:seed-user`, never at runtime |
| `ENABLE_SYNC` | opt | `true` turns on the in-process pipeline (never together with n8n polling) |
| `OPENAI_API_KEY` | when sync/AI used | Extraction, vision, Whisper, assistant (`OPENAI_MODEL` overrides `gpt-4o`) |
| `BASE_CURRENCY` | default `USD` | Normalization target for all amounts |
| `SYNC_INTERVAL_SECONDS`, `SYNC_CONCURRENCY` | defaults 60 / 3 | Scheduler knobs |
| `N8N_NORMALIZE_WEBHOOK_URL`, `N8N_CONTRACT_WEBHOOK_URL`, `N8N_DUPLICATE_CHECK_WEBHOOK_URL`, `N8N_VENDOR_INTEL_WEBHOOK_URL` | opt | Enhancement webhooks (§6.5), all fail open |

See [.env.example](.env.example) for the annotated template and
[DEPLOYMENT.md](DEPLOYMENT.md) §2 for the deploy-time table.

---

## 12. HTTP API reference

Auth legend: 🔓 none · 🔑 `X-Internal-Key` · 👤 Supabase JWT (user).

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /healthz` | 🔓 | DB ping + uptime/version (platform health check) |
| `GET /config` | 🔓 | Supabase URL + anon key for the frontend |
| `GET /internal/connections?provider=` | 🔑 | Active connections for n8n |
| `POST /internal/token` | 🔑 | Mint an access token (`409` when re-auth needed) |
| `GET /connect/:provider` | 👤 | Start mailbox OAuth (PKCE) |
| `GET /callback/:provider` | 👤 | OAuth callback: validate + store connection |
| `GET /connections` | 👤 | List the user's connections |
| `DELETE /connections/:id` | 👤 | Revoke + remove a connection |
| `GET /settings/invoice-store` · `PUT` | 👤 | Get / set the OneDrive storage connection (Microsoft only) |
| `GET /test/:connectionId` | 👤 | Smoke test: list invoice-candidate emails |
| `POST /voice-invoice` | 👤 | Assistant turn (text or base64 audio) |
| `POST /upload-invoice` | 👤 | Manual PDF/image invoice ingestion |
| `GET /reports?period=` | 👤 | Report JSON (monthly/quarterly/yearly) |
| `POST /reports/send` | 👤 | Email the report from a connected mailbox |
| `GET /anomalies` | 👤 | Latest 20 flagged anomalies |
| `GET/POST /subscriptions` · `PATCH/DELETE /subscriptions/:id` | 👤 | Subscriptions CRUD (PATCH toggles active/cancelled) |
| `GET/POST /employees` | 👤 | List (with expiry flags) / create employees |
| `POST /employees/from-contract` | 👤 | Create an employee from an AI-extracted contract PDF |
| `GET /employees/alerts` | 👤 | Contract/probation/missing-contract alerts |
| `GET/PATCH/DELETE /employees/:id` | 👤 | Detail (contract, leaves, bonuses, salary history) / update / delete |
| `POST/GET /employees/:id/contract` | 👤 | Upload (store + extract-for-review) / download the latest contract PDF |
| `POST /employees/:id/leaves` · `DELETE …/:leaveId` | 👤 | Vacation/sick entries |
| `POST /employees/:id/bonuses` · `DELETE …/:bonusId` | 👤 | Bonus entries |

---

## 13. Frontend

Plain static HTML/JS served by Express — no framework, no bundler. Every page:

- Fetches `/config`, initializes Supabase JS (from esm.sh), keeps the session
  in the `sb_token` cookie so redirect-based routes see it, and redirects to
  `login.html` when unauthenticated.
- Shares navigation via [public/sidebar.js](public/sidebar.js) and styling via
  [public/portal.css](public/portal.css).

Pages: **login** (password / OTP verify / Google), **app** (dashboard:
connections, invoice-store picker, anomaly panel), **voice** (MediaRecorder →
base64 → `/voice-invoice`, playback via `blob:` URLs), **reports**,
**subscriptions**, **employees** + **employee** detail (contract upload with a
review-then-confirm form for extracted fields).

---

## 14. Development workflow

```bash
cp .env.example .env      # fill in real values
npm install
npm run db:migrate        # schema.sql + all migrations (idempotent, via tsx)
npm run db:seed-user      # create THE single allowed login (one-off)
npm run dev               # tsx watch src/index.ts | pino-pretty
npm test                  # node --test (employeeAlerts unit tests)

# production
npm run build             # tsc -> dist/
npm run db:migrate:prod   # node dist/scripts/migrate.js (release step)
npm start                 # node dist/index.js
```

Deploy steps, provider redirect-URI setup, and the post-deploy smoke test are
in [DEPLOYMENT.md](DEPLOYMENT.md); planned improvements and known tradeoffs are in
[NEXT_STEPS.md](NEXT_STEPS.md). The scheduler's documented scale path: lift
`syncConnection` (already an isolated unit of work) into BullMQ workers, then
replace polling with Graph change-notification webhooks.
