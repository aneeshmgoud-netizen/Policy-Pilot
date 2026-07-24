import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_HEALTH_CLIENT } from './health.constants';

type CheckState = 'up' | 'down';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_HEALTH_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  liveness() {
    // Liveness: the process is up and serving. Deliberately does not touch
    // Postgres/Redis so an orchestrator won't kill a pod for a transient
    // dependency blip — that's the readiness probe's job.
    return { status: 'ok' };
  }

  @Get('ready')
  async readiness() {
    const [postgres, redis] = await Promise.all([
      this.checkPostgres(),
      this.checkRedis(),
    ]);
    const checks = { postgres, redis };

    if (postgres !== 'up' || redis !== 'up') {
      // 503 so load balancers and orchestrators stop routing traffic here
      // until both dependencies recover.
      throw new ServiceUnavailableException({ status: 'unavailable', checks });
    }

    return { status: 'ok', checks };
  }

  private async checkPostgres(): Promise<CheckState> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<CheckState> {
    try {
      const reply = await this.redis.ping();
      return reply === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
