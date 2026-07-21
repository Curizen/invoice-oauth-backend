# Deployment

Primary target: **AWS App Runner**, built from the included `Dockerfile`.
(Railway and Render remain supported as alternates — see the bottom of this
file.)

## 1. AWS App Runner setup

App Runner deploys a container image from ECR; there's no "connect your git
repo" step like Railway/Render — you build the image and push it yourself
(or wire up CI to do it later). `apprunner.json` in the repo root is a
template for the service definition; copy it, fill in the placeholders, and
use it with the CLI as shown below. Every command here assumes you already
have AWS credentials configured (`aws sts get-caller-identity` should work).

### 1a. One-time account setup

```bash
export AWS_REGION=us-east-1        # pick your region
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# ECR repo for the image
aws ecr create-repository --repository-name invoice-oauth-starter --region "$AWS_REGION"

# Role App Runner uses to PULL the image from ECR
aws iam create-role --role-name AppRunnerECRAccessRole \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"build.apprunner.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name AppRunnerECRAccessRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess

# Role the RUNNING container uses to read secrets (see 1c)
aws iam create-role --role-name AppRunnerInstanceRole \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"tasks.apprunner.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam put-role-policy --role-name AppRunnerInstanceRole --policy-name read-invoice-app-secrets \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"arn:aws:secretsmanager:$AWS_REGION:$ACCOUNT_ID:secret:invoice-app/*\"}]}"
```

### 1b. Build and push the image

```bash
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

docker build -t invoice-oauth-starter .
docker tag invoice-oauth-starter:latest "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/invoice-oauth-starter:latest"
docker push "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/invoice-oauth-starter:latest"
```

`db/supabase-root-2021-ca.crt` (used for verified DB TLS — see the
environment variable table below) is already picked up by the existing
`COPY db ./db` line in the Dockerfile; no image changes needed.

### 1c. Store secrets in Secrets Manager

One secret per sensitive value, matching the ARNs already referenced in
`apprunner.json`:

```bash
aws secretsmanager create-secret --name invoice-app/database-url        --secret-string "$DATABASE_URL"
aws secretsmanager create-secret --name invoice-app/master-key-hex      --secret-string "$MASTER_KEY_HEX"
aws secretsmanager create-secret --name invoice-app/internal-api-key    --secret-string "$INTERNAL_API_KEY"
aws secretsmanager create-secret --name invoice-app/google-client-secret --secret-string "$GOOGLE_CLIENT_SECRET"
aws secretsmanager create-secret --name invoice-app/ms-client-secret    --secret-string "$MS_CLIENT_SECRET"
```

(`OPENAI_API_KEY` only matters if you flip on `ENABLE_SYNC` — see the table
below; add it the same way if/when you do.)

### 1d. Create the service

Copy `apprunner.json`, replace every `<...>` placeholder (account id,
region, image tag, Supabase URL/anon key, OAuth client ids, and — once you
know it — `APP_URL` with the domain App Runner assigns), then:

```bash
aws apprunner create-service --cli-input-json file://apprunner.json --region "$AWS_REGION"
```

App Runner assigns a domain like `https://xxxxxxxxxx.us-east-1.awsapprunner.com`.
Once you have it:

```bash
SERVICE_ARN=$(aws apprunner list-services --query "ServiceSummaryList[?ServiceName=='invoice-oauth-starter'].ServiceArn" --output text)
aws apprunner describe-service --service-arn "$SERVICE_ARN" --query "Service.ServiceUrl" --output text
```

Set `APP_URL` to that (with `https://`) in `apprunner.json`'s
`RuntimeEnvironmentVariables` and re-run `aws apprunner update-service
--service-arn "$SERVICE_ARN" --cli-input-json file://apprunner.json` —
several production checks (secure cookies, the `APP_URL` boot validation in
`src/config.ts`) depend on it being the real `https://` URL. Do this before
running the migration in step 3.

No VPC connector is needed: App Runner's default public egress can already
reach Supabase's pooler over the internet. Only add one if you move the
database to a private RDS/VPC-only endpoint.

## 2. Environment variables

| Variable | Description | Secret? |
|---|---|---|
| `NODE_ENV` | `production` in deployment. | No |
| `PORT` | The app listens on this (default `3000`). App Runner doesn't inject it — leave unset and keep `apprunner.json`'s `ImageConfiguration.Port` at `"3000"` to match, or set both consistently if you change it. | No |
| `APP_URL` | Public HTTPS URL of this service. Must be `https://` in production or the app refuses to boot. | No |
| `DATABASE_URL` | Postgres connection string (Supabase session pooler URI). | **Yes** |
| `MASTER_KEY_HEX` | 32-byte hex key for AES-256-GCM (refresh tokens, sealed cookies, and the at-rest field encryption in `src/fieldCrypto.ts`). Must be exactly 64 hex chars in production. | **Yes** |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID. | No |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret. | **Yes** |
| `MS_CLIENT_ID` | Azure app registration client ID. | No |
| `MS_CLIENT_SECRET` | Azure app registration client secret. | **Yes** |
| `INTERNAL_API_KEY` | Shared secret n8n sends as `X-Internal-Key` on `/internal/*`. | **Yes** |
| `INTERNAL_ALLOWED_IPS` | Optional comma-separated source-IP allowlist for `/internal/*`. Leave unset unless n8n's egress IP is stable — App Runner's own address isn't involved here, this restricts who may *call* your service. | No |
| `SUPABASE_URL` | Supabase project URL, used for auth + surfaced (intentionally) via `/config`. | No |
| `SUPABASE_ANON_KEY` | Supabase anon key — meant to be public, safe to expose via `/config`. | No |
| `SUPABASE_CA_CERT_FILE` | Path to the Supabase CA cert for verified DB TLS. Set to `db/supabase-root-2021-ca.crt` (baked into the image) unless you've swapped databases. Leaving this and `SUPABASE_CA_CERT` both unset boots with certificate verification **disabled** — the app logs a loud warning if so. | No |
| `SUPABASE_CA_CERT` | Alternative to the file path: the PEM (or base64 of it) inline. Only needed if you're not using the committed cert. | No |
| `ALLOW_DEMO_AUTH` | Must be unset/`false` in production — the app refuses to boot with it `true` outside `NODE_ENV=development`. Only relevant for local dev without Supabase configured. | No |
| `OPENAI_API_KEY` | Required if `ENABLE_SYNC=true` (the in-process pipeline calls OpenAI to extract invoice fields). | **Yes** (if set) |
| `ENABLE_SYNC` | Enables the in-process invoice sync scheduler. The pipeline writes to the real Supabase schema (vendors → invoices → anomaly/audit), so it's safe to turn on — **but only after deactivating the external n8n workflow.** Running both at once double-processes every mailbox. A Postgres advisory lock (`src/pipeline/scheduler.ts`) stops two *App Runner instances* of this service from double-processing each other, but does nothing against n8n running concurrently — pick exactly one active pipeline. | No |
| `BASE_CURRENCY` | Default currency code (e.g. `USD`). | No |

## 3. Run migrations and the sensitive-data backfill

App Runner has no built-in one-off shell/task runner (unlike Railway's `run`
or Render's dashboard Shell). Run these from any machine with network
access to the database — your laptop is fine, since `DATABASE_URL` points
at Supabase's public pooler:

```bash
NODE_ENV=production npm run build
DATABASE_URL=... npm run db:migrate:prod
```

Then, **only once you're ready to cut over from the old plaintext columns**
(this is a one-way step — it drops the plaintext `salary`, `file_data`, etc.
columns after verifying every row has an encrypted twin) and only against a
database no *other* running instance of the old code is still writing to:

```bash
DATABASE_URL=... MASTER_KEY_HEX=... npm run db:encrypt-sensitive:prod
```

Both scripts are idempotent/rerunnable.

## 4. External provider configuration

- **Google Cloud console** → APIs & Services → Credentials → your OAuth
  client → add authorized redirect URI:
  `https://<your-apprunner-domain>/callback/google`
- **Azure portal** → App registrations → your app → Authentication → add
  redirect URI: `https://<your-apprunner-domain>/callback/microsoft`
- **Supabase** → Authentication → URL Configuration → set Site URL to
  `https://<your-apprunner-domain>` and add it to the redirect URL allow-list.
- **n8n**: update the "Get Connections" and "Get Token" nodes to call
  `https://<your-apprunner-domain>/internal/connections` and
  `https://<your-apprunner-domain>/internal/token` respectively.

## 5. Post-deploy smoke test

- [ ] `curl https://<your-apprunner-domain>/healthz` → `{"ok":true,...}`
- [ ] Log in via the app's Supabase auth flow
- [ ] Click "Connect Microsoft", complete consent, land back on `/app.html`
- [ ] `curl -H "X-Internal-Key: $INTERNAL_API_KEY" https://<your-apprunner-domain>/internal/connections` → returns the connection just created
- [ ] Send a test invoice email to the connected mailbox
- [ ] Verify the attachment lands in the account's OneDrive app folder
- [ ] Verify a row appears in the `invoices` table with `connected_account_id` populated

## 6. Redeploying after a code change

```bash
docker build -t invoice-oauth-starter .
docker tag invoice-oauth-starter:latest "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/invoice-oauth-starter:latest"
docker push "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/invoice-oauth-starter:latest"
```

`apprunner.json` has `"AutoDeploymentsEnabled": true`, so App Runner picks
up the new image automatically within a few minutes of the push. If a
deploy changed `db/`, rerun step 3's migration first.

---

## Alternates: Railway / Render

Both also build from the included `Dockerfile`.

### Railway

1. Push this repo to GitHub.
2. In Railway: New Project → Deploy from GitHub repo → select this repo.
   Railway detects `railway.toml` and builds via the Dockerfile.
3. Add a Postgres database (Railway plugin, or point `DATABASE_URL` at your
   existing Supabase project) and set the environment variables from the
   table above.
4. Deploy once, then run the migration:
   ```bash
   railway run npm run db:migrate:prod
   ```
5. Set `APP_URL` to the domain Railway assigns and redeploy.

### Render

Same environment variables and migration script, run via the dashboard's
one-off "Shell" command. `render.yaml` is already checked in.
