import { createServer } from 'node:http';
import { config } from './config.js';
import { getDb } from './db.js';
import { pingRedis } from './redis.js';
import { ensureIndexes } from './models.js';
import { startOutboundWorker } from './services/outbound.js';
import { attachWebSocketServer } from './ws.js';
import { createApp } from './app.js';

let isReady = false;
const app = createApp(() => isReady);

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
attachWebSocketServer(server);

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
