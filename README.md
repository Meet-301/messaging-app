# Switchboard

A multi-tenant shared team inbox built with Express, TypeScript, MongoDB, Redis, WebSockets, and React.

## Prerequisites

- **Node.js** >= 22
- **Docker** (for MongoDB, Redis, Pigeon, and Mock IdP via `docker compose`), or local MongoDB (`:27017`) and Redis (`:6379`)

## Running from a Clean Clone

1. **Start infrastructure & simulators:**
   ```bash
   npm run up
   npm run doctor
   ```
   *(If running MongoDB and Redis locally without Docker, start them and run `npm run mocks` instead of `npm run up`.)*

2. **Install dependencies:**
   ```bash
   npm run scaffold:install
   ```

3. **Run in development mode (two terminals):**
   ```bash
   # Terminal 1: API & WebSocket server on :4000
   npm run scaffold:server

   # Terminal 2: Vite React UI on :5173 (proxies /api, /auth, /ws -> :4000)
   npm run scaffold:web
   ```

4. **Run unit/integration tests:**
   ```bash
   npm --prefix scaffold/server test
   ```

5. **Run the full automated check (stop your dev server first):**
   ```bash
   npm run check:full
   ```

## Architecture Overview

```text
Simulated Customers -> Pigeon (:4010) --POST /webhooks/pigeon--> Express Server (:4000) <--WS /ws & REST /api--> React UI (:5173)
                                                                       |        |
                                                                    MongoDB    Redis
                                                             (durable state,  (sessions, rate limits,
                                                              queues, locks)   WS replay & Pub/Sub)
```

- **Express + TypeScript (`scaffold/server`):** Handles OIDC PKCE login (`/auth/*`), Pigeon webhook ingestion with HMAC verification and deduplication (`/webhooks/pigeon`), tenant-isolated REST APIs (`/api/*`), WebSocket replay + live Pub/Sub (`/ws`), and the background outbound worker.
- **MongoDB:** Stores `conversations`, `messages`, `processed_events`, `workspace_seqs`, and E2EE `notes` with unique/sparse indexes for concurrency and idempotency.
- **Redis:** Stores OIDC state, shared user sessions (`sess:*`), per-workspace rate-limit token buckets and `Retry-After` pause keys (`sb:rl:*`, `sb:pause:*`), and WebSocket replay sorted sets + Pub/Sub channels (`sb:ws:*`).
- **React + Vite (`scaffold/web`):** 3-column support inbox with OIDC login, workspace switcher, live WebSocket reconnection (`&after=<seq>`), claim/close controls, and client-side `AES-GCM-256` encrypted internal notes.

## Repository File Guide

- `switchboard.json` — Harness install/start/health manifest.
- `DECISIONS.md` — Architecture summary, cuts, assumptions, and known limitations.
- `PROTOCOL.md` — End-to-end encrypted private notes specification and threat model.
- `CHECK_REPORT.json` — Output from `npm run check:full`.
- `ai-logs/` — Exported AI session transcripts.
