import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PrecedentsModule } from '../precedents/precedents.module';
import { DecisionExecutionSweeperService } from './decision-execution-sweeper.service';
import { DecisionExecutionProcessor } from './decision-execution.processor';
import {
  DECISION_EXECUTION_DEFAULT_JOB_OPTIONS,
  DECISION_EXECUTION_QUEUE,
} from './decision-execution.constants';
import { DecisionsController } from './decisions.controller';
import { DecisionsService } from './decisions.service';
import { ExecutionAdapter } from './execution-adapter.service';

@Module({
  imports: [
    PrecedentsModule,
    // The Redis connection itself is configured once, globally, by
    // QueueModule's BullModule.forRootAsync — registerQueue here just adds
    // this queue under that shared connection. Same 3-attempt exponential
    // backoff + jitter policy as the access-request queue, since this is
    // also calling into a rate-limited downstream system.
    BullModule.registerQueue({
      name: DECISION_EXECUTION_QUEUE,
      defaultJobOptions: DECISION_EXECUTION_DEFAULT_JOB_OPTIONS,
    }),
  ],
  controllers: [DecisionsController],
  providers: [
    DecisionsService,
    ExecutionAdapter,
    DecisionExecutionProcessor,
    DecisionExecutionSweeperService,
  ],
})
export class DecisionsModule {}
