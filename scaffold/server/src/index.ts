import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { config } from './config.js';
import { getDb, pingDb } from './db.js';
import { pingRedis } from './redis.js';
import { ensureIndexes } from './models.js';
import { createWebhooksRouter } from './routes/webhooks.js';
import { createGraderRouter } from './routes/grader.js';
import { startOutboundWorker } from './services/outbound.js';

const app = express();
let isReady = false;

app.get('/healthz', async (_req: Request, res: Response) => {
  if (!isReady) {
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

app.use('/__grader', createGraderRouter());

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof SyntaxError && 'status' in err && (err as { status?: number }).status === 400) {
    return res.status(400).json({ error: 'invalid json' });
  }
  console.error('[server] unhandled error:', err);
  return res.status(500).json({ error: 'internal server error' });
});

async function bootstrap(): Promise<void> {
  const db = await getDb();
  await ensureIndexes(db);
  const redisOk = await pingRedis();
  if (!redisOk) {
    throw new Error('Redis ping failed during startup');
  }
  isReady = true;
  startOutboundWorker();
}

const server = createServer(app);

bootstrap()
  .then(() => {
    server.listen(config.port, () => {
      console.log(`server on http://localhost:${config.port}`);
    });
  })
  .catch((err) => {
    console.error('[server] failed to start:', err);
    process.exit(1);
  });
