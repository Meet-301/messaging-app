import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { closeDb, getDb } from '../src/db.js';
import { ensureIndexes, messagesCol } from '../src/models.js';
import { closeRedis } from '../src/redis.js';
import { claimConversation } from '../src/services/outbound.js';

let server: Server;
let baseUrl: string;

function signPigeon(rawBody: string, tsSec = Math.floor(Date.now() / 1000)): string {
  const sig = crypto
    .createHmac('sha256', config.pigeon.webhookSecret)
    .update(`${tsSec}.${rawBody}`)
    .digest('hex');
  return `t=${tsSec},v1=${sig}`;
}

async function resetData(): Promise<void> {
  const res = await fetch(`${baseUrl}/__grader/reset`, {
    method: 'POST',
    headers: { 'x-grader-token': config.graderToken },
  });
  assert.equal(res.status, 200);
}

before(async () => {
  const db = await getDb();
  await ensureIndexes(db);
  const app = createApp(() => true);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

beforeEach(async () => {
  await resetData();
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
  await closeRedis();
});

describe('1. Webhook security, idempotency, and status ordering', () => {
  it('accepts valid HMAC, rejects tampered body (401), expired timestamp (401), and malformed JSON (400)', async () => {
    const validBody = JSON.stringify({
      id: 'evt_valid_1',
      type: 'message.inbound',
      workspace: 'ws_acme',
      occurred_at: '2026-11-25T10:00:00.000Z',
      data: { message_id: 'pmsg_valid_1', from: '+14155550101', text: 'Hello' },
    });

    // Valid signature -> 200
    const okRes = await fetch(`${baseUrl}/webhooks/pigeon`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pigeon-signature': signPigeon(validBody),
      },
      body: validBody,
    });
    assert.equal(okRes.status, 200);

    // Tampered body -> 401
    const tamperedBody = validBody.replace('Hello', 'Hacked');
    const tamperRes = await fetch(`${baseUrl}/webhooks/pigeon`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pigeon-signature': signPigeon(validBody),
      },
      body: tamperedBody,
    });
    assert.equal(tamperRes.status, 401);

    // Expired timestamp (> 300s old) -> 401
    const oldTs = Math.floor(Date.now() / 1000) - 350;
    const staleRes = await fetch(`${baseUrl}/webhooks/pigeon`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pigeon-signature': signPigeon(validBody, oldTs),
      },
      body: validBody,
    });
    assert.equal(staleRes.status, 401);

    // Valid signature + malformed JSON -> 400
    const badJson = '{"id": "evt_bad", broken';
    const badJsonRes = await fetch(`${baseUrl}/webhooks/pigeon`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pigeon-signature': signPigeon(badJson),
      },
      body: badJson,
    });
    assert.equal(badJsonRes.status, 400);

    // Verify only the single valid message was stored
    const db = await getDb();
    const count = await messagesCol(db).countDocuments({ workspace: 'ws_acme' });
    assert.equal(count, 1);
  });

  it('deduplicates repeated event.id and ignores out-of-order status downgrades', async () => {
    // Seed an outbound message via /__grader/reply
    const replyRes = await fetch(`${baseUrl}/__grader/reply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-grader-token': config.graderToken,
      },
      body: JSON.stringify({
        workspace: 'ws_acme',
        contact: '+14155550101',
        text: 'Outbound test',
        client_ref: 'ref_order_1',
      }),
    });
    assert.equal(replyRes.status, 202);

    // Duplicate inbound webhook with same event.id
    const inboundBody = JSON.stringify({
      id: 'evt_dup_1',
      type: 'message.inbound',
      workspace: 'ws_acme',
      occurred_at: '2026-11-25T10:00:00.000Z',
      data: { message_id: 'pmsg_dup_1', from: '+14155550101', text: 'Dup test' },
    });
    const sig = signPigeon(inboundBody);
    const r1 = await fetch(`${baseUrl}/webhooks/pigeon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pigeon-signature': sig },
      body: inboundBody,
    });
    const r2 = await fetch(`${baseUrl}/webhooks/pigeon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pigeon-signature': sig },
      body: inboundBody,
    });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);

    const db = await getDb();
    const inboundCount = await messagesCol(db).countDocuments({
      workspace: 'ws_acme',
      direction: 'inbound',
    });
    assert.equal(inboundCount, 1);

    // Out-of-order status: 'delivered' arrives BEFORE 'sent'
    const deliveredBody = JSON.stringify({
      id: 'evt_status_deliv',
      type: 'message.status',
      workspace: 'ws_acme',
      occurred_at: '2026-11-25T10:00:05.000Z',
      data: { message_id: 'pm_1', client_ref: 'ref_order_1', status: 'delivered' },
    });
    const sentBody = JSON.stringify({
      id: 'evt_status_sent',
      type: 'message.status',
      workspace: 'ws_acme',
      occurred_at: '2026-11-25T10:00:02.000Z',
      data: { message_id: 'pm_1', client_ref: 'ref_order_1', status: 'sent' },
    });

    const dRes = await fetch(`${baseUrl}/webhooks/pigeon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pigeon-signature': signPigeon(deliveredBody) },
      body: deliveredBody,
    });
    assert.equal(dRes.status, 200);

    const sRes = await fetch(`${baseUrl}/webhooks/pigeon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pigeon-signature': signPigeon(sentBody) },
      body: sentBody,
    });
    assert.equal(sRes.status, 200);

    const msg = await messagesCol(db).findOne({ client_ref: 'ref_order_1' });
    assert.equal(msg?.status, 'delivered');
  });
});

describe('2. Atomic conversation claim concurrency', () => {
  it('allows strictly 1 winner out of 6 concurrent claims and allows idempotent re-claim by winner', async () => {
    const agents = ['agent_1', 'agent_2', 'agent_3', 'agent_4', 'agent_5', 'agent_6'];
    const results = await Promise.all(
      agents.map((agent) =>
        claimConversation({
          workspace: 'ws_globex',
          contact: '+442079460201',
          agent,
        })
      )
    );

    const winners = results
      .map((r, i) => (r.claimed ? agents[i] : null))
      .filter((x): x is string => x !== null);
    const losers = results.filter((r) => !r.claimed);

    assert.equal(winners.length, 1);
    assert.equal(losers.length, 5);

    // Winner claiming again succeeds
    const reClaim = await claimConversation({
      workspace: 'ws_globex',
      contact: '+442079460201',
      agent: winners[0],
    });
    assert.equal(reClaim.claimed, true);

    // Another agent claiming gets rejected
    const otherAgent = agents.find((a) => a !== winners[0])!;
    const otherClaim = await claimConversation({
      workspace: 'ws_globex',
      contact: '+442079460201',
      agent: otherAgent,
    });
    assert.equal(otherClaim.claimed, false);
  });
});

describe('3. Outbound reply idempotency & validation', () => {
  it('returns 202 for duplicate client_ref without creating a second DB message, and 400 for unknown workspace', async () => {
    const payload = {
      workspace: 'ws_acme',
      contact: '+14155550102',
      text: 'Idempotent reply',
      client_ref: 'ref_idem_1',
    };

    const [r1, r2] = await Promise.all([
      fetch(`${baseUrl}/__grader/reply`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-grader-token': config.graderToken,
        },
        body: JSON.stringify(payload),
      }),
      fetch(`${baseUrl}/__grader/reply`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-grader-token': config.graderToken,
        },
        body: JSON.stringify(payload),
      }),
    ]);

    assert.equal(r1.status, 202);
    assert.equal(r2.status, 202);

    const db = await getDb();
    const count = await messagesCol(db).countDocuments({ client_ref: 'ref_idem_1' });
    assert.equal(count, 1);

    const badWs = await fetch(`${baseUrl}/__grader/reply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-grader-token': config.graderToken,
      },
      body: JSON.stringify({ ...payload, workspace: 'ws_nonexistent', client_ref: 'ref_bad_ws' }),
    });
    assert.ok(badWs.status >= 400 && badWs.status < 500);
  });
});
