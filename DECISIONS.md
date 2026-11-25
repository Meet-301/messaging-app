# Switchboard — Design Decisions

## What Was Built
- **Auth & Tenant Isolation:** OIDC Authorization Code + PKCE (`S256`) login via the Mock IdP (`GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`) backed by shared Redis sessions (`sess:<sid>`) and `HttpOnly`, `SameSite=Lax` cookies. All `/api/*` and `/ws` endpoints enforce authentication (`401`) and workspace membership (`403`).
- **Pigeon Webhook Ingestion:** `POST /webhooks/pigeon` captures the raw body buffer before JSON parsing, verifies `x-pigeon-signature` (`t.<rawBody>` HMAC-SHA256 with `timingSafeEqual`) and 300s replay window (`401`), rejects invalid JSON (`400`), ignores unknown workspaces/event types (`200`), deduplicates via `processed_events` and unique `message_id`, and prevents out-of-order status downgrades (`delivered` never reverts to `sent`).
- **Crash-Safe Outbound Queue:** Replies are persisted in MongoDB (`status: 'queued'`, sparse unique `client_ref`) before returning `202`. Four worker loops claim jobs atomically using a 15s `locked_until` lease, enforce a shared per-workspace Redis token bucket (8 burst, 4/sec refill) and `Retry-After` pause keys via Lua, and send with `Idempotency-Key` and a 10s timeout.
- **Atomic Claims & Real-Time WebSockets:** `claimConversation` uses atomic `findOneAndUpdate` with `E11000` retry handling so only one agent wins a race. `GET /ws?workspace=<id>&after=<seq>` replays missed frames from a Redis sorted set (`sb:ws:events:<workspace>`) and streams live updates across server copies via Redis Pub/Sub.
- **Frontend, E2EE Notes & Tests:** 3-column React inbox (`scaffold/web`), client-side `PBKDF2-SHA256` + `AES-GCM-256` encrypted private notes (`PROTOCOL.md`), and `node:test` integration tests (`scaffold/server/test/core.test.ts`).

## What Was Cut and Why
- **Elasticsearch full-text search** and **Paybox per-seat billing** were cut so all effort could focus on surviving `kill -9` crashes, network outages, rate limits, and multi-instance concurrency (Levels 1–5).

## Assumptions Where the Brief Was Silent
- **Workspace-shared E2EE passphrase:** Private notes derive an `AES-GCM-256` key in the browser from a workspace passphrase stored in `sessionStorage` (`PBKDF2-SHA256`, 100,000 iterations), allowing workspace agents to share notes without a server-side public-key directory.
- **15-second worker lock TTL:** `LOCK_TTL_MS = 15_000` (> 10s HTTP timeout) prevents two copies from double-sending a slow request while ensuring surviving copies reclaim crashed work well within the 60s failover window.
- **Inbound persistence on closed conversations:** Inbound webhooks always persist and update `last_activity_at` regardless of `open`/`closed` status so no customer message is ever dropped.

## What Is Still Wrong / Known Limitations
- **Unbounded Redis replay sorted set:** `sb:ws:events:<workspace>` is not trimmed with `ZREMRANGEBYRANK`, so long-lived workspaces in production would eventually need a retention cap.
- **Post-200 crash window on outbound sends:** If a server copy is `kill -9`'d after Pigeon accepts a message (`200 OK`) but before MongoDB transitions `status` from `queued` to `sent`, another copy retries with the same `Idempotency-Key` (safe for the customer, but adds one redundant HTTP request).
- **No CSP headers on frontend:** An XSS vulnerability or compromised server bundle could read the `sessionStorage` passphrase used for encrypted notes (documented in `PROTOCOL.md`).
