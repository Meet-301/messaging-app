import { Redis } from 'ioredis';
import { config } from './config.js';

let redis: Redis | undefined;

// Connects on first use. Call from anywhere: const redis = getRedis();
export function getRedis(): Redis {
  if (!redis) redis = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
  return redis;
}

export async function pingRedis(): Promise<boolean> {
  try {
    const r = getRedis();
    const res = await r.ping();
    return res === 'PONG';
  } catch {
    return false;
  }
}

export async function clearAppRedisKeys(): Promise<void> {
  const r = getRedis();
  let cursor = '0';
  do {
    const [nextCursor, keys] = await r.scan(cursor, 'MATCH', 'sb:*', 'COUNT', 200);
    cursor = nextCursor;
    if (keys.length > 0) {
      await r.del(...keys);
    }
  } while (cursor !== '0');
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    redis.disconnect();
    redis = undefined;
  }
}
