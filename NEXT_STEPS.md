# Next Steps Guide

Prioritized, with the *why* and a concrete *how* for each. Ordered roughly by
"do this before real users" → "do this to scale". See
[ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together.

---

## 0. Verify against the real database first

Before trusting the in-process pipeline, run it end-to-end against Supabase with
a **single test mailbox** and `ENABLE_SYNC=true`, and watch for insert errors.

- [ ] Confirm the `audit_action` enum accepts `INVOICE_SAVED`, `DUPLICATE_BLOCKED`,
      `ANOMALY_FLAGGED` and `actor_role` accepts `accountant`.
- [ ] Confirm `anomaly_log.anomaly_level` accepts `medium` / `high`.
- [ ] Confirm leaving `invoices.status`, `is_duplicate`, `duplicate_of` unset is
      allowed (DB defaults exist).
- [ ] Confirm a real invoice email produces: 1 `vendors` row (or updated stats),
      1 `invoices` row with `connected_account_id` + `vendor_id` populated,
      the OneDrive file, and 1 `INVOICE_SAVED` audit row.
- [ ] Re-send the same email → confirm it is **not** reprocessed (dedupe) and no
      duplicate `invoices` row appears.

**Pick exactly one pipeline.** If you enable the in-process scheduler, deactivate
the n8n workflow (and vice-versa) or every mailbox is double-processed.

---

## 1. Replace demo auth everywhere it still leaks through

`demoAuth` logs everyone in as a single seeded user. It's only selected when
`SUPABASE_URL` is unset, but make that impossible in production.

- **How:** keep `supabaseAuth` as the only path in prod; consider deleting
  `demoAuth` or gating it behind `NODE_ENV !== 'production'` explicitly.
- Verify local JWTs instead of calling `supabase.auth.getUser()` per request
  (it's a network round-trip on every call today). Verify the Supabase project
  JWT signature locally and cache the decoded user for the token's lifetime.

---

## 2. Move key material to a KMS (envelope encryption)

`crypto.ts` uses a single static `MASTER_KEY_HEX` from env — fine for dev, not
for production. It's deliberately the *only* module touching key material.

- **How:** generate a per-record/per-tenant data key (DEK), encrypt the DEK with
  a KMS key (AWS KMS `GenerateDataKey`, GCP KMS, or Vault Transit), store the
  wrapped DEK next to the ciphertext. Bump `KEY_VERSION` and support decrypting
  old rows during rollover. The ciphertext format and AAD binding can stay.

---

## 3. Make the token cache multi-instance safe

`tokenService.ts` caches access tokens in an in-process `Map`. With >1 instance
(Railway horizontal scaling), each instance refreshes independently and they can
race on refresh-token rotation.

- **How:** move the cache to Redis (`SET key token EX <ttl>`), and add a
  per-connection lock (e.g. `SET NX` lease) around the refresh so only one
  instance rotates a given refresh token at a time.

---

## 4. Harden the `/internal/*` surface

Today a leaked `INTERNAL_API_KEY` grants full read + token-mint access.

- **How:** IP-allowlist the route to n8n's egress IP(s), and/or add a second
  platform-level shared secret / private networking. Rotate the key on a
  schedule. (There's already an in-code note at the guard.)

---

## 5. Replace polling with change notifications (reliability + cost)

The scheduler polls every mailbox on a timer. That's simple but wastes Graph
calls and adds latency.

- **How (near-term):** move the per-connection sync into a real queue (BullMQ on
  Redis): one job per connection, concurrency limits, retries with backoff,
  dead-letter for poison messages. The scheduler becomes a thin enqueuer.
- **How (longer-term):** register **Microsoft Graph change-notification
  subscriptions** (and **Gmail `users.watch` + Pub/Sub**) so new mail pushes to
  a webhook instead of being polled. Keep a low-frequency reconciliation poll as
  a safety net.

---

## 6. Robustness in the pipeline

- **Large uploads:** OneDrive upload already switches to an upload session >4 MB
  — smoke-test a large PDF to confirm the chunked path works end-to-end.
- **LLM failures:** `extractInvoiceFields` falls back to defaults on bad JSON,
  which can write a low-quality invoice. Consider storing `ai_confidence` and
  routing low-confidence extractions to a review queue instead of auto-saving.
- **Idempotency on races:** the invoice insert relies on the
  `invoices_message_dedupe` partial index. If you ever run overlapping workers on
  the same connection, note the vendor upsert happens *before* the insert, so a
  lost insert race would still have incremented vendor stats — acceptable today
  (the scheduler's `running` flag prevents overlap) but revisit under a queue.
- **Rate limits (provider side):** add backoff/retry on Graph/OpenAI `429`s.

---

## 7. Observability

- Ship pino logs to a log sink (Railway/Render drain, or Logtail/Datadog).
- Add metrics: invoices saved, duplicates blocked, anomalies flagged, refresh
  failures, and **alert on spikes of `reauth_required`** (a sign of a bad
  deploy or revoked app).
- Add a `/metrics` endpoint or push to your APM of choice.

---

## 8. Data model & migrations

- Adopt a migration-tracking table (or a tool like `node-pg-migrate` / `graphile-migrate`)
  so migrations are versioned and only applied once, instead of the current
  whole-file idempotent replays.
- Decide whether to formalize the pre-existing Supabase accounting tables
  (`invoices`, `vendors`, `audit_log`, `duplicate_log`, `anomaly_log`) as
  checked-in schema files so the whole schema is reproducible from the repo.
- Consider a DB-level unique constraint on `(user_id, vendor, invoice_number)`
  if you want the duplicate rule enforced by Postgres rather than only in code.

---

## 9. Provider verification (blocks public launch)

- **Google:** `gmail.readonly` is a *restricted* scope — production needs OAuth
  verification **+ a CASA security assessment**. In "Testing" mode refresh
  tokens expire after 7 days.
- **Microsoft:** complete publisher verification.

---

## 10. Frontend polish

- The `sb_token` cookie is set by client JS (not HttpOnly, since JS must write
  it). If you later verify JWTs server-side, consider issuing your own HttpOnly
  session cookie instead and drop `sb_token`.
- Wire up the `?onboard=` param that `login.html` already preserves through the
  OTP flow, if you want a guided first-connection experience.

---

### Suggested order

1 → 0 → 4 (ship-blockers for a private beta) →
2, 3 (before scaling past one instance) →
5, 6, 7 (reliability at volume) →
8, 9, 10 (maturity & public launch).
