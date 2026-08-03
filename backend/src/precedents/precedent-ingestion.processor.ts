import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  PRECEDENT_INGESTION_QUEUE,
} from './precedent-ingestion.constants';
import { PrecedentIngestionService } from './precedent-ingestion.service';

export interface PrecedentIngestionJobData {
  decisionFeedbackId: string;
}

@Processor(PRECEDENT_INGESTION_QUEUE)
export class PrecedentIngestionProcessor extends WorkerHost {
  constructor(
    private readonly precedentIngestionService: PrecedentIngestionService,
  ) {
    super();
  }

  async process(job: Job<PrecedentIngestionJobData>): Promise<void> {
    await this.precedentIngestionService.ingest(job.data.decisionFeedbackId);
  }
}
