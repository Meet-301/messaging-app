import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { clearAppRedisKeys } from '../redis.js';
import {
  conversationsCol,
  messagesCol,
  processedEventsCol,
  workspaceSeqsCol,
} from '../models.js';
import {
  claimConversation,
  enqueueOutboundReply,
  isKnownWorkspace,
} from '../services/outbound.js';

function requireGraderToken(req: Request, res: Response, next: NextFunction): void {
  if (req.header('x-grader-token') !== config.graderToken) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

export function createGraderRouter(): Router {
  const router = Router();
  router.use(requireGraderToken);

  router.post('/reset', async (_req: Request, res: Response) => {
    const db = await getDb();
    await Promise.all([
      conversationsCol(db).deleteMany({}),
      messagesCol(db).deleteMany({}),
      processedEventsCol(db).deleteMany({}),
      workspaceSeqsCol(db).deleteMany({}),
      clearAppRedisKeys(),
    ]);
    res.status(200).json({ ok: true });
  });

  router.get('/snapshot', async (_req: Request, res: Response) => {
    const db = await getDb();

    const [conversations, inboundMsgs, outboundMsgs] = await Promise.all([
      conversationsCol(db).find({}).toArray(),
      messagesCol(db)
        .find({ direction: 'inbound' })
        .sort({ occurred_at: 1, created_at: 1, _id: 1 })
        .toArray(),
      messagesCol(db).find({ direction: 'outbound' }).toArray(),
    ]);

    const workspaces: Record<
      string,
      {
        contacts: Record<string, { inbound: string[]; assignee: string | null }>;
        outbound: Record<string, string>;
      }
    > = {};

    const ensureWs = (ws: string) => {
      if (!workspaces[ws]) {
        workspaces[ws] = { contacts: {}, outbound: {} };
      }
      return workspaces[ws];
    };

    for (const ws of Object.keys(config.pigeon.apiKeys)) {
      ensureWs(ws);
    }

    for (const conv of conversations) {
      const wsObj = ensureWs(conv.workspace);
      wsObj.contacts[conv.contact] = {
        inbound: [],
        assignee: conv.assignee ?? null,
      };
    }

    for (const msg of inboundMsgs) {
      if (!msg.message_id) continue;
      const wsObj = ensureWs(msg.workspace);
      if (!wsObj.contacts[msg.contact]) {
        wsObj.contacts[msg.contact] = { inbound: [], assignee: null };
      }
      wsObj.contacts[msg.contact].inbound.push(msg.message_id);
    }

    for (const msg of outboundMsgs) {
      if (!msg.client_ref) continue;
      const wsObj = ensureWs(msg.workspace);
      wsObj.outbound[msg.client_ref] = msg.status;
    }

    res.status(200).json({ workspaces });
  });

  router.post('/reply', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const workspace = typeof body.workspace === 'string' ? body.workspace : '';
    const contact = typeof body.contact === 'string' ? body.contact : '';
    const text = typeof body.text === 'string' ? body.text : '';
    const client_ref = typeof body.client_ref === 'string' ? body.client_ref : '';

    if (!isKnownWorkspace(workspace)) {
      return res.status(400).json({ error: 'unknown workspace' });
    }
    if (!contact || !client_ref) {
      return res.status(400).json({ error: 'missing contact or client_ref' });
    }

    await enqueueOutboundReply({ workspace, contact, text, client_ref });
    return res.status(202).json({ ok: true, client_ref });
  });

  router.post('/claim', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const workspace = typeof body.workspace === 'string' ? body.workspace : '';
    const contact = typeof body.contact === 'string' ? body.contact : '';
    const agent = typeof body.agent === 'string' ? body.agent : '';

    if (!isKnownWorkspace(workspace)) {
      return res.status(400).json({ error: 'unknown workspace' });
    }
    if (!contact || !agent) {
      return res.status(400).json({ error: 'missing contact or agent' });
    }

    const result = await claimConversation({ workspace, contact, agent });
    if (!result.claimed) {
      return res.status(409).json({ error: 'already claimed' });
    }

    return res.status(200).json({ ok: true, assignee: agent });
  });

  return router;
}
