import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

export const THROTTLER_REDIS: unique symbol = Symbol('ThrottlerRedis');

/**
 * Lazy, so a process whose routes never count anything opens no connection: the public reads, and
 *   the suites that exercise them without a Redis.
 */
export function throttlerRedis(url: string): Redis {
  return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
}

/** The counters every replica shares (`nestjs-web-security` rule 9). */
export function throttlerStorage(redis: Redis): ThrottlerStorageRedisService {
  return new ThrottlerStorageRedisService(redis);
}

/** The storage leaves its client to whoever made it; this closes it on shutdown. */
@Injectable()
export class ThrottlerRedisLifecycle implements OnApplicationShutdown {
  public constructor(@Inject(THROTTLER_REDIS) private readonly redis: Redis) {}

  public async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'wait') {
      this.redis.disconnect();
      return;
    }
    await this.redis.quit();
  }
}
