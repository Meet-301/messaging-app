import { MongoServerError, type Collection, type Db } from 'mongodb';
import { getRedis } from './redis.js';

export type ConversationStatus = 'open' | 'closed';
export type MessageDirection = 'inbound' | 'outbound';
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'failed';

export interface ConversationDoc {
  workspace: string;
  contact: string;
  status: ConversationStatus;
  assignee: string | null;
  last_activity_at: Date;
  created_at: Date;
}

export interface MessageDoc {
  workspace: string;
  contact: string;
  direction: MessageDirection;
  message_id?: string;
  client_ref?: string;
  text: string;
  status: MessageStatus;
  occurred_at: Date;
  created_at: Date;
  locked_until?: Date | null;
  attempts?: number;
  last_error?: string;
}

export interface ProcessedEventDoc {
  event_id: string;
  created_at: Date;
}

export interface WorkspaceSeqDoc {
  workspace: string;
  seq: number;
}

export interface PrivateNoteDoc {
  workspace: string;
  contact: string;
  author_sub: string;
  author_name: string;
  text: string;
  created_at: Date;
}

export function conversationsCol(db: Db): Collection<ConversationDoc> {
  return db.collection<ConversationDoc>('conversations');
}

export function messagesCol(db: Db): Collection<MessageDoc> {
  return db.collection<MessageDoc>('messages');
}

export function processedEventsCol(db: Db): Collection<ProcessedEventDoc> {
  return db.collection<ProcessedEventDoc>('processed_events');
}

export function workspaceSeqsCol(db: Db): Collection<WorkspaceSeqDoc> {
  return db.collection<WorkspaceSeqDoc>('workspace_seqs');
}

export function notesCol(db: Db): Collection<PrivateNoteDoc> {
  return db.collection<PrivateNoteDoc>('notes');
}

export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    conversationsCol(db).createIndex({ workspace: 1, contact: 1 }, { unique: true }),
    conversationsCol(db).createIndex({ workspace: 1, last_activity_at: -1 }),

    messagesCol(db).createIndex({ message_id: 1 }, { unique: true, sparse: true }),
    messagesCol(db).createIndex({ client_ref: 1 }, { unique: true, sparse: true }),
    messagesCol(db).createIndex({ workspace: 1, contact: 1, direction: 1, occurred_at: 1 }),
    messagesCol(db).createIndex({ direction: 1, status: 1, locked_until: 1, created_at: 1 }),

    processedEventsCol(db).createIndex({ event_id: 1 }, { unique: true }),
    workspaceSeqsCol(db).createIndex({ workspace: 1 }, { unique: true }),
    notesCol(db).createIndex({ workspace: 1, contact: 1, created_at: 1 }),
  ]);
}

export function isDuplicateKeyError(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

export async function nextWorkspaceSeq(db: Db, workspace: string): Promise<number> {
  try {
    const res = await workspaceSeqsCol(db).findOneAndUpdate(
      { workspace },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    return res!.seq;
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const res = await workspaceSeqsCol(db).findOneAndUpdate(
      { workspace },
      { $inc: { seq: 1 } },
      { returnDocument: 'after' }
    );
    return res!.seq;
  }
}

export async function emitWorkspaceEvent(
  db: Db,
  workspace: string,
  payload: Record<string, unknown>
): Promise<number> {
  const seq = await nextWorkspaceSeq(db, workspace);
  const frame = JSON.stringify({ seq, ...payload });
  const redis = getRedis();
  const streamKey = `sb:ws:events:${workspace}`;
  const pubChannel = `sb:ws:pub:${workspace}`;

  await Promise.all([
    redis.zadd(streamKey, seq, frame),
    redis.publish(pubChannel, frame),
  ]);

  return seq;
}
