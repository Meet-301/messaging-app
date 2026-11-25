import crypto from 'node:crypto';
import express, { type Request, type Response, Router } from 'express';
import { config } from '../config.js';
import { getDb } from '../db.js';
import {
  conversationsCol,
  emitWorkspaceEvent,
  isDuplicateKeyError,
  messagesCol,
  processedEventsCol,
} from '../models.js';
import { isKnownWorkspace } from '../services/outbound.js';

const MAX_TIMESTAMP_AGE_SEC = 300;

function parseSignatureHeader(header: string): { t: number; v1: string } | null {
  const parts = header.split(',');
  let tStr: string | undefined;
  let v1: string | undefined;

  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') tStr = v;
    else if (k === 'v1') v1 = v;
  }

  if (!tStr || !v1) return null;
  if (!/^\d+$/.test(tStr)) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(v1)) return null;

  const t = Number(tStr);
  if (!Number.isSafeInteger(t)) return null;

  return { t, v1: v1.toLowerCase() };
}

function verifyPigeonSignature(rawBody: string, header: string | undefined): boolean {
  if (!header || typeof header !== 'string') return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parsed.t) > MAX_TIMESTAMP_AGE_SEC) {
    return false;
  }

  const expectedHex = crypto
    .createHmac('sha256', config.pigeon.webhookSecret)
    .update(`${parsed.t}.${rawBody}`)
    .digest('hex');

  const sigBuf = Buffer.from(parsed.v1, 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (sigBuf.length !== expectedBuf.length) return false;

  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

export function createWebhooksRouter(): Router {
  const router = Router();

  router.post(
    '/pigeon',
    express.raw({ type: '*/*', limit: '2mb' }),
    async (req: Request, res: Response) => {
      const rawBuf = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : '');
      const rawBody = rawBuf.toString('utf8');

      const sigHeader = req.header('x-pigeon-signature');
      if (!verifyPigeonSignature(rawBody, sigHeader)) {
        return res.status(401).json({ error: 'invalid signature' });
      }

      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(rawBody);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return res.status(400).json({ error: 'invalid json body' });
        }
        event = parsed as Record<string, unknown>;
      } catch {
        return res.status(400).json({ error: 'invalid json' });
      }

      const workspace = typeof event.workspace === 'string' ? event.workspace : '';
      if (!isKnownWorkspace(workspace)) {
        return res.status(200).json({ ok: true, ignored: 'unknown_workspace' });
      }

      const eventType = typeof event.type === 'string' ? event.type : '';
      if (eventType !== 'message.inbound' && eventType !== 'message.status') {
        return res.status(200).json({ ok: true, ignored: 'unknown_event_type' });
      }

      const eventId =
        typeof event.id === 'string' && event.id.length > 0
          ? event.id
          : req.header('x-pigeon-event-id') || '';

      const db = await getDb();

      if (eventId) {
        const already = await processedEventsCol(db).findOne({ event_id: eventId });
        if (already) {
          return res.status(200).json({ ok: true, deduplicated: true });
        }
      }

      const data =
        event.data && typeof event.data === 'object' && !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>)
          : {};

      if (eventType === 'message.inbound') {
        const messageId = typeof data.message_id === 'string' ? data.message_id : '';
        const contact = typeof data.from === 'string' ? data.from : '';
        const text = typeof data.text === 'string' ? data.text : '';
        if (!messageId || !contact) {
          return res.status(400).json({ error: 'missing message_id or from' });
        }

        const parsedOccurredAt =
          typeof event.occurred_at === 'string' ? new Date(event.occurred_at) : new Date();
        const occurredAt = Number.isNaN(parsedOccurredAt.getTime()) ? new Date() : parsedOccurredAt;
        const now = new Date();

        try {
          await messagesCol(db).insertOne({
            workspace,
            contact,
            direction: 'inbound',
            message_id: messageId,
            text,
            status: 'delivered',
            occurred_at: occurredAt,
            created_at: now,
          });
        } catch (err) {
          if (isDuplicateKeyError(err)) {
            if (eventId) {
              await processedEventsCol(db)
                .insertOne({ event_id: eventId, created_at: now })
                .catch(() => {});
            }
            return res.status(200).json({ ok: true, deduplicated: true });
          }
          throw err;
        }

        await conversationsCol(db).updateOne(
          { workspace, contact },
          {
            $setOnInsert: {
              workspace,
              contact,
              status: 'open',
              assignee: null,
              created_at: now,
            },
            $max: { last_activity_at: occurredAt },
          },
          { upsert: true }
        );

        if (eventId) {
          await processedEventsCol(db)
            .insertOne({ event_id: eventId, created_at: now })
            .catch(() => {});
        }

        await emitWorkspaceEvent(db, workspace, {
          type: 'message.inbound',
          contact,
          message_id: messageId,
          text,
          occurred_at: occurredAt.toISOString(),
        });

        return res.status(200).json({ ok: true });
      }

      // eventType === 'message.status'
      const clientRef = typeof data.client_ref === 'string' ? data.client_ref : '';
      const nextStatus = typeof data.status === 'string' ? data.status : '';
      const pigeonMsgId = typeof data.message_id === 'string' ? data.message_id : undefined;

      if (!clientRef) {
        return res.status(200).json({ ok: true, ignored: 'missing_client_ref' });
      }

      const existing = await messagesCol(db).findOne({
        workspace,
        client_ref: clientRef,
        direction: 'outbound',
      });

      if (!existing) {
        return res.status(200).json({ ok: true, ignored: 'unknown_client_ref' });
      }

      let allowedPrevStatuses: Array<'queued' | 'sent'> | null = null;
      if (nextStatus === 'sent') {
        allowedPrevStatuses = ['queued'];
      } else if (nextStatus === 'delivered' || nextStatus === 'failed') {
        allowedPrevStatuses = ['queued', 'sent'];
      }

      let statusModified = false;
      if (allowedPrevStatuses) {
        const setFields: Record<string, unknown> = { status: nextStatus };
        if (pigeonMsgId) setFields.message_id = pigeonMsgId;

        const updateRes = await messagesCol(db).updateOne(
          {
            _id: existing._id,
            status: { $in: allowedPrevStatuses },
          },
          { $set: setFields }
        );
        statusModified = updateRes.modifiedCount > 0;
      }

      const now = new Date();
      if (eventId) {
        try {
          await processedEventsCol(db).insertOne({ event_id: eventId, created_at: now });
        } catch (err) {
          if (isDuplicateKeyError(err)) {
            return res.status(200).json({ ok: true, deduplicated: true });
          }
          throw err;
        }
      }

      if (statusModified) {
        await emitWorkspaceEvent(db, workspace, {
          type: 'message.status',
          contact: existing.contact,
          client_ref: clientRef,
          status: nextStatus,
        });
      }

      return res.status(200).json({ ok: true });
    }
  );

  return router;
}
