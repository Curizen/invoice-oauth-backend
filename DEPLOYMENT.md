# Deployment

Primary target: **Railway**. Fallback: **Render**. Both build from the
included `Dockerfile`.

## 1. Railway setup

1. Push this repo to GitHub.
2. In Railway: New Project → Deploy from GitHub repo → select this repo.
   Railway detects `railway.toml` and builds via the Dockerfile.
3. Add a Postgres database (Railway plugin, or point `DATABASE_URL` at your
   existing Supabase project) and set the environment variables below.
4. Deploy once, then run the migration (step 3 below) before using the app.
5. Set `APP_URL` to the domain Railway assigns (or your custom domain) and
   redeploy — several checks (secure cookies, production env validation)
   depend on `APP_URL` being the real `https://` URL.

## 2. Environment variables

| Variable | Description | Secret? |
|---|---|---|
| `NODE_ENV` | Set to `production` on Railway/Render. | No |
| `PORT` | Injected automatically by the platform; leave unset locally-managed. | No |
| `APP_URL` | Public HTTPS URL of this service. Must be `https://` in production or the app refuses to boot. | No |
| `DATABASE_URL` | Postgres connection string (Session pooler URI if using Supabase). | **Yes** |
| `MASTER_KEY_HEX` | 32-byte hex key for AES-256-GCM token encryption. Must be exactly 64 hex chars in production. | **Yes** |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID. | No |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret. | **Yes** |
| `MS_CLIENT_ID` | Azure app registration client ID. | No |
| `MS_CLIENT_SECRET` | Azure app registration client secret. | **Yes** |
| `INTERNAL_API_KEY` | Shared secret n8n sends as `X-Internal-Key` on `/internal/*`. | **Yes** |
| `SUPABASE_URL` | Supabase project URL, used for auth + surfaced (intentionally) via `/config`. | No |
| `SUPABASE_ANON_KEY` | Supabase anon key — meant to be public, safe to expose via `/config`. | No |
| `OPENAI_API_KEY` | Required if `ENABLE_SYNC=true` (the in-process pipeline calls OpenAI to extract invoice fields). | **Yes** (if set) |
| `ENABLE_SYNC` | Enables the in-process invoice sync scheduler. The pipeline now writes to the real Supabase schema (vendors → invoices → anomaly/audit), so it is safe to turn on — **but only after deactivating the external n8n workflow.** Running both at once double-processes every mailbox (n8n and the in-process poller would each fetch, extract, upload, and save the same attachments). Pick exactly one active pipeline. | No |
| `BASE_CURRENCY` | Default currency code (e.g. `USD`). No consumer yet; safe default. | No |

## 3. Run the migration

After the first deploy (and after any future deploy that changes `db/`):

```bash
railway run npm run db:migrate:prod
```

(Render: use the dashboard's one-off "Shell" command with the same npm
script.) This runs `db/schema.sql` then `db/migration_002_invoices.sql`
statement-by-statement, skipping benign "already exists" conditions —
safe to rerun.

## 4. External provider configuration

- **Google Cloud console** → APIs & Services → Credentials → your OAuth
  client → add authorized redirect URI:
  `https://<your-domain>/callback/google`
- **Azure portal** → App registrations → your app → Authentication → add
  redirect URI: `https://<your-domain>/callback/microsoft`
- **Supabase** → Authentication → URL Configuration → set Site URL to
  `https://<your-domain>` and add it to the redirect URL allow-list.
- **n8n**: update the "Get Connections" and "Get Token" nodes to call
  `https://<your-domain>/internal/connections` and
  `https://<your-domain>/internal/token` respectively.

## 5. Post-deploy smoke test

- [ ] `curl https://<your-domain>/healthz` → `{"ok":true,...}`
- [ ] Log in via the app's Supabase auth flow
- [ ] Click "Connect Microsoft", complete consent, land back on `/app.html`
- [ ] `curl -H "X-Internal-Key: $INTERNAL_API_KEY" https://<your-domain>/internal/connections` → returns the connection just created
- [ ] Send a test invoice email to the connected mailbox
- [ ] Verify the attachment lands in the account's OneDrive app folder
- [ ] Verify a row appears in the `invoices` table with `connected_account_id` populated
