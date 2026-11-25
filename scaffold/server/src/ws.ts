import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { getRedis } from './redis.js';
import {
  getSession,
  isWorkspaceMember,
  parseCookies,
  SESSION_COOKIE_NAME,
} from './services/session.js';

interface ClientEntry {
  ws: WebSocket;
  ready: boolean;
  lastSentSeq: number;
  buffer: Array<{ seq: number; raw: string }>;
}

export function attachWebSocketServer(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  const clientsByWorkspace = new Map<string, Set<ClientEntry>>();
  const subscribedChannels = new Set<string>();

  const sub = getRedis().duplicate();
  sub.on('message', (channel, message) => {
    const prefix = 'sb:ws:pub:';
    if (!channel.startsWith(prefix)) return;
    const workspace = channel.slice(prefix.length);
    const clients = clientsByWorkspace.get(workspace);
    if (!clients || clients.size === 0) return;

    let seq = -1;
    try {
      const parsed = JSON.parse(message) as { seq?: unknown };
      if (typeof parsed.seq === 'number') seq = parsed.seq;
    } catch {
      return;
    }

    for (const client of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (!client.ready) {
        client.buffer.push({ seq, raw: message });
      } else if (seq > client.lastSentSeq) {
        client.lastSentSeq = seq;
        client.ws.send(message);
      }
    }
  });

  async function ensureSubscribed(workspace: string): Promise<void> {
    const channel = `sb:ws:pub:${workspace}`;
    if (!subscribedChannels.has(channel)) {
      subscribedChannels.add(channel);
      await sub.subscribe(channel);
    }
  }

  server.on('upgrade', (req, socket: Duplex, head) => {
    void (async () => {
      try {
        const url = new URL(req.url || '/', 'http://localhost');
        if (url.pathname !== '/ws') {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
          return;
        }

        const cookies = parseCookies(req.headers.cookie);
        const sid = cookies[SESSION_COOKIE_NAME];
        const user = await getSession(sid);
        if (!user) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        const workspace = url.searchParams.get('workspace') || '';
        if (!workspace || !isWorkspaceMember(user, workspace)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }

        const afterRaw = url.searchParams.get('after');
        const after =
          afterRaw !== null && afterRaw !== '' && Number.isFinite(Number(afterRaw))
            ? Number(afterRaw)
            : undefined;

        await ensureSubscribed(workspace);

        wss.handleUpgrade(req, socket, head, (ws) => {
          void handleConnection(ws, workspace, after);
        });
      } catch (err) {
        console.error('[ws] upgrade error:', err);
        socket.destroy();
      }
    })();
  });

  async function handleConnection(
    ws: WebSocket,
    workspace: string,
    after: number | undefined
  ): Promise<void> {
    const entry: ClientEntry = {
      ws,
      ready: false,
      lastSentSeq: after ?? -1,
      buffer: [],
    };

    let set = clientsByWorkspace.get(workspace);
    if (!set) {
      set = new Set();
      clientsByWorkspace.set(workspace, set);
    }
    set.add(entry);

    const cleanup = () => {
      set?.delete(entry);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    try {
      if (after !== undefined) {
        const missed = await getRedis().zrangebyscore(
          `sb:ws:events:${workspace}`,
          `(${after}`,
          '+inf'
        );
        for (const raw of missed) {
          if (ws.readyState !== WebSocket.OPEN) return;
          try {
            const parsed = JSON.parse(raw) as { seq?: unknown };
            const seq = typeof parsed.seq === 'number' ? parsed.seq : -1;
            if (seq > entry.lastSentSeq) {
              entry.lastSentSeq = seq;
              ws.send(raw);
            }
          } catch {
            // ignore malformed frame
          }
        }
      }

      if (ws.readyState !== WebSocket.OPEN) return;

      entry.buffer.sort((a, b) => a.seq - b.seq);
      for (const item of entry.buffer) {
        if (item.seq > entry.lastSentSeq && ws.readyState === WebSocket.OPEN) {
          entry.lastSentSeq = item.seq;
          ws.send(item.raw);
        }
      }
      entry.buffer = [];
      entry.ready = true;
    } catch (err) {
      console.error('[ws] replay error:', err);
      ws.close();
    }
  }
}
