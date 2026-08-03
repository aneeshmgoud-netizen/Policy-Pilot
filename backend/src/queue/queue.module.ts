import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import IORedis from 'ioredis';
import { AgentModule } from '../agent/agent.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { PrecedentsModule } from '../precedents/precedents.module';
import { RagModule } from '../rag/rag.module';
import { AccessRequestProcessor } from './access-request.processor';
import { ACCESS_REQUEST_QUEUE } from './queue.constants';
import { RecommendationGroundingService } from './recommendation-grounding.service';
import { StaleRequestSweeperService } from './stale-request-sweeper.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        // BullMQ requires maxRetriesPerRequest: null on the connection it
        // uses for blocking commands. REDIS_URL presence is validated at
        // bootstrap (see config/env.validation.ts); the fallback keeps local
        // dev working if that validation is ever bypassed.
        connection: new IORedis(
          configService.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
          {
            maxRetriesPerRequest: null,
          },
        ),
      }),
    }),
    BullModule.registerQueue({
      name: ACCESS_REQUEST_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        // Exponential backoff (1s, 2s, 4s) with 50% randomized jitter, so
        // concurrent failures (e.g. a downstream outage) don't all retry in
        // lockstep and hammer the dependency at the same instants — the
        // classic thundering-herd-on-retry problem.
        backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
      },
    }),
    EntitlementsModule,
    PrecedentsModule,
    RagModule,
    AgentModule,
    ScheduleModule.forRoot(),
  ],
  providers: [
    AccessRequestProcessor,
    StaleRequestSweeperService,
    RecommendationGroundingService,
  ],
  exports: [BullModule],
})
export class QueueModule {}
