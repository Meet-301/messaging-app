import type { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { getRedis } from '../redis.js';
import {
  conversationsCol,
  emitWorkspaceEvent,
  isDuplicateKeyError,
  messagesCol,
  type ConversationDoc,
} from '../models.js';

const LOCK_TTL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const WORKER_CONCURRENCY = 4;
const IDLE_POLL_MS = 150;

// Atomic Redis Lua script:
// Checks pause key first; if not paused, refills token bucket (cap 8, 4/sec) and consumes 1 token.
// Returns 1 if allowed, 0 if paused or rate-limited.
const RATE_LIMIT_LUA = `
local pauseKey = KEYS[1]
local bucketKey = KEYS[2]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])

if redis.call('EXISTS', pauseKey) == 1 then
  return 0
end

local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local data = redis.call('HMGET', bucketKey, 'tokens', 'ts')
local tokens = tonumber(data[1])
local lastTs = tonumber(data[2])

if tokens == nil or lastTs == nil then
  tokens = capacity
  lastTs = nowMs
else
  local elapsed = math.max(0, nowMs - lastTs)
  tokens = math.min(capacity, tokens + elapsed * refillPerMs)
  lastTs = nowMs
end

if tokens < 1 then
  redis.call('HMSET', bucketKey, 'tokens', tokens, 'ts', lastTs)
  redis.call('PEXPIRE', bucketKey, 10000)
  return 0
end

tokens = tokens - 1
redis.call('HMSET', bucketKey, 'tokens', tokens, 'ts', lastTs)
redis.call('PEXPIRE', bucketKey, 10000)
return 1
`;

let workerRunning = false;
let wakeResolvers: Array<() => void> = [];

export function triggerWorker(): void {
  const resolvers = wakeResolvers;
  wakeResolvers = [];
  for (const r of resolvers) r();
}

function waitForWakeOrTimeout(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeResolvers = wakeResolvers.filter((r) => r !== done);
      resolve();
    }, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    wakeResolvers.push(done);
  });
}

export function isKnownWorkspace(workspace: string): boolean {
  return Object.prototype.hasOwnProperty.call(config.pigeon.apiKeys, workspace);
}

export async function enqueueOutboundReply(params: {
  workspace: string;
  contact: string;
  text: string;
  client_ref: string;
}): Promise<void> {
  const db = await getDb();
  const now = new Date();

  await conversationsCol(db).updateOne(
    { workspace: params.workspace, contact: params.contact },
    {
      $setOnInsert: {
        workspace: params.workspace,
        contact: params.contact,
        status: 'open',
        assignee: null,
        created_at: now,
      },
      $max: { last_activity_at: now },
    },
    { upsert: true }
  );

  try {
    await messagesCol(db).insertOne({
      workspace: params.workspace,
      contact: params.contact,
      direction: 'outbound',
      client_ref: params.client_ref,
      text: params.text,
      status: 'queued',
      occurred_at: now,
      created_at: now,
      locked_until: null,
      attempts: 0,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      return;
    }
    throw err;
  }

  triggerWorker();
}

export async function claimConversation(params: {
  workspace: string;
  contact: string;
  agent: string;
}): Promise<{ claimed: boolean; conversation?: ConversationDoc }> {
  const db = await getDb();
  const now = new Date();
  const filter = {
    workspace: params.workspace,
    contact: params.contact,
    $or: [{ assignee: null }, { assignee: params.agent }],
  };

  let doc: ConversationDoc | null = null;
  try {
    doc = await conversationsCol(db).findOneAndUpdate(
      filter,
      {
        $set: { assignee: params.agent },
        $setOnInsert: {
          workspace: params.workspace,
          contact: params.contact,
          status: 'open',
          last_activity_at: now,
          created_at: now,
        },
      },
      { upsert: true, returnDocument: 'after' }
    );
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Concurrent upsert created the document; retry without upsert
    doc = await conversationsCol(db).findOneAndUpdate(
      filter,
      { $set: { assignee: params.agent } },
      { returnDocument: 'after' }
    );
  }

  if (!doc) {
    return { claimed: false };
  }

  await emitWorkspaceEvent(db, params.workspace, {
    type: 'conversation.assigned',
    contact: params.contact,
    assignee: params.agent,
  });

  return { claimed: true, conversation: doc };
}

async function getUnpausedWorkspaces(): Promise<string[]> {
  const redis = getRedis();
  const all = Object.keys(config.pigeon.apiKeys);
  const checks = await Promise.all(
    all.map(async (ws) => ({ ws, paused: await redis.exists(`sb:pause:${ws}`) }))
  );
  return checks.filter((c) => c.paused === 0).map((c) => c.ws);
}

async function tryAcquireRateLimitToken(workspace: string): Promise<boolean> {
  const redis = getRedis();
  const allowed = await redis.eval(
    RATE_LIMIT_LUA,
    2,
    `sb:pause:${workspace}`,
    `sb:rl:${workspace}`,
    8,
    0.004
  );
  return allowed === 1;
}

async function releaseLock(msgId: ObjectId, lastError?: string): Promise<void> {
  const db = await getDb();
  const update: Record<string, unknown> = { locked_until: null };
  if (lastError !== undefined) update.last_error = lastError;
  await messagesCol(db).updateOne({ _id: msgId }, { $set: update });
}

async function processOneMessage(): Promise<boolean> {
  const db = await getDb();
  const unpaused = await getUnpausedWorkspaces();
  if (unpaused.length === 0) return false;

  const now = new Date();
  const lockUntil = new Date(now.getTime() + LOCK_TTL_MS);

  const msg = await messagesCol(db).findOneAndUpdate(
    {
      direction: 'outbound',
      status: 'queued',
      workspace: { $in: unpaused },
      $or: [{ locked_until: null }, { locked_until: { $lte: now } }],
    },
    {
      $set: { locked_until: lockUntil },
      $inc: { attempts: 1 },
    },
    {
      sort: { created_at: 1 },
      returnDocument: 'after',
    }
  );

  if (!msg) return false;

  const allowed = await tryAcquireRateLimitToken(msg.workspace);
  if (!allowed) {
    await releaseLock(msg._id);
    return false;
  }

  const apiKey = config.pigeon.apiKeys[msg.workspace];
  if (!apiKey || !msg.client_ref) {
    await messagesCol(db).updateOne(
      { _id: msg._id },
      { $set: { status: 'failed', locked_until: null, last_error: 'missing apiKey or client_ref' } }
    );
    return true;
  }

  try {
    const res = await fetch(`${config.pigeon.url}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Idempotency-Key': msg.client_ref,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: msg.contact,
        text: msg.text,
        client_ref: msg.client_ref,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.ok) {
      let pigeonMsgId: string | undefined;
      try {
        const data = (await res.json()) as { id?: string };
        if (typeof data?.id === 'string') pigeonMsgId = data.id;
      } catch {
        // ignore JSON parse issues on 200
      }

      const setFields: Record<string, unknown> = { locked_until: null };
      if (pigeonMsgId) setFields.message_id = pigeonMsgId;
      await messagesCol(db).updateOne({ _id: msg._id }, { $set: setFields });

      // Never downgrade if a webhook already marked it delivered/failed
      const statusUpdate = await messagesCol(db).updateOne(
        { _id: msg._id, status: 'queued' },
        { $set: { status: 'sent' } }
      );
      if (statusUpdate.modifiedCount > 0) {
        await emitWorkspaceEvent(db, msg.workspace, {
          type: 'message.status',
          contact: msg.contact,
          client_ref: msg.client_ref,
          status: 'sent',
        });
      }
      return true;
    }

    if (res.status === 429) {
      const retryAfterRaw = res.headers.get('retry-after');
      const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : 1;
      const pauseMs = Math.max(250, Math.ceil((Number.isFinite(retryAfterSec) ? retryAfterSec : 1) * 1000) + 150);
      await getRedis().set(`sb:pause:${msg.workspace}`, '1', 'PX', pauseMs);
      await releaseLock(msg._id, `HTTP 429 (pause ${pauseMs}ms)`);
      return false;
    }

    if (res.status === 503 || res.status >= 500) {
      // Short backoff per workspace during provider outage to avoid hammering
      await getRedis().set(`sb:pause:${msg.workspace}`, '1', 'PX', 600);
      await releaseLock(msg._id, `HTTP ${res.status}`);
      return false;
    }

    // Permanent 4xx failure (e.g. 400, 401, 404)
    await messagesCol(db).updateOne(
      { _id: msg._id, status: 'queued' },
      { $set: { status: 'failed', locked_until: null, last_error: `HTTP ${res.status}` } }
    );
    await emitWorkspaceEvent(db, msg.workspace, {
      type: 'message.status',
      contact: msg.contact,
      client_ref: msg.client_ref,
      status: 'failed',
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await releaseLock(msg._id, message);
    return false;
  }
}

async function workerLoop(): Promise<void> {
  while (workerRunning) {
    try {
      const didWork = await processOneMessage();
      if (!didWork) {
        await waitForWakeOrTimeout(IDLE_POLL_MS);
      }
    } catch (err) {
      console.error('[outbound-worker] error:', err);
      await waitForWakeOrTimeout(500);
    }
  }
}

export function startOutboundWorker(): void {
  if (workerRunning) return;
  workerRunning = true;
  for (let i = 0; i < WORKER_CONCURRENCY; i++) {
    void workerLoop();
  }
}
