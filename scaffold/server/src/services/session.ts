import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getRedis } from '../redis.js';

export const SESSION_COOKIE_NAME = 'sb_session';
const SESSION_TTL_SEC = 86400; // 24h

export interface WorkspaceMembership {
  id: string;
  role: 'admin' | 'agent' | string;
}

export interface SessionUser {
  sub: string;
  name: string;
  email: string;
  workspaces: WorkspaceMembership[];
}

export interface AuthenticatedRequest extends Request {
  user?: SessionUser;
  sessionId?: string;
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

export async function createSession(user: SessionUser): Promise<string> {
  const sid = crypto.randomBytes(24).toString('hex');
  await getRedis().set(`sess:${sid}`, JSON.stringify(user), 'EX', SESSION_TTL_SEC);
  return sid;
}

export async function getSession(sid: string | undefined): Promise<SessionUser | null> {
  if (!sid) return null;
  const raw = await getRedis().get(`sess:${sid}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export async function deleteSession(sid: string | undefined): Promise<void> {
  if (!sid) return;
  await getRedis().del(`sess:${sid}`);
}

export function isWorkspaceMember(user: SessionUser, workspace: string): boolean {
  return Array.isArray(user.workspaces) && user.workspaces.some((w) => w.id === workspace);
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[SESSION_COOKIE_NAME];
  const user = await getSession(sid);
  if (!user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.user = user;
  req.sessionId = sid;
  next();
}
