import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

// Reconnect attempts slow down to this, so an absent Redis isn't knocked on every few hundred ms.
const MAX_RECONNECT_DELAY_MS = 30_000;

@Injectable()
export class RedisCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);
  private readonly client: Redis;
  // Said once when Redis goes away and once when it comes back — not on every reconnect attempt.
  private down = false;

  constructor(config: ConfigService) {
    const url = config.get<string>('redisUrl')!;
    this.client = new Redis(url, {
      // Bounded retries — this is a producer-side cache client, not a
      // BullMQ Worker/QueueEvents connection (those require
      // maxRetriesPerRequest: null instead). A cache miss should fail fast,
      // not hang a request while Redis is unreachable.
      maxRetriesPerRequest: 2,
      // Without a connection a command fails at once instead of waiting in a
      // queue for the reconnects (that cost every cached read 0.5–1+ s while
      // Redis was down).
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 500, MAX_RECONNECT_DELAY_MS),
    });
    // ioredis emits 'error' on every failed connection attempt — an
    // unhandled 'error' event on a Node EventEmitter crashes the process,
    // so this listener is required even though get/set already catch.
    this.client.on('error', (err: Error & { code?: string }) => {
      if (this.down) return;
      this.down = true;
      // A refused connection arrives as an AggregateError with an empty message: say what happened.
      const why = err.message || err.code || 'no answer';
      this.logger.warn(`Redis cache unavailable (${why}) at ${this.where(url)} — carrying on without the cache; it is used again once Redis is back.`);
    });
    this.client.on('ready', () => {
      if (this.down) this.logger.log('Redis cache is back.');
      this.down = false;
    });
  }

  /** Host and port only — never a password from the URL. */
  private where(url: string): string {
    try {
      const u = new URL(url);
      return `${u.hostname}:${u.port || '6379'}`;
    } catch {
      return 'the configured address';
    }
  }

  private get ready(): boolean {
    return this.client.status === 'ready';
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.ready) return null;
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null; // fail open — a cache error must never break a read
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.ready) return;
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      // non-fatal
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (!this.ready) return;
    try {
      if (keys.length) await this.client.del(keys);
    } catch {
      // non-fatal
    }
  }

  onModuleDestroy() {
    this.client.disconnect();
  }
}
