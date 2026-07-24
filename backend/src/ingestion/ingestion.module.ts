import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { IdempotencyService } from './idempotency.service';
import { IngestionController } from './ingestion.controller';
import { IngestionService } from './ingestion.service';

@Module({
  imports: [QueueModule],
  controllers: [IngestionController],
  providers: [IngestionService, IdempotencyService],
})
export class IngestionModule {}
