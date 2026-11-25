import crypto from 'node:crypto';
import { Router, type Response } from 'express';
import { getDb } from '../db.js';
import {
  conversationsCol,
  emitWorkspaceEvent,
  messagesCol,
  notesCol,
} from '../models.js';
import {
  claimConversation,
  enqueueOutboundReply,
  isKnownWorkspace,
} from '../services/outbound.js';
import {
  isWorkspaceMember,
  requireAuth,
  type AuthenticatedRequest,
} from '../services/session.js';

function getWorkspaceParam(req: AuthenticatedRequest): string {
  if (typeof req.query.workspace === 'string' && req.query.workspace) {
    return req.query.workspace;
  }
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body.workspace === 'string') {
    return body.workspace;
  }
  return '';
}

function checkWorkspaceAccess(
  req: AuthenticatedRequest,
  res: Response
): string | null {
  const workspace = getWorkspaceParam(req);
  if (!workspace) {
    res.status(400).json({ error: 'missing workspace' });
    return null;
  }
  if (!isWorkspaceMember(req.user!, workspace)) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  if (!isKnownWorkspace(workspace)) {
    res.status(404).json({ error: 'unknown workspace' });
    return null;
  }
  return workspace;
}

export function createApiRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/me', (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    return res.status(200).json({
      sub: user.sub,
      name: user.name,
      email: user.email,
      workspaces: user.workspaces,
    });
  });

  router.get('/conversations', async (req: AuthenticatedRequest, res: Response) => {
    const workspace = checkWorkspaceAccess(req, res);
    if (!workspace) return;

    const statusParam = typeof req.query.status === 'string' ? req.query.status : 'all';
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
    const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.floor(limitRaw))) : 50;
    const cursorRaw = typeof req.query.cursor === 'string' ? req.query.cursor : '';

    const filter: Record<string, unknown> = { workspace };
    if (statusParam === 'open' || statusParam === 'closed') {
      filter.status = statusParam;
    }
    if (cursorRaw) {
      const cursorDate = new Date(cursorRaw);
      if (!Number.isNaN(cursorDate.getTime())) {
        filter.last_activity_at = { $lt: cursorDate };
      }
    }

    const db = await getDb();
    const docs = await conversationsCol(db)
      .find(filter)
      .sort({ last_activity_at: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = docs.length > limit;
    const items = hasMore ? docs.slice(0, limit) : docs;
    const contacts = items.map((c) => c.contact);

    const lastMsgs = contacts.length
      ? await messagesCol(db)
          .aggregate<{
            _id: string;
            text: string;
            direction: string;
            status: string;
            occurred_at: Date;
          }>([
            { $match: { workspace, contact: { $in: contacts } } },
            { $sort: { occurred_at: -1, created_at: -1, _id: -1 } },
            {
              $group: {
                _id: '$contact',
                text: { $first: '$text' },
                direction: { $first: '$direction' },
                status: { $first: '$status' },
                occurred_at: { $first: '$occurred_at' },
              },
            },
          ])
          .toArray()
      : [];

    const lastMsgMap = new Map(lastMsgs.map((m) => [m._id, m]));
    const conversations = items.map((c) => {
      const last = lastMsgMap.get(c.contact);
      return {
        workspace: c.workspace,
        contact: c.contact,
        status: c.status,
        assignee: c.assignee,
        last_activity_at: c.last_activity_at,
        created_at: c.created_at,
        last_message: last
          ? {
              text: last.text,
              direction: last.direction,
              status: last.status,
              occurred_at: last.occurred_at,
            }
          : null,
      };
    });

    const nextCursor =
      hasMore && items.length > 0
        ? items[items.length - 1].last_activity_at.toISOString()
        : null;

    return res.status(200).json({ conversations, next_cursor: nextCursor });
  });

  router.get('/conversations/:contact/messages', async (req: AuthenticatedRequest, res: Response) => {
    const workspace = checkWorkspaceAccess(req, res);
    if (!workspace) return;

    const contact = decodeURIComponent(String(req.params.contact || ''));
    if (!contact) return res.status(400).json({ error: 'missing contact' });

    const db = await getDb();
    const [conversation, messages, notes] = await Promise.all([
      conversationsCol(db).findOne({ workspace, contact }),
      messagesCol(db)
        .find({ workspace, contact })
        .sort({ occurred_at: 1, created_at: 1, _id: 1 })
        .toArray(),
      notesCol(db)
        .find({ workspace, contact })
        .sort({ created_at: 1, _id: 1 })
        .toArray(),
    ]);

    return res.status(200).json({
      conversation: conversation ?? {
        workspace,
        contact,
        status: 'open',
        assignee: null,
        last_activity_at: null,
        created_at: null,
      },
      messages,
      notes,
    });
  });

  router.post('/conversations/:contact/claim', async (req: AuthenticatedRequest, res: Response) => {
    const workspace = checkWorkspaceAccess(req, res);
    if (!workspace) return;

    const contact = decodeURIComponent(String(req.params.contact || ''));
    if (!contact) return res.status(400).json({ error: 'missing contact' });

    const result = await claimConversation({
      workspace,
      contact,
      agent: req.user!.sub,
    });

    if (!result.claimed) {
      return res.status(409).json({ error: 'already claimed' });
    }
    return res.status(200).json({ ok: true, assignee: req.user!.sub });
  });

  router.post('/conversations/:contact/unclaim', async (req: AuthenticatedRequest, res: Response) => {
    const workspace = checkWorkspaceAccess(req, res);
    if (!workspace) return;

    const contact = decodeURIComponent(String(req.params.contact || ''));
    if (!contact) return res.status(400).json({ error: 'missing contact' });

    const db = await getDb();
    const membership = req.user!.workspaces.find((w) => w.id === workspace);
    const isAdmin = membership?.role === 'admin';

    const filter = isAdmin
      ? { workspace, contact }
      : { workspace, contact, $or: [{ assignee: req.user!.sub }, { assignee: null }] };

    const updated = await conversationsCol(db).findOneAndUpdate(
      filter,
      { $set: { assignee: null } },
      { returnDocument: 'after' }
    );

    if (!updated) {
      return res.status(409).json({ error: 'cannot unclaim conversation held by another agent' });
    }

    await emitWorkspaceEvent(db, workspace, {
      type: 'conversation.assigned',
      contact,
      assignee: null,
    });

    return res.status(200).json({ ok: true, assignee: null });
  });

  router.post('/conversations/:contact/status', async (req: AuthenticatedRequest, res: Response) => {
    const workspace = checkWorkspaceAccess(req, res);
    if (!workspace) return;

    const contact = decodeURIComponent(String(req.params.contact || ''));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = body.status;

    if (!contact) return res.status(400).json({ error: 'missing contact' });
    if (status !== 'open' && status !== 'closed') {
      return res.status(400).json({ error: 'status must be open or closed' });
    }

    const db = await getDb();
    const now = new Date();
    await conversationsCol(db).updateOne(
      { workspace, contact },
      {
        $set: { status },
        $setOnInsert: {
          workspace,
          contact,
          assignee: null,
          last_activity_at: now,
          created_at: now,
        },
      },
      { upsert: true }
    );

    await emitWorkspaceEvent(db, workspace, {
      type: 'conversation.status',
      contact,
      status,
    });

    return res.status(200).json({ ok: true, status });
  });

  router.post('/conversations/:contact/reply', async (req: AuthenticatedRequest, res: Response) => {
    const workspace = checkWorkspaceAccess(req, res);
    if (!workspace) return;

    const contact = decodeURIComponent(String(req.params.contact || ''));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const client_ref =
      typeof body.client_ref === 'string' && body.client_ref.trim()
        ? body.client_ref.trim()
        : `ui_${crypto.randomUUID()}`;

    if (!contact) return res.status(400).json({ error: 'missing contact' });
    if (!text) return res.status(400).json({ error: 'missing text' });

    await enqueueOutboundReply({ workspace, contact, text, client_ref });

    const db = await getDb();
    await emitWorkspaceEvent(db, workspace, {
      type: 'message.outbound',
      contact,
      client_ref,
      text,
      status: 'queued',
    });

    return res.status(202).json({ ok: true, client_ref, status: 'queued' });
  });

  router.post('/conversations/:contact/notes', async (req: AuthenticatedRequest, res: Response) => {
    const workspace = checkWorkspaceAccess(req, res);
    if (!workspace) return;

    const contact = decodeURIComponent(String(req.params.contact || ''));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ciphertext = typeof body.ciphertext === 'string' ? body.ciphertext.trim() : '';
    const iv = typeof body.iv === 'string' ? body.iv.trim() : '';
    const alg = body.alg === 'AES-GCM-256' ? ('AES-GCM-256' as const) : null;
    const key_id = typeof body.key_id === 'string' ? body.key_id.trim() : 'default';

    if (!contact) return res.status(400).json({ error: 'missing contact' });
    if (!ciphertext || !iv || !alg) {
      return res.status(400).json({ error: 'missing ciphertext, iv, or valid alg (AES-GCM-256)' });
    }

    const db = await getDb();
    const now = new Date();
    const note = {
      workspace,
      contact,
      author_sub: req.user!.sub,
      author_name: req.user!.name,
      ciphertext,
      iv,
      alg,
      key_id,
      created_at: now,
    };

    const insertRes = await notesCol(db).insertOne(note);

    await emitWorkspaceEvent(db, workspace, {
      type: 'note.created',
      contact,
      note: {
        _id: insertRes.insertedId,
        ...note,
      },
    });

    return res.status(201).json({ ok: true, note: { _id: insertRes.insertedId, ...note } });
  });

  return router;
}
