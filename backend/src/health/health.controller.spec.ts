import { ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

function makeController(opts: {
  postgresOk: boolean;
  redisReply: string | Error;
}) {
  const prisma = {
    $queryRaw: opts.postgresOk
      ? jest.fn().mockResolvedValue([{ '?column?': 1 }])
      : jest.fn().mockRejectedValue(new Error('connection refused')),
  } as unknown as PrismaService;

  const redis = {
    ping:
      opts.redisReply instanceof Error
        ? jest.fn().mockRejectedValue(opts.redisReply)
        : jest.fn().mockResolvedValue(opts.redisReply),
  } as unknown as Redis;

  return new HealthController(prisma, redis);
}

describe('HealthController', () => {
  it('reports liveness as ok without touching dependencies', () => {
    const controller = makeController({ postgresOk: true, redisReply: 'PONG' });
    expect(controller.liveness()).toEqual({ status: 'ok' });
  });

  it('reports readiness ok when Postgres and Redis are both up', async () => {
    const controller = makeController({ postgresOk: true, redisReply: 'PONG' });
    await expect(controller.readiness()).resolves.toEqual({
      status: 'ok',
      checks: { postgres: 'up', redis: 'up' },
    });
  });

  it('fails readiness (503) when Postgres is down', async () => {
    const controller = makeController({ postgresOk: false, redisReply: 'PONG' });
    await expect(controller.readiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('fails readiness (503) when Redis does not answer PONG', async () => {
    const controller = makeController({
      postgresOk: true,
      redisReply: new Error('redis unreachable'),
    });
    await expect(controller.readiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('includes per-dependency check detail in the 503 payload', async () => {
    const controller = makeController({ postgresOk: false, redisReply: 'PONG' });
    await expect(controller.readiness()).rejects.toMatchObject({
      response: { status: 'unavailable', checks: { postgres: 'down', redis: 'up' } },
    });
  });
});
