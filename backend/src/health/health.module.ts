import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import IORedis, { Redis } from 'ioredis';
import { HealthController } from './health.controller';
import { REDIS_HEALTH_CLIENT } from './health.constants';

@Module({
  imports: [ConfigModule],
  controllers: [HealthController],
  providers: [
    {
      provide: REDIS_HEALTH_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Redis =>
        new IORedis(
          configService.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
          {
            maxRetriesPerRequest: null,
            // Connect on first probe rather than at boot, and never queue
            // commands while offline — a readiness check should fail fast, not
            // block, when Redis is unreachable.
            lazyConnect: true,
            enableOfflineQueue: false,
          },
        ),
    },
  ],
})
export class HealthModule implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS_HEALTH_CLIENT) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    // Release the health-probe connection cleanly on shutdown.
    if (this.redis.status !== 'end') {
      await this.redis.quit();
    }
  }
}
