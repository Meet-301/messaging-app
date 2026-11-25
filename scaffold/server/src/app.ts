import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { pingDb } from './db.js';
import { pingRedis } from './redis.js';
import { createWebhooksRouter } from './routes/webhooks.js';
import { createGraderRouter } from './routes/grader.js';
import { createAuthRouter } from './routes/auth.js';
import { createApiRouter } from './routes/api.js';

export function createApp(getReady: () => boolean = () => true): Express {
  const app = express();

  app.get('/healthz', async (_req: Request, res: Response) => {
    if (!getReady()) {
      return res.status(503).json({ ok: false, reason: 'initializing' });
    }
    const [mongoOk, redisOk] = await Promise.all([pingDb(), pingRedis()]);
    if (!mongoOk || !redisOk) {
      return res.status(503).json({ ok: false, mongo: mongoOk, redis: redisOk });
    }
    return res.status(200).json({ ok: true });
  });

  // Mount webhooks before express.json() so raw body Buffer is preserved for HMAC verification.
  app.use('/webhooks', createWebhooksRouter());

  app.use(express.json({ limit: '2mb' }));

  app.use('/auth', createAuthRouter());
  app.use('/api', createApiRouter());
  app.use('/__grader', createGraderRouter());

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDistDir = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(webDistDir, 'index.html'));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError && 'status' in err && (err as { status?: number }).status === 400) {
      return res.status(400).json({ error: 'invalid json' });
    }
    console.error('[server] unhandled error:', err);
    return res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
